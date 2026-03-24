/**
 * gallery sub-skill — photo gallery management and sharing.
 *
 * Service sub-skill: provides gallery search, send, and generate-and-send.
 * Called by the orchestration layer or other sub-skills.
 */

import type { SubSkillContext, SubSkillResult } from '../../../../scripts/utils/types';
import {
  searchGallery,
  sendPhoto,
  generateAndSend,
  addPhotoToGallery,
  updateGalleryAfterShare,
  pruneGallery,
  sendViaOpenClaw,
} from './gallery-ops';
import { uploadToImgURL } from './imgurl-upload';

// Re-export all functions for direct import by other sub-skills
export {
  searchGallery,
  sendPhoto,
  generateAndSend,
  addPhotoToGallery,
  updateGalleryAfterShare,
  pruneGallery,
  sendViaOpenClaw,
} from './gallery-ops';

export { uploadToImgURL } from './imgurl-upload';

// Re-export types
export type {
  GalleryPhoto,
  PhotoGallery,
  GallerySearchResult,
  GallerySendResult,
} from './gallery-ops';

export { DEFAULT_PHOTO_GALLERY } from './gallery-ops';

// Actions (for router-based invocation)
export const actions: Record<string, (ctx: SubSkillContext) => Promise<SubSkillResult>> = {
  async 'gallery-search'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const query = ctx.config.query as string;
    const limit = (ctx.config.limit as number) || 5;
    const result = searchGallery(query, limit);
    return {
      narrative: `Found ${result.total} photos matching "${query}", returning top ${result.results.length}`,
    };
  },

  async 'gallery-send'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const { id, channel, target, caption } = ctx.config as {
      id: string; channel: string; target: string; caption?: string;
    };
    const result = sendPhoto(id, channel, target, caption);
    if (!result.success) {
      return { narrative: `Failed to send photo: ${result.error}` };
    }
    return {
      narrative: `Photo ${id} sent successfully`,
      emotion_deltas: [{ sociability: 0.1, valence: 0.1 }],
    };
  },

  async 'gallery-generate-and-send'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const { prompt, style, channel, target, caption } = ctx.config as {
      prompt: string; style: string; channel: string; target: string; caption?: string;
    };
    const result = await generateAndSend(prompt, style as any, channel, target, caption);
    if (!result.success) {
      return { narrative: `Generate-and-send failed: ${result.error}` };
    }
    return {
      narrative: `Generated and sent photo ${result.photoId}`,
      emotion_deltas: [{ creativity: 0.2, sociability: 0.1, valence: 0.15 }],
      vitality_cost: 8,
    };
  },

  async 'gallery-prune'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const gallery = pruneGallery();
    return {
      narrative: `Gallery pruned, ${gallery.photos.length} photos remaining`,
    };
  },
};

export const manifest = {
  name: 'gallery',
  display_name: '照片画廊',
  version: '0.1.0',
  description: '照片搜索、分享、画廊管理',
  intent_bindings: [],
};
