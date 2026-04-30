// alive/scripts/engines/vitality.ts
// Metabolism system — generalized (no platform-specific action types)

import { VitalityState, EmotionState } from '../utils/types';
import { now, getLocalDate } from '../utils/time-utils';
import { VITALITY_CONFIG } from '../config';

const VITALITY_MAX = VITALITY_CONFIG.VITALITY_MAX;
const VITALITY_MIN = 0;
const BASE_DRAIN_PER_TICK = VITALITY_CONFIG.BASE_DRAIN_PER_TICK;  // 从 3 降到 2：减缓全天活力消耗（之前 85→8.6 太快）

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
  rest: 10,               // 从 8 提高到 10
  browsing_light: 4,      // 从 3 提高到 4
  positive_interaction: 3, // 从 2 提高到 3
  learning_complete: 5,
  exercise: 6,
  sleep_cycle: 20,        // 从 15 提高到 20
  afternoon_rest: 12,     // 新增：下午小憩恢复
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
  const emergency = newConsecutive >= VITALITY_CONFIG.EMERGENCY_LOW_DAYS;
  const base = REPLENISHMENT.sleep_cycle;
  const newVitality = emergency 
    ? clampVitality(Math.max(state.vitality, VITALITY_CONFIG.EMERGENCY_MIN_VITALITY) + base)
    : clampVitality(state.vitality + base);
  return { ...state, vitality: newVitality, last_updated: now().toISOString(), consecutive_low_days: emergency ? 0 : newConsecutive };
}

/**
 * 下午小憩恢复（13:00-15:00 触发一次）。
 * 只在活力低于 50 时触发，模拟自然午休。
 */
export function afternoonRestRecovery(state: VitalityState, hour: number): VitalityState {
  if (hour < 13 || hour > 15) return state;
  if (state.vitality >= 50) return state;

  const today = getLocalDate();
  if (state.last_afternoon_rest_date === today) return state;

  const gain = REPLENISHMENT.afternoon_rest;
  return {
    ...state,
    vitality: clampVitality(state.vitality + gain),
    last_updated: now().toISOString(),
    last_afternoon_rest_date: today,
  };
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

export const DEFAULT_VITALITY: VitalityState = {
  vitality: VITALITY_CONFIG.DEFAULT_VITALITY,
  last_updated: null,
  consecutive_low_days: 0,
  last_afternoon_rest_date: null,
};
