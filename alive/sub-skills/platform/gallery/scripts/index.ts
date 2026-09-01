/**
 * gallery sub-skill — photo gallery management and sharing.
 *
 * Service sub-skill: provides gallery search, send, and generate-and-send.
 * Called by the orchestration layer or other sub-skills.
 */

import * as fs from 'fs';
import type { SubSkillContext, SubSkillResult } from '../../../../scripts/utils/types';
import { PATHS } from '../../../../scripts/utils/file-utils';
import {
  searchGallery,
  sendPhoto,
  generateAndSend,
  addPhotoToGallery,
  updateGalleryAfterShare,
  pruneGallery,
  sendMedia,
  shareLifePhoto,
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
  sendMedia,
  shareLifePhoto,
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

  async 'share-life'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const caption = (ctx.config.caption as string)
      || ctx.intent?.description
      || '随手拍的';
    const existing = shareLifePhoto(caption);
    if (existing.photoId) {
      return {
        narrative: `发了张自拍 ${existing.photoId}`,
        emotion_deltas: [{ sociability: 0.12, valence: 0.1, creativity: 0.05 }],
        vitality_cost: 6,
      };
    }
    const refsDir = PATHS.referencesDir;
    if (fs.existsSync(refsDir) && fs.readdirSync(refsDir).some((n) => !n.startsWith('.'))) {
      const result = await generateAndSend(caption, 'daily', 'owner', 'user', caption);
      if (result.success) {
        return {
          narrative: `拍了张新的发你 ${result.photoId}`,
          emotion_deltas: [{ creativity: 0.2, sociability: 0.1, valence: 0.15 }],
          vitality_cost: 10,
        };
      }
    }
    return {
      narrative: existing.textOnly ? '相册空，先发了文字心得' : '自拍没发出去',
      emotion_deltas: [{ valence: 0.04 }],
      vitality_cost: 2,
    };
  },
};

export const manifest = {
  name: 'gallery',
  display_name: '照片画廊',
  version: '0.2.0',
  description: '自拍、生活照、画廊分享',
  intent_bindings: [
    { intent: 'express', action: 'share-life', priority: 8 },
    { intent: 'connect', action: 'share-life', priority: 6 },
  ],
};
