/**
 * competitor-tracker.ts
 * Monitors competitor accounts by fetching their latest content via
 * xhs-bridge (search) and yt-dlp-downloader + video-summary ClawHub skills.
 * All failures are graceful — missing data is noted but never fatal.
 *
 * Enhanced: Now consumes rich CompetitorProfile from persona config
 * to provide structured summaries with content mix, audience, and takeaways.
 */

import { execFileSync } from 'child_process';
import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now, wallNow, getLocalDate } from '../utils/time-utils';
import { CompetitorUpdate, CompetitorLog, OpsConfig, CompetitorProfile, IdentityMode } from '../utils/types';
import { matchesTaxonomy } from './ops-taxonomy';

// ─── Constants ───────────────────────────────────────────────────────────────

const NO_POSTS_FOUND_DAYS = 99;
const FETCH_FAILED_DAYS = -1;
const MAX_COMPETITOR_LOG_ENTRIES = 200;

// ─── Pure functions (exported for testing) ───────────────────────────────────

export function buildCompetitorSummary(updates: CompetitorUpdate[]): string {
  if (updates.length === 0) return '无竞品数据';
  return updates.map(u => {
    if (!u.latest_post) return `@${u.account}  ${u.days_since_last_post}天未更新`;
    const { topic, engagement } = u.latest_post;
    return `@${u.account}  今日发布「${topic}」互动${engagement}`;
  }).join('\n');
}

export interface CompetitorContextOptions {
  /** Filter profiles to only those relevant to this identity mode */
  identityMode?: IdentityMode;
  /** Max profiles to include (default: unlimited) */
  maxProfiles?: number;
  /** Include takeaways section (default: true) */
  includeTakeaways?: boolean;
  /** Include avoid points section (default: true) */
  includeAvoids?: boolean;
  /** Max bullets per takeaways/avoids section (default: unlimited) */
  maxBulletsPerSection?: number;
}

/**
 * Build a rich competitor context string for LLM prompts.
 * Includes profile metadata (tag, audience, content mix, interaction style)
 * alongside live tracking data (latest posts).
 * Supports optional identity-based filtering for prompt budget control.
 */
