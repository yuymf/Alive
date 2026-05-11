/**
 * competitor-fetcher.ts
 * Layer 1 — Data collection for competitor analysis pipeline.
 *
 * Fetches posts from XHS/Douyin per competitor account,
 * deduplicates, prunes old posts, and stores results.
 * Each account is fetched independently; one failure never blocks others.
 */

import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { wallNow } from '../utils/time-utils';
import { execFileSync } from 'child_process';
import type {
  CompetitorAccountFetchStatus,
  CompetitorPost,
  CompetitorPostsStore,
  CompetitorProfile,
  FetchResult,
} from '../utils/types';
import { listDouyinUserPosts } from '../../sub-skills/platform/douyin-bridge/scripts/douyin-client';
import {
  buildCompetitorKey,
  buildCompetitorKeyFromProfile,
  findProfileByFetchId,
} from './competitor-keys';

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_POSTS_PER_ACCOUNT = 20;
export const POST_RETENTION_DAYS = 30;
export const DOUYIN_FETCH_TIMEOUT = 45_000;

/** 随机等待 minMs~maxMs 毫秒，用于账号间节流，降低风控触发率。 */
function jitter(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isXhsNonRetryable(msg: string): boolean {
  return /Not logged in|风控|冷却|rate|limit|429|461|captcha|验证码|频繁|blocked|too many|滑块|challenge/i.test(msg);
}


// ─── Pure functions (exported for testing) ────────────────────────────────────

/**
 * Build the key used to identify an account in the store.
 * Format: "name:platform"
 */
export function buildAccountKey(name: string, platform: string): string {
  return buildCompetitorKey(name, platform);
}

/**
 * Parse an account key back into name and platform.
 * Uses lastIndexOf to correctly handle account names that contain colons.
 */
export function parseAccountKey(key: string): { name: string; platform: string } {
  const colonIdx = key.lastIndexOf(':');
  if (colonIdx < 0) return { name: key, platform: 'xhs' };
  return { name: key.slice(0, colonIdx), platform: key.slice(colonIdx + 1) };
}

/**
 * Merge existing and incoming posts, deduplicating by post_id.
 * Incoming wins on conflict. Result is sorted by engagement desc and capped at maxPosts.
 */
export function mergeAndDedupPosts(
  existing: readonly CompetitorPost[],
  incoming: readonly CompetitorPost[],
  maxPosts: number,
): CompetitorPost[] {
  // Build a map from post_id → post; existing first, then incoming overwrites
  const byId = new Map<string, CompetitorPost>();
  for (const post of existing) {
    byId.set(post.post_id, post);
  }
  for (const post of incoming) {
    byId.set(post.post_id, post);
  }

  // Sort by engagement descending, cap at maxPosts
  return Array.from(byId.values())
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, maxPosts);
}

/**
 * Remove posts older than retentionDays from the given reference date.
 * Uses posted_at if present, otherwise falls back to fetched_at.
 */
export function pruneOldPosts(
  posts: readonly CompetitorPost[],
  referenceDate: Date,
  retentionDays = POST_RETENTION_DAYS,
): CompetitorPost[] {
  const cutoffMs = referenceDate.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return posts.filter(post => {
    const dateStr = post.posted_at ?? post.fetched_at;
    const postMs = new Date(dateStr).getTime();
    return postMs >= cutoffMs;
  });
}

function recordFetchStatus(
  statuses: Record<string, CompetitorAccountFetchStatus>,
  input: CompetitorAccountFetchStatus,
): void {
  statuses[input.canonical_key] = input;
}

function resolveCanonicalKey(
  profiles: readonly CompetitorProfile[],
  platform: 'xhs' | 'douyin' | 'bilibili',
  fetchId: string,
  fallbackName: string,
): string {
  const profile = findProfileByFetchId(profiles, platform, fetchId)
    ?? profiles.find(p => p.platform === platform && p.name === fallbackName);

  if (profile) return buildCompetitorKeyFromProfile(profile);
  return buildCompetitorKey(fallbackName, platform);
}

// ─── Platform fetchers (private) ─────────────────────────────────────────────

async function fetchXhsPosts(accountName: string): Promise<CompetitorPost[]> {
  const { getUserNotes } = await import('../../sub-skills/platform/xhs-bridge/scripts/xhs-client');
  const notes = await getUserNotes(accountName, MAX_POSTS_PER_ACCOUNT);
  const fetchedAt = wallNow().toISOString();

  return notes.map(note => ({
    account_name: accountName,
    platform: 'xhs' as const,
    post_id: note.id || `xhs_${note.title.slice(0, 20)}_${fetchedAt}`,
    title: note.title,
    engagement: note.likes,
    fetched_at: fetchedAt,
  }));
}

