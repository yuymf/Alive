// alive/scripts/router/sub-skill-sdk.ts
// SDK for building sub-skills — re-exports types and provides helpers

export type {
  SubSkillContext,
  SubSkillResult,
  SubSkillManifest,
  SubSkill,
  EmotionDelta,
  EmotionState,
  FeedbackEvent,
  PersonaConfig,
  ResolvedIntent,
  MemoryAccessor,
  SocialGraphAccessor,
  SocialRelation,
  IntentCategory,
} from '../utils/types';

/**
 * Helper to create a SubSkillResult with sensible defaults.
 */
export function createResult(narrative: string, options?: {
  emotion_deltas?: import('../utils/types').EmotionDelta[];
  vitality_cost?: number;
  feedback?: import('../utils/types').FeedbackEvent[];
  events_triggered?: string[];
}): import('../utils/types').SubSkillResult {
  return {
    narrative,
    emotion_deltas: options?.emotion_deltas,
    vitality_cost: options?.vitality_cost,
    feedback: options?.feedback,
    events_triggered: options?.events_triggered,
  };
}

/**
 * Helper to create a FeedbackEvent for the confidence engine.
 */
export function createFeedback(
  source: string,
  metric: number,
  baseline: number,
): import('../utils/types').FeedbackEvent {
  return {
    source,
    metric,
    baseline,
    timestamp: new Date().toISOString(),
  };
}
