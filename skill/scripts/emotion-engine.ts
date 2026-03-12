// skill/scripts/emotion-engine.ts
// Emotion computation engine (Spec §6)

import { EmotionState, EmotionDelta, EMOTION_BASELINE } from './types';

const DECAY_RATE = 0.1; // 10% per hour toward baseline

/**
 * Clamp a value within [min, max].
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Derive a mood description word from valence and arousal.
 * Uses a 2D emotion model (Russell's circumplex):
 *   high arousal + positive valence → 兴奋/开心
 *   low arousal  + positive valence → 放松/满足
 *   high arousal + negative valence → 焦虑/烦躁
 *   low arousal  + negative valence → 低落/疲倦
 */
export function describeMood(valence: number, arousal: number): string {
  if (valence > 0.5 && arousal > 0.6) return '超开心';
  if (valence > 0.5 && arousal > 0.3) return '开心';
  if (valence > 0.2 && arousal > 0.6) return '兴奋';
  if (valence > 0.2 && arousal > 0.3) return '不错';
  if (valence > 0.0 && arousal <= 0.3) return '平静';
  if (valence > -0.2) return '普通';
  if (valence > -0.5 && arousal > 0.6) return '焦虑';
  if (valence > -0.5 && arousal > 0.3) return '有点烦';
  if (valence > -0.5) return '低落';
  if (arousal > 0.5) return '很烦躁';
  return '很低落';
}

/**
 * Decay all emotion dimensions toward ESTP baseline by DECAY_RATE.
 * Called once per heartbeat (~1 hour). (Spec §6: 10% per hour)
 */
export function decayTowardBaseline(state: EmotionState): EmotionState {
  const decay = (current: number, baseline: number): number =>
    current + (baseline - current) * DECAY_RATE;

  const newValence = clamp(decay(state.mood.valence, EMOTION_BASELINE.valence!), -1.0, 1.0);
  const newArousal = clamp(decay(state.mood.arousal, EMOTION_BASELINE.arousal!), 0, 1.0);

  return {
    ...state,
    mood: {
      valence: newValence,
      arousal: newArousal,
      description: describeMood(newValence, newArousal),
    },
    energy: clamp(decay(state.energy, EMOTION_BASELINE.energy!), 0, 1.0),
    stress: clamp(decay(state.stress, EMOTION_BASELINE.stress!), 0, 1.0),
    creativity: clamp(decay(state.creativity, EMOTION_BASELINE.creativity!), 0, 1.0),
    sociability: clamp(decay(state.sociability, EMOTION_BASELINE.sociability!), 0, 1.0),
  };
}

/**
 * Apply an emotion delta to current state. Clamps all values within valid ranges.
 */
export function applyDelta(state: EmotionState, delta: EmotionDelta, cause: string): EmotionState {
  const newValence = clamp(state.mood.valence + (delta.valence ?? 0), -1.0, 1.0);
  const newArousal = clamp(state.mood.arousal + (delta.arousal ?? 0), 0, 1.0);
  return {
    mood: {
      valence: newValence,
      arousal: newArousal,
      description: describeMood(newValence, newArousal),
    },
    energy: clamp(state.energy + (delta.energy ?? 0), 0, 1.0),
    stress: clamp(state.stress + (delta.stress ?? 0), 0, 1.0),
    creativity: clamp(state.creativity + (delta.creativity ?? 0), 0, 1.0),
    sociability: clamp(state.sociability + (delta.sociability ?? 0), 0, 1.0),
    last_updated: new Date().toISOString(),
    recent_cause: cause,
  };
}

/**
 * Known event deltas (Spec §6 table).
 */
