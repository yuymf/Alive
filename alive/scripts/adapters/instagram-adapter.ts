/**
 * alive/scripts/adapters/instagram-adapter.ts
 *
 * Platform adapter that wires alive's platform sub-skills (instagram-bridge,
 * generate-image, content-planner, gallery, xhs-bridge) into the abstract
 * ctx.config interfaces expected by the orchestration sub-skills (instagram,
 * social-engagement, content-browse).
 *
 * Usage: Call createInstagramConfig(), createSocialEngagementConfig(), and
 * createContentBrowseConfig() to get config objects that can be injected
 * into the respective sub-skill contexts.
 *
 * Architecture:
 *   orchestration layer (alive/sub-skills/instagram)
 *       ↑ ctx.config injection
 *   adapter layer (this file)
 *       ↓ direct imports
 *   platform sub-skills (alive/sub-skills/platform/*)
 */

// === Platform sub-skill imports ===

// Instagram bridge
import {
  uploadAlbum,
  getComments as igGetComments,
  replyComment as igReplyComment,
  postComment as igPostComment,
  getUserFeed,
  hashtagTop,
  getMediaInsights,
  getUserInfo,
} from '../../sub-skills/platform/instagram-bridge/scripts/bridge-client';

// Generate image
import { generateImageSet } from '../../sub-skills/platform/generate-image/scripts/provider';
import { selectReferences } from '../../sub-skills/platform/generate-image/scripts/reference-selector';
import type { ContentStyle } from '../../sub-skills/platform/generate-image/scripts/prompt-builder';

// Content planner
import {
  planPhoto as cpPlanPhoto,
  planPost as cpPlanPost,
} from '../../sub-skills/platform/content-planner/scripts/planner';

// Gallery (for ImgURL upload + gallery index)
import { uploadToImgURL } from '../../sub-skills/platform/gallery/scripts/imgurl-upload';
import { addPhotoToGallery, pruneGallery } from '../../sub-skills/platform/gallery/scripts/gallery-ops';

// XHS bridge
import {
  listXhsFeed,
  searchXhsNotes,
  isXhsAvailable,
} from '../../sub-skills/platform/xhs-bridge/scripts/xhs-client';

// Douyin bridge
import {
  searchDouyinVideos,
  checkDouyinLogin,
} from '../../sub-skills/platform/douyin-bridge/scripts/douyin-client';

// Alive infra
import * as fs from 'fs';
import * as path from 'path';
import { PATHS, readJSON, writeJSON, appendText } from '../utils/file-utils';
import { now, getLocalDate } from '../utils/time-utils';
import type { PostHistory, PostRecord, PhotoGallery, GalleryPhoto, EmotionState } from '../utils/types';
import { DEFAULT_PHOTO_GALLERY, hydrateEmotionState, DEFAULT_MOMENTUM, DEFAULT_UNDERTONE } from '../utils/types';

// ═══════════════════════════════════════════════════════════════════
// INSTAGRAM sub-skill adapter
// ═══════════════════════════════════════════════════════════════════

/**
 * Create the config object for alive/sub-skills/instagram.
 * Wires content-planner + generate-image + instagram-bridge into the
 * abstract planPhoto/generateImages/planPost/publishPost callbacks.
 */
