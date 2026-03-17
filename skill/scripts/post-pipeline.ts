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
import { PostHistory, PostRecord, ContentStyle, EmotionState, PostImpulseState, DEFAULT_POST_IMPULSE, hydrateEmotionState, DEFAULT_MOMENTUM, DEFAULT_UNDERTONE } from './types';
import { PATHS, readJSON, writeJSON, appendText } from './file-utils';
import { generateImageSet, GenerateSetResult } from './generate-image';
import { uploadToImgURL } from './imgurl-upload';
import { now, getLocalDate, getLocalTimeHHMM } from './time-utils';
import { refreshInspiration } from './inspiration-collector';
import { planPhoto, planPost, shouldConsiderPosting } from './content-planner';
import { callInstagramBridge, uploadAlbum } from './instagram-bridge-client';
import { resetImpulseAfterPost, accumulateImpulse } from './post-impulse';
import type { GalleryPhoto, PhotoGallery } from './types';
import { DEFAULT_PHOTO_GALLERY } from './types';
import { addPhotoToGallery, pruneGallery } from './gallery-send';
import { scheduleCommentCheck } from './comment-engine';

const DEFAULT_POST_HISTORY: PostHistory = { posts: [] };
const PHOTO_ROLL_RETENTION_DAYS = 30;

/**
 * Post local photos to Instagram via instagrapi bridge.
 * Supports single photo upload and carousel/album upload.
 * Returns media_pk as string.
 */
async function postToInstagram(imagePaths: string[], caption: string): Promise<string> {
  if (imagePaths.length === 1) {
    const result = await callInstagramBridge('upload_photo', {
      image: imagePaths[0],
      caption,
    }) as { media_pk: string; media_code: string };
    if (!result.media_pk) throw new Error(`Upload returned no media_pk: ${JSON.stringify(result)}`);
    return result.media_pk;
  }
  return uploadAlbum(imagePaths, caption);
}

/**
 * Backward compatibility helper: normalize old PostRecord with image_local_path
 * (singular) to the new image_local_paths (array) format.
 */
export function normalizePostRecord(post: PostRecord): PostRecord {
  if (!post.image_local_paths && (post as any).image_local_path) {
    return { ...post, image_local_paths: [(post as any).image_local_path] };
  }
  return post;
}

/**
 * Write diary entry in Minase's voice (not system log).
 * Reads current emotion state for mood description.
 */
function writeDiary(entry: string, importance: number, tags: string[]): void {
  const currentTime = now();
  const dateStr = getLocalDate(currentTime);
  const timeStr = getLocalTimeHHMM(currentTime);
  const emotion = hydrateEmotionState(readJSON<Record<string, unknown>>(PATHS.emotionState, {
    mood: { valence: 0.3, arousal: 0.5, description: '普通' },
    energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
    last_updated: null, recent_cause: '',
    momentum: { ...DEFAULT_MOMENTUM },
    undertone: { ...DEFAULT_UNDERTONE },
    impulse_history: [],
    consecutive_high_stress: 0,
    threshold_break_cooldown: 0,
  }));
  appendText(PATHS.diary, `\n## ${dateStr} ${timeStr}\n${entry}\n情绪: ${emotion.mood.description} | 重要性: ${importance}\n标签: ${tags.join(', ')}\n`);
}

/**
 * Clean up old photos from photo-roll (>30 days, unless posted to Instagram).
 */
function cleanupPhotoRoll(): void {
  const rollDir = PATHS.photoRoll;
  if (!fs.existsSync(rollDir)) return;

  const history = readJSON<PostHistory>(PATHS.postHistory, DEFAULT_POST_HISTORY);
  const normalizedHistory: PostHistory = { posts: history.posts.map(normalizePostRecord) };
  const postedPaths = new Set(normalizedHistory.posts.flatMap(p => p.image_local_paths));
  const cutoff = now().getTime() - PHOTO_ROLL_RETENTION_DAYS * 24 * 60 * 60 * 1000;

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

  // Also prune gallery entries older than retention period
  pruneGallery();
}

/**
 * Check engagement stats for posts that are ~24h old and missing stats.
 * Called from heartbeat-tick during regular ticks.
 */
