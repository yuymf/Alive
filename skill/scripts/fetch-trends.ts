#!/usr/bin/env node
/**
 * fetch-trends.ts
 * Fetches trending cosplay hashtags/topics for Instagram content planning.
 * Writes findings to world.md memory file.
 *
 * Primary source: Arctic Shift API (free, no auth, mirrors Reddit data).
 * Fallback: Reddit public .json endpoints (currently blocked by Reddit as of 2025).
 *
 * Usage: node fetch-trends.js [--query "keyword"]
 */

import * as fs from 'fs';
import * as path from 'path';
import { getLocalDate } from './time-utils';

const MEMORY_BASE = path.join(process.env.HOME!, '.openclaw', 'workspace', 'memory', 'minase');
const WORLD_PATH = path.join(MEMORY_BASE, 'world.md');

const ARCTIC_SHIFT_BASE = 'https://arctic-shift.photon-reddit.com/api';
const USER_AGENT = 'minase-digital-life/0.1';

const SUBREDDITS = ['cosplay', 'Animecosplay'];

interface ArcticShiftPost {
  id: string;
  title: string;
  score: number;
  selftext: string;
  subreddit: string;
  permalink: string;
  num_comments: number;
  name: string;        // e.g. "t3_abc123"
  created_utc: number;
}

interface ArcticShiftComment {
  body: string;
  score: number;
  author: string;
}

interface RedditPost {
  data: {
    title: string;
    score: number;
    url: string;
    selftext: string;
    permalink: string;
    num_comments: number;
    id: string;
    subreddit: string;
  };
}

interface RedditResponse {
  data: {
    children: RedditPost[];
  };
}

interface RedditComment {
  data: {
    body: string;
    score: number;
    author: string;
  };
}

