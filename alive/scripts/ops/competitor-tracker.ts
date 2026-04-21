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
import { CompetitorUpdate, CompetitorLog, OpsConfig, CompetitorProfile, IdentityMode, CompetitorPostsStore, CompetitorPost } from '../utils/types';
import { matchesTaxonomy } from './ops-taxonomy';
import { RoundAbortController, resolveThrottleConfig, sleepWithJitter } from './throttle';

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
      if (result.rate_limited) {
        console.warn(`[competitor-tracker] Douyin 风控限流 for ${secUid}: ${result.reason ?? 'cooldown'}`);
      }
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

// ─── Derive updates from posts store (avoids duplicate API calls) ──────────

/**
 * Derive CompetitorUpdate[] from a CompetitorPostsStore without calling any API.
 * Transforms post data into the lightweight format used by competitor-log.json.
 * Returns an empty array if the store has no accounts.
 */
export function deriveUpdatesFromPosts(
  store: CompetitorPostsStore,
  ops: OpsConfig,
): CompetitorUpdate[] {
  const updates: CompetitorUpdate[] = [];

  for (const [accountKey, posts] of Object.entries(store.accounts)) {
    if (posts.length === 0) continue;

    // Parse account key: "name:platform"
    const colonIdx = accountKey.lastIndexOf(':');
    const accountName = colonIdx >= 0 ? accountKey.slice(0, colonIdx) : accountKey;
    const platform = colonIdx >= 0 ? accountKey.slice(colonIdx + 1) : 'xhs';

    // Resolve display name from ops config (tracker uses display names, not IDs)
    const profile = ops.competitors?.find(
      c => c.name === accountName && c.platform === platform,
    );
    const displayName = profile?.name ?? accountName;

    const recentPosts = posts.slice(0, RECENT_POSTS_COUNT).map(p => postToRecentPost(p));
    const latest = recentPosts[0];

    if (!latest) continue;

    const postedAt = latest.time ? new Date(latest.time) : null;
    const daysSince = postedAt
      ? Math.floor((now().getTime() - postedAt.getTime()) / (1000 * 60 * 60 * 24))
      : UNKNOWN_POST_AGE_DAYS;

    updates.push({
      account: displayName,
      platform: platform as CompetitorUpdate['platform'],
      latest_post: latest,
      recent_posts: recentPosts,
      days_since_last_post: daysSince,
      fetched_at: store.last_fetched || wallNow().toISOString(),
    });
  }

  return updates;
}

function postToRecentPost(post: CompetitorPost): NonNullable<CompetitorUpdate['latest_post']> {
  return {
    time: post.posted_at ?? post.fetched_at,
    content_type: post.platform === 'douyin' ? '视频' : '图文',
    topic: post.title,
    engagement: post.engagement,
    summary: post.title,
  };
}

// ─── Competitor cache TTL (for cron-side staleness checks) ─────────────────
//
// In the async-decoupled architecture, consumers read the cache unconditionally
// (see readCachedCompetitors below) and the producer cron decides when a
// refresh is warranted via isCompetitorCacheStale().

export const COMPETITOR_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function getOldestFetchedAtMs(updates: CompetitorUpdate[]): number | null {
  const timestamps = updates
    .map(update => Date.parse(update.fetched_at))
    .filter(ts => Number.isFinite(ts));

  return timestamps.length > 0 ? Math.min(...timestamps) : null;
}

export function resetCompetitorTrackerCache(): void {
  // No in-process caching anymore — readCachedCompetitors/refreshCompetitors
  // rely exclusively on competitor-log.json. The function is retained so
  // existing test helpers remain callable as a no-op.
}

// ─── Main exports ──────────────────────────────────────────────────────────

/**
 * Persist competitor updates to competitor-log.json.
 * Handles legacy format dedup and today-entry merging.
 */
