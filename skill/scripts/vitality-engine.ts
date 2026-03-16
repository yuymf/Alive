// skill/scripts/vitality-engine.ts
// Metabolism system — creates survival pressure for digital life (Spec: digital-life-comparison §3.1)
// Vitality is a resource that depletes naturally and must be replenished through actions.

import { VitalityState, EmotionState } from './types';
import { now } from './time-utils';

const VITALITY_MAX = 100;
const VITALITY_MIN = 0;

function clampVitality(v: number): number {
  return Math.min(VITALITY_MAX, Math.max(VITALITY_MIN, v));
}

// === Consumption Rules ===
// Every heartbeat tick naturally costs vitality
const BASE_DRAIN_PER_TICK = 3;

const ACTION_COSTS: Record<string, number> = {
  'post-pipeline': 10,
  'high_social': 5,
  'browsing': 2,
  'creative_work': 8,
  'learning': 4,
  'search': 4,
};

// === Replenishment Rules ===
const REPLENISHMENT: Record<string, number> = {
  rest: 8,
  browsing_light: 3,
  positive_interaction: 2,
  learning_complete: 5,
  exercise: 6,
  sleep_cycle: 15,   // applied at morning plan
};

/**
 * Apply base drain per heartbeat tick.
 * Stress accelerates drain; low arousal slows it.
 */
export function drainVitality(
  state: VitalityState,
  emotion: EmotionState,
  flowModifier?: number,
): VitalityState {
  const stressMultiplier = 1.0 + emotion.stress * 0.5;  // max 1.5x at full stress
  const arousalDiscount = emotion.mood.arousal < 0.3 ? 0.8 : 1.0;  // resting state costs less
  const modifier = flowModifier ?? 1.0;
  const drain = BASE_DRAIN_PER_TICK * stressMultiplier * arousalDiscount * modifier;

  return {
    ...state,
    vitality: clampVitality(state.vitality - drain),
    last_updated: now().toISOString(),
  };
}

/**
 * Apply cost for a specific action.
 */
export function applyActionCost(
  state: VitalityState,
  actionType: string,
): VitalityState {
  const cost = ACTION_COSTS[actionType] ?? 0;
  if (cost === 0) return state;

  return {
    ...state,
    vitality: clampVitality(state.vitality - cost),
  };
}

/**
 * Replenish vitality from a positive event.
 */
export function replenishVitality(
  state: VitalityState,
  source: string,
): VitalityState {
  const gain = REPLENISHMENT[source] ?? 0;
  if (gain === 0) return state;

  return {
    ...state,
    vitality: clampVitality(state.vitality + gain),
  };
}

/**
 * Morning recovery: simulate overnight sleep replenishment.
 * Also tracks consecutive low-vitality days and applies emergency recovery.
 */
export function morningRecovery(state: VitalityState): VitalityState {
  const wasLow = state.vitality < 30;
  const newConsecutive = wasLow ? state.consecutive_low_days + 1 : 0;

  // Emergency recovery: if low for 3+ consecutive days, force recovery to 60
  // (prevents "death spiral" where character can never recover)
  const emergencyRecovery = newConsecutive >= 3;
  const baseRecovery = REPLENISHMENT.sleep_cycle;

  const newVitality = emergencyRecovery
    ? Math.max(state.vitality + baseRecovery, 60)
    : clampVitality(state.vitality + baseRecovery);

  return {
    ...state,
    vitality: newVitality,
    last_updated: now().toISOString(),
    consecutive_low_days: emergencyRecovery ? 0 : newConsecutive,
  };
}

// === Vitality Zones ===

export type VitalityZone = 'high' | 'normal' | 'low' | 'critical';

export function getVitalityZone(vitality: number): VitalityZone {
  if (vitality > 70) return 'high';
  if (vitality > 30) return 'normal';
  if (vitality > 10) return 'low';
  return 'critical';
}

/**
 * Get behavioral constraints based on vitality zone.
 * Returns what actions are allowed/restricted.
 */
export function getVitalityConstraints(vitality: number): {
  canPost: boolean;
  canDoHeavySocial: boolean;
  canCreateContent: boolean;
  canSearch: boolean;
  moodModifier: string;
  intentMultiplier: number;
} {
  const zone = getVitalityZone(vitality);

  switch (zone) {
    case 'high':
      return {
        canPost: true,
        canDoHeavySocial: true,
        canCreateContent: true,
        canSearch: true,
        moodModifier: '精力充沛',
        intentMultiplier: 1.2,
      };
    case 'normal':
      return {
        canPost: true,
        canDoHeavySocial: true,
        canCreateContent: true,
        canSearch: true,
        moodModifier: '',
        intentMultiplier: 1.0,
      };
    case 'low':
      return {
        canPost: false,
        canDoHeavySocial: false,
        canCreateContent: true,
        canSearch: vitality > 20,
        moodModifier: '有点累了',
        intentMultiplier: 0.6,
      };
    case 'critical':
      return {
        canPost: false,
        canDoHeavySocial: false,
        canCreateContent: false,
        canSearch: false,
        moodModifier: '好累...需要休息',
        intentMultiplier: 0.3,
      };
  }
}

export const DEFAULT_VITALITY: VitalityState = {
  vitality: 70,
  last_updated: null,
  consecutive_low_days: 0,
};