export function buildCompetitorContext(
  profiles: readonly CompetitorProfile[],
  updates: CompetitorUpdate[],
  options?: CompetitorContextOptions,
): string {
  if (profiles.length === 0) return '';

  let filteredProfiles = [...profiles];

  // Filter by identity mode using taxonomy
  if (options?.identityMode) {
    const mode = options.identityMode;
    filteredProfiles = filteredProfiles.filter(p => {
      const label = p.group ?? p.tag;
      return matchesTaxonomy(mode, label);
    });
    // If nothing matches, fall back to primary profiles only
    if (filteredProfiles.length === 0) {
      filteredProfiles = profiles.filter(p => p.reference_type === 'primary');
    }
  }

  // Limit number of profiles
  if (options?.maxProfiles && filteredProfiles.length > options.maxProfiles) {
    // Prefer primary over secondary
    const primary = filteredProfiles.filter(p => p.reference_type === 'primary');
    const secondary = filteredProfiles.filter(p => p.reference_type !== 'primary');
    filteredProfiles = [...primary, ...secondary].slice(0, options.maxProfiles);
  }

  // Group profiles by group tag
  const groups = new Map<string, CompetitorProfile[]>();
  for (const p of filteredProfiles) {
    const key = p.group ?? p.tag;
    const existing = groups.get(key) ?? [];
    groups.set(key, [...existing, p]);
  }

  const sections: string[] = [];
  for (const [groupName, members] of groups) {
    const memberLines = members.map(p => {
      const mixStr = p.content_mix
        ? Object.entries(p.content_mix).map(([k, v]) => `${k}${v}%`).join('、')
        : '未知';
      const liveData = updates.find(u => u.account === p.name && u.platform === p.platform);
      const liveStr = liveData?.latest_post
        ? `最新：「${liveData.latest_post.topic}」互动${liveData.latest_post.engagement}`
        : '暂无实时数据';
      return `  @${p.name}（${p.platform}）${p.followers ? `粉丝${p.followers}` : ''}
    人设：${p.tag_desc}
    内容比例：${mixStr}
    受众：${p.audience ?? '未知'}
    互动风格：${p.interaction_style ?? '未知'}
    ${liveStr}`;
    }).join('\n');
    sections.push(`【${groupName}】\n${memberLines}`);
  }

  // Add takeaways summary for primary competitors
  const includeTakeaways = options?.includeTakeaways !== false;
  const includeAvoids = options?.includeAvoids !== false;
  const maxBullets = options?.maxBulletsPerSection;

  const primaryTakeaways = includeTakeaways
    ? filteredProfiles
        .filter(p => p.reference_type === 'primary' && p.takeaways && p.takeaways.length > 0)
        .flatMap(p => (p.takeaways ?? []).map(t => `- ${p.name}：${t}`))
    : [];

  const avoidPoints = includeAvoids
    ? filteredProfiles
        .filter(p => p.avoid && p.avoid.length > 0)
        .flatMap(p => (p.avoid ?? []).map(a => `- 避免（${p.name}）：${a}`))
    : [];

  // Add notice if no live data is available for any competitor
  const hasAnyLiveData = filteredProfiles.some(p =>
    updates.find(u => u.account === p.name && u.platform === p.platform)?.latest_post != null,
  );
  let result = sections.join('\n\n');
  if (!hasAnyLiveData && updates.length === 0) {
    result = `⚠️ 以下为静态竞品画像（暂无实时动态数据）\n\n${result}`;
  }
  const trimmedTakeaways = maxBullets ? primaryTakeaways.slice(0, maxBullets) : primaryTakeaways;
  const trimmedAvoids = maxBullets ? avoidPoints.slice(0, maxBullets) : avoidPoints;
  if (trimmedTakeaways.length > 0) {
    result += `\n\n【借鉴要点】\n${trimmedTakeaways.join('\n')}`;
  }
  if (trimmedAvoids.length > 0) {
    result += `\n\n【避坑提醒】\n${trimmedAvoids.join('\n')}`;
  }

  return result;
}

/**
 * Get all competitor account identifiers by platform from both
 * legacy competitor_accounts and new competitors[] profiles.
 *
 * For Douyin: prefers `external_id` (sec_user_id) over `name` for API calls.
 * This allows persona.yaml to use a human-readable display name while still
 * providing the correct sec_user_id for the web API.
 */
export function resolveCompetitorAccounts(ops: OpsConfig): { xhs: string[]; douyin: string[] } {
  const xhs = new Set(ops.competitor_accounts.xhs);
  const douyin = new Set(ops.competitor_accounts.douyin);

  if (ops.competitors) {
    for (const c of ops.competitors) {
      if (c.platform === 'xhs') xhs.add(c.name);
      if (c.platform === 'douyin') {
        // Prefer external_id (sec_user_id) for API calls; fall back to name
        douyin.add(c.external_id ?? c.name);
      }
    }
  }

  return { xhs: [...xhs], douyin: [...douyin] };
}

import * as os from 'os';
import * as path from 'path';

const XHS_CLI = path.join(os.homedir(), '.openclaw', 'skills', 'xiaohongshu-skills', 'scripts', 'cli.py');

// ─── ClawHub skill calls ──────────────────────────────────────────────────────

function fetchXhsAccount(account: string): CompetitorUpdate {
  try {
    const raw = execFileSync('python3', [
      XHS_CLI, 'search-feeds',
      '--keyword', account,
    ], { timeout: 30_000, encoding: 'utf8' });
    // Output is JSON with a "feeds" array
    const parsed = JSON.parse(raw.trim()) as {
      feeds?: Array<{
        displayTitle?: string;
        interactInfo?: { likedCount?: string };
        createdAt?: string;
      }>;
    };
    const results = parsed.feeds ?? [];
    if (results.length === 0) {
      return { account, platform: 'xhs', latest_post: null, days_since_last_post: NO_POSTS_FOUND_DAYS, fetched_at: wallNow().toISOString() };
    }
    const latest = results[0];
    const postedAt = latest.createdAt ? new Date(latest.createdAt) : now();
    const daysSince = Math.floor((now().getTime() - postedAt.getTime()) / (1000 * 60 * 60 * 24));
    const likes = parseInt(latest.interactInfo?.likedCount ?? '0', 10) || 0;
    return {
      account,
      platform: 'xhs',
      latest_post: {
        time: postedAt.toISOString(),
        content_type: '图文',
        topic: latest.displayTitle ?? '未知',
        engagement: likes,
        summary: latest.displayTitle ?? '',
      },
      days_since_last_post: daysSince,
      fetched_at: wallNow().toISOString(),
    };
  } catch {
    return { account, platform: 'xhs', latest_post: null, days_since_last_post: FETCH_FAILED_DAYS, fetched_at: wallNow().toISOString() };
  }
}

