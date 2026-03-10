#!/usr/bin/env node
/**
 * post-instagram.ts
 * Instagram Graph API integration for Minase
 * Usage:
 *   node post-instagram.js --post --image-url <url> --caption <text>
 *   node post-instagram.js --check-stats <media_id>
 */

import * as fs from 'fs';
import * as path from 'path';

const IG_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const IG_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID;
const MEMORY_BASE = path.join(process.env.HOME!, '.openclaw', 'workspace', 'memory', 'minase');

interface MediaCreateResponse {
  id: string;
}

interface MediaPublishResponse {
  id: string;
}

interface MediaInsightsResponse {
  data: Array<{
    name: string;
    values: Array<{ value: number }>;
  }>;
}

async function igPost(endpoint: string, params: Record<string, string>, method = 'POST'): Promise<unknown> {
  const url = new URL(`https://graph.instagram.com/v21.0${endpoint}`);
  if (method === 'GET') {
    url.searchParams.set('access_token', IG_ACCESS_TOKEN!);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString());
    return res.json();
  }
  const body = new URLSearchParams({ access_token: IG_ACCESS_TOKEN!, ...params });
  const res = await fetch(url.toString(), { method, body });
  return res.json();
}

async function createMediaContainer(imageUrl: string, caption: string): Promise<string> {
  const data = await igPost(`/${IG_ACCOUNT_ID}/media`, {
    image_url: imageUrl,
    caption,
  }) as MediaCreateResponse;
  if (!data.id) throw new Error(`Media container creation failed: ${JSON.stringify(data)}`);
  return data.id;
}

async function publishMedia(containerId: string): Promise<string> {
  const data = await igPost(`/${IG_ACCOUNT_ID}/media_publish`, {
    creation_id: containerId,
  }) as MediaPublishResponse;
  if (!data.id) throw new Error(`Media publish failed: ${JSON.stringify(data)}`);
  return data.id;
}

async function checkStats(mediaId: string): Promise<void> {
  const data = await igPost(
    `/${mediaId}/insights`,
    { metric: 'impressions,reach,likes,comments,follows' },
    'GET'
  ) as MediaInsightsResponse;

  const stats: Record<string, number> = {};
  for (const item of data.data ?? []) {
    stats[item.name] = item.values?.[0]?.value ?? 0;
  }
  console.log(JSON.stringify(stats));

  // Write to memory
  const wisdomPath = path.join(MEMORY_BASE, 'core-wisdom.json');
  if (fs.existsSync(wisdomPath)) {
    const wisdom = JSON.parse(fs.readFileSync(wisdomPath, 'utf8'));
    wisdom.total_importance_since_reflection = (wisdom.total_importance_since_reflection ?? 0) + 5;
    fs.writeFileSync(wisdomPath, JSON.stringify(wisdom, null, 2));
  }
}

async function postToInstagram(imageUrl: string, caption: string): Promise<void> {
  if (!IG_ACCESS_TOKEN || !IG_ACCOUNT_ID) {
    throw new Error('INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_ACCOUNT_ID must be set');
  }
  console.log('Creating media container...');
  const containerId = await createMediaContainer(imageUrl, caption);
  console.log(`Container ID: ${containerId}`);

  // Instagram requires a short wait before publishing
  await new Promise(r => setTimeout(r, 3000));

  console.log('Publishing...');
  const mediaId = await publishMedia(containerId);
  console.log(`Published! Media ID: ${mediaId}`);

  // Write to diary
  const diaryPath = path.join(MEMORY_BASE, 'diary.md');
  const now = new Date().toISOString();
  const entry = `\n## ${now.split('T')[0]} ${now.split('T')[1].slice(0,5)}\n发了新 Instagram 帖子。Media ID: ${mediaId}\n情绪: excited | 重要性: 6\n标签: instagram, post\n`;
  if (fs.existsSync(diaryPath)) {
    fs.appendFileSync(diaryPath, entry);
  }
}

// CLI entry
const args = process.argv.slice(2);
if (args[0] === '--check-stats' && args[1]) {
  checkStats(args[1]).catch(console.error);
} else if (args[0] === '--post') {
  const imageUrlIdx = args.indexOf('--image-url');
  const captionIdx = args.indexOf('--caption');
  if (imageUrlIdx === -1 || captionIdx === -1) {
    console.error('Usage: post-instagram.js --post --image-url <url> --caption <text>');
    process.exit(1);
  }
  const imageUrl = args[imageUrlIdx + 1];
  const caption = args[captionIdx + 1];
  postToInstagram(imageUrl, caption).catch(console.error);
} else {
  console.error('Usage: post-instagram.js --post --image-url <url> --caption <text>');
  console.error('       post-instagram.js --check-stats <media_id>');
  process.exit(1);
}
