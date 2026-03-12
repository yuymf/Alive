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
  };
}

interface RedditResponse {
  data: {
    children: RedditPost[];
  };
}

async function fetchRedditTrends(url: string): Promise<string[]> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'minase-digital-life/0.1' }
  });
  const data = await res.json() as RedditResponse;
  return data.data.children.map(p => p.data.title);
}

async function fetchTrends(query?: string): Promise<void> {
  const topics: string[] = [];

  for (const source of TREND_SOURCES) {
    try {
      const results = await fetchRedditTrends(source);
      topics.push(...results);
    } catch (e) {
      // Silently skip failed sources
    }
  }

  if (topics.length === 0) {
    console.log('No trends fetched.');
    return;
  }

  const now = getLocalDate();
  const entry = `\n## ${now} 趋势观察\n\n${topics.slice(0, 10).map(t => `- ${t}`).join('\n')}\n`;

  fs.mkdirSync(MEMORY_BASE, { recursive: true });
  if (!fs.existsSync(WORLD_PATH)) {
    fs.writeFileSync(WORLD_PATH, '# 世界观察\n\n_水瀬在浏览网络时学到的事情。_\n');
  }
  fs.appendFileSync(WORLD_PATH, entry);
  console.log(`Wrote ${topics.length} trends to world.md`);
}

const queryIdx = process.argv.indexOf('--query');
const query = queryIdx !== -1 ? process.argv[queryIdx + 1] : undefined;
fetchTrends(query).catch(console.error);
