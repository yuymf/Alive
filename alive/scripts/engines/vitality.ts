// alive/scripts/engines/vitality.ts
// Metabolism system — generalized (no platform-specific action types)

import { VitalityState, EmotionState } from '../utils/types';
import { now } from '../utils/time-utils';

const VITALITY_MAX = 100;
const VITALITY_MIN = 0;
const BASE_DRAIN_PER_TICK = 3;

function clampVitality(v: number): number {
  return Math.min(VITALITY_MAX, Math.max(VITALITY_MIN, v));
}

// Action cost categories (generic, sub-skills report their own costs)
const ACTION_COSTS: Record<string, number> = {
  heavy_creation: 10,
  heavy_social: 5,
  browsing: 2,
  creative_work: 8,
  learning: 4,
  search: 4,
};

const REPLENISHMENT: Record<string, number> = {
  rest: 8,
  browsing_light: 3,
  positive_interaction: 2,
  learning_complete: 5,
  exercise: 6,
  sleep_cycle: 15,
};

export function drainVitality(state: VitalityState, emotion: EmotionState, flowModifier?: number): VitalityState {
  const stressMultiplier = 1.0 + emotion.stress * 0.5;
  const arousalDiscount = emotion.mood.arousal < 0.3 ? 0.8 : 1.0;
  const modifier = flowModifier ?? 1.0;
  const drain = BASE_DRAIN_PER_TICK * stressMultiplier * arousalDiscount * modifier;
  return { ...state, vitality: clampVitality(state.vitality - drain), last_updated: now().toISOString() };
}

export function applyActionCost(state: VitalityState, actionType: string, customCost?: number): VitalityState {
  const cost = customCost ?? ACTION_COSTS[actionType] ?? 0;
  if (cost === 0) return state;
  return { ...state, vitality: clampVitality(state.vitality - cost) };
}

export function replenishVitality(state: VitalityState, source: string, customGain?: number): VitalityState {
  const gain = customGain ?? REPLENISHMENT[source] ?? 0;
  if (gain === 0) return state;
  return { ...state, vitality: clampVitality(state.vitality + gain) };
}

export function morningRecovery(state: VitalityState): VitalityState {
  const wasLow = state.vitality < 30;
  const newConsecutive = wasLow ? state.consecutive_low_days + 1 : 0;
  const emergency = newConsecutive >= 3;
  const base = REPLENISHMENT.sleep_cycle;
  const newVitality = emergency ? Math.max(state.vitality + base, 60) : clampVitality(state.vitality + base);
  return { ...state, vitality: newVitality, last_updated: now().toISOString(), consecutive_low_days: emergency ? 0 : newConsecutive };
}

export type VitalityZone = 'high' | 'normal' | 'low' | 'critical';

export function getVitalityZone(vitality: number): VitalityZone {
  if (vitality > 70) return 'high';
  if (vitality > 30) return 'normal';
  if (vitality > 10) return 'low';
  return 'critical';
}

export function getVitalityConstraints(vitality: number): {
  canDoHeavyWork: boolean;
  canDoHeavySocial: boolean;
  canCreate: boolean;
  canSearch: boolean;
  moodModifier: string;
  intentMultiplier: number;
} {
  const zone = getVitalityZone(vitality);
  switch (zone) {
    case 'high': return { canDoHeavyWork: true, canDoHeavySocial: true, canCreate: true, canSearch: true, moodModifier: '精力充沛', intentMultiplier: 1.2 };
    case 'normal': return { canDoHeavyWork: true, canDoHeavySocial: true, canCreate: true, canSearch: true, moodModifier: '', intentMultiplier: 1.0 };
    case 'low': return { canDoHeavyWork: false, canDoHeavySocial: false, canCreate: true, canSearch: vitality > 20, moodModifier: '有点累了', intentMultiplier: 0.6 };
    case 'critical': return { canDoHeavyWork: false, canDoHeavySocial: false, canCreate: false, canSearch: false, moodModifier: '好累...需要休息', intentMultiplier: 0.3 };
  }
}

export const DEFAULT_VITALITY: VitalityState = { vitality: 70, last_updated: null, consecutive_low_days: 0 };
