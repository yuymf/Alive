// alive/tests/vitality.test.ts
// Tests for the generalized vitality/metabolism engine

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  drainVitality,
  applyActionCost,
  replenishVitality,
  morningRecovery,
  getVitalityZone,
  getVitalityConstraints,
  DEFAULT_VITALITY,
} from '../scripts/engines/vitality';
import { VitalityState, EmotionState, DEFAULT_MOMENTUM, DEFAULT_UNDERTONE } from '../scripts/utils/types';
import { setTimeOverride } from '../scripts/utils/time-utils';

vi.mock('../scripts/persona/persona-loader', () => ({
  getEmotionBaseline: () => ({ valence: 0.3, arousal: 0.5, energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5 }),
}));

function makeVitality(overrides: Partial<VitalityState> = {}): VitalityState {
  return { ...DEFAULT_VITALITY, ...overrides };
}

function makeEmotion(overrides: Partial<EmotionState> = {}): EmotionState {
  return {
    mood: { valence: 0.3, arousal: 0.5, description: '普通' },
    energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
    last_updated: null, recent_cause: 'test',
    momentum: { ...DEFAULT_MOMENTUM }, undertone: { ...DEFAULT_UNDERTONE },
    impulse_history: [], consecutive_high_stress: 0, threshold_break_cooldown: 0,
    ...overrides,
  };
}

beforeEach(() => {
  setTimeOverride(new Date('2026-03-24T14:00:00'));
});

// ──── drainVitality ────

describe('drainVitality', () => {
  it('drains base amount per tick', () => {
    const state = makeVitality({ vitality: 70 });
    const emotion = makeEmotion();
    const result = drainVitality(state, emotion);
    expect(result.vitality).toBeLessThan(70);
    expect(result.vitality).toBeGreaterThan(60);
  });

  it('drains more when stressed', () => {
    const state = makeVitality({ vitality: 70 });
    const calm = drainVitality(state, makeEmotion({ stress: 0.1 }));
    const stressed = drainVitality(state, makeEmotion({ stress: 0.8 }));
    expect(stressed.vitality).toBeLessThan(calm.vitality);
  });

  it('drains less when arousal is low', () => {
    const state = makeVitality({ vitality: 70 });
    const lowArousal = drainVitality(state, makeEmotion({ mood: { valence: 0.3, arousal: 0.2, description: '平静' } }));
    const highArousal = drainVitality(state, makeEmotion({ mood: { valence: 0.3, arousal: 0.5, description: '普通' } }));
    expect(lowArousal.vitality).toBeGreaterThan(highArousal.vitality);
  });

  it('uses flow modifier', () => {
    const state = makeVitality({ vitality: 70 });
    const noFlow = drainVitality(state, makeEmotion(), 1.0);
    const inFlow = drainVitality(state, makeEmotion(), 0.5);
    expect(inFlow.vitality).toBeGreaterThan(noFlow.vitality); // less drain
  });

  it('never drops below 0', () => {
    const state = makeVitality({ vitality: 1 });
    const result = drainVitality(state, makeEmotion({ stress: 0.9 }));
    expect(result.vitality).toBeGreaterThanOrEqual(0);
  });

  it('updates last_updated', () => {
    const state = makeVitality({ last_updated: null });
    const result = drainVitality(state, makeEmotion());
    expect(result.last_updated).toBeTruthy();
  });
});

// ──── applyActionCost ────

describe('applyActionCost', () => {
  it('applies known action cost', () => {
    const state = makeVitality({ vitality: 70 });
    const result = applyActionCost(state, 'heavy_creation');
    expect(result.vitality).toBe(60); // -10
  });

  it('applies custom cost', () => {
    const state = makeVitality({ vitality: 70 });
    const result = applyActionCost(state, 'custom', 15);
    expect(result.vitality).toBe(55);
  });

  it('returns unchanged for unknown action type (0 cost)', () => {
    const state = makeVitality({ vitality: 70 });
    const result = applyActionCost(state, 'unknown_action');
    expect(result.vitality).toBe(70);
  });

  it('clamps to 0', () => {
    const state = makeVitality({ vitality: 5 });
    const result = applyActionCost(state, 'heavy_creation'); // -10
    expect(result.vitality).toBe(0);
  });
});