export async function checkPostStats(): Promise<void> {
  const igUser = process.env.INSTAGRAM_USERNAME;
  if (!igUser) return;

  const history = readJSON<PostHistory>(PATHS.postHistory, DEFAULT_POST_HISTORY);
  const normalizedHistory: PostHistory = { posts: history.posts.map(normalizePostRecord) };
  const currentMs = now().getTime();
  const CHECK_AFTER_MS = 24 * 60 * 60 * 1000; // 24h
  const CHECK_WINDOW_MS = 72 * 60 * 60 * 1000; // Only check posts up to 72h old

  // Find posts needing stats
  const postsNeedingStats = normalizedHistory.posts.filter(
    p => !p.stats && (currentMs - p.timestamp) >= CHECK_AFTER_MS && (currentMs - p.timestamp) <= CHECK_WINDOW_MS
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
        checked_at: currentMs,
      });
      console.log(`Stats fetched for media ${post.media_id}`);
    } catch (err) {
      console.error(`Failed to fetch stats for media ${post.media_id}: ${(err as Error).message}`);
    }
  }

  if (statsMap.size > 0) {
    // Immutable update: map over all posts, merging stats where available
    const finalPosts = normalizedHistory.posts.map(p =>
      statsMap.has(p.media_id) ? { ...p, stats: statsMap.get(p.media_id) } : p
    );
    writeJSON(PATHS.postHistory, { posts: finalPosts });
  }
}

/**
 * Write gallery entries for a batch of generated images.
 * Called after generateImageSet() with upload results.
 */
export function writePhotosToGallery(
  images: Array<{ localPath: string; timestamp: number }>,
  uploadResults: Array<{ url: string }>,
  style: ContentStyle,
  description: string,
  tags: string[],
): void {
  const emotion = hydrateEmotionState(readJSON<Record<string, unknown>>(PATHS.emotionState, {
    mood: { valence: 0.3, arousal: 0.5, description: '普通' },
    energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
    last_updated: null, recent_cause: '',
    momentum: { ...DEFAULT_MOMENTUM },
    undertone: { ...DEFAULT_UNDERTONE },
    impulse_history: [],
    consecutive_high_stress: 0,
    threshold_break_cooldown: 0,
  }));

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const upload = uploadResults[i] ?? { url: '' };
    const hour = new Date(img.timestamp).getHours();
    const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    const seq = String(Date.now() % 1000).padStart(3, '0');
    const dateStr = getLocalDate(new Date(img.timestamp)).replace(/-/g, '');

    const photo: GalleryPhoto = {
      id: `${dateStr}_${style}_${timeOfDay}_${seq}`,
      localPath: img.localPath,
      publicUrl: upload.url,
      description,
      tags: [...tags],
      style,
      emotion: { valence: emotion.mood.valence, energy: emotion.energy },
      createdAt: new Date(img.timestamp).toISOString(),
      sharedAt: null,
      shareCount: 0,
      postedToInstagram: false,
    };

    addPhotoToGallery(photo);
  }
}

/**
 * Mark photos as posted to Instagram by localPath.
 */
export function markPhotosAsPosted(localPaths: string[]): void {
  const gallery = readJSON<PhotoGallery>(PATHS.photoGallery, DEFAULT_PHOTO_GALLERY);
  const pathSet = new Set(localPaths);
  const updatedGallery: PhotoGallery = {
    photos: gallery.photos.map(p =>
      pathSet.has(p.localPath) ? { ...p, postedToInstagram: true } : p
    ),
  };
  writeJSON(PATHS.photoGallery, updatedGallery);
}

/**
 * Main pipeline entry point.
 */
