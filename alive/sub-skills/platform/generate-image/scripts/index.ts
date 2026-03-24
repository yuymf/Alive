/**
 * generate-image sub-skill — AI image generation pipeline.
 *
 * Service sub-skill: provides image generation capabilities.
 * Called by the instagram orchestration layer, not by router directly.
 */

import type { SubSkillContext, SubSkillResult } from '../../../../scripts/utils/types';
import {
  generateImage,
  generateImageSet,
  generateReferences,
  buildImagePrompt,
  buildRealisticPrompt,
  sanitizeForImageGen,
  loadReferenceBase64,
  callImageProvider,
  getImageEntry,
} from './provider';
import { selectReferences, isSelfieType } from './reference-selector';
import { postProcessImage, getProcessingParams } from './post-process';
import { setTravelCityGetter } from './prompt-builder';

// Re-export everything for direct import by other sub-skills
export {
  generateImage,
  generateImageSet,
  generateReferences,
  buildImagePrompt,
  buildRealisticPrompt,
  sanitizeForImageGen,
  loadReferenceBase64,
  callImageProvider,
  getImageEntry,
} from './provider';
export { selectReferences, isSelfieType } from './reference-selector';
export { postProcessImage, getProcessingParams } from './post-process';
export { setTravelCityGetter } from './prompt-builder';

// Re-export types
export type {
  ContentStyle,
  ImageEntry,
  ShotDescription,
  GenerateImageOptions,
  GenerateImageResult,
  GenerateSetOptions,
  GenerateSetResult,
} from './provider';

// Actions (for router-based invocation if needed)
export const actions: Record<string, (ctx: SubSkillContext) => Promise<SubSkillResult>> = {
  async 'generate-image-set'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const config = ctx.config as {
      shots: Array<{ description: string; angle: string; variation: string }>;
      style: string;
      baseReferenceDir: string;
      outputDir?: string;
      fallbackReferenceImage?: string;
    };

    const result = await generateImageSet({
      shots: config.shots,
      style: config.style as any,
      baseReferenceDir: config.baseReferenceDir,
      outputDir: config.outputDir,
      fallbackReferenceImage: config.fallbackReferenceImage,
    });

    return {
      narrative: `Generated ${result.images.length} images (${result.failed} failed)`,
      emotion_deltas: [{ creativity: 0.2, valence: 0.1 }],
      vitality_cost: 5 * result.images.length,
    };
  },

  async 'generate-references'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const config = ctx.config as { sourcePath: string; outputDir: string };
    await generateReferences(config.sourcePath, config.outputDir);
    return {
      narrative: 'Reference images generated',
    };
  },
};

export const manifest = {
  name: 'generate-image',
  display_name: 'AI 图像生成',
  version: '0.1.0',
  description: 'AI 图像生成全链路',
  intent_bindings: [],
};