export function createInstagramConfig() {
  return {
    /**
     * Plan what to photograph (content-planner → PhotoIntent)
     */
    async planPhoto(_emotion: unknown, _inspiration: unknown, _confidence: number) {
      const intent = await cpPlanPhoto();
      // Map content-planner's PhotoIntent → instagram's expected shape
      return {
        style: intent.style,
        scene_description: intent.sceneDescription,
        outfit_description: intent.shots[0]?.outfit ?? '',
        emotion_tone: intent.mood,
        shots: intent.shots.map(s => ({
          description: s.description,
          camera_angle: s.angle,
          mood: s.variation,
        })),
      };
    },

    /**
     * Generate images from a photo intent (generate-image sub-skill)
     * Also writes generated images to gallery index.
     */
    async generateImages(photoIntent: {
      style: string;
      shots: Array<{ description: string; camera_angle: string; mood: string }>;
      scene_description?: string;
    }) {
      const style = photoIntent.style as ContentStyle;
      const shots = photoIntent.shots.map(s => ({
        description: s.description,
        angle: s.camera_angle,
        variation: s.mood,
      }));

      const result = await generateImageSet({
        shots,
        style,
        baseReferenceDir: PATHS.referencesDir,
        outputDir: PATHS.photoRoll,
      });

      // Upload successful images to ImgURL for public URLs
      const urls: string[] = [];
      for (const img of result.images) {
        try {
          const uploaded = await uploadToImgURL(img.localPath);
          urls.push(uploaded.url);
        } catch {
          urls.push(''); // upload failed, but local path still valid
        }
      }

      // Write to gallery index (migrated from post-pipeline.ts writePhotosToGallery)
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

      const batchId = `${getLocalDate()}_${Date.now()}`;
      for (let i = 0; i < result.images.length; i++) {
        const img = result.images[i];
        const url = urls[i] ?? '';
        const hour = new Date(img.timestamp).getHours();
        const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
        const seq = String(i).padStart(3, '0');
        const dateStr = getLocalDate(new Date(img.timestamp)).replace(/-/g, '');

        const photo: GalleryPhoto = {
          id: `${dateStr}_${style}_${timeOfDay}_${seq}`,
          localPath: img.localPath,
          publicUrl: url,
          description: photoIntent.scene_description ?? shots[i]?.description ?? '',
          tags: [style as string],
          style,
          emotion: { valence: emotion.mood.valence, energy: emotion.energy },
          createdAt: new Date(img.timestamp).toISOString(),
          sharedAt: null,
          shareCount: 0,
          postedToInstagram: false,
          batchId,
          shotIndex: i,
        };

        addPhotoToGallery(photo);
      }

      return {
        paths: result.images.map(i => i.localPath),
        urls,
      };
    },

    /**
     * Plan post caption + hashtags (content-planner → PostIntent)
     *
     * If the content planner returns wantToPost=false or an empty caption
     * (e.g. because photo-roll is empty at plan time), we generate a
     * minimal but natural-sounding fallback caption based on the photo intent.
     */
    async planPost(
      photoIntent: unknown,
      _imagePaths: string[],
      _emotion: unknown,
      _confidence: number,
    ) {
      const intent = await cpPlanPost();

      // If cpPlanPost returned a meaningful caption, use it directly
      if (intent.caption && intent.caption.trim().length > 0) {
        console.log(`[instagram-adapter] planPost caption: "${intent.caption.slice(0, 60)}…"`);
        return {
          caption: intent.caption,
          hashtags: intent.hashtags,
          style: '',
          photo_paths: intent.selectedPhotos,
        };
      }

      // Fallback: cpPlanPost returned empty caption (wantToPost=false or LLM parse issue)
      // Generate a natural-sounding default caption from photo intent context
      const pi = photoIntent as { style?: string; scene_description?: string; emotion_tone?: string } | undefined;
      const style = pi?.style ?? '';
      const scene = pi?.scene_description ?? '';
      const tone = pi?.emotion_tone ?? '';

      // Build a simple, human-feeling caption
      const fallbackCaptions = [
        scene ? `${scene.slice(0, 40)}...` : null,
        tone ? `今天的心情：${tone}` : null,
        style ? `#${style.replace(/\s+/g, '')}` : null,
        '📷',
      ].filter(Boolean);
      const fallbackCaption = fallbackCaptions.join(' ');

      console.warn(`[instagram-adapter] planPost returned empty caption, using fallback: "${fallbackCaption}"`);

      return {
        caption: fallbackCaption,
        hashtags: intent.hashtags.length > 0 ? intent.hashtags : ['photography', 'daily'],
        style: '',
        photo_paths: intent.selectedPhotos,
      };
    },

    /**
     * Publish to Instagram (instagram-bridge → upload album)
     */
    async publishPost(postIntent: {
      caption: string;
      hashtags: string[];
      photo_paths: string[];
    }) {
      const caption = postIntent.caption +
        (postIntent.hashtags.length > 0
          ? '\n\n' + postIntent.hashtags.map(h => `#${h}`).join(' ')
          : '');

      try {
        const mediaPk = await uploadAlbum(postIntent.photo_paths, caption);
        return { media_id: mediaPk, success: true };
      } catch (err) {
        console.error(`[instagram-adapter] publishPost failed: ${(err as Error).message}`);
        return { media_id: '', success: false };
      }
    },

    /**
     * Schedule a comment check for later
     */
    scheduleCommentCheck(mediaPk: string, caption: string) {
      const pending = readJSON<Array<{ media_pk: string; scheduled_after: number; post_context: unknown }>>
        (PATHS.pendingEngagement, []);
      pending.push({
        media_pk: mediaPk,
        scheduled_after: Date.now() + 24 * 60 * 60 * 1000,
        post_context: { caption, hashtags: [] },
      });
      writeJSON(PATHS.pendingEngagement, pending);
    },

    /**
     * Check post stats (instagram-bridge → get_media_insights)
     */
    async checkPostStats(mediaId: string) {
      const insights = await getMediaInsights(mediaId);
      return {
        likes: (insights as any).like_count ?? 0,
        comments: (insights as any).comment_count ?? 0,
        reach: (insights as any).reach ?? 0,
        saves: (insights as any).saved ?? 0,
      };
    },

    /**
     * Get follower count
     */
    async getFollowerCount() {
      const igUser = process.env.INSTAGRAM_USER_ID ?? '';
      if (!igUser) return 0;
      const info = await getUserInfo(igUser);
      return info.follower_count ?? 0;
    },

    followerBaseline: 100,

    /**
     * Mark photos as posted to Instagram in the gallery index.
     */
    markPhotosAsPosted(localPaths: string[]) {
      const gallery = readJSON<PhotoGallery>(PATHS.photoGallery, DEFAULT_PHOTO_GALLERY);
      const pathSet = new Set(localPaths);
      const updatedGallery: PhotoGallery = {
        photos: gallery.photos.map(p =>
          pathSet.has(p.localPath) ? { ...p, postedToInstagram: true } : p
        ),
      };
      writeJSON(PATHS.photoGallery, updatedGallery);
    },

    /**
     * Normalize old PostRecord (backward compat: image_local_path → image_local_paths).
     */
    normalizePostRecord(post: PostRecord): PostRecord {
      if (!post.image_local_paths && (post as any).image_local_path) {
        return { ...post, image_local_paths: [(post as any).image_local_path] };
      }
      return post;
    },

    /**
     * Clean up old photos from photo-roll (>30 days, unless referenced by posts).
     * Also prunes the gallery index.
     */
    cleanupPhotoRoll() {
      const rollDir = PATHS.photoRoll;
      if (!fs.existsSync(rollDir)) return;

      const RETENTION_DAYS = 30;
      const history = readJSON<PostHistory>(PATHS.postHistory, { posts: [] });
      const normalizedPosts = history.posts.map(p => {
        if (!p.image_local_paths && (p as any).image_local_path) {
          return { ...p, image_local_paths: [(p as any).image_local_path] };
        }
        return p;
      });
      const postedPaths = new Set(normalizedPosts.flatMap(p => p.image_local_paths));
      const cutoff = now().getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

      for (const dateDir of fs.readdirSync(rollDir)) {
        const dirPath = path.join(rollDir, dateDir);
        if (!fs.statSync(dirPath).isDirectory()) continue;

        const dirDate = new Date(dateDir).getTime();
        if (isNaN(dirDate) || dirDate > cutoff) continue;

        for (const file of fs.readdirSync(dirPath)) {
          const filePath = path.join(dirPath, file);
          if (!postedPaths.has(filePath)) {
            fs.unlinkSync(filePath);
          }
        }

        if (fs.readdirSync(dirPath).length === 0) {
          fs.rmdirSync(dirPath);
        }
      }

      pruneGallery();
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// SOCIAL-ENGAGEMENT sub-skill adapter
// ═══════════════════════════════════════════════════════════════════

/**
 * Create the config object for alive/sub-skills/social-engagement.
 * Wires instagram-bridge's comment/engagement functions.
 */
export function createSocialEngagementConfig() {
  return {
    /**
     * Get comments on a post (instagram-bridge)
     */
    async getComments(mediaPk: string, limit: number) {
      return igGetComments(mediaPk, limit);
    },

    /**
     * Reply to a comment (instagram-bridge)
     */
    async replyComment(mediaPk: string, commentPk: string, text: string) {
      return igReplyComment(mediaPk, commentPk, text);
    },

    /**
     * Post a new comment (instagram-bridge)
     */
    async postComment(mediaPk: string, text: string) {
      return igPostComment(mediaPk, text);
    },

    /**
     * Get candidate posts for outbound engagement.
     * Uses hashtag search + user feed from instagram-bridge.
     */
    async getCandidates() {
      const candidates: Array<{
        media_pk: string;
        user_id: string;
        username: string;
        caption: string;
        like_count: number;
        comment_count: number;
      }> = [];

      // Hashtag discovery
      const hashtags = ['cosplay', 'コスプレ', 'coser'];
      for (const tag of hashtags.slice(0, 2)) {
        try {
          const result = await hashtagTop(tag, 10);
          for (const post of result.posts) {
            candidates.push({
              media_pk: post.pk,
              user_id: post.user_id,
              username: post.username,
              caption: post.caption_text,
              like_count: post.like_count,
              comment_count: post.comment_count,
            });
          }
        } catch { /* non-critical */ }
      }

      return candidates;
    },

    /**
     * Pending media PKs for comment reply (read from state)
     */
    get pendingMediaPks() {
      const pending = readJSON<Array<{ media_pk: string; scheduled_after: number }>>(
        PATHS.pendingEngagement, [],
      );
      return pending
        .filter(p => Date.now() >= p.scheduled_after)
        .map(p => p.media_pk);
    },

    /**
     * Post captions keyed by media_pk (for context in comment replies)
     */
    get postCaptions() {
      const pending = readJSON<Array<{ media_pk: string; post_context: { caption: string } }>>(
        PATHS.pendingEngagement, [],
      );
      const captions: Record<string, string> = {};
      for (const p of pending) {
        captions[p.media_pk] = p.post_context?.caption ?? '';
      }
      return captions;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// CONTENT-BROWSE sub-skill adapter
// ═══════════════════════════════════════════════════════════════════

import { ContentProviderRegistry } from './content-provider';
import type { ContentItem, ContentSourcesConfig } from '../utils/types';

/**
 * Create the config object for alive/sub-skills/content-browse.
 * Wires xhs-bridge + instagram-bridge as default feed/search providers.
 * When a ContentProviderRegistry is provided, aggregates all registered
 * providers alongside the built-in XHS + IG sources.
 */
export function createContentBrowseConfig(options?: {
  webSearch?: (query: string, limit?: number) => Promise<Array<{ title: string; url: string; snippet: string }>>;
  registry?: ContentProviderRegistry;
  contentSources?: ContentSourcesConfig;
  /** Max search results per platform per keyword (default: 5, was 10) */
  maxSearchResults?: number;
}) {
  const registry = options?.registry;
  const contentSources = options?.contentSources;
  const platformFilter = contentSources?.platforms;
  const maxSearchResults = options?.maxSearchResults ?? 5;
  // Only call Instagram APIs if 'instagram' is explicitly in the platform filter, or no filter is set
  const igEnabled = !platformFilter || platformFilter.includes('instagram');

  return {
    /**
     * Get feed items — combines built-in XHS + IG with Registry providers
     */
    async getFeedItems() {
      const items: Array<{
        id: string;
        title: string;
        likes: number;
        user?: string;
        tags?: string[];
        source?: string;
        url?: string;
        snippet?: string;
      }> = [];

      // XHS feed (built-in)
      try {
        if (await isXhsAvailable()) {
          const xhsNotes = await listXhsFeed();
          for (const note of xhsNotes.slice(0, 10)) {
            items.push({
              id: `xhs_${note.id}`,
              title: note.title,
              likes: note.likes,
              user: note.user,
              tags: note.tags,
              source: 'xhs',
            });
          }
        }
      } catch { /* non-critical */ }

      // Instagram hashtag feed (built-in) — only if instagram is in the platform filter (or no filter set)
      if (igEnabled) {
        try {
          const result = await hashtagTop('cosplay', 10);
          for (const post of result.posts) {
            items.push({
              id: `ig_${post.pk}`,
              title: post.caption_text.slice(0, 80),
              likes: post.like_count,
              user: post.username,
              source: 'instagram',
            });
          }
        } catch { /* non-critical */ }
      }

      // Registry providers (multi-platform bridge)
      // Skip if trend-analyzer already fetched hot lists within the last 4 hours
      // (avoids redundant DailyHot API calls when ops-trends already ran)
      if (registry) {
        let skipRegistryFeed = false;
        try {
          const { readJSON } = await import('../utils/file-utils');
          const { PATHS } = await import('../utils/file-utils');
          const trendsCache = readJSON<{ computed_at?: string }>(PATHS.trendsCache, {});
          if (trendsCache.computed_at) {
            const cacheAge = Date.now() - new Date(trendsCache.computed_at).getTime();
            if (cacheAge < 4 * 60 * 60 * 1000) { // 4 hours
              skipRegistryFeed = true;
              console.log(`[content-browse] Skipping Registry feed — trend-analyzer cache is fresh (${Math.round(cacheAge / 60_000)}min old)`);
            }
          }
        } catch { /* non-critical — if cache check fails, proceed with registry */ }

        if (!skipRegistryFeed) {
          try {
            const registryItems = await registry.getAggregatedFeed({
              platforms: platformFilter,
              keywords: contentSources?.keywords,
              limit: maxSearchResults,
            });
            for (const item of registryItems) {
              // Skip if already present (dedup by id)
              if (!items.some(existing => existing.id === item.id)) {
                items.push({
                  id: item.id,
                  title: item.title,
                  likes: item.likes ?? 0,
                  user: item.user,
                  tags: item.tags,
                  source: item.source,
                  url: item.url,
                  snippet: item.snippet,
                });
              }
            }
          } catch { /* non-critical — registry failure does not block built-in sources */ }
        }
      }

      return items;
    },

    /**
     * Search content by keyword — combines built-in XHS + IG with Registry
     */
    async searchContent(keyword: string) {
      const items: Array<{
        id: string;
        title: string;
        likes: number;
        user?: string;
        tags?: string[];
        source?: string;
        url?: string;
        snippet?: string;
      }> = [];

      // XHS search — sort by popularity, filter to recent 7 days
      try {
        if (await isXhsAvailable()) {
          const notes = await searchXhsNotes(keyword, {
            sortBy: '最热',
            publishTime: '7天内',
          });
          for (const note of notes.slice(0, maxSearchResults)) {
            items.push({
              id: `xhs_${note.id}`,
              title: note.title,
              likes: note.likes,
              user: note.user,
              tags: note.tags,
              source: 'xhs',
            });
          }
        }
      } catch { /* non-critical */ }

      // IG hashtag search — only if instagram is in the platform filter (or no filter set)
      if (igEnabled) {
        try {
          const result = await hashtagTop(keyword, maxSearchResults);
          for (const post of result.posts) {
            items.push({
              id: `ig_${post.pk}`,
              title: post.caption_text.slice(0, 80),
              likes: post.like_count,
              user: post.username,
              source: 'instagram',
            });
          }
        } catch { /* non-critical */ }
      }

      // Douyin search (built-in)
      try {
        const douyinLogin = checkDouyinLogin();
        if (douyinLogin.success && douyinLogin.logged_in) {
          const douyinResult = searchDouyinVideos(keyword, maxSearchResults);
          if (douyinResult.success && douyinResult.videos) {
            for (const video of douyinResult.videos.slice(0, maxSearchResults)) {
              items.push({
                id: `douyin_${video.aweme_id}`,
                title: video.desc,
                likes: video.digg_count,
                user: video.author,
                source: 'douyin',
                url: `https://www.douyin.com/video/${video.aweme_id}`,
              });
            }
          }
        }
      } catch { /* non-critical */ }

      // Registry search (multi-platform bridge)
      if (registry) {
        try {
          const registryItems = await registry.search(keyword, {
            platforms: platformFilter,
            limit: maxSearchResults,
          });
          for (const item of registryItems) {
            if (!items.some(existing => existing.id === item.id)) {
              items.push({
                id: item.id,
                title: item.title,
                likes: item.likes ?? 0,
                user: item.user,
                tags: item.tags,
                source: item.source,
                url: item.url,
                snippet: item.snippet,
              });
            }
          }
        } catch { /* non-critical */ }
      }

      // Sort by likes descending so high-engagement content surfaces first
      items.sort((a, b) => b.likes - a.likes);
      return items;
    },

    /**
     * Web search — delegate to caller-provided implementation
     */
    webSearch: options?.webSearch,

    /**
     * Default search keywords — use persona content_sources.keywords if available
     */
    searchKeywords: contentSources?.keywords ?? ['cosplay', 'コスプレ', 'anime'],

    /**
     * The registry instance (exposed for content-browse sub-skill to access source info)
     */
    registry,

    /**
     * Source platforms summary (for LLM prompt injection)
     */
    get sourcePlatforms(): string[] {
      const platforms = ['xhs', 'douyin', 'instagram'];
      if (registry) {
        for (const p of registry.getProviders(platformFilter)) {
          if (!platforms.includes(p.meta.name)) {
            platforms.push(p.meta.name);
          }
        }
      }
      return platforms;
    },

    /**
     * Trend query templates
     */
    get trendQueries() {
      const year = new Date().getFullYear();
      const month = new Date().getMonth() + 1;
      const season = month >= 3 && month <= 5 ? '春季'
        : month >= 6 && month <= 8 ? '夏季'
        : month >= 9 && month <= 11 ? '秋季'
        : '冬季';
      return [
        `${year} ${season} cosplay 趋势`,
        `${year} ${season} anime photography trends`,
        `${year} Instagram cosplayer growth tips`,
      ];
    },
  };
}