function persistLog(updates: CompetitorUpdate[], today: string): void {
  const rawExisting = readJSON<Record<string, unknown>>(PATHS.competitorLog, {});
  const existingEntries: CompetitorUpdate[] =
    (rawExisting as any).entries ?? (rawExisting as any).competitors ?? [];
  const withoutToday = existingEntries.filter(e => {
    const entryDate = getLocalDate(new Date(e.fetched_at));
    return entryDate !== today;
  });

  const todayExisting = existingEntries.filter(e => {
    const entryDate = getLocalDate(new Date(e.fetched_at));
    return entryDate === today;
  });
  const merged = new Map<string, CompetitorUpdate>();
  for (const e of todayExisting) {
    merged.set(`${e.account}|${e.platform}`, e);
  }
  for (const e of updates) {
    merged.set(`${e.account}|${e.platform}`, e);
  }
  const todayEntries = [...merged.values()];

  const sourceAtMs = getOldestFetchedAtMs(todayEntries) ?? wallNow().getTime();
  const log: CompetitorLog = {
    entries: [...withoutToday, ...todayEntries].slice(-MAX_COMPETITOR_LOG_ENTRIES),
    last_updated: new Date(sourceAtMs).toISOString(),
  };
  writeJSON(PATHS.competitorLog, log);
}

// ─── Async-decoupled consumer API (pure read) ──────────────────────────────

export interface CachedCompetitorsRead {
  updates: CompetitorUpdate[];
  computed_at: string | null;
}

/**
 * Read today's competitor updates from competitor-log.json.
 *
 * Synchronous, zero platform IO. Returns an empty list when the log is
 * missing or when no entry exists for the current local date — callers
 * (e.g. /brief) surface a "cache not ready" banner via
 * readCachedCompetitorsWithMeta().
 *
 * This is the sole consumer entry point. Refreshing is the job of the
 * ops-trends cron via refreshCompetitors().
 */
export function readCachedCompetitors(): CompetitorUpdate[] {
  return readCachedCompetitorsWithMeta().updates;
}

export function readCachedCompetitorsWithMeta(): CachedCompetitorsRead {
  const log = readJSON<CompetitorLog>(PATHS.competitorLog, { entries: [], last_updated: '' });
  const today = getLocalDate(now());
  const todayEntries = log.entries.filter(
    e => getLocalDate(new Date(e.fetched_at)) === today,
  );

  if (todayEntries.length === 0) {
    return { updates: [], computed_at: null };
  }

  const oldestMs = getOldestFetchedAtMs(todayEntries);
  const computedAt = oldestMs !== null
    ? new Date(oldestMs).toISOString()
    : log.last_updated || null;

  return { updates: todayEntries, computed_at: computedAt };
}

/**
 * Returns true when the competitor-log.json cache is older than
 * COMPETITOR_CACHE_TTL_MS or has no entry for today. Used by the
 * ops-trends cron to decide whether a refresh is needed.
 */
export function isCompetitorCacheStale(): boolean {
  const meta = readCachedCompetitorsWithMeta();
  if (!meta.computed_at) return true;
  const age = now().getTime() - new Date(meta.computed_at).getTime();
  return age >= COMPETITOR_CACHE_TTL_MS;
}

/**
 * Refresh competitor tracking by calling every platform (XHS / Douyin /
 * Bilibili) and persisting the result to competitor-log.json.
 *
 * The sole producer path — only the ops-trends cron should call this.
 * Consumers must use readCachedCompetitors() and never trigger platform IO.
 *
 * Two architectural notes:
 *
 * 1. The previous "three-layer fallback" (in-process cache → file cache →
 *    posts-store derivation → full fetch) existed to minimise latency when
 *    a user was waiting on /brief. Under async decoupling nobody waits,
 *    so the refresh is always a full fetch — simpler, more predictable,
 *    and less likely to leak inconsistent partial data.
 *
 * 2. Accounts are fetched one-at-a-time with a random jitter between
 *    each call (see `ops.throttle.account_gap_ms`). The rationale is the
 *    same as for trend refresh: platform anti-abuse systems flag bursts
 *    of requests far more readily than a calm, human-like cadence, and
 *    no consumer is blocked on this round.
 *
 * Returns whatever was successfully fetched before the round was aborted
 * or all accounts were visited. The cache is written with whatever was
 * collected — partial rounds are acceptable.
 */
