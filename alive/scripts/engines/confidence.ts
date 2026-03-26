// alive/scripts/engines/confidence.ts
// Generalized confidence engine — accepts FeedbackEvent[] from any source
// (Replaces Instagram-specific PostHistory dependency)

import { ConfidenceState, FeedbackEvent } from '../utils/types';
import { now } from '../utils/time-utils';
import { CONFIDENCE_CONFIG } from '../config';

const CONFIDENCE_MIN = CONFIDENCE_CONFIG.CONFIDENCE_MIN;
const CONFIDENCE_MAX = CONFIDENCE_CONFIG.CONFIDENCE_MAX;
const CONFIDENCE_NEUTRAL = CONFIDENCE_CONFIG.CONFIDENCE_NEUTRAL;
const DECAY_RATE = CONFIDENCE_CONFIG.DECAY_RATE;

function clampConfidence(v: number): number {
  return Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, v));
}

/**
 * Update confidence based on a feedback event.
 * Positive = metric > baseline, negative = metric < baseline.
 * Streak bonus amplifies consecutive same-direction results.
 */
export function updateConfidenceFromFeedback(
  state: ConfidenceState,
  feedback: FeedbackEvent,
): ConfidenceState {
  const isPositive = feedback.metric > feedback.baseline;
  const delta = isPositive ? CONFIDENCE_CONFIG.FEEDBACK_DELTA : -CONFIDENCE_CONFIG.FEEDBACK_DELTA;
  const newStreak = isPositive
    ? (state.streak > 0 ? state.streak + 1 : 1)
    : (state.streak < 0 ? state.streak - 1 : -1);

  const streakBonus = Math.min(Math.abs(newStreak), 3) * 0.02 * Math.sign(newStreak);

  return {
    confidence: clampConfidence(state.confidence + delta + streakBonus),
    streak: newStreak,
    last_updated: now().toISOString(),
  };
}

/**
 * Batch update confidence from multiple feedback events.
 */
export function updateConfidenceFromBatch(
  state: ConfidenceState,
  feedbacks: FeedbackEvent[],
): ConfidenceState {
  let current = state;
  for (const fb of feedbacks) {
    current = updateConfidenceFromFeedback(current, fb);
  }
  return current;
}

/**
 * Daily decay: confidence drifts toward neutral (1.0).
 */
export function decayConfidence(state: ConfidenceState): ConfidenceState {
  const decayed = state.confidence + (CONFIDENCE_NEUTRAL - state.confidence) * DECAY_RATE;
  return { ...state, confidence: clampConfidence(decayed) };
}

/**
 * Get the creation rate multiplier from confidence.
 */
export function getCreationRateMultiplier(confidence: number): number {
  return confidence;
}

/**
 * Get mood hint for LLM prompt based on confidence level.
 */
export function getConfidenceMoodHint(confidence: number): string {
  if (confidence > 1.2) return '最近状态很好，信心满满';
  if (confidence > 1.05) return '状态不错';
  if (confidence > 0.95) return '';
  if (confidence > 0.8) return '最近效果不太好，有点犹豫';
  return '信心比较低，需要重新找方向';
}

export const DEFAULT_CONFIDENCE: ConfidenceState = {
  confidence: 1.0,
  streak: 0,
  last_updated: null,
};
