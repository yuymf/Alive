/**
 * competitor-fetcher.ts
 * Layer 1 — Data collection for competitor analysis pipeline.
 *
 * Fetches posts from XHS/Douyin per competitor account,
 * deduplicates, prunes old posts, and stores results.
 * Each account is fetched independently; one failure never blocks others.
 */

import { execFileSync } from 'child_process';
import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { wallNow } from '../utils/time-utils';
import type { CompetitorPost, CompetitorPostsStore, CompetitorProfile, FetchResult } from '../utils/types';

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_POSTS_PER_ACCOUNT = 20;
export const POST_RETENTION_DAYS = 30;
export const DOUYIN_FETCH_TIMEOUT = 45_000;

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

interface YtDlpVideo {
  id?: string;
  title?: string;
  like_count?: number;
  upload_date?: string;
  thumbnail?: string;
  comment_count?: number;
}

function fetchDouyinPosts(accountId: string): CompetitorPost[] {
  const fetchedAt = wallNow().toISOString();

  // Strategy 1: try yt-dlp-downloader skill
  try {
    const raw = execFileSync(
      'openclaw',
      ['skills', 'run', 'yt-dlp-downloader', '--args', JSON.stringify({ account_id: accountId, limit: MAX_POSTS_PER_ACCOUNT })],
      { timeout: DOUYIN_FETCH_TIMEOUT, encoding: 'utf8' },
    );

    const parsed = JSON.parse(raw.trim()) as { videos?: YtDlpVideo[] };
    const videos = parsed.videos ?? [];

    if (videos.length > 0) {
      return videos.map(video => ({
        account_name: accountId,
        platform: 'douyin' as const,
        post_id: video.id ?? `douyin_${accountId}_${Math.random().toString(36).slice(2)}`,
        title: video.title ?? '',
        engagement: video.like_count ?? 0,
        comment_count: video.comment_count,
        posted_at: video.upload_date,
        cover_url: video.thumbnail,
        fetched_at: fetchedAt,
      }));
    }
    console.warn(`[competitor-fetcher] yt-dlp-downloader returned 0 videos for ${accountId}, trying curl fallback`);
  } catch (err) {
    console.warn(
      `[competitor-fetcher] yt-dlp-downloader failed for ${accountId}: ${err instanceof Error ? err.message : err} — trying curl fallback`,
    );
  }

  // Strategy 2: fallback to curl + Douyin Web API (requires sec_user_id and cookies)
  try {
    return fetchDouyinPostsViaCurl(accountId, fetchedAt);
  } catch (err) {
    console.error(
      `[competitor-fetcher] curl fallback also failed for ${accountId}: ${err instanceof Error ? err.message : err}`,
    );
    throw err; // propagate to let caller record as failed
  }
}

/**
 * Fallback: Fetch Douyin posts via curl + Web API.
 * Uses DOUYIN_COOKIES_FILE for authentication.
 * The accountId should be a sec_user_id for this method to work.
 */
function fetchDouyinPostsViaCurl(secUid: string, fetchedAt: string): CompetitorPost[] {
  const cookiesFile = process.env.DOUYIN_COOKIES_FILE ?? '';
  let cookieHeader = '';
  if (cookiesFile) {
    try {
      const fs = require('fs') as typeof import('fs');
      cookieHeader = fs.readFileSync(cookiesFile, 'utf8').trim();
    } catch {
      console.warn(`[competitor-fetcher] Cookie file not found: ${cookiesFile}`);
    }
  }

  const url = `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${encodeURIComponent(secUid)}&count=${MAX_POSTS_PER_ACCOUNT}&max_cursor=0&aid=6383&device_platform=webapp&source=channel_pc_web`;
  const curlArgs = [
    '-s', '--max-time', '20',
    url,
    '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '-H', 'Accept: application/json',
    '-H', 'Referer: https://www.douyin.com/',
  ];
  if (cookieHeader) curlArgs.push('-H', `Cookie: ${cookieHeader}`);

  const raw = execFileSync('curl', curlArgs, { timeout: 25_000, encoding: 'utf8' });
  if (!raw.trim() || raw.trim().startsWith('<')) {
    console.warn(`[competitor-fetcher] curl fallback: empty or HTML response for ${secUid}`);
    return [];
  }

  const d = JSON.parse(raw.trim()) as {
    status_code?: number;
    aweme_list?: Array<{
      aweme_id?: string;
      desc?: string;
      statistics?: { digg_count?: number; comment_count?: number };
      create_time?: number;
      video?: { cover?: { url_list?: string[] } };
    }>;
  };
  const list = d.aweme_list ?? [];
  if (list.length === 0) {
    console.warn(`[competitor-fetcher] curl fallback: aweme_list empty for ${secUid} (status_code=${d.status_code ?? 'N/A'})`);
  }

  return list.map(v => ({
    account_name: secUid,
    platform: 'douyin' as const,
    post_id: v.aweme_id ?? `douyin_${secUid}_${Math.random().toString(36).slice(2)}`,
    title: v.desc ?? '',
    engagement: v.statistics?.digg_count ?? 0,
    comment_count: v.statistics?.comment_count,
    posted_at: v.create_time ? new Date(v.create_time * 1000).toISOString() : undefined,
    cover_url: v.video?.cover?.url_list?.[0],
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
  accounts: { xhs: string[]; douyin: string[] },
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

  // Fetch XHS accounts
  for (const accountName of accounts.xhs) {
    const key = buildAccountKey(accountName, 'xhs');
    try {
      const incoming = await fetchXhsPosts(accountName);
      const existingPosts = updatedAccounts[key] ?? [];
      const merged = mergeAndDedupPosts(existingPosts, incoming, MAX_POSTS_PER_ACCOUNT);
      const pruned = pruneOldPosts(merged, now);
      updatedAccounts[key] = pruned;
      success.push(key);
    } catch {
      // Retain previous data; mark as failed
      failed.push(key);
    }
  }

  // Fetch Douyin accounts
  for (const accountId of accounts.douyin) {
    const key = buildAccountKey(accountId, 'douyin');
    try {
      const incoming = fetchDouyinPosts(accountId);
      const existingPosts = updatedAccounts[key] ?? [];
      const merged = mergeAndDedupPosts(existingPosts, incoming, MAX_POSTS_PER_ACCOUNT);
      const pruned = pruneOldPosts(merged, now);
      updatedAccounts[key] = pruned;
      success.push(key);
    } catch {
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