export async function refreshCompetitors(ops: OpsConfig): Promise<CompetitorUpdate[]> {
  const throttle = resolveThrottleConfig(ops);
  const round = new RoundAbortController(throttle, 'competitors');
  const today = getLocalDate(now());
  const accounts = resolveCompetitorAccounts(ops);

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

  const bilibiliEntries = (ops.competitors ?? [])
    .filter(c => c.platform === 'bilibili')
    .map(c => ({
      mid: c.url?.match(/space\.bilibili\.com\/(\d+)/)?.[1] ?? '',
      name: c.name,
    }))
    .filter(e => e.mid !== '');

  // Flatten all accounts into a single ordered work list so the
  // account-gap jitter spans the entire round, not per-platform loops.
  // XHS-by-id first (most precise), then XHS-by-search, then Douyin,
  // then Bilibili — platform transitions are naturally spread out.
  type Work =
    | { kind: 'xhs-id'; userId: string; displayName: string }
    | { kind: 'xhs-search'; account: string }
    | { kind: 'douyin'; secUid: string }
    | { kind: 'bilibili'; mid: string; name: string };

  const workList: Work[] = [
    ...[...accounts.xhsUserIds.entries()].map(
      ([userId, displayName]) => ({ kind: 'xhs-id', userId, displayName } as Work),
    ),
    ...accounts.xhs.map(account => ({ kind: 'xhs-search', account } as Work)),
    ...accounts.douyin.map(secUid => ({ kind: 'douyin', secUid } as Work)),
    ...bilibiliEntries.map(e => ({ kind: 'bilibili', mid: e.mid, name: e.name } as Work)),
  ];

  const all: CompetitorUpdate[] = [];

  for (let i = 0; i < workList.length; i++) {
    if (round.shouldAbort()) {
      console.warn(`[competitor-tracker] ${workList.length - i} account(s) skipped — ${round.getReason()}`);
      break;
    }
    if (i > 0) {
      await sleepWithJitter(throttle.account_gap_ms, round, `competitor #${i}`);
      if (round.shouldAbort()) break;
    }

    const job = workList[i];
    try {
      if (job.kind === 'xhs-id') {
        all.push(fetchXhsAccountByUserId(job.userId, job.displayName));
      } else if (job.kind === 'xhs-search') {
        all.push(fetchXhsAccount(job.account));
      } else if (job.kind === 'douyin') {
        const update = fetchDouyinAccount(job.secUid);
        const displayName = douyinDisplayNames.get(job.secUid);
        all.push(
          displayName && update.account !== displayName
            ? { ...update, account: displayName }
            : update,
        );
      } else if (job.kind === 'bilibili') {
        all.push(fetchBilibiliAccount(job.mid, job.name));
      }
    } catch (err) {
      console.error(`[competitor-tracker] ${job.kind} fetch threw:`, (err as Error).message);
    }
  }

  persistLog(all, today);

  if (process.env.ALIVE_DEBUG === '1' || process.env.ALIVE_DEBUG === 'true') {
    console.error(`[competitor-tracker] round elapsed ${Math.round(round.getElapsedMs() / 1000)}s, ${all.length}/${workList.length} accounts fetched`);
  }

  return all;
}

/**
 * @deprecated Use readCachedCompetitors() in consumers or refreshCompetitors()
 * in the ops-trends cron. This wrapper now always behaves as a pure cache
 * read and never fetches from platforms — it exists only so third-party
 * callers and existing tests keep compiling during migration.
 */
export function trackCompetitors(_ops: OpsConfig): CompetitorUpdate[] {
  return readCachedCompetitors();
}
