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

export const NO_POSTS_FOUND_DAYS = 99;
export const FETCH_FAILED_DAYS = -1;
/** Sentinal value: postedAt unknown (XHS feeds lack createdAt) — must not be treated as "0 days" */
export const UNKNOWN_POST_AGE_DAYS = -2;
const MAX_COMPETITOR_LOG_ENTRIES = 200;
/** 每个竞品账号抓取的最近帖子数量 */
const RECENT_POSTS_COUNT = 10;

// ─── Pure functions (exported for testing) ───────────────────────────────────

export function buildCompetitorSummary(updates: CompetitorUpdate[]): string {
  if (updates.length === 0) return '无竞品数据';
  return updates.map(u => {
    if (!u.latest_post) return `@${u.account}  ${u.days_since_last_post === FETCH_FAILED_DAYS ? '拉取失败' : `${u.days_since_last_post}天未更新`}`;
    const { topic, engagement } = u.latest_post;
    if (u.days_since_last_post === UNKNOWN_POST_AGE_DAYS) {
      return `@${u.account}  发布「${topic}」互动${engagement}（发布时间未知）`;
    }
    // 展示最近帖子（最多 3 条概要）
    const recentLines = u.recent_posts.length > 1
      ? u.recent_posts.slice(1, 4).map(p => `  ·「${p.topic.length > 15 ? p.topic.slice(0, 15) + '…' : p.topic}」互动${p.engagement}`).join('\n')
      : '';
    return `@${u.account}  今日发布「${topic}」互动${engagement}${recentLines ? '\n' + recentLines : ''}`;
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

  // Limit number of profiles — prefer primary, then by freshness
  if (options?.maxProfiles && filteredProfiles.length > options.maxProfiles) {
    // Sort: primary first, then by estimated_start_date (newer = first, unknown = last within same tier)
    filteredProfiles.sort((a, b) => {
      // Primary vs secondary
      if (a.reference_type === 'primary' && b.reference_type !== 'primary') return -1;
      if (a.reference_type !== 'primary' && b.reference_type === 'primary') return 1;
      // Within same tier: newer start date first (unknown dates go last)
      const aDate = a.estimated_start_date ? new Date(a.estimated_start_date).getTime() : 0;
      const bDate = b.estimated_start_date ? new Date(b.estimated_start_date).getTime() : 0;
      // If both have dates, sort descending (newer first)
      if (aDate && bDate) return bDate - aDate;
      // If only one has a date, it comes first
      if (aDate && !bDate) return -1;
      if (!aDate && bDate) return 1;
      return 0;
    });
    filteredProfiles = filteredProfiles.slice(0, options.maxProfiles);
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
      const recentStr = liveData?.recent_posts?.length
        ? liveData.recent_posts.slice(0, 3).map((post, i) =>
            i === 0
              ? `最新：「${post.topic}」互动${post.engagement}`
              : `·「${post.topic.length > 15 ? post.topic.slice(0, 15) + '…' : post.topic}」互动${post.engagement}`
          ).join('\n    ')
        : liveData?.latest_post
          ? `最新：「${liveData.latest_post.topic}」互动${liveData.latest_post.engagement}`
          : '暂无实时数据';
      const startStr = p.estimated_start_date
        ? `起号：${p.estimated_start_date.slice(0, 10)}`
        : '';
      return `  @${p.name}（${p.platform}）${p.followers ? `粉丝${p.followers}` : ''}${startStr ? ` | ${startStr}` : ''}
    人设：${p.tag_desc}
    内容比例：${mixStr}
    受众：${p.audience ?? '未知'}
    互动风格：${p.interaction_style ?? '未知'}
    ${recentStr}`;
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
export function resolveCompetitorAccounts(ops: OpsConfig): {
  xhs: string[];
  xhsUserIds: Map<string, string>;   // user_id → display_name (precise fetch via user-profile)
  douyin: string[];
} {
  const xhs = new Set(ops.competitor_accounts.xhs);
  const douyin = new Set(ops.competitor_accounts.douyin);
  const xhsUserIds = new Map<string, string>();

  if (ops.competitors) {
    for (const c of ops.competitors) {
      if (c.platform === 'xhs') {
        // Priority: external_id → xhs_user_id from url → fallback to search by name
        const xhsUserIdFromUrl = c.url?.match(
          /xiaohongshu\.com\/user\/profile\/([a-f0-9]{24})/
        )?.[1];
        if (c.external_id || xhsUserIdFromUrl) {
          const userId = c.external_id ?? xhsUserIdFromUrl ?? '';
          xhsUserIds.set(userId, c.name);
        } else {
          xhs.add(c.name);  // no url — search by name
        }
      }
      if (c.platform === 'douyin') {
        // Priority: external_id → sec_uid in url → name
        const secUidFromUrl = c.url?.match(/douyin\.com\/user\/([A-Za-z0-9_=-]+)/)?.[1];
        douyin.add(c.external_id ?? secUidFromUrl ?? c.name);
      }
    }
  }

  return { xhs: [...xhs], douyin: [...douyin], xhsUserIds };
}

import * as os from 'os';
import * as path from 'path';

function resolveXhsSkillsDir(): string {
  return process.env.XHS_SKILLS_DIR
    ?? path.join(os.homedir(), '.openclaw', 'skills', 'xiaohongshu-skills');
}

import { listDouyinUserPosts } from '../../sub-skills/platform/douyin-bridge/scripts/douyin-client';

// ─── ClawHub skill calls ──────────────────────────────────────────────────────

function fetchXhsAccount(account: string): CompetitorUpdate {
  try {
    const xhsDir = resolveXhsSkillsDir();
    const xhsCli = path.join(xhsDir, 'scripts', 'cli.py');
    const raw = execFileSync('uv', [
      'run', '--directory', xhsDir, 'python', xhsCli,
      'search-feeds', '--keyword', account,
      '--sort-by', '最新',  // sort by newest to get the actual latest post
    ], { timeout: 15_000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    // Output is JSON with a "feeds" array
    // NOTE: XHS SDK Feed.to_dict() does NOT include createdAt — we must handle its absence
    const parsed = JSON.parse(raw.trim()) as {
      feeds?: Array<{
        displayTitle?: string;
        interactInfo?: { likedCount?: string };
        createdAt?: string;
        id?: string;
        user?: { userId?: string; nickname?: string };
      }>;
    };
    const results = parsed.feeds ?? [];
    if (results.length === 0) {
      return { account, platform: 'xhs', latest_post: null, recent_posts: [], days_since_last_post: NO_POSTS_FOUND_DAYS, fetched_at: wallNow().toISOString() };
    }
    const recentPosts = results.slice(0, RECENT_POSTS_COUNT).map(f => {
      const postedAt = f.createdAt ? new Date(f.createdAt) : null;
      const likes = parseInt(f.interactInfo?.likedCount ?? '0', 10) || 0;
      return {
        time: postedAt?.toISOString() ?? wallNow().toISOString(),
        content_type: '图文' as const,
        topic: f.displayTitle ?? '未知',
        engagement: likes,
        summary: f.displayTitle ?? '',
      };
    });
    const latest = recentPosts[0];
    const postedAt = latest.time ? new Date(latest.time) : null;
    const daysSince = postedAt
      ? Math.floor((now().getTime() - postedAt.getTime()) / (1000 * 60 * 60 * 24))
      : UNKNOWN_POST_AGE_DAYS;
    return {
      account,
      platform: 'xhs',
      latest_post: latest,
      recent_posts: recentPosts,
      days_since_last_post: daysSince,
      fetched_at: wallNow().toISOString(),
    };
  } catch {
    return { account, platform: 'xhs', latest_post: null, recent_posts: [], days_since_last_post: FETCH_FAILED_DAYS, fetched_at: wallNow().toISOString() };
  }
}

function fetchXhsAccountByUserId(userId: string, displayName: string): CompetitorUpdate {
  try {
    const xhsDir = resolveXhsSkillsDir();
    const xhsCli = path.join(xhsDir, 'scripts', 'cli.py');
    const raw = execFileSync('uv', [
      'run', '--directory', xhsDir, 'python', xhsCli,
      'user-profile', '--user-id', userId, '--xsec-token', '',
    ], { timeout: 15_000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

    const parsed = JSON.parse(raw.trim()) as {
      basicInfo?: { nickname?: string; redId?: string; desc?: string };
      interactions?: Array<{ type?: string; name?: string; count?: number }>;
      feeds?: Array<{
        displayTitle?: string;
        interactInfo?: { likedCount?: string };
        createdAt?: string;
        id?: string;
        user?: { userId?: string; nickname?: string };
      }>;
    };

    const results = parsed.feeds ?? [];
    if (results.length === 0) {
      return {
        account: displayName, platform: 'xhs', latest_post: null, recent_posts: [],
        days_since_last_post: NO_POSTS_FOUND_DAYS,
        fetched_at: wallNow().toISOString(),
      };
    }

    const recentPosts = results.slice(0, RECENT_POSTS_COUNT).map(f => {
      const postedAt = f.createdAt ? new Date(f.createdAt) : null;
      const likes = parseInt(f.interactInfo?.likedCount ?? '0', 10) || 0;
      return {
        time: postedAt?.toISOString() ?? wallNow().toISOString(),
        content_type: '图文' as const,
        topic: f.displayTitle ?? '未知',
        engagement: likes,
        summary: f.displayTitle ?? '',
      };
    });
    const latest = recentPosts[0];
    const postedAt = latest.time ? new Date(latest.time) : null;
    const daysSince = postedAt
      ? Math.floor((now().getTime() - postedAt.getTime()) / (1000 * 60 * 60 * 24))
      : UNKNOWN_POST_AGE_DAYS;

    return {
      account: displayName,
      platform: 'xhs',
      latest_post: latest,
      recent_posts: recentPosts,
      days_since_last_post: daysSince,
      fetched_at: wallNow().toISOString(),
    };
  } catch {
    // Precise fetch failed — return failure marker instead of falling back
    // to search-by-name (which would double the timeout)
    return { account: displayName, platform: 'xhs', latest_post: null, recent_posts: [], days_since_last_post: FETCH_FAILED_DAYS, fetched_at: wallNow().toISOString() };
  }
}

function fetchDouyinAccount(secUid: string): CompetitorUpdate {
  try {
    // 请求 10+ 条，跳过置顶帖后保留 RECENT_POSTS_COUNT 条
    const result = listDouyinUserPosts(secUid, RECENT_POSTS_COUNT + 3);
    if (!result.success || !result.videos?.length) {
      return {
        account: secUid,
        platform: 'douyin',
        latest_post: null,
        recent_posts: [],
        days_since_last_post: NO_POSTS_FOUND_DAYS,
        fetched_at: wallNow().toISOString(),
      };
    }
    // 跳过置顶帖
    const nonPinned = result.videos.filter(v => !v.is_top);
    const toProcess = nonPinned.length > 0 ? nonPinned : result.videos;
    const recentPosts = toProcess.slice(0, RECENT_POSTS_COUNT).map(v => {
      const postedAt = v.create_time ? new Date(v.create_time * 1000) : now();
      return {
        time: postedAt.toISOString(),
        content_type: '视频' as const,
        topic: v.desc || '未知',
        engagement: v.digg_count,
        summary: v.desc || '',
      };
    });
    const latest = recentPosts[0];
    const postedAt = latest.time ? new Date(latest.time) : now();
    const daysSince = Math.floor((now().getTime() - postedAt.getTime()) / (1000 * 60 * 60 * 24));
    return {
      account: secUid,
      platform: 'douyin',
      latest_post: latest,
      recent_posts: recentPosts,
      days_since_last_post: daysSince,
      fetched_at: wallNow().toISOString(),
    };
  } catch (err) {
    console.error(`[competitor-tracker] fetchDouyinAccount failed for ${secUid}:`, err instanceof Error ? err.message : err);
    return {
      account: secUid,
      platform: 'douyin',
      latest_post: null,
      recent_posts: [],
      days_since_last_post: FETCH_FAILED_DAYS,
      fetched_at: wallNow().toISOString(),
    };
  }
}

function fetchBilibiliAccount(mid: string, displayName: string): CompetitorUpdate {
  try {
    const cookie = process.env.BILIBILI_COOKIE ?? '';
    // WBI signing with cookie: nav → img_key/sub_key → mixin key → signed request
    const script = `
const https = require('https');
const crypto = require('crypto');
const mid = ${JSON.stringify(mid)};
const COOKIE = ${JSON.stringify(cookie)};
const MAX = ${RECENT_POSTS_COUNT};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// WBI mixin key shuffle table (fixed by Bilibili)
const MIXIN_KEY_ENC_TAB = [
  46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,
  27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,
  37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,
  22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52,
];

function getMixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map(i => raw[i]).join('').slice(0, 32);
}

function get(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': UA,
      'Referer': 'https://space.bilibili.com/' + mid + '/video',
      'Origin': 'https://space.bilibili.com',
      ...(COOKIE ? { 'Cookie': COOKIE } : {}),
      ...(extraHeaders || {}),
    };
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  try {
    // Step 1: get WBI keys (nav also validates cookie)
    const nav = await get('https://api.bilibili.com/x/web-interface/nav');
    const imgKey = nav?.data?.wbi_img?.img_url?.match(/([a-f0-9]+)\\.png/)?.[1] ?? '';
    const subKey = nav?.data?.wbi_img?.sub_url?.match(/([a-f0-9]+)\\.png/)?.[1] ?? '';
    if (!imgKey || !subKey) { process.stdout.write('[]'); return; }

    const mixinKey = getMixinKey(imgKey, subKey);

    // Step 2: sign params
    const wts = Math.floor(Date.now() / 1000);
    const params = { mid, ps: MAX, pn: 1, order: 'pubdate', wts };
    const query = Object.keys(params).sort()
      .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k]).replace(/[!'()*]/g, '')))
      .join('&');
    const w_rid = crypto.createHash('md5').update(query + mixinKey).digest('hex');

    // Step 3: fetch video list
    const apiUrl = 'https://api.bilibili.com/x/space/wbi/arc/search?' + query + '&w_rid=' + w_rid;
    const d = await get(apiUrl);
    const vlist = d?.data?.list?.vlist ?? [];
    if (!vlist.length) { process.stdout.write('[]'); return; }
    process.stdout.write(JSON.stringify(vlist.slice(0, MAX).map(v => ({
      title: v.title || '',
      play: v.play || 0,
      created: v.created || 0,
    }))));
  } catch(e) {
    process.stdout.write('[]');
  }
}
main();
`;
    const raw = execFileSync(process.execPath, ['-e', script], { timeout: 20_000, encoding: 'utf8' });
    const videos = JSON.parse(raw.trim()) as Array<{ title?: string; play?: number; created?: number }>;
    if (!videos.length || !videos[0].title) {
      return { account: displayName, platform: 'bilibili', latest_post: null, recent_posts: [], days_since_last_post: NO_POSTS_FOUND_DAYS, fetched_at: wallNow().toISOString() };
    }
    const recentPosts = videos.map(v => {
      const postedAt = v.created ? new Date(v.created * 1000) : now();
      return {
        time: postedAt.toISOString(),
        content_type: '视频' as const,
        topic: v.title ?? '未知',
        engagement: v.play ?? 0,
        summary: v.title ?? '',
      };
    });
    const latest = recentPosts[0];
    const postedAt = latest.time ? new Date(latest.time) : now();
    const daysSince = Math.floor((now().getTime() - postedAt.getTime()) / (1000 * 60 * 60 * 24));
    return {
      account: displayName,
      platform: 'bilibili',
      latest_post: latest,
      recent_posts: recentPosts,
      days_since_last_post: daysSince,
      fetched_at: wallNow().toISOString(),
    };
  } catch {
    return { account: displayName, platform: 'bilibili', latest_post: null, recent_posts: [], days_since_last_post: FETCH_FAILED_DAYS, fetched_at: wallNow().toISOString() };
  }
}

// ─── TTL-based file cache ──────────────────────────────────────────────────
// Replaces the old in-process daily cache which was useless under cron
// (each cron invocation is a new process, so _cachedDay was always null).
// Now reads competitor-log.json's last_updated for TTL check — works cross-process.

const COMPETITOR_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

/** In-process cache (still useful for same-process repeated calls, e.g. cron + /brief) */
let _cachedDay: string | null = null;
let _cachedUpdates: CompetitorUpdate[] | null = null;

// ─── Main export ─────────────────────────────────────────────────────────────

export function trackCompetitors(ops: OpsConfig): CompetitorUpdate[] {
  const today = getLocalDate(now());

  // 1) In-process cache hit (same day, same process)
  if (_cachedDay === today && _cachedUpdates !== null) {
    console.error(`[competitor-tracker] Using in-process cached data for ${today}`);
    return _cachedUpdates;
  }

  // 2) File-level TTL cache hit (cross-process, e.g. cron spawns new process)
  const existing = readJSON<CompetitorLog>(PATHS.competitorLog, { entries: [], last_updated: '' });
  if (existing.last_updated && existing.entries.length > 0) {
    const age = now().getTime() - new Date(existing.last_updated).getTime();
    if (age < COMPETITOR_CACHE_TTL_MS) {
      const freshEntries = existing.entries.filter(e => {
        const entryDate = getLocalDate(new Date(e.fetched_at));
        return entryDate === today;
      });
      if (freshEntries.length > 0) {
        console.error(`[competitor-tracker] Using file-level cached data (age: ${Math.round(age / 60_000)}min, ${freshEntries.length} entries for today)`);
        _cachedDay = today;
        _cachedUpdates = freshEntries;
        return freshEntries;
      }
    }
  }

  const accounts = resolveCompetitorAccounts(ops);

  // XHS accounts with url — precise fetch by user_id
  const xhsByIdUpdates = [...accounts.xhsUserIds.entries()].map(
    ([userId, displayName]) => fetchXhsAccountByUserId(userId, displayName)
  );

  // XHS accounts without url — search by name
  const xhsSearchUpdates = accounts.xhs.map(fetchXhsAccount);

  const xhsUpdates = [...xhsByIdUpdates, ...xhsSearchUpdates];

  // Build sec_uid → display name map for Douyin accounts
  const douyinDisplayNames = new Map<string, string>();
  if (ops.competitors) {
    for (const c of ops.competitors) {
      if (c.platform === 'douyin') {
        const secUidFromUrl = c.url?.match(/douyin\.com\/user\/([A-Za-z0-9_=-]+)/)?.[1];
        const secUid = c.external_id ?? secUidFromUrl ?? c.name;
        douyinDisplayNames.set(secUid, c.name);
      }
    }
  }

  const douyinUpdates = accounts.douyin.map(secUid => {
    const update = fetchDouyinAccount(secUid);
    // Replace sec_uid with human-readable display name
    const displayName = douyinDisplayNames.get(secUid);
    if (displayName && update.account !== displayName) {
      return { ...update, account: displayName };
    }
    return update;
  });

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

  // Persist (handle legacy format: { competitors, lastUpdate })
  const rawExisting = readJSON<Record<string, unknown>>(PATHS.competitorLog, {});
  const existingEntries: CompetitorUpdate[] =
    (rawExisting as any).entries ?? (rawExisting as any).competitors ?? [];
  // Use getLocalDate on fetched_at to ensure consistent timezone comparison
  const withoutToday = existingEntries.filter(e => {
    const entryDate = getLocalDate(new Date(e.fetched_at));
    return entryDate !== today;
  });

  // Dedup today's entries: for the same account+platform, only keep the latest fetch
  // (replaces older entries instead of appending duplicates)
  const todayExisting = existingEntries.filter(e => {
    const entryDate = getLocalDate(new Date(e.fetched_at));
    return entryDate === today;
  });
  const merged = new Map<string, CompetitorUpdate>();
  // First, populate with today's existing entries
  for (const e of todayExisting) {
    merged.set(`${e.account}|${e.platform}`, e);
  }
  // Then, overwrite with fresh data (keeps the most recent fetch)
  for (const e of all) {
    merged.set(`${e.account}|${e.platform}`, e);
  }
  const todayEntries = [...merged.values()];

  const log: CompetitorLog = {
    entries: [...withoutToday, ...todayEntries].slice(-MAX_COMPETITOR_LOG_ENTRIES), // keep last 200 entries
    last_updated: wallNow().toISOString(),
  };
  writeJSON(PATHS.competitorLog, log);

  // Update in-process cache
  _cachedDay = today;
  _cachedUpdates = all;

  return all;
}
