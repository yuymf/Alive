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
import type { CompetitorPost, CompetitorPostsStore, CompetitorProfile, FetchResult } from '../utils/types';
import { listDouyinUserPosts } from '../../sub-skills/platform/douyin-bridge/scripts/douyin-client';

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_POSTS_PER_ACCOUNT = 20;
export const POST_RETENTION_DAYS = 30;
export const DOUYIN_FETCH_TIMEOUT = 45_000;

/** 随机等待 minMs~maxMs 毫秒，用于账号间节流，降低风控触发率。 */
function jitter(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Pure functions (exported for testing) ────────────────────────────────────

/**
 * Build the key used to identify an account in the store.
 * Format: "name:platform"
 */
export function buildAccountKey(name: string, platform: string): string {
  return `${name}:${platform}`;
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

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Fetch posts for all competitor accounts.
 * Each account is fetched independently — failures are tracked but do not block others.
 * Results are written to PATHS.competitorPosts.
 */
export async function fetchCompetitorPosts(
  accounts: { xhs: string[]; xhsUserIds: Map<string, string>; douyin: string[] },
  _profiles: readonly CompetitorProfile[],
  _basePath: string,
): Promise<FetchResult> {
  const existing = readJSON<CompetitorPostsStore>(PATHS.competitorPosts, {
    version: 1,
    last_fetched: '',
    accounts: {},
  });

  // Work on a mutable copy of the accounts map
  const updatedAccounts: Record<string, readonly CompetitorPost[]> = { ...existing.accounts };

  const success: string[] = [];
  const failed: string[] = [];
  const now = wallNow();

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
      success.push(key);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Not logged in')) {
        console.warn(`[competitor-fetcher] XHS 未登录，跳过账号 ${key}，不影响其他平台抓取。请重新登录小红书。`);
      } else {
        console.warn(`[competitor-fetcher] XHS user-profile 抓取失败 ${key}: ${msg}，尝试搜索回退`);
        // Fallback to search by name
        try {
          const incoming = await fetchXhsPosts(displayName);
          const existingPosts = updatedAccounts[key] ?? [];
          const merged = mergeAndDedupPosts(existingPosts, incoming, MAX_POSTS_PER_ACCOUNT);
          const pruned = pruneOldPosts(merged, now);
          updatedAccounts[key] = pruned;
          success.push(key);
        } catch (fallbackErr) {
          const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          console.warn(`[competitor-fetcher] XHS 搜索回退也失败 ${key}: ${fbMsg}`);
          failed.push(key);
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
      success.push(key);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Not logged in')) {
        console.warn(`[competitor-fetcher] XHS 未登录，跳过账号 ${key}，不影响其他平台抓取。请重新登录小红书。`);
      } else {
        console.warn(`[competitor-fetcher] XHS 抓取失败 ${key}: ${msg}`);
      }
      // 保留历史数据，只标记失败
      failed.push(key);
    }
  }

  // Fetch Douyin accounts
  for (let i = 0; i < accounts.douyin.length; i++) {
    const accountId = accounts.douyin[i];
    const key = buildAccountKey(accountId, 'douyin');
    // 账号间节流：随机等待 3~7s
    if (i > 0) await jitter(3000, 7000);
    try {
      const incoming = fetchDouyinPosts(accountId);
      const existingPosts = updatedAccounts[key] ?? [];
      const merged = mergeAndDedupPosts(existingPosts, incoming, MAX_POSTS_PER_ACCOUNT);
      const pruned = pruneOldPosts(merged, now);
      updatedAccounts[key] = pruned;
      success.push(key);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[competitor-fetcher] Douyin 抓取失败 ${key}: ${msg}`);
      failed.push(key);
    }
  }

  const store: CompetitorPostsStore = {
    version: 1,
    last_fetched: wallNow().toISOString(),
    accounts: updatedAccounts,
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
  });
}
