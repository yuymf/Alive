#!/usr/bin/env node
/**
 * post-pipeline.ts
 * Orchestrates the full photo → share flow.
 * Spawned as a detached child process by heartbeat-tick.
 *
 * Minase's perspective: she's taking photos and sharing her life on Instagram.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { PostHistory, PostRecord, ContentStyle, EmotionState } from './types';
import { PATHS, readJSON, writeJSON, appendText } from './file-utils';
import { generateImage, buildImagePrompt } from './generate-image';
import { uploadToImgURL } from './imgurl-upload';
import { refreshInspiration } from './inspiration-collector';
import { planPhoto, planPost, shouldConsiderPosting } from './content-planner';

const DEFAULT_POST_HISTORY: PostHistory = { posts: [] };
const PHOTO_ROLL_RETENTION_DAYS = 30;

/**
 * Call the Python instagram-bridge.py script with a subcommand and args.
 * Returns parsed JSON from stdout.
 */
export function callInstagramBridge(command: string, args: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Resolve bridge path: works both in installed context (__dirname = scripts/)
    // and development context (__dirname = dist/, bridge at skill/scripts/)
    let bridgePath = path.join(__dirname, 'instagram-bridge.py');
    if (!fs.existsSync(bridgePath)) {
      bridgePath = path.join(__dirname, '..', 'skill', 'scripts', 'instagram-bridge.py');
    }
    if (!fs.existsSync(bridgePath)) {
      return reject(new Error(`instagram-bridge.py not found (tried __dirname and skill/scripts/)`));
    }

    const cliArgs = [bridgePath, command];
    for (const [key, value] of Object.entries(args)) {
      cliArgs.push(`--${key}`, value);
    }

    execFile('python3', cliArgs, { timeout: 120_000 }, (error, stdout, stderr) => {
      if (stderr) console.error(`[ig-bridge] ${stderr.trim()}`);
      if (error) {
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.error) return reject(new Error(parsed.error));
        } catch {
          if (stdout) console.error(`[ig-bridge] Unparseable stdout: ${stdout.slice(0, 200)}`);
        }
        return reject(new Error(`instagram-bridge ${command} failed: ${error.message}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Failed to parse bridge output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

/**
 * Post a local photo to Instagram via instagrapi bridge.
 * Returns media_pk as string.
 */
async function postToInstagram(imagePath: string, caption: string): Promise<string> {
  const result = await callInstagramBridge('upload_photo', {
    image: imagePath,
    caption,
  }) as { media_pk: string; media_code: string };
  if (!result.media_pk) throw new Error(`Upload returned no media_pk: ${JSON.stringify(result)}`);
  return result.media_pk;
}

/**
 * Write diary entry in Minase's voice (not system log).
 * Reads current emotion state for mood description.
 */
function writeDiary(entry: string, importance: number, tags: string[]): void {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toISOString().split('T')[1].slice(0, 5);
  const emotion = readJSON<EmotionState>(PATHS.emotionState, {
    mood: { valence: 0.3, arousal: 0.5, description: '普通' },
    energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
    last_updated: null, recent_cause: '',
  });
  appendText(PATHS.diary, `\n## ${dateStr} ${timeStr}\n${entry}\n情绪: ${emotion.mood.description} | 重要性: ${importance}\n标签: ${tags.join(', ')}\n`);
}

/**
 * Clean up old photos from photo-roll (>30 days, unless posted to Instagram).
 */
function cleanupPhotoRoll(): void {
  const rollDir = PATHS.photoRoll;
  if (!fs.existsSync(rollDir)) return;

  const history = readJSON<PostHistory>(PATHS.postHistory, DEFAULT_POST_HISTORY);
  const postedPaths = new Set(history.posts.map(p => p.image_local_path));
  const cutoff = Date.now() - PHOTO_ROLL_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  for (const dateDir of fs.readdirSync(rollDir)) {
    const dirPath = path.join(rollDir, dateDir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    // Parse date from directory name (YYYY-MM-DD)
    const dirDate = new Date(dateDir).getTime();
    if (isNaN(dirDate) || dirDate > cutoff) continue;

    // Delete unposted photos
    for (const file of fs.readdirSync(dirPath)) {
      const filePath = path.join(dirPath, file);
      if (!postedPaths.has(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    // Remove empty directories
    if (fs.readdirSync(dirPath).length === 0) {
      fs.rmdirSync(dirPath);
    }
  }
}

/**
 * Check engagement stats for posts that are ~24h old and missing stats.
 * Called from heartbeat-tick during regular ticks.
 */
export async function checkPostStats(): Promise<void> {
  const igUser = process.env.INSTAGRAM_USERNAME;
  if (!igUser) return;

  const history = readJSON<PostHistory>(PATHS.postHistory, DEFAULT_POST_HISTORY);
  const now = Date.now();
  const CHECK_AFTER_MS = 24 * 60 * 60 * 1000; // 24h
  const CHECK_WINDOW_MS = 72 * 60 * 60 * 1000; // Only check posts up to 72h old

  // Find posts needing stats
  const postsNeedingStats = history.posts.filter(
    p => !p.stats && (now - p.timestamp) >= CHECK_AFTER_MS && (now - p.timestamp) <= CHECK_WINDOW_MS
  );

  if (postsNeedingStats.length === 0) return;

  // Fetch stats via bridge and build updated media_id → stats map
  const statsMap = new Map<string, PostRecord['stats']>();
  for (const post of postsNeedingStats) {
    try {
      const data = await callInstagramBridge('get_media_insights', {
        'media-pk': post.media_id,
      }) as { likes?: number; comments?: number; reach?: number; error?: string };

      if (data.error) {
        console.error(`Bridge error for media ${post.media_id}: ${data.error}`);
        continue;
      }

      statsMap.set(post.media_id, {
        likes: data.likes ?? 0,
        comments: data.comments ?? 0,
        reach: data.reach ?? 0,
        follows: 0,
        checked_at: now,
      });
      console.log(`Stats fetched for media ${post.media_id}`);
    } catch (err) {
      console.error(`Failed to fetch stats for media ${post.media_id}: ${(err as Error).message}`);
    }
  }

  if (statsMap.size > 0) {
    // Immutable update: map over all posts, merging stats where available
    const finalPosts = history.posts.map(p =>
      statsMap.has(p.media_id) ? { ...p, stats: statsMap.get(p.media_id) } : p
    );
    writeJSON(PATHS.postHistory, { posts: finalPosts });
  }
}

/**
 * Main pipeline entry point.
 */
async function runPipeline(): Promise<void> {
  console.log('Post pipeline started.');

  // 0. Cleanup old photos
  cleanupPhotoRoll();

  // 1. Refresh expired inspiration
  await refreshInspiration();

  // 2. Photo phase: does Minase want to take a photo?
  let lastPhotoStyle: ContentStyle | null = null;
  try {
    const photoIntent = await planPhoto();

    if (photoIntent.wantToShoot) {
      console.log(`Photo intent: ${photoIntent.sceneDescription}`);

      const prompt = buildImagePrompt(photoIntent.sceneDescription, photoIntent.style);
      const result = await generateImage({
        prompt,
        referenceImagePath: PATHS.referenceImage,
        style: photoIntent.style,
      });

      lastPhotoStyle = photoIntent.style;
      writeDiary(photoIntent.reason, 4, ['拍照', photoIntent.style]);
      console.log(`Photo saved: ${result.localPath}`);
    } else {
      console.log(`No photo intent: ${photoIntent.reason}`);
    }
  } catch (err) {
    // "拍糊了"
    writeDiary('今天想拍照来着，但是没拍好...手机有点卡', 2, ['拍照', '失败']);
    console.error(`Photo failed: ${(err as Error).message}`);
  }

  // 3. Post phase: does Minase want to share on Instagram?
  const history = readJSON<PostHistory>(PATHS.postHistory, DEFAULT_POST_HISTORY);
  const postCheck = shouldConsiderPosting(history);

  if (!postCheck.allowed) {
    console.log(`Post skipped: ${postCheck.reason}`);
    return;
  }

  try {
    const postIntent = await planPost();

    if (!postIntent.wantToPost || !postIntent.selectedPhoto) {
      console.log(`No post intent: ${postIntent.reason}`);
      return;
    }

    // Verify selected photo exists
    if (!fs.existsSync(postIntent.selectedPhoto)) {
      console.error(`Selected photo not found: ${postIntent.selectedPhoto}`);
      return;
    }

    // Upload and post to Instagram via instagrapi bridge (direct local file upload)
    const fullCaption = `${postIntent.caption}\n\n${postIntent.hashtags.map(t => `#${t}`).join(' ')}`;
    console.log('Posting to Instagram...');
    const mediaId = await postToInstagram(postIntent.selectedPhoto, fullCaption);

    // Upload to ImgURL for public URL archival (non-blocking, failure is non-fatal)
    let imageUrl: string | undefined;
    try {
      console.log('Uploading to ImgURL...');
      const imgResult = await uploadToImgURL(postIntent.selectedPhoto);
      imageUrl = imgResult.url;
      console.log(`ImgURL: ${imageUrl}`);
    } catch (err) {
      console.error(`ImgURL upload failed (non-fatal): ${(err as Error).message}`);
    }

    // Record to post history
    // Style comes from the photo intent if we took a photo this run,
    // otherwise infer from caption keywords (fallback: 'daily')
    const inferredStyle: ContentStyle = lastPhotoStyle
      ?? (postIntent.caption.includes('cos') ? 'cos'
        : postIntent.caption.includes('旅') ? 'travel'
        : 'daily');
    const record: PostRecord = {
      media_id: mediaId,
      timestamp: Date.now(),
      style: inferredStyle,
      caption: postIntent.caption,
      hashtags: postIntent.hashtags,
      image_local_path: postIntent.selectedPhoto,
      ...(imageUrl && { image_url: imageUrl }),
    };
    const updatedHistory: PostHistory = {
      posts: [...history.posts, record],
    };
    writeJSON(PATHS.postHistory, updatedHistory);

    // Diary entry in Minase's voice
    writeDiary(postIntent.reason, 6, ['instagram', 'post']);
    console.log(`Posted! Media ID: ${mediaId}`);
  } catch (err) {
    writeDiary('发ins的时候出了点问题...好烦', 2, ['instagram', '失败']);
    console.error(`Post failed: ${(err as Error).message}`);
  }
}

// Entry point
if (require.main === module) {
  runPipeline()
    .then(() => console.log('Post pipeline completed.'))
    .catch(err => {
      console.error('Pipeline error:', err.message);
      process.exit(1);
    });
}

export { runPipeline };
