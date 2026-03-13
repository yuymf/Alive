// skill/scripts/confidence-engine.ts
// Positive feedback loop: post performance → confidence → creation rate
// (digital-life-comparison §3.3)

import { ConfidenceState, PostHistory } from './types';
import { now } from './time-utils';

const CONFIDENCE_MIN = 0.5;
const CONFIDENCE_MAX = 1.5;
const CONFIDENCE_NEUTRAL = 1.0;
const DECAY_RATE = 0.0033; // ~5% toward neutral per day (0.05/15 ticks per day)

function clampConfidence(v: number): number {
  return Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, v));
}

/**
 * Update confidence based on latest post performance vs 7-day average.
 * Called after post stats are checked.
 */
export function updateConfidence(
  state: ConfidenceState,
  history: PostHistory,
): ConfidenceState {
  const postsWithStats = history.posts.filter(p => p.stats);
  if (postsWithStats.length < 2) return state;

  // Calculate 7-day average engagement
  const sevenDaysAgo = now().getTime() - 7 * 24 * 60 * 60 * 1000;
  const recentPosts = postsWithStats.filter(p => p.timestamp > sevenDaysAgo);
  if (recentPosts.length === 0) return state;

  const avgEngagement = recentPosts.reduce((sum, p) => {
    return sum + (p.stats!.likes + p.stats!.comments * 3);
  }, 0) / recentPosts.length;

  // Compare latest post to average
  const latest = postsWithStats[postsWithStats.length - 1];
  const latestEngagement = latest.stats!.likes + latest.stats!.comments * 3;

  const isPositive = latestEngagement > avgEngagement;
  const delta = isPositive ? 0.05 : -0.05;
  const newStreak = isPositive
    ? (state.streak > 0 ? state.streak + 1 : 1)
    : (state.streak < 0 ? state.streak - 1 : -1);

  // Streak bonus: consecutive results amplify confidence change
  const streakBonus = Math.min(Math.abs(newStreak), 3) * 0.02 * Math.sign(newStreak);

  return {
    confidence: clampConfidence(state.confidence + delta + streakBonus),
    streak: newStreak,
    last_updated: now().toISOString(),
  };
}

/**
 * Daily decay: confidence drifts toward neutral (1.0).
 */
export function decayConfidence(state: ConfidenceState): ConfidenceState {
  const decayed = state.confidence + (CONFIDENCE_NEUTRAL - state.confidence) * DECAY_RATE;
  return {
    ...state,
    confidence: clampConfidence(decayed),
  };
}

/**
 * Get the creation rate multiplier from confidence.
 * High confidence → faster creation intent accumulation.
 */
export function getCreationRateMultiplier(confidence: number): number {
  return confidence;  // direct mapping: 0.5x to 1.5x
}

/**
 * Get mood hint for LLM prompt based on confidence level.
 */
export function getConfidenceMoodHint(confidence: number): string {
  if (confidence > 1.2) return '最近创作状态很好，信心满满';
  if (confidence > 1.05) return '创作状态不错';
  if (confidence > 0.95) return '';
  if (confidence > 0.8) return '最近效果不太好，有点犹豫';
  return '创作信心比较低，需要重新找方向';
}

export const DEFAULT_CONFIDENCE: ConfidenceState = {
  confidence: 1.0,
  streak: 0,
  last_updated: null,
};
