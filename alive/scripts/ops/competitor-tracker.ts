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
import { now, getLocalDate } from '../utils/time-utils';
import { CompetitorUpdate, CompetitorLog, OpsConfig, CompetitorProfile } from '../utils/types';

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

/**
 * Build a rich competitor context string for LLM prompts.
 * Includes profile metadata (tag, audience, content mix, interaction style)
 * alongside live tracking data (latest posts).
 */
export function buildCompetitorContext(
  profiles: readonly CompetitorProfile[],
  updates: CompetitorUpdate[],
): string {
  if (profiles.length === 0) return '';

  // Group profiles by group tag
  const groups = new Map<string, CompetitorProfile[]>();
  for (const p of profiles) {
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
  const primaryTakeaways = profiles
    .filter(p => p.reference_type === 'primary' && p.takeaways && p.takeaways.length > 0)
    .flatMap(p => (p.takeaways ?? []).map(t => `- ${p.name}：${t}`));

  const avoidPoints = profiles
    .filter(p => p.avoid && p.avoid.length > 0)
    .flatMap(p => (p.avoid ?? []).map(a => `- 避免（${p.name}）：${a}`));

  let result = sections.join('\n\n');
  if (primaryTakeaways.length > 0) {
    result += `\n\n【借鉴要点】\n${primaryTakeaways.join('\n')}`;
  }
  if (avoidPoints.length > 0) {
    result += `\n\n【避坑提醒】\n${avoidPoints.join('\n')}`;
  }

  return result;
}

/**
 * Get all competitor account names by platform from both
 * legacy competitor_accounts and new competitors[] profiles.
 */
export function resolveCompetitorAccounts(ops: OpsConfig): { xhs: string[]; douyin: string[] } {
  const xhs = new Set(ops.competitor_accounts.xhs);
  const douyin = new Set(ops.competitor_accounts.douyin);

  if (ops.competitors) {
    for (const c of ops.competitors) {
      if (c.platform === 'xhs') xhs.add(c.name);
      if (c.platform === 'douyin') douyin.add(c.name);
    }
  }

  return { xhs: [...xhs], douyin: [...douyin] };
}

// ─── ClawHub skill calls ──────────────────────────────────────────────────────

function fetchXhsAccount(account: string): CompetitorUpdate {
  try {
    const raw = execFileSync('openclaw', [
      'skill', 'run', 'xhs-bridge',
      '--args', JSON.stringify({ action: 'search', keyword: account, limit: 3 }),
    ], { timeout: 30_000, encoding: 'utf8' });
    const results = JSON.parse(raw) as Array<{
      title?: string; likes?: number; timestamp?: string;
    }>;
    if (results.length === 0) {
      return { account, platform: 'xhs', latest_post: null, days_since_last_post: NO_POSTS_FOUND_DAYS, fetched_at: now().toISOString() };
    }
    const latest = results[0];
    const postedAt = latest.timestamp ? new Date(latest.timestamp) : now();
    const daysSince = Math.floor((now().getTime() - postedAt.getTime()) / (1000 * 60 * 60 * 24));
    return {
      account,
      platform: 'xhs',
      latest_post: {
        time: postedAt.toISOString(),
        content_type: '图文',
        topic: latest.title ?? '未知',
        engagement: latest.likes ?? 0,
        summary: latest.title ?? '',
      },
      days_since_last_post: daysSince,
      fetched_at: now().toISOString(),
    };
  } catch {
    return { account, platform: 'xhs', latest_post: null, days_since_last_post: FETCH_FAILED_DAYS, fetched_at: now().toISOString() };
  }
}

function fetchDouyinAccount(accountId: string): CompetitorUpdate {
  try {
    // Use yt-dlp to get latest video info
    const raw = execFileSync('openclaw', [
      'skill', 'run', 'yt-dlp-downloader',
      '--args', JSON.stringify({
        url: `https://www.douyin.com/user/${accountId}`,
        action: 'info',
        limit: 1,
      }),
    ], { timeout: 45_000, encoding: 'utf8' });
    const info = JSON.parse(raw) as { title?: string; like_count?: number; upload_date?: string };
    const postedAt = info.upload_date
      ? new Date(`${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}`)
      : now();
    const daysSince = Math.floor((now().getTime() - postedAt.getTime()) / (1000 * 60 * 60 * 24));

    const summary = info.title ?? '';

    return {
      account: accountId,
      platform: 'douyin',
      latest_post: {
        time: postedAt.toISOString(),
        content_type: '视频',
        topic: info.title ?? '未知',
        engagement: info.like_count ?? 0,
        summary,
      },
      days_since_last_post: daysSince,
      fetched_at: now().toISOString(),
    };
  } catch {
    return { account: accountId, platform: 'douyin', latest_post: null, days_since_last_post: FETCH_FAILED_DAYS, fetched_at: now().toISOString() };
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function trackCompetitors(ops: OpsConfig): CompetitorUpdate[] {
  const accounts = resolveCompetitorAccounts(ops);
  const xhsUpdates = accounts.xhs.map(fetchXhsAccount);
  const douyinUpdates = accounts.douyin.map(fetchDouyinAccount);
  const all = [...xhsUpdates, ...douyinUpdates];

  // Persist
  const existing = readJSON<CompetitorLog>(PATHS.competitorLog, { entries: [], last_updated: '' });
  const today = getLocalDate(now());
  const withoutToday = existing.entries.filter(e => !e.fetched_at.startsWith(today));
  const log: CompetitorLog = {
    entries: [...withoutToday, ...all].slice(-MAX_COMPETITOR_LOG_ENTRIES), // keep last 200 entries
    last_updated: now().toISOString(),
  };
  writeJSON(PATHS.competitorLog, log);
  return all;
}