async function runPipeline(): Promise<void> {
  const isForced = process.env.FORCED_POST === '1';
  console.log('Post pipeline started.');

  // 0. Cleanup old photos
  cleanupPhotoRoll();

  // 1. Refresh expired inspiration
  await refreshInspiration();

  // 2. Photo phase: does Minase want to take a photo?
  let lastPhotoStyle: ContentStyle | null = null;
  let setResult: GenerateSetResult | null = null;

  try {
    const refDir = PATHS.references;
    const photoIntent = await planPhoto();

    if (!photoIntent.wantToShoot) {
      writeDiary(photoIntent.reason, 2, ['不想拍']);
      console.log(`No photo intent: ${photoIntent.reason}`);
      return;
    }

    console.log(`Photo intent: ${photoIntent.sceneDescription} (${photoIntent.shots.length} shots)`);

    const styleReference = photoIntent.referenceInspiration
      ? path.join(PATHS.inspirationRefs, photoIntent.referenceInspiration)
      : undefined;

    setResult = await generateImageSet({
      shots: photoIntent.shots,
      baseReferenceDir: refDir,
      styleReference,
      style: photoIntent.style,
    });

    if (setResult.images.length === 0) {
      writeDiary('拍照全部失败了...', 3, ['失败']);
      console.error(`All ${setResult.failed} shots failed.`);
      return;
    }

    // Accumulate impulse from successful photos
    let impulse: PostImpulseState = readJSON(PATHS.postImpulse, DEFAULT_POST_IMPULSE);
    const photoBoost = 20 + Math.random() * 10;
    impulse = accumulateImpulse(impulse, photoBoost);
    writeJSON(PATHS.postImpulse, impulse);

    lastPhotoStyle = photoIntent.style;
    writeDiary(photoIntent.reason, 4, ['拍照', photoIntent.style]);
    console.log(`Photos saved: ${setResult.images.length} successful, ${setResult.failed} failed`);

    // Upload all photos to ImgURL and write gallery index
    const uploadResults: Array<{ url: string }> = [];
    for (const img of setResult.images) {
      try {
        const uploadResult = await uploadToImgURL(img.localPath);
        uploadResults.push({ url: uploadResult.url });
      } catch (err) {
        console.error(`ImgURL upload failed for ${img.localPath}: ${(err as Error).message}`);
        uploadResults.push({ url: '' });
      }
    }

    const photoTags = [photoIntent.style, ...(photoIntent.sceneDescription.match(/[\u4e00-\u9fff]+/g) ?? []).slice(0, 5)];
    writePhotosToGallery(setResult.images, uploadResults, photoIntent.style, photoIntent.sceneDescription, photoTags);
  } catch (err) {
    // "拍糊了"
    writeDiary('今天想拍照来着，但是没拍好...手机有点卡', 2, ['拍照', '失败']);
    console.error(`Photo failed: ${(err as Error).message}`);
  }

  // 3. Post phase: does Minase want to share on Instagram?
  const history = readJSON<PostHistory>(PATHS.postHistory, DEFAULT_POST_HISTORY);
  const normalizedHistory: PostHistory = { posts: history.posts.map(normalizePostRecord) };

  if (!isForced) {
    const postCheck = shouldConsiderPosting(normalizedHistory);
    if (!postCheck.allowed) {
      console.log(`[pipeline] shouldConsiderPosting blocked: ${postCheck.reason}`);
      return;
    }
  }

  try {
    const postIntent = await planPost({ skipAdvisor: isForced });

    if (!postIntent.wantToPost || postIntent.selectedPhotos.length === 0) {
      console.log(`No post intent: ${postIntent.reason}`);
      writeDiary(postIntent.reason, 2, ['不想发']);
      return;
    }

    // Verify selected photos exist
    const existingPhotos = postIntent.selectedPhotos.filter(p => {
      if (!fs.existsSync(p)) {
        console.error(`Selected photo not found: ${p}`);
        return false;
      }
      return true;
    });

    if (existingPhotos.length === 0) {
      console.error('No selected photos exist on disk.');
      return;
    }

    // Upload and post to Instagram via instagrapi bridge (direct local file upload)
    const caption = `${postIntent.caption}\n\n${postIntent.hashtags.map(t => `#${t}`).join(' ')}`;
    console.log(`Posting ${existingPhotos.length} photo(s) to Instagram...`);
    const mediaPk = await postToInstagram(existingPhotos, caption);

    // Schedule comment replies 24h after posting
    scheduleCommentCheck({
      media_pk: mediaPk,
      scheduled_after: Date.now() + 24 * 60 * 60 * 1000,
      post_context: {
        caption: postIntent.caption,
        hashtags: postIntent.hashtags,
      },
    });

    // Upload first photo to ImgURL for public URL archival (non-blocking, failure is non-fatal)
    let imageUrl: string | undefined;
    try {
      console.log('Uploading to ImgURL...');
      const imgResult = await uploadToImgURL(existingPhotos[0]);
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
    const newRecord: PostRecord = {
      media_id: mediaPk,
      timestamp: now().getTime(),
      style: inferredStyle,
      caption: postIntent.caption,
      hashtags: postIntent.hashtags,
      image_local_paths: existingPhotos,
      ...(imageUrl && { image_url: imageUrl }),
    };
    const updatedHistory: PostHistory = {
      posts: [...normalizedHistory.posts, newRecord],
    };
    writeJSON(PATHS.postHistory, updatedHistory);

    // Mark posted photos in gallery
    markPhotosAsPosted(existingPhotos);

    // Reset impulse after successful post
    let impulse: PostImpulseState = readJSON(PATHS.postImpulse, DEFAULT_POST_IMPULSE);
    impulse = resetImpulseAfterPost(impulse);
    writeJSON(PATHS.postImpulse, impulse);

    // Diary entry in Minase's voice
    writeDiary(postIntent.reason, 6, ['instagram', 'post']);
    if (isForced) {
      const todayStr = new Date().toLocaleDateString('zh-CN');
      const timeStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      appendText(
        PATHS.diary,
        `\n## ${todayStr} ${timeStr}\n今天差点忘了发帖，赶紧补上了。以后不能这样，发帖是我的工作。\n情绪: 懊悔 | 重要性: 3\n标签: kpi兜底\n`
      );
    }
    console.log(`Posted! Media ID: ${mediaPk}`);
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