function fetchDouyinAccount(secUid: string): CompetitorUpdate {
  try {
    // Read cookies from file (populated from browser session)
    const cookiesFile = process.env.DOUYIN_COOKIES_FILE ?? '';
    let cookieHeader = '';
    if (cookiesFile) {
      try {
        const fs = require('fs') as typeof import('fs');
        cookieHeader = fs.readFileSync(cookiesFile, 'utf8').trim();
      } catch (e) {
        console.warn(`[competitor-tracker] Cookie file not found or unreadable: ${cookiesFile}`, e);
      }
    } else {
      console.warn('[competitor-tracker] DOUYIN_COOKIES_FILE not set — Douyin API requests will likely fail');
    }

    const url = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${encodeURIComponent(secUid)}&count=1&max_cursor=0&aid=6383&device_platform=webapp&source=channel_pc_web`;
    const curlArgs = [
      '-s', '--max-time', '15',
      url,
      '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '-H', 'Accept: application/json',
      '-H', 'Referer: https://www.douyin.com/',
    ];
    if (cookieHeader) curlArgs.push('-H', `Cookie: ${cookieHeader}`);

    const raw = execFileSync('curl', curlArgs, { timeout: 20_000, encoding: 'utf8' });
    if (!raw.trim()) {
      console.warn(`[competitor-tracker] Douyin API returned empty response for ${secUid} (cookie ${cookieHeader ? 'present' : 'absent'})`);
      return { account: secUid, platform: 'douyin', latest_post: null, days_since_last_post: FETCH_FAILED_DAYS, fetched_at: wallNow().toISOString() };
    }

    // Check if response is HTML (captcha/redirect) instead of JSON
    if (raw.trim().startsWith('<') || raw.trim().startsWith('<!')) {
      console.warn(`[competitor-tracker] ⚠️ Douyin API returned HTML (captcha) for ${secUid} — Cookie is expired or invalid. Please update DOUYIN_COOKIES_FILE: ${cookiesFile || 'NOT SET'}`);
      return { account: secUid, platform: 'douyin', latest_post: null, days_since_last_post: FETCH_FAILED_DAYS, fetched_at: wallNow().toISOString() };
    }

    const d = JSON.parse(raw.trim()) as { status_code?: number; aweme_list?: Array<{ desc?: string; statistics?: { digg_count?: number }; create_time?: number }> };

    if (d.status_code && d.status_code !== 0) {
      console.warn(`[competitor-tracker] Douyin API returned status_code=${d.status_code} for ${secUid}`);
    }

    const list = d.aweme_list ?? [];
    if (!list.length) {
      console.warn(`[competitor-tracker] Douyin API returned empty aweme_list for ${secUid} (status_code=${d.status_code ?? 'N/A'})`);
      return { account: secUid, platform: 'douyin', latest_post: null, days_since_last_post: NO_POSTS_FOUND_DAYS, fetched_at: wallNow().toISOString() };
    }
    const v = list[0];
    const postedAt = v.create_time ? new Date(v.create_time * 1000) : now();
    const daysSince = Math.floor((now().getTime() - postedAt.getTime()) / (1000 * 60 * 60 * 24));
    return {
      account: secUid,
      platform: 'douyin',
      latest_post: {
        time: postedAt.toISOString(),
        content_type: '视频',
        topic: v.desc ?? '未知',
        engagement: v.statistics?.digg_count ?? 0,
        summary: v.desc ?? '',
      },
      days_since_last_post: daysSince,
      fetched_at: wallNow().toISOString(),
    };
  } catch (err) {
    console.error(`[competitor-tracker] fetchDouyinAccount failed for ${secUid}:`, err instanceof Error ? err.message : err);
    return { account: secUid, platform: 'douyin', latest_post: null, days_since_last_post: FETCH_FAILED_DAYS, fetched_at: wallNow().toISOString() };
  }
}

function fetchBilibiliAccount(mid: string, displayName: string): CompetitorUpdate {
  try {
    const script = `
const https = require('https');
const mid = ${JSON.stringify(mid)};
const url = 'https://api.bilibili.com/x/space/arc/search?mid=' + mid + '&ps=1&pn=1&order=pubdate';
const req = https.get(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0',
    'Referer': 'https://space.bilibili.com/' + mid,
    'Cookie': ''
  }
}, (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    try {
      const d = JSON.parse(data);
      const vlist = (d.data && d.data.list && d.data.list.vlist) || [];
      if (!vlist.length) { process.stdout.write('{}'); return; }
      const v = vlist[0];
      process.stdout.write(JSON.stringify({
        title: v.title || '',
        play: v.play || 0,
        created: v.created || 0
      }));
    } catch(e) { process.stdout.write('{}'); }
  });
});
req.on('error', () => process.stdout.write('{}'));
req.setTimeout(10000, () => { req.destroy(); process.stdout.write('{}'); });
`;
    const raw = execFileSync('node', ['-e', script], { timeout: 15_000, encoding: 'utf8' });
    const info = JSON.parse(raw.trim()) as { title?: string; play?: number; created?: number };
    if (!info.title) {
      return { account: displayName, platform: 'bilibili', latest_post: null, days_since_last_post: NO_POSTS_FOUND_DAYS, fetched_at: wallNow().toISOString() };
    }
    const postedAt = info.created ? new Date(info.created * 1000) : now();
    const daysSince = Math.floor((now().getTime() - postedAt.getTime()) / (1000 * 60 * 60 * 24));
    return {
      account: displayName,
      platform: 'bilibili',
      latest_post: {
        time: postedAt.toISOString(),
        content_type: '视频',
        topic: info.title,
        engagement: info.play ?? 0,
        summary: info.title,
      },
      days_since_last_post: daysSince,
      fetched_at: wallNow().toISOString(),
    };
  } catch {
    return { account: displayName, platform: 'bilibili', latest_post: null, days_since_last_post: FETCH_FAILED_DAYS, fetched_at: wallNow().toISOString() };
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function trackCompetitors(ops: OpsConfig): CompetitorUpdate[] {
  const accounts = resolveCompetitorAccounts(ops);
  const xhsUpdates = accounts.xhs.map(fetchXhsAccount);
  const douyinUpdates = accounts.douyin.map(fetchDouyinAccount);

  // Bilibili accounts from competitors[] with platform === 'bilibili'
  const bilibiliEntries = (ops.competitors ?? [])
    .filter(c => c.platform === 'bilibili')
    .map(c => ({
      mid: c.url?.match(/space\.bilibili\.com\/(\d+)/)?.[1] ?? '',
      name: c.name,
    }))
    .filter(e => e.mid !== '');
  const bilibiliUpdates = bilibiliEntries.map(e => fetchBilibiliAccount(e.mid, e.name));

  const all = [...xhsUpdates, ...douyinUpdates, ...bilibiliUpdates];

  // Persist
  const existing = readJSON<CompetitorLog>(PATHS.competitorLog, { entries: [], last_updated: '' });
  const today = getLocalDate(now());
  // Use getLocalDate on fetched_at to ensure consistent timezone comparison
  const withoutToday = existing.entries.filter(e => {
    const entryDate = getLocalDate(new Date(e.fetched_at));
    return entryDate !== today;
  });
  const log: CompetitorLog = {
    entries: [...withoutToday, ...all].slice(-MAX_COMPETITOR_LOG_ENTRIES), // keep last 200 entries
    last_updated: wallNow().toISOString(),
  };
  writeJSON(PATHS.competitorLog, log);
  return all;
}
