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
