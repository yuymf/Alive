/**
 * instagram-bridge sub-skill — Instagram platform API layer.
 *
 * This is a "service" sub-skill: it provides API wrappers for other sub-skills
 * to import directly, rather than binding to intents.
 * Intent bindings are empty because this sub-skill is called by the
 * instagram orchestration layer, not by the router directly.
 */

import type { SubSkillContext, SubSkillResult } from '../../../../scripts/utils/types';
import {
  uploadAlbum,
  getComments,
  replyComment,
  postComment,
  getUserFeed,
  hashtagTop,
  hashtagRecent,
  getMediaInsights,
  getUserInfo,
} from './bridge-client';

// Re-export all client functions for direct import by other sub-skills
export {
  callInstagramBridge,
  uploadAlbum,
  getComments,
  replyComment,
  postComment,
  getUserFeed,
  hashtagTop,
  hashtagRecent,
  getMediaInsights,
  getUserInfo,
} from './bridge-client';

// Re-export types
export type {
  InstagramComment,
  InstagramMediaSummary,
  InstagramHashtagPost,
  InstagramHashtagResult,
  CommentResult,
} from './bridge-client';

// Actions (can be called via router if intent_bindings are added later)
export const actions: Record<string, (ctx: SubSkillContext) => Promise<SubSkillResult>> = {
  /**
   * Upload an album to Instagram.
   * Expects ctx.config.imagePaths (string[]) and ctx.config.caption (string).
   */
  async 'ig-upload-album'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const imagePaths = ctx.config.imagePaths as string[];
    const caption = ctx.config.caption as string;
    if (!imagePaths?.length || !caption) {
      return { narrative: 'Missing imagePaths or caption in config' };
    }
    const mediaPk = await uploadAlbum(imagePaths, caption);
    console.log(`[instagram-bridge] Album uploaded: ${mediaPk}`);
    return {
      narrative: `Album published to Instagram (media_pk: ${mediaPk})`,
      emotion_deltas: [{ valence: 0.2, arousal: 0.1, creativity: 0.1 }],
    };
  },

  /**
   * Get comments on a media post.
   */
  async 'ig-get-comments'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const mediaPk = ctx.config.mediaPk as string;
    const amount = (ctx.config.amount as number) || 20;
    const comments = await getComments(mediaPk, amount);
    return {
      narrative: `Retrieved ${comments.length} comments`,
    };
  },

  /**
   * Reply to a comment.
   */
  async 'ig-reply-comment'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const { mediaPk, commentPk, text } = ctx.config as { mediaPk: string; commentPk: string; text: string };
    const result = await replyComment(mediaPk, commentPk, text);
    return {
      narrative: result.success ? `Replied to comment ${commentPk}` : 'Failed to reply',
    };
  },

  /**
   * Search hashtag top posts.
   */
  async 'ig-hashtag-search'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const name = ctx.config.hashtag as string;
    const amount = (ctx.config.amount as number) || 15;
    const result = await hashtagTop(name, amount);
    return {
      narrative: `Found ${result.posts.length} top posts for #${result.hashtag}`,
    };
  },

  /**
   * Get user feed.
   */
  async 'ig-get-feed'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const userId = ctx.config.userId as string;
    const amount = (ctx.config.amount as number) || 5;
    const feed = await getUserFeed(userId, amount);
    return {
      narrative: `Retrieved ${feed.length} feed items`,
    };
  },
};

// Manifest (loaded from manifest.json in production)
export const manifest = {
  name: 'instagram-bridge',
  display_name: 'Instagram API 桥接',
  version: '0.1.0',
  description: 'Instagram 平台 API 封装',
  intent_bindings: [],
};