export const EVENT_DELTAS: Record<string, { delta: EmotionDelta; cause: string }> = {
  post_data_good: {
    delta: { valence: 0.3, arousal: 0.2, energy: 0.1, stress: -0.1, creativity: 0.2, sociability: 0.2 },
    cause: '帖子数据不错',
  },
  post_data_bad: {
    delta: { valence: -0.3, arousal: 0.1, energy: -0.1, stress: 0.2, creativity: -0.1, sociability: -0.2 },
    cause: '帖子数据不太好',
  },
  warm_comment: {
    delta: { valence: 0.2, arousal: 0.1, energy: 0.1, stress: -0.1, sociability: 0.3 },
    cause: '收到暖心评论',
  },
  troll_comment: {
    delta: { valence: -0.2, arousal: 0.3, energy: -0.1, stress: 0.3, sociability: -0.2 },
    cause: '收到杠精评论',
  },
  found_inspiration: {
    delta: { valence: 0.2, arousal: 0.2, creativity: 0.4 },
    cause: '发现好灵感',
  },
  completed_cos_work: {
    delta: { valence: 0.4, arousal: -0.1, energy: -0.2, stress: -0.3, creativity: -0.1, sociability: 0.2 },
    cause: '完成了一个cos作品',
  },
  worked_4_hours: {
    delta: { arousal: -0.1, energy: -0.2, stress: 0.1, creativity: -0.1 },
    cause: '工作了4小时',
  },
  finished_exercise: {
    delta: { valence: 0.1, arousal: -0.2, energy: 0.2, stress: -0.2 },
    cause: '健身完',
  },
  relaxed: {
    delta: { valence: 0.1, arousal: -0.2, energy: 0.1, stress: -0.2, creativity: 0.1 },
    cause: '追番/摸鱼放松了',
  },
};

// === Dimension Coupling (digital-life-comparison §2.1) ===
// Non-linear interactions between emotion dimensions and intent weights.

/**
 * Compute intent intensity multipliers based on current emotion state.
 * This creates coupling: emotion → intent weight.
 * Returns a record of category → multiplier.
 */
export function computeEmotionIntentCoupling(emotion: EmotionState): Record<string, number> {
  return {
    '创作': 1.0 + 0.5 * emotion.creativity,                          // creativity boosts creation urge
    '社交': 1.0 + 0.3 * emotion.sociability - 0.2 * emotion.stress,  // sociability boosts, stress suppresses
    '窥屏': 1.0 + 0.2 * (1.0 - emotion.energy),                      // low energy → more browsing
    '休息': 1.0 + 0.8 * (1.0 - emotion.energy),                      // low energy → strong rest urge
    '表达': 1.0 + 0.3 * Math.abs(emotion.mood.valence),              // strong feelings → urge to express
    '学习': 1.0 + 0.2 * emotion.creativity - 0.3 * emotion.stress,   // curiosity minus stress
    '梦想': 1.0 + 0.2 * emotion.mood.valence,                        // positive mood → dreaming
  };
}

/**
 * Apply emotion feedback from intent satisfaction.
 * When an intent is satisfied, it feeds back into emotion.
 * This creates coupling: intent satisfaction → emotion change.
 */
export function intentSatisfactionFeedback(
  emotion: EmotionState,
  category: string,
): EmotionState {
  const feedbacks: Record<string, EmotionDelta> = {
    '创作': { creativity: 0.1, valence: 0.1 },
    '社交': { sociability: 0.15, valence: 0.05 },
    '窥屏': { energy: -0.05 },
    '休息': { energy: 0.15, stress: -0.1 },
    '表达': { valence: 0.05, arousal: 0.05 },
    '学习': { creativity: 0.1, energy: -0.05 },
    '梦想': { valence: 0.1 },
  };

  const delta = feedbacks[category];
  if (!delta) return emotion;

  return applyDelta(emotion, delta, `满足了${category}需求`);
}

/**
 * Scale an emotion delta by social closeness.
 * Core circle interactions have full impact; distant interactions are muted.
 */
export function scaleByCloseness(delta: EmotionDelta, closeness: number): EmotionDelta {
  const scale = Math.max(0.1, closeness / 10.0);
  const result: EmotionDelta = {};
  if (delta.valence !== undefined) result.valence = delta.valence * scale;
  if (delta.arousal !== undefined) result.arousal = delta.arousal * scale;
  if (delta.energy !== undefined) result.energy = delta.energy * scale;
  if (delta.stress !== undefined) result.stress = delta.stress * scale;
  if (delta.creativity !== undefined) result.creativity = delta.creativity * scale;
  if (delta.sociability !== undefined) result.sociability = delta.sociability * scale;
  return result;
}
