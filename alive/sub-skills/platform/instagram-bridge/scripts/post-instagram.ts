#!/usr/bin/env node
/**
 * post-instagram.ts
 * Instagram integration for Minase via instagrapi Python bridge.
 * Usage:
 *   node post-instagram.js --post --image <local_path> --caption <text>
 *   node post-instagram.js --check-stats <media_pk>
 */

import * as fs from 'fs';
import * as path from 'path';
import { callInstagramBridge } from './bridge-client';
import { now } from '../../../../scripts/utils/time-utils';

const MEMORY_BASE = path.join(process.env.HOME!, '.openclaw', 'workspace', 'memory', 'minase');

async function checkStats(mediaPk: string): Promise<void> {
  const data = await callInstagramBridge('get_media_insights', {
    'media-pk': mediaPk,
  }) as { likes?: number; comments?: number; reach?: number; error?: string };

  if (data.error) {
    throw new Error(data.error);
  }

  const stats = {
    likes: data.likes ?? 0,
    comments: data.comments ?? 0,
    reach: data.reach ?? 0,
  };
  console.log(JSON.stringify(stats));

  // Write to memory
  const wisdomPath = path.join(MEMORY_BASE, 'core-wisdom.json');
  if (fs.existsSync(wisdomPath)) {
    const wisdom = JSON.parse(fs.readFileSync(wisdomPath, 'utf8'));
    const updated = {
      ...wisdom,
      total_importance_since_reflection: (wisdom.total_importance_since_reflection ?? 0) + 5,
    };
    fs.writeFileSync(wisdomPath, JSON.stringify(updated, null, 2));
  }
}

async function postToInstagram(imagePath: string, caption: string): Promise<void> {
  if (!process.env.INSTAGRAM_USERNAME || !process.env.INSTAGRAM_PASSWORD) {
    throw new Error('INSTAGRAM_USERNAME and INSTAGRAM_PASSWORD must be set');
  }

  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image not found: ${imagePath}`);
  }

  console.log('Uploading to Instagram...');
  const result = await callInstagramBridge('upload_photo', {
    image: imagePath,
    caption,
  }) as { media_pk: string; media_code: string; error?: string };

  if (result.error) {
    throw new Error(result.error);
  }

  console.log(`Published! Media PK: ${result.media_pk}, Code: ${result.media_code}`);

  // Write to diary
  const diaryPath = path.join(MEMORY_BASE, 'diary.md');
  const currentTime = now().toISOString();
  const entry = `\n## ${currentTime.split('T')[0]} ${currentTime.split('T')[1].slice(0, 5)}\n发了新 Instagram 帖子。Media PK: ${result.media_pk}\n情绪: excited | 重要性: 6\n标签: instagram, post\n`;
  if (fs.existsSync(diaryPath)) {
    fs.appendFileSync(diaryPath, entry);
  }
}

// CLI entry
const args = process.argv.slice(2);
if (args[0] === '--check-stats' && args[1]) {
  checkStats(args[1]).catch(console.error);
} else if (args[0] === '--post') {
  const imageIdx = args.indexOf('--image');
  const captionIdx = args.indexOf('--caption');
  if (imageIdx === -1 || captionIdx === -1) {
    console.error('Usage: post-instagram.js --post --image <local_path> --caption <text>');
    process.exit(1);
  }
  const imagePath = args[imageIdx + 1];
  const caption = args[captionIdx + 1];
  postToInstagram(imagePath, caption).catch(console.error);
} else {
  console.error('Usage: post-instagram.js --post --image <local_path> --caption <text>');
  console.error('       post-instagram.js --check-stats <media_pk>');
  process.exit(1);
}