// ──── replenishVitality ────

describe('replenishVitality', () => {
  it('replenishes from rest', () => {
    const state = makeVitality({ vitality: 50 });
    const result = replenishVitality(state, 'rest');
    expect(result.vitality).toBe(58); // +8
  });

  it('replenishes with custom gain', () => {
    const state = makeVitality({ vitality: 50 });
    const result = replenishVitality(state, 'custom', 20);
    expect(result.vitality).toBe(70);
  });

  it('caps at 100', () => {
    const state = makeVitality({ vitality: 95 });
    const result = replenishVitality(state, 'sleep_cycle'); // +15
    expect(result.vitality).toBe(100);
  });

  it('returns unchanged for unknown source', () => {
    const state = makeVitality({ vitality: 50 });
    const result = replenishVitality(state, 'unknown_source');
    expect(result.vitality).toBe(50);
  });
});

// ──── morningRecovery ────

describe('morningRecovery', () => {
  it('adds sleep_cycle recovery', () => {
    const state = makeVitality({ vitality: 50 });
    const result = morningRecovery(state);
    expect(result.vitality).toBe(65); // +15
  });

  it('tracks consecutive low days', () => {
    const state = makeVitality({ vitality: 25, consecutive_low_days: 1 });
    const result = morningRecovery(state);
    expect(result.consecutive_low_days).toBe(2);
  });

  it('resets consecutive_low_days when vitality is ok', () => {
    const state = makeVitality({ vitality: 50, consecutive_low_days: 2 });
    const result = morningRecovery(state);
    expect(result.consecutive_low_days).toBe(0);
  });

  it('triggers emergency recovery after 3 consecutive low days', () => {
    const state = makeVitality({ vitality: 20, consecutive_low_days: 2 });
    const result = morningRecovery(state);
    // emergency: max(20+15=35, 60) = 60, consecutive resets
    expect(result.vitality).toBe(60);
    expect(result.consecutive_low_days).toBe(0);
  });
});

// ──── getVitalityZone ────

describe('getVitalityZone', () => {
  it('returns high for > 70', () => { expect(getVitalityZone(80)).toBe('high'); });
  it('returns normal for 31-70', () => { expect(getVitalityZone(50)).toBe('normal'); });
  it('returns low for 11-30', () => { expect(getVitalityZone(20)).toBe('low'); });
  it('returns critical for <= 10', () => { expect(getVitalityZone(5)).toBe('critical'); });
  it('returns normal for exactly 31', () => { expect(getVitalityZone(31)).toBe('normal'); });
});

// ──── getVitalityConstraints ────

describe('getVitalityConstraints', () => {
  it('high zone allows everything', () => {
    const c = getVitalityConstraints(80);
    expect(c.canDoHeavyWork).toBe(true);
    expect(c.canDoHeavySocial).toBe(true);
    expect(c.canCreate).toBe(true);
    expect(c.canSearch).toBe(true);
    expect(c.intentMultiplier).toBe(1.2);
  });

  it('low zone restricts heavy work', () => {
    const c = getVitalityConstraints(20);
    expect(c.canDoHeavyWork).toBe(false);
    expect(c.canDoHeavySocial).toBe(false);
    expect(c.canCreate).toBe(true);
    expect(c.moodModifier).toContain('累');
  });

  it('critical zone restricts everything', () => {
    const c = getVitalityConstraints(5);
    expect(c.canDoHeavyWork).toBe(false);
    expect(c.canCreate).toBe(false);
    expect(c.canSearch).toBe(false);
    expect(c.intentMultiplier).toBe(0.3);
  });
});
