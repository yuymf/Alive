// alive/sub-skills/instagram/scripts/index.ts
// Instagram content creation sub-skill
//
// This is the SubSkill interface entry point. The heavy lifting (image generation,
// Instagram API calls, content planning) is done by platform-specific modules
// injected via ctx.config by the host application.
//
// Design decision: Instagram-specific code (instagram-bridge-client, generate-image,
// content-planner, prompt-builder, etc.) is NOT copied into alive/. Instead, the
// host application (e.g. MizuSan skill/) injects these as config callbacks.
// This keeps alive/ platform-agnostic while supporting the full Instagram pipeline.

import * as fs from 'fs';
import * as path from 'path';
import type { SubSkillContext, SubSkillResult, EmotionDelta } from '../../../scripts/router/sub-skill-sdk';
import { createResult, createFeedback } from '../../../scripts/router/sub-skill-sdk';
import { WorkImpulseState, DEFAULT_WORK_IMPULSE_STATE, isFeatureEnabled } from '../../../scripts/utils/types';
import {
  accumulateImpulse, decayImpulse as coreDecayImpulse,
  shouldInjectProduceDesire, resetImpulseAfterOutput,
} from '../../../scripts/engines/work-impulse';

// ── Types (Instagram-specific, declared locally) ─────────────────

export interface ContentStyle {
  type: 'cos' | 'daily' | 'behind_scenes' | 'travel' | 'travel_portrait' | 'travel_food' | 'travel_street';
}

export interface PhotoIntent {
  style: string;
  scene_description: string;
  outfit_description: string;
  emotion_tone: string;
  shots: Array<{
    description: string;
    camera_angle: string;
    mood: string;
  }>;
}

export interface PostIntent {
  caption: string;
  hashtags: string[];
  style: string;
  photo_paths: string[];
  scheduled_time?: string;
}

export interface PostRecord {
  id: string;
  media_id?: string;
  timestamp: string;
  style: string;
  caption: string;
  hashtags: string[];
  photo_urls: string[];
  stats?: {
    likes: number;
    comments: number;
    reach: number;
    saves: number;
    checked_at: string;
  };
}

// ── Template Loader ──────────────────────────────────────────────

function loadTemplate(templateName: string): string {
  const templateDir = path.join(__dirname, '..', 'templates');
  const templatePath = path.join(templateDir, templateName);
  if (fs.existsSync(templatePath)) return fs.readFileSync(templatePath, 'utf8');
  throw new Error(`Template not found: ${templateName}`);
}

// ── Actions ──────────────────────────────────────────────────────