export interface TrendPost {
  title: string;
  score: number;
  selftext: string;
  subreddit: string;
  topComments: string[];
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

export function formatTrendEntry(post: TrendPost): string {
  const lines: string[] = [];
  lines.push(`**${post.title}** (↑${post.score})`);
  if (post.selftext.trim()) {
    lines.push(`   > ${truncate(post.selftext.trim(), 200)}`);
  }
  for (const comment of post.topComments) {
    lines.push(`   - 热评: "${truncate(comment, 150)}"`);
  }
  return lines.join('\n');
}

export function formatTrendSection(subreddit: string, posts: TrendPost[]): string {
  const lines: string[] = [`### r/${subreddit}`];
  posts.forEach((post, i) => {
    lines.push(`${i + 1}. ${formatTrendEntry(post)}`);
  });
  return lines.join('\n');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Arctic Shift API (primary source)
// ---------------------------------------------------------------------------

export async function fetchArcticShiftComments(postId: string, limit: number): Promise<string[]> {
  try {
    const linkId = postId.startsWith('t3_') ? postId : `t3_${postId}`;
    const url = `${ARCTIC_SHIFT_BASE}/comments/search?link_id=${linkId}&limit=20&sort=desc&sort_type=created_utc`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as { data: ArcticShiftComment[] | null };
    if (!json.data) return [];
    return json.data
      .filter(c => c.score > 5 && c.body && !c.body.startsWith('Your thread has been removed'))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(c => c.body);
  } catch (err) {
    console.warn(`Failed to fetch Arctic Shift comments for ${postId}: ${(err as Error).message}`);
    return [];
  }
}

async function fetchArcticShiftTrends(subreddit: string): Promise<TrendPost[]> {
  // Fetch 25 recent posts, then sort by score client-side
  // (Arctic Shift only supports sort by created_utc, not score)
  const url = `${ARCTIC_SHIFT_BASE}/posts/search?subreddit=${subreddit}&after=7d&limit=25`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Arctic Shift HTTP ${res.status}`);
  const json = await res.json() as { data: ArcticShiftPost[] | null };
  if (!json.data || json.data.length === 0) throw new Error('No posts returned');

  const topPosts = [...json.data]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const results: TrendPost[] = [];
  for (const post of topPosts) {
    const topComments: string[] = [];
    if (post.num_comments > 0) {
      await delay(500);
      const comments = await fetchArcticShiftComments(post.id, 3);
      topComments.push(...comments);
    }
    results.push({
      title: post.title,
      score: post.score,
      selftext: post.selftext ?? '',
      subreddit: post.subreddit,
      topComments,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Reddit .json fallback (kept for when/if Reddit re-enables public API)
// ---------------------------------------------------------------------------

export async function fetchPostComments(permalink: string, limit: number): Promise<RedditComment[]> {
  try {
    const url = `https://www.reddit.com${permalink}.json?limit=${limit}&sort=top`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as Array<{ data: { children: Array<{ kind: string; data: RedditComment['data'] }> } }>;
    if (!Array.isArray(data) || data.length < 2) return [];
    return data[1].data.children
      .filter(c => c.kind === 't1' && c.data.score > 10)
      .sort((a, b) => b.data.score - a.data.score)
      .slice(0, limit)
      .map(c => ({ data: c.data }));
  } catch (err) {
    console.warn(`Failed to fetch comments for ${permalink}: ${(err as Error).message}`);
    return [];
  }
}

async function fetchRedditTrends(subreddit: string): Promise<TrendPost[]> {
  const url = `https://www.reddit.com/r/${subreddit}/top.json?t=week&limit=5`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as RedditResponse;
  const posts = data.data.children
    .sort((a, b) => b.data.score - a.data.score)
    .slice(0, 3);

  const results: TrendPost[] = [];
  for (const post of posts) {
    const topComments: string[] = [];
    if (post.data.num_comments > 0) {
      await delay(1000);
      const comments = await fetchPostComments(post.data.permalink, 3);
      topComments.push(...comments.map(c => c.data.body));
    }
    results.push({
      title: post.data.title,
      score: post.data.score,
      selftext: post.data.selftext ?? '',
      subreddit: post.data.subreddit,
      topComments,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main: try Arctic Shift first, fall back to Reddit .json
// ---------------------------------------------------------------------------

async function fetchSubredditTrends(subreddit: string): Promise<TrendPost[]> {
  try {
    return await fetchArcticShiftTrends(subreddit);
  } catch (e) {
    console.warn(`Arctic Shift failed for r/${subreddit}: ${(e as Error).message}, trying Reddit fallback`);
  }
  try {
    return await fetchRedditTrends(subreddit);
  } catch (e) {
    console.warn(`Reddit fallback also failed for r/${subreddit}: ${(e as Error).message}`);
  }
  return [];
}

async function fetchTrends(query?: string): Promise<void> {
  const allPosts: Map<string, TrendPost[]> = new Map();

  for (const sub of SUBREDDITS) {
    const posts = await fetchSubredditTrends(sub);
    if (posts.length > 0) {
      allPosts.set(sub, [...(allPosts.get(sub) ?? []), ...posts]);
    }
  }

  if (allPosts.size === 0) {
    console.log('No trends fetched.');
    return;
  }

  const now = getLocalDate();
  const sections: string[] = [`\n## ${now} 趋势观察\n`];
  for (const [sub, posts] of allPosts) {
    sections.push(formatTrendSection(sub, posts));
  }
  const entry = sections.join('\n') + '\n';

  fs.mkdirSync(MEMORY_BASE, { recursive: true });
  if (!fs.existsSync(WORLD_PATH)) {
    fs.writeFileSync(WORLD_PATH, '# 世界观察\n\n_水瀬在浏览网络时学到的事情。_\n');
  }
  fs.appendFileSync(WORLD_PATH, entry);
  const totalPosts = [...allPosts.values()].reduce((sum, p) => sum + p.length, 0);
  console.log(`Wrote ${totalPosts} trends to world.md`);
}

const queryIdx = process.argv.indexOf('--query');
const query = queryIdx !== -1 ? process.argv[queryIdx + 1] : undefined;
fetchTrends(query).catch(console.error);
