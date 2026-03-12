#!/usr/bin/env node
/**
 * fetch-trends.ts
 * Fetches trending cosplay hashtags/topics for Instagram content planning.
 * Writes findings to world.md memory file.
 * Usage: node fetch-trends.js [--query "keyword"]
 */

import * as fs from 'fs';
import * as path from 'path';
import { getLocalDate } from './time-utils';

const MEMORY_BASE = path.join(process.env.HOME!, '.openclaw', 'workspace', 'memory', 'minase');
const WORLD_PATH = path.join(MEMORY_BASE, 'world.md');

// Curated sources for cos trend discovery (public, no auth required)
const TREND_SOURCES = [
  'https://www.reddit.com/r/cosplay/top.json?t=week&limit=5',
  'https://www.reddit.com/r/Animecosplay/top.json?t=week&limit=5',
];

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

export async function fetchPostComments(permalink: string, limit: number): Promise<RedditComment[]> {
  try {
    const url = `https://www.reddit.com${permalink}.json?limit=${limit}&sort=top`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'minase-digital-life/0.1' },
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

async function fetchRedditTrends(url: string): Promise<TrendPost[]> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'minase-digital-life/0.1' },
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

async function fetchTrends(query?: string): Promise<void> {
  const allPosts: Map<string, TrendPost[]> = new Map();

  for (const source of TREND_SOURCES) {
    try {
      const posts = await fetchRedditTrends(source);
      if (posts.length > 0) {
        const sub = posts[0].subreddit;
        allPosts.set(sub, [...(allPosts.get(sub) ?? []), ...posts]);
      }
    } catch (e) {
      // Silently skip failed sources
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