export const actions = {
  /**
   * Full Instagram content creation pipeline.
   *
   * Expects ctx.config to contain platform-specific injections:
   *
   *   - planPhoto(emotion, inspiration, confidence): Promise<PhotoIntent>
   *       Content planning — decides what to shoot
   *
   *   - generateImages(photoIntent): Promise<{paths: string[], urls: string[]}>
   *       Image generation pipeline (prompt building → AI gen → post-process → upload)
   *
   *   - planPost(photoIntent, imagePaths, emotion, confidence): Promise<PostIntent>
   *       Caption + hashtag generation
   *
   *   - publishPost(postIntent): Promise<{media_id: string, success: boolean}>
   *       Instagram API upload + publish
   *
   *   - scheduleCommentCheck?(media_pk: string, caption: string): void
   *       Schedule comment reply for 24h later
   *
   *   - refreshInspiration?(): Promise<void>
   *       Refresh trend/inspiration data before planning
   *
   *   - getFollowerCount?(): Promise<number>
   *       Current follower count for feedback
   *
   *   - followerBaseline?: number
   *       Expected average engagement for confidence feedback
   */
  async 'instagram-post'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const { persona, emotion, confidence, memory, llm, config } = ctx;

    // Required injections
    const planPhoto = config.planPhoto as ((e: unknown, i: unknown, c: number) => Promise<PhotoIntent>) | undefined;
    const generateImages = config.generateImages as ((pi: PhotoIntent) => Promise<{ paths: string[]; urls: string[] }>) | undefined;
    const planPost = config.planPost as ((pi: PhotoIntent, paths: string[], e: unknown, c: number) => Promise<PostIntent>) | undefined;
    const publishPost = config.publishPost as ((intent: PostIntent) => Promise<{ media_id: string; success: boolean }>) | undefined;

    if (!planPhoto || !generateImages || !planPost || !publishPost) {
      return createResult(
        '想发 Instagram 但创作管线未配置',
        { vitality_cost: 0 },
      );
    }

    // Optional injections
    const refreshInspiration = config.refreshInspiration as (() => Promise<void>) | undefined;
    const scheduleCommentCheck = config.scheduleCommentCheck as ((mediaPk: string, caption: string) => void) | undefined;
    const getFollowerCount = config.getFollowerCount as (() => Promise<number>) | undefined;
    const followerBaseline = (config.followerBaseline as number) ?? 100;

    const workImpulseEnabled = isFeatureEnabled(persona, 'work_impulse');
    let impulseState: WorkImpulseState | null = null;

    if (workImpulseEnabled) {
      impulseState = memory.readJSON<WorkImpulseState>('work-impulse', DEFAULT_WORK_IMPULSE_STATE);
      impulseState = coreDecayImpulse(impulseState);

      if (!shouldInjectProduceDesire(impulseState)) {
        // Accumulate from browsing/inspiration
        impulseState = accumulateImpulse(impulseState, 5 + Math.random() * 10);
        memory.writeJSON('work-impulse', impulseState);

        return createResult(
          `发帖冲动还不够强（${Math.round(impulseState.value)}/100）`,
          { vitality_cost: 0 },
        );
      }
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const timeStr = new Date().toTimeString().slice(0, 5);

    // 1. Refresh inspiration (optional)
    if (refreshInspiration) {
      try { await refreshInspiration(); } catch { /* non-critical */ }
    }

    // 2. Plan what to shoot
    const inspirationData = memory.readJSON('inspiration-state', {});
    let photoIntent: PhotoIntent;
    try {
      photoIntent = await planPhoto(emotion, inspirationData, confidence);
    } catch (err) {
      console.error(`[instagram] planPhoto failed: ${(err as Error).message}`);
      return createResult(
        '想拍点什么但没想好',
        { vitality_cost: 10, emotion_deltas: [{ stress: 0.03 }] },
      );
    }

    // 3. Generate images
    let images: { paths: string[]; urls: string[] };
    try {
      images = await generateImages(photoIntent);
    } catch (err) {
      console.error(`[instagram] generateImages failed: ${(err as Error).message}`);
      return createResult(
        '拍照/修图失败了',
        { vitality_cost: 20, emotion_deltas: [{ stress: 0.05, valence: -0.1 }] },
      );
    }

    if (images.paths.length === 0) {
      return createResult(
        '生成的图片质量不够好，放弃发帖',
        { vitality_cost: 15, emotion_deltas: [{ valence: -0.05 }] },
      );
    }

    // 4. Plan post (caption + hashtags)
    let postIntent: PostIntent;
    try {
      postIntent = await planPost(photoIntent, images.paths, emotion, confidence);
    } catch (err) {
      console.error(`[instagram] planPost failed: ${(err as Error).message}`);
      return createResult(
        '图片拍好了但没想好文案',
        { vitality_cost: 15, emotion_deltas: [{ stress: 0.02 }] },
      );
    }

    // Guard: never publish without a caption (empty captions lack 活人感)
    if (!postIntent.caption || postIntent.caption.trim().length === 0) {
      console.warn(`[instagram] planPost returned empty caption, aborting publish`);
      return createResult(
        '想了半天文案还是不满意，算了下次再发',
        { vitality_cost: 10, emotion_deltas: [{ stress: 0.02 }] },
      );
    }

    console.log(`[instagram] Caption: "${postIntent.caption.slice(0, 80)}…", Hashtags: ${postIntent.hashtags.length}`);

    // 5. Publish
    let publishResult: { media_id: string; success: boolean };
    try {
      publishResult = await publishPost({ ...postIntent, photo_paths: images.paths });
    } catch (err) {
      console.error(`[instagram] publishPost failed: ${(err as Error).message}`);
      return createResult(
        '发帖失败了——可能是网络问题',
        { vitality_cost: 20, emotion_deltas: [{ stress: 0.08, valence: -0.1 }] },
      );
    }

    if (!publishResult.success) {
      return createResult(
        'Instagram 上传失败',
        { vitality_cost: 20, emotion_deltas: [{ stress: 0.05, valence: -0.08 }] },
      );
    }

    // 6. Post-publish housekeeping
    // Reset impulse only when the work impulse engine is enabled
    if (workImpulseEnabled && impulseState) {
      impulseState = resetImpulseAfterOutput(impulseState);
      memory.writeJSON('work-impulse', impulseState);
    }

    // Record post history
    const postHistory = memory.readJSON<{ posts: PostRecord[] }>('post-history', { posts: [] });
    const record: PostRecord = {
      id: `p${Date.now()}`,
      media_id: publishResult.media_id,
      timestamp: new Date().toISOString(),
      style: photoIntent.style,
      caption: postIntent.caption,
      hashtags: postIntent.hashtags,
      photo_urls: images.urls,
    };
    postHistory.posts.push(record);
    memory.writeJSON('post-history', postHistory);

    // Schedule comment check (24h later)
    if (scheduleCommentCheck && publishResult.media_id) {
      scheduleCommentCheck(publishResult.media_id, postIntent.caption);
    }

    // Diary entry
    memory.appendDiary(
      `\n## ${dateStr} ${timeStr}\n📸 发了一条 Instagram！\n风格: ${photoIntent.style}\n文案: ${postIntent.caption.slice(0, 100)}\n标签: ${postIntent.hashtags.slice(0, 5).join(' ')}\n情绪: ${emotion.mood.description} | 重要性: 8\n标签: instagram, 创作, ${photoIntent.style}\n`,
    );

    console.log(`[instagram] Published! media_id=${publishResult.media_id}, style=${photoIntent.style}`);

    // Build emotion deltas based on confidence
    const emotionDeltas: EmotionDelta[] = [
      { valence: 0.15, creativity: 0.1, arousal: 0.1 },
    ];
    if (confidence > 1.0) {
      emotionDeltas.push({ valence: 0.05 }); // bonus for high confidence
    }

    // Build feedback for confidence engine
    const feedback = [];
    if (getFollowerCount) {
      try {
        const followers = await getFollowerCount();
        feedback.push(createFeedback('instagram-post', followers, followerBaseline));
      } catch { /* non-critical */ }
    }

    return createResult(
      `发了一条 Instagram（${photoIntent.style}风格）—— ${postIntent.caption.slice(0, 60)}`,
      {
        vitality_cost: 40,
        emotion_deltas: emotionDeltas,
        feedback,
      },
    );
  },

  /**
   * Check post stats for recent posts and generate feedback.
   * Called periodically (e.g. 24-48h after posting).
   *
   * Expects ctx.config:
   *   - checkPostStats(media_id): Promise<{likes, comments, reach, saves}>
   */
  async 'instagram-check-stats'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const { memory, config } = ctx;

    const checkPostStats = config.checkPostStats as ((mediaId: string) => Promise<{
      likes: number; comments: number; reach: number; saves: number;
    }>) | undefined;

    if (!checkPostStats) {
      return createResult('数据查看功能未配置', { vitality_cost: 0 });
    }

    const postHistory = memory.readJSON<{ posts: PostRecord[] }>('post-history', { posts: [] });
    const uncheckedPosts = postHistory.posts.filter(
      p => p.media_id && !p.stats && Date.now() - new Date(p.timestamp).getTime() > 24 * 60 * 60 * 1000,
    );

    if (uncheckedPosts.length === 0) {
      return createResult('没有需要查看数据的帖子', { vitality_cost: 0 });
    }

    let checkedCount = 0;
    const feedback = [];

    for (const post of uncheckedPosts.slice(0, 3)) {
      try {
        const stats = await checkPostStats(post.media_id!);
        post.stats = { ...stats, checked_at: new Date().toISOString() };
        checkedCount++;

        // Generate feedback for confidence engine
        const engagement = stats.likes + stats.comments * 3;
        const avgEngagement = (config.avgEngagement as number) ?? 50;
        feedback.push(createFeedback('instagram-stats', engagement, avgEngagement));
      } catch (err) {
        console.error(`[instagram] checkStats failed for ${post.media_id}: ${(err as Error).message}`);
      }
    }

    if (checkedCount > 0) {
      memory.writeJSON('post-history', postHistory);
    }

    const bestPost = uncheckedPosts.reduce((best, p) =>
      (p.stats && (!best.stats || (p.stats.likes > best.stats.likes))) ? p : best,
    );

    const narrative = checkedCount > 0
      ? `查了 ${checkedCount} 条帖子的数据${bestPost.stats ? `，最好的一条有 ${bestPost.stats.likes} 个赞` : ''}`
      : '查数据失败了';

    return createResult(narrative, {
      vitality_cost: 5,
      feedback,
      emotion_deltas: checkedCount > 0
        ? [{ valence: 0.03 }]
        : [],
    });
  },
};