async function fetchXhsPostsByUserId(userId: string, displayName: string): Promise<CompetitorPost[]> {
  const { getUserProfileNotes } = await import('../../sub-skills/platform/xhs-bridge/scripts/xhs-client');
  const notes = await getUserProfileNotes(userId, MAX_POSTS_PER_ACCOUNT);
  const fetchedAt = wallNow().toISOString();

  return notes.map(note => ({
    account_name: displayName,
    platform: 'xhs' as const,
    post_id: note.id || `xhs_${note.title.slice(0, 20)}_${fetchedAt}`,
    title: note.title,
    engagement: note.likes,
    fetched_at: fetchedAt,
  }));
}

function fetchDouyinPosts(accountId: string): CompetitorPost[] {
  const fetchedAt = wallNow().toISOString();

  // Use douyin-bridge CDP (headless Chrome, no Cookie required)
  const cdpResult = listDouyinUserPosts(accountId, MAX_POSTS_PER_ACCOUNT);
  if (!cdpResult.success) {
    if (cdpResult.rate_limited) {
      throw new Error(`Douyin 风控限流 for ${accountId}: ${cdpResult.reason ?? 'cooldown'}，等待 ${cdpResult.retry_after ?? '?'}s`);
    }
    throw new Error(`CDP fetch failed for ${accountId}: ${cdpResult.error ?? 'unknown'}`);
  }
  if (!cdpResult.videos?.length) {
    throw new Error(`CDP returned 0 videos for ${accountId}`);
  }
  return cdpResult.videos.map(v => ({
    account_name: accountId,
    platform: 'douyin' as const,
    post_id: v.aweme_id || `douyin_${accountId}_${Math.random().toString(36).slice(2)}`,
    title: v.desc || '',
    engagement: v.digg_count,
    posted_at: v.create_time ? new Date(v.create_time * 1000).toISOString() : undefined,
    fetched_at: fetchedAt,
  }));
}

