/**
 * content-planner sub-skill — content decision engine.
 *
 * Service sub-skill: provides photo/post intent planning, style ratio management,
 * and advisor consultation.
 * Called by the orchestration layer, not by router directly.
 */

import type { SubSkillContext, SubSkillResult } from '../../../../scripts/utils/types';
import {
  planPhoto,
  planPost,
  shouldConsiderPosting,
  normalizeBatchOutfits,
  filterAlreadyPostedPhotos,
  resolvePostSelection,
} from './planner';
import { consultAdvisor } from './advisor';
import { calcTravelPhase, advanceTravelState } from './travel-state';

// Re-export all functions for direct import by other sub-skills
export {
  planPhoto,
  planPost,
  shouldConsiderPosting,
  normalizeBatchOutfits,
  filterAlreadyPostedPhotos,
  resolvePostSelection,
} from './planner';

export { consultAdvisor } from './advisor';
export type { AdvisorContext } from './advisor';

export {
  calcTravelPhase,
  advanceTravelState,
} from './travel-state';

// Re-export types
export type {
  PhotoIntent,
  PostIntent,
  PostHistory,
  PostRecord,
  InspirationData,
  ShotDescription,
} from './planner';

export type {
  TravelState,
  TravelSpot,
  TravelPhase,
} from './travel-state';

export { DEFAULT_TRAVEL_STATE } from './travel-state';

// Actions (for router-based invocation)
export const actions: Record<string, (ctx: SubSkillContext) => Promise<SubSkillResult>> = {
  async 'plan-photo'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const intent = await planPhoto();
    if (!intent.wantToShoot) {
      return {
        narrative: `不想拍照：${intent.reason}`,
      };
    }
    return {
      narrative: `想拍 ${intent.style} — ${intent.sceneDescription.slice(0, 60)}… (${intent.imageCount} shots)`,
      emotion_deltas: [{ creativity: 0.1, valence: 0.05 }],
    };
  },

  async 'plan-post'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const skipAdvisor = ctx.config.skipAdvisor as boolean | undefined;
    const intent = await planPost({ skipAdvisor });
    if (!intent.wantToPost) {
      return {
        narrative: `不想发帖：${intent.reason}`,
      };
    }
    return {
      narrative: `想发 ${intent.selectedPhotos.length} 张照片 — "${intent.caption.slice(0, 40)}…"`,
      emotion_deltas: [{ sociability: 0.1, valence: 0.1 }],
    };
  },

  async 'consult-advisor'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const advCtx = ctx.config as {
      currentCity: string; country: string; followerCount: number;
      recentPostsSummary: string; trendingTopics: string;
    };
    const advice = await consultAdvisor(advCtx);
    return {
      narrative: advice || '（今天没联系到小慧）',
    };
  },
};

export const manifest = {
  name: 'content-planner',
  display_name: '内容策划引擎',
  version: '0.1.0',
  description: '内容决策引擎 — 拍照意图、发帖决策、风格比例管理',
  intent_bindings: [],
};