function fetchBilibiliPosts(mid: string, displayName: string): CompetitorPost[] {
  const fetchedAt = wallNow().toISOString();
  const cookie = process.env.BILIBILI_COOKIE ?? '';
  const maxPosts = MAX_POSTS_PER_ACCOUNT;

  const script = `
const https = require('https');
const crypto = require('crypto');
const mid = ${JSON.stringify(mid)};
const COOKIE = ${JSON.stringify(cookie)};
const MAX = ${maxPosts};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
    const nav = await get('https://api.bilibili.com/x/web-interface/nav');
    const imgKey = nav?.data?.wbi_img?.img_url?.match(/([a-f0-9]+)\\.png/)?.[1] ?? '';
    const subKey = nav?.data?.wbi_img?.sub_url?.match(/([a-f0-9]+)\\.png/)?.[1] ?? '';
    if (!imgKey || !subKey) { process.stdout.write('[]'); return; }

    const mixinKey = getMixinKey(imgKey, subKey);
    const wts = Math.floor(Date.now() / 1000);
    const params = { mid, ps: MAX, pn: 1, order: 'pubdate', wts };
    const query = Object.keys(params).sort()
      .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k]).replace(/[!'()*]/g, '')))
      .join('&');
    const w_rid = crypto.createHash('md5').update(query + mixinKey).digest('hex');

    const apiUrl = 'https://api.bilibili.com/x/space/wbi/arc/search?' + query + '&w_rid=' + w_rid;
    const d = await get(apiUrl);
    const vlist = d?.data?.list?.vlist ?? [];
    if (!vlist.length) { process.stdout.write('[]'); return; }
    process.stdout.write(JSON.stringify(vlist.slice(0, MAX).map(v => ({
      title: v.title || '',
      play: v.play || 0,
      created: v.created || 0,
      bvid: v.bvid || '',
    }))));
  } catch(e) {
    process.stdout.write('[]');
  }
}
main();
`;

  try {
    const raw = execFileSync(process.execPath, ['-e', script], { timeout: 20_000, encoding: 'utf8' });
    const videos = JSON.parse(raw.trim()) as Array<{ title?: string; play?: number; created?: number; bvid?: string }>;

    if (!videos.length || !videos[0].title) {
      return [];
    }

    return videos.map(v => ({
      account_name: displayName,
      platform: 'bilibili' as const,
      post_id: v.bvid || `bili_${mid}_${v.created ?? Date.now()}`,
      title: v.title ?? '',
      engagement: v.play ?? 0,
      posted_at: v.created ? new Date(v.created * 1000).toISOString() : undefined,
      fetched_at: fetchedAt,
    }));
  } catch {
    return [];
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Fetch posts for all competitor accounts.
 * Each account is fetched independently — failures are tracked but do not block others.
 * Results are written to PATHS.competitorPosts.
 */
export async function fetchCompetitorPosts(
  accounts: { xhs: string[]; xhsUserIds: Map<string, string>; douyin: string[]; bilibili?: Array<{ mid: string; name: string }> },
  profiles: readonly CompetitorProfile[],
  _basePath: string,
): Promise<FetchResult> {
  const existing = readJSON<CompetitorPostsStore>(PATHS.competitorPosts, {
    version: 1,
    last_fetched: '',
    accounts: {},
  });

  // Work on a mutable copy of the accounts map
  const updatedAccounts: Record<string, readonly CompetitorPost[]> = { ...existing.accounts };
  const fetchStatuses: Record<string, CompetitorAccountFetchStatus> = { ...(existing.fetch_statuses ?? {}) };

  const success: string[] = [];
  const failed: string[] = [];
  const now = wallNow();
  const attemptedAt = now.toISOString();

  // Fetch XHS accounts by user_id (precise fetch)
  const xhsUserIdEntries = [...(accounts.xhsUserIds?.entries() ?? [])];
  for (let i = 0; i < xhsUserIdEntries.length; i++) {
    const [userId, displayName] = xhsUserIdEntries[i];
    const key = buildAccountKey(displayName, 'xhs');
    if (i > 0) await jitter(5000, 12000);
    try {
      const incoming = await fetchXhsPostsByUserId(userId, displayName);
      const existingPosts = updatedAccounts[key] ?? [];
      const merged = mergeAndDedupPosts(existingPosts, incoming, MAX_POSTS_PER_ACCOUNT);
      const pruned = pruneOldPosts(merged, now);
      updatedAccounts[key] = pruned;
      const status = pruned.length > 0 ? 'success' : 'empty';
      if (status === 'success') success.push(key);
      else failed.push(key);
      recordFetchStatus(fetchStatuses, {
        canonical_key: key,
        fetch_id: userId,
        status,
        platform: 'xhs',
        last_attempted: attemptedAt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isXhsNonRetryable(msg)) {
        console.warn(`[competitor-fetcher] XHS user-profile 跳过搜索回退 ${key}: ${msg}`);
        failed.push(key);
        recordFetchStatus(fetchStatuses, {
          canonical_key: key,
          fetch_id: userId,
          status: 'failed',
          platform: 'xhs',
          last_attempted: attemptedAt,
          error: msg,
        });
      } else {
        console.warn(`[competitor-fetcher] XHS user-profile 抓取失败 ${key}: ${msg}，尝试搜索回退`);
        // Fallback to search by name only for non-rate-limit failures.
        try {
          const incoming = await fetchXhsPosts(displayName);
          const existingPosts = updatedAccounts[key] ?? [];
          const merged = mergeAndDedupPosts(existingPosts, incoming, MAX_POSTS_PER_ACCOUNT);
          const pruned = pruneOldPosts(merged, now);
          updatedAccounts[key] = pruned;
          const status = pruned.length > 0 ? 'success' : 'empty';
          if (status === 'success') success.push(key);
          else failed.push(key);
          recordFetchStatus(fetchStatuses, {
            canonical_key: key,
            fetch_id: userId,
            status,
            platform: 'xhs',
            last_attempted: attemptedAt,
          });
        } catch (fallbackErr) {
          const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          console.warn(`[competitor-fetcher] XHS 搜索回退也失败 ${key}: ${fbMsg}`);
          failed.push(key);
          recordFetchStatus(fetchStatuses, {
            canonical_key: key,
            fetch_id: userId,
            status: 'failed',
            platform: 'xhs',
            last_attempted: attemptedAt,
            error: fbMsg,
          });
        }
      }
    }
  }

  // Fetch XHS accounts by name (search)
  for (let i = 0; i < accounts.xhs.length; i++) {
    const accountName = accounts.xhs[i];
    const key = buildAccountKey(accountName, 'xhs');
    // 账号间节流：第一个账号不等，后续账号随机等待 5~12s
    if (i > 0) await jitter(5000, 12000);
    try {
      const incoming = await fetchXhsPosts(accountName);
      const existingPosts = updatedAccounts[key] ?? [];
      const merged = mergeAndDedupPosts(existingPosts, incoming, MAX_POSTS_PER_ACCOUNT);
      const pruned = pruneOldPosts(merged, now);
      updatedAccounts[key] = pruned;
      const status = pruned.length > 0 ? 'success' : 'empty';
      if (status === 'success') success.push(key);
      else failed.push(key);
      recordFetchStatus(fetchStatuses, {
        canonical_key: key,
        fetch_id: accountName,
        status,
        platform: 'xhs',
        last_attempted: attemptedAt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Not logged in')) {
        console.warn(`[competitor-fetcher] XHS 未登录，跳过账号 ${key}，不影响其他平台抓取。请重新登录小红书。`);
      } else {
        console.warn(`[competitor-fetcher] XHS 抓取失败 ${key}: ${msg}`);
      }
      // 保留历史数据，只标记失败
      failed.push(key);
      recordFetchStatus(fetchStatuses, {
        canonical_key: key,
        fetch_id: accountName,
        status: 'failed',
        platform: 'xhs',
        last_attempted: attemptedAt,
        error: msg,
      });
    }
  }

  // Fetch Douyin accounts
  for (let i = 0; i < accounts.douyin.length; i++) {
    const accountId = accounts.douyin[i];
    const key = resolveCanonicalKey(profiles, 'douyin', accountId, accountId);
    // 账号间节流：随机等待 3~7s
    if (i > 0) await jitter(3000, 7000);
    try {
      const incoming = fetchDouyinPosts(accountId).map(post => ({
        ...post,
        account_name: parseAccountKey(key).name,
      }));
      const existingPosts = updatedAccounts[key] ?? [];
      const merged = mergeAndDedupPosts(existingPosts, incoming, MAX_POSTS_PER_ACCOUNT);
      const pruned = pruneOldPosts(merged, now);
      updatedAccounts[key] = pruned;
      const status = pruned.length > 0 ? 'success' : 'empty';
      if (status === 'success') success.push(key);
      else failed.push(key);
      recordFetchStatus(fetchStatuses, {
        canonical_key: key,
        fetch_id: accountId,
        status,
        platform: 'douyin',
        last_attempted: attemptedAt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[competitor-fetcher] Douyin 抓取失败 ${key}: ${msg}`);
      failed.push(key);
      recordFetchStatus(fetchStatuses, {
        canonical_key: key,
        fetch_id: accountId,
        status: 'failed',
        platform: 'douyin',
        last_attempted: attemptedAt,
        error: msg,
      });
    }
  }

  // Fetch Bilibili accounts
  const bilibiliAccounts = accounts.bilibili ?? [];
  for (let i = 0; i < bilibiliAccounts.length; i++) {
    const { mid, name } = bilibiliAccounts[i];
    const key = buildAccountKey(name, 'bilibili');
    if (i > 0) await jitter(5000, 12000);
    try {
      const incoming = fetchBilibiliPosts(mid, name);
      if (incoming.length === 0) {
        // No posts returned — keep existing data, just log
        console.warn(`[competitor-fetcher] Bilibili 抓取返回 0 条 ${key}`);
        const status = updatedAccounts[key]?.length ? 'success' : 'empty';
        if (status === 'success') success.push(key);
        else failed.push(key);
        recordFetchStatus(fetchStatuses, {
          canonical_key: key,
          fetch_id: mid,
          status,
          platform: 'bilibili',
          last_attempted: attemptedAt,
        });
        continue;
      }
      const existingPosts = updatedAccounts[key] ?? [];
      const merged = mergeAndDedupPosts(existingPosts, incoming, MAX_POSTS_PER_ACCOUNT);
      const pruned = pruneOldPosts(merged, now);
      updatedAccounts[key] = pruned;
      success.push(key);
      recordFetchStatus(fetchStatuses, {
        canonical_key: key,
        fetch_id: mid,
        status: 'success',
        platform: 'bilibili',
        last_attempted: attemptedAt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[competitor-fetcher] Bilibili 抓取失败 ${key}: ${msg}`);
      failed.push(key);
      recordFetchStatus(fetchStatuses, {
        canonical_key: key,
        fetch_id: mid,
        status: 'failed',
        platform: 'bilibili',
        last_attempted: attemptedAt,
        error: msg,
      });
    }
  }

  const store: CompetitorPostsStore = {
    version: 1,
    last_fetched: wallNow().toISOString(),
    accounts: updatedAccounts,
    fetch_statuses: fetchStatuses,
  };
  writeJSON(PATHS.competitorPosts, store);

  return { success, failed };
}

/**
 * Load the stored competitor posts from disk.
 */
export function loadCompetitorPosts(): CompetitorPostsStore {
  return readJSON<CompetitorPostsStore>(PATHS.competitorPosts, {
    version: 1,
    last_fetched: '',
    accounts: {},
    fetch_statuses: {},
  });
}
