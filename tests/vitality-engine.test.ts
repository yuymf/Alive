import { describe, it, expect } from 'vitest';
import {
  drainVitality,
  applyActionCost,
  replenishVitality,
  morningRecovery,
  getVitalityZone,
  getVitalityConstraints,
  DEFAULT_VITALITY,
} from '../skill/scripts/vitality-engine';
import { VitalityState, EmotionState, DEFAULT_MOMENTUM, DEFAULT_UNDERTONE } from '../skill/scripts/types';

// === Test helpers ===

function makeVitality(overrides?: Partial<VitalityState>): VitalityState {
  return {
    vitality: 50,
    last_updated: null,
    consecutive_low_days: 0,
    ...overrides,
  };
}

function makeEmotion(overrides?: {
  stress?: number;
  arousal?: number;
}): EmotionState {
  return {
    mood: {
      valence: 0.3,
      arousal: overrides?.arousal ?? 0.5,
      description: 'neutral',
    },
    energy: 0.5,
    stress: overrides?.stress ?? 0.0,
    creativity: 0.4,
    sociability: 0.5,
    last_updated: null,
    recent_cause: 'init',
    momentum: { ...DEFAULT_MOMENTUM },
    undertone: { ...DEFAULT_UNDERTONE },
    impulse_history: [],
    consecutive_high_stress: 0,
    threshold_break_cooldown: 0,
  };
}

// === drainVitality ===

describe('drainVitality', () => {
  it('should apply base drain of 3/tick when stress=0 and arousal=0.5', () => {
    const state = makeVitality({ vitality: 50 });
    const emotion = makeEmotion({ stress: 0, arousal: 0.5 });
    const result = drainVitality(state, emotion);
    // stressMultiplier = 1.0 + 0 * 0.5 = 1.0
    // arousalDiscount = 1.0 (arousal >= 0.3)
    // drain = 3 * 1.0 * 1.0 = 3
    expect(result.vitality).toBeCloseTo(47);
  });

  it('should drain faster at maximum stress (stress=1)', () => {
    const state = makeVitality({ vitality: 50 });
    const noStress = makeEmotion({ stress: 0, arousal: 0.5 });
    const highStress = makeEmotion({ stress: 1, arousal: 0.5 });
    const resultNormal = drainVitality(state, noStress);
    const resultStressed = drainVitality(state, highStress);
    // At stress=1: drain = 3 * (1 + 1*0.5) * 1.0 = 4.5
    expect(resultStressed.vitality).toBeLessThan(resultNormal.vitality);
    expect(resultStressed.vitality).toBeCloseTo(45.5);
  });

  it('should apply 0.8 arousal discount when arousal < 0.3 (resting state)', () => {
    const state = makeVitality({ vitality: 50 });
    const restingEmotion = makeEmotion({ stress: 0, arousal: 0.2 });
    const result = drainVitality(state, restingEmotion);
    // stressMultiplier = 1.0, arousalDiscount = 0.8
    // drain = 3 * 1.0 * 0.8 = 2.4
    expect(result.vitality).toBeCloseTo(47.6);
  });

  it('should clamp vitality at 0 when drain exceeds current vitality', () => {
    const state = makeVitality({ vitality: 2 });
    const emotion = makeEmotion({ stress: 0, arousal: 0.5 });
    const result = drainVitality(state, emotion);
    expect(result.vitality).toBe(0);
  });

  it('should not produce negative vitality', () => {
    const state = makeVitality({ vitality: 0 });
    const emotion = makeEmotion({ stress: 1, arousal: 0.5 });
    const result = drainVitality(state, emotion);
    expect(result.vitality).toBeGreaterThanOrEqual(0);
  });

  it('should not mutate the original state', () => {
    const state = makeVitality({ vitality: 50 });
    const original = state.vitality;
    const emotion = makeEmotion({ stress: 0, arousal: 0.5 });
    drainVitality(state, emotion);
    expect(state.vitality).toBe(original);
  });

  it('should return a new object (spread immutability)', () => {
    const state = makeVitality({ vitality: 50 });
    const emotion = makeEmotion({ stress: 0, arousal: 0.5 });
    const result = drainVitality(state, emotion);
    expect(result).not.toBe(state);
  });

  it('should preserve extra fields via spread operator', () => {
    const state = makeVitality({ vitality: 50, consecutive_low_days: 2 });
    const emotion = makeEmotion({ stress: 0, arousal: 0.5 });
    const result = drainVitality(state, emotion);
    expect(result.consecutive_low_days).toBe(2);
  });

  it('should set last_updated to a valid ISO string', () => {
    const state = makeVitality({ vitality: 50 });
    const emotion = makeEmotion({ stress: 0, arousal: 0.5 });
    const result = drainVitality(state, emotion);
    expect(result.last_updated).toBeTruthy();
    expect(() => new Date(result.last_updated!)).not.toThrow();
  });

  it('should combine stress multiplier and arousal discount together', () => {
    const state = makeVitality({ vitality: 50 });
    const emotion = makeEmotion({ stress: 1, arousal: 0.2 });
    const result = drainVitality(state, emotion);
    // stressMultiplier = 1.5, arousalDiscount = 0.8
    // drain = 3 * 1.5 * 0.8 = 3.6
    expect(result.vitality).toBeCloseTo(46.4);
  });

  it('should apply flowModifier to reduce drain when in flow (×0.7)', () => {
    const state = makeVitality({ vitality: 50 });
    const emotion = makeEmotion({ stress: 0, arousal: 0.5 });
    const result = drainVitality(state, emotion, 0.7);
    // drain = 3 * 1.0 * 1.0 * 0.7 = 2.1
    expect(result.vitality).toBeCloseTo(47.9);
  });

  it('should default flowModifier to 1.0 when not provided', () => {
    const state = makeVitality({ vitality: 50 });
    const emotion = makeEmotion({ stress: 0, arousal: 0.5 });
    const withDefault = drainVitality(state, emotion);
    const withExplicit = drainVitality(state, emotion, 1.0);
    expect(withDefault.vitality).toBeCloseTo(withExplicit.vitality);
  });

  it('should combine flowModifier with stress and arousal', () => {
    const state = makeVitality({ vitality: 50 });
    const emotion = makeEmotion({ stress: 1, arousal: 0.2 });
    const result = drainVitality(state, emotion, 0.7);
    // stressMultiplier = 1.5, arousalDiscount = 0.8, flowModifier = 0.7
    // drain = 3 * 1.5 * 0.8 * 0.7 = 2.52
    expect(result.vitality).toBeCloseTo(47.48);
  });
});

// === applyActionCost ===

describe('applyActionCost', () => {
  it('should deduct 10 for post-pipeline', () => {
    const state = makeVitality({ vitality: 50 });
    const result = applyActionCost(state, 'post-pipeline');
    expect(result.vitality).toBe(40);
  });

  it('should deduct 5 for high_social', () => {
    const state = makeVitality({ vitality: 50 });
    const result = applyActionCost(state, 'high_social');
    expect(result.vitality).toBe(45);
  });

  it('should deduct 2 for browsing', () => {
    const state = makeVitality({ vitality: 50 });
    const result = applyActionCost(state, 'browsing');
    expect(result.vitality).toBe(48);
  });

  it('should deduct 8 for creative_work', () => {
    const state = makeVitality({ vitality: 50 });
    const result = applyActionCost(state, 'creative_work');
    expect(result.vitality).toBe(42);
  });

  it('should deduct 4 for learning', () => {
    const state = makeVitality({ vitality: 50 });
    const result = applyActionCost(state, 'learning');
    expect(result.vitality).toBe(46);
  });

  it('should return the original state object unchanged for unknown action type', () => {
    const state = makeVitality({ vitality: 50 });
    const result = applyActionCost(state, 'unknown_action');
    expect(result).toBe(state);
    expect(result.vitality).toBe(50);
  });

  it('should clamp vitality at 0 when cost exceeds current vitality', () => {
    const state = makeVitality({ vitality: 5 });
    const result = applyActionCost(state, 'post-pipeline');
    expect(result.vitality).toBe(0);
  });

  it('should not produce negative vitality', () => {
    const state = makeVitality({ vitality: 0 });
    const result = applyActionCost(state, 'creative_work');
    expect(result.vitality).toBeGreaterThanOrEqual(0);
  });

  it('should not mutate the original state', () => {
    const state = makeVitality({ vitality: 50 });
    applyActionCost(state, 'post-pipeline');
    expect(state.vitality).toBe(50);
  });

  it('should preserve extra fields via spread operator', () => {
    const state = makeVitality({ vitality: 50, consecutive_low_days: 3 });
    const result = applyActionCost(state, 'browsing');
    expect(result.consecutive_low_days).toBe(3);
  });
});

// === replenishVitality ===

describe('replenishVitality', () => {
  it('should add 8 for rest', () => {
    const state = makeVitality({ vitality: 50 });
    const result = replenishVitality(state, 'rest');
    expect(result.vitality).toBe(58);
  });

  it('should add 3 for browsing_light', () => {
    const state = makeVitality({ vitality: 50 });
    const result = replenishVitality(state, 'browsing_light');
    expect(result.vitality).toBe(53);
  });

  it('should add 2 for positive_interaction', () => {
    const state = makeVitality({ vitality: 50 });
    const result = replenishVitality(state, 'positive_interaction');
    expect(result.vitality).toBe(52);
  });

  it('should add 5 for learning_complete', () => {
    const state = makeVitality({ vitality: 50 });
    const result = replenishVitality(state, 'learning_complete');
    expect(result.vitality).toBe(55);
  });

  it('should add 6 for exercise', () => {
    const state = makeVitality({ vitality: 50 });
    const result = replenishVitality(state, 'exercise');
    expect(result.vitality).toBe(56);
  });

  it('should add 15 for sleep_cycle', () => {
    const state = makeVitality({ vitality: 50 });
    const result = replenishVitality(state, 'sleep_cycle');
    expect(result.vitality).toBe(65);
  });

  it('should return the original state object unchanged for unknown source', () => {
    const state = makeVitality({ vitality: 50 });
    const result = replenishVitality(state, 'unknown_source');
    expect(result).toBe(state);
    expect(result.vitality).toBe(50);
  });

  it('should clamp vitality at 100', () => {
    const state = makeVitality({ vitality: 95 });
    const result = replenishVitality(state, 'rest');
    expect(result.vitality).toBe(100);
  });

  it('should not exceed 100 even with large replenishment', () => {
    const state = makeVitality({ vitality: 90 });
    const result = replenishVitality(state, 'sleep_cycle');
    expect(result.vitality).toBeLessThanOrEqual(100);
  });

  it('should not mutate the original state', () => {
    const state = makeVitality({ vitality: 50 });
    replenishVitality(state, 'rest');
    expect(state.vitality).toBe(50);
  });

  it('should preserve extra fields via spread operator', () => {
    const state = makeVitality({ vitality: 50, consecutive_low_days: 1 });
    const result = replenishVitality(state, 'rest');
    expect(result.consecutive_low_days).toBe(1);
  });
});

// === morningRecovery ===

describe('morningRecovery', () => {
  it('should add 15 (sleep_cycle) under normal conditions', () => {
    const state = makeVitality({ vitality: 50, consecutive_low_days: 0 });
    const result = morningRecovery(state);
    expect(result.vitality).toBe(65);
  });

  it('should clamp normal recovery at 100', () => {
    const state = makeVitality({ vitality: 90, consecutive_low_days: 0 });
    const result = morningRecovery(state);
    expect(result.vitality).toBe(100);
  });

  it('should increment consecutive_low_days when vitality < 30', () => {
    const state = makeVitality({ vitality: 20, consecutive_low_days: 1 });
    const result = morningRecovery(state);
    // vitality 20 < 30 → wasLow=true → newConsecutive=2
    // no emergency (2 < 3) → normal recovery: clamp(20+15)=35
    expect(result.consecutive_low_days).toBe(2);
    expect(result.vitality).toBe(35);
  });

  it('should reset consecutive_low_days to 0 when vitality >= 30', () => {
    const state = makeVitality({ vitality: 40, consecutive_low_days: 2 });
    const result = morningRecovery(state);
    // vitality 40 >= 30 → wasLow=false → newConsecutive=0
    expect(result.consecutive_low_days).toBe(0);
  });

  it('should apply emergency recovery (force to at least 60) after 3 consecutive low days', () => {
    // After 2 consecutive low days, the next tick with low vitality triggers emergency
    // newConsecutive would be 3, so emergencyRecovery=true
    const state = makeVitality({ vitality: 20, consecutive_low_days: 2 });
    const result = morningRecovery(state);
    // wasLow=true → newConsecutive=3 → emergencyRecovery=true
    // newVitality = Math.max(20+15, 60) = Math.max(35, 60) = 60
    expect(result.vitality).toBe(60);
  });

  it('should use Math.max so normal recovery exceeds 60 if possible during emergency', () => {
    // If vitality + 15 > 60, Math.max should pick the higher value
    const state = makeVitality({ vitality: 50, consecutive_low_days: 2 });
    // wasLow = false (50 >= 30) → newConsecutive = 0, no emergency
    // Just a normal recovery check: 50+15=65
    const result = morningRecovery(state);
    expect(result.vitality).toBe(65);
  });

  it('should reset consecutive_low_days to 0 after emergency recovery', () => {
    const state = makeVitality({ vitality: 20, consecutive_low_days: 2 });
    const result = morningRecovery(state);
    // emergency triggers → reset to 0
    expect(result.consecutive_low_days).toBe(0);
  });

  it('emergency recovery sets vitality to at least 60 even if base recovery stays low', () => {
    const state = makeVitality({ vitality: 5, consecutive_low_days: 2 });
    const result = morningRecovery(state);
    // wasLow=true → newConsecutive=3 → emergency
    // Math.max(5+15, 60) = Math.max(20, 60) = 60
    expect(result.vitality).toBeGreaterThanOrEqual(60);
  });

  it('should not mutate the original state', () => {
    const state = makeVitality({ vitality: 20, consecutive_low_days: 2 });
    const originalVitality = state.vitality;
    const originalDays = state.consecutive_low_days;
    morningRecovery(state);
    expect(state.vitality).toBe(originalVitality);
    expect(state.consecutive_low_days).toBe(originalDays);
  });

  it('should preserve extra fields via spread operator', () => {
    const stateWithExtra = {
      vitality: 50,
      last_updated: '2026-01-01T00:00:00.000Z',
      consecutive_low_days: 0,
    };
    const result = morningRecovery(stateWithExtra);
    // All original fields should still be present
    expect(result).toHaveProperty('vitality');
    expect(result).toHaveProperty('last_updated');
    expect(result).toHaveProperty('consecutive_low_days');
  });

  it('should set last_updated to a valid ISO string', () => {
    const state = makeVitality({ vitality: 50 });
    const result = morningRecovery(state);
    expect(result.last_updated).toBeTruthy();
    expect(() => new Date(result.last_updated!)).not.toThrow();
  });
});

// === getVitalityZone ===

describe('getVitalityZone', () => {
  it('should return "high" for vitality above 70', () => {
    expect(getVitalityZone(71)).toBe('high');
    expect(getVitalityZone(100)).toBe('high');
  });

  it('should return "normal" for vitality exactly at 70 boundary', () => {
    // > 70 is "high"; 70 itself is not > 70, so it falls to the next check
    expect(getVitalityZone(70)).toBe('normal');
  });

  it('should return "normal" for vitality in 31-70 range', () => {
    expect(getVitalityZone(50)).toBe('normal');
    expect(getVitalityZone(31)).toBe('normal');
  });

  it('should return "normal" for vitality exactly at 30 boundary', () => {
    // > 30 is "normal"; 30 itself is not > 30, so it falls to the next check
    expect(getVitalityZone(30)).toBe('low');
  });

  it('should return "low" for vitality in 11-30 range', () => {
    expect(getVitalityZone(20)).toBe('low');
    expect(getVitalityZone(11)).toBe('low');
  });

  it('should return "low" for vitality exactly at 10 boundary', () => {
    // > 10 is "low"; 10 itself is not > 10, so it falls to "critical"
    expect(getVitalityZone(10)).toBe('critical');
  });

  it('should return "critical" for vitality at 10 or below', () => {
    expect(getVitalityZone(5)).toBe('critical');
    expect(getVitalityZone(0)).toBe('critical');
  });
});

// === getVitalityConstraints ===

describe('getVitalityConstraints', () => {
  it('should allow all actions in high zone (vitality > 70)', () => {
    const constraints = getVitalityConstraints(80);
    expect(constraints.canPost).toBe(true);
    expect(constraints.canDoHeavySocial).toBe(true);
    expect(constraints.canCreateContent).toBe(true);
  });

  it('should set intentMultiplier to 1.2 in high zone', () => {
    const constraints = getVitalityConstraints(80);
    expect(constraints.intentMultiplier).toBe(1.2);
  });

  it('should set moodModifier to 精力充沛 in high zone', () => {
    const constraints = getVitalityConstraints(80);
    expect(constraints.moodModifier).toBe('精力充沛');
  });

  it('should allow all actions in normal zone (vitality 31-70)', () => {
    const constraints = getVitalityConstraints(50);
    expect(constraints.canPost).toBe(true);
    expect(constraints.canDoHeavySocial).toBe(true);
    expect(constraints.canCreateContent).toBe(true);
  });

  it('should set intentMultiplier to 1.0 in normal zone', () => {
    const constraints = getVitalityConstraints(50);
    expect(constraints.intentMultiplier).toBe(1.0);
  });

  it('should set empty moodModifier in normal zone', () => {
    const constraints = getVitalityConstraints(50);
    expect(constraints.moodModifier).toBe('');
  });

  it('should block posting in low zone (vitality 11-30)', () => {
    const constraints = getVitalityConstraints(20);
    expect(constraints.canPost).toBe(false);
  });

  it('should block heavy social in low zone', () => {
    const constraints = getVitalityConstraints(20);
    expect(constraints.canDoHeavySocial).toBe(false);
  });

  it('should still allow content creation in low zone', () => {
    const constraints = getVitalityConstraints(20);
    expect(constraints.canCreateContent).toBe(true);
  });

  it('should set intentMultiplier to 0.6 in low zone', () => {
    const constraints = getVitalityConstraints(20);
    expect(constraints.intentMultiplier).toBe(0.6);
  });

  it('should set moodModifier to 有点累了 in low zone', () => {
    const constraints = getVitalityConstraints(20);
    expect(constraints.moodModifier).toBe('有点累了');
  });

  it('should block posting in critical zone (vitality <= 10)', () => {
    const constraints = getVitalityConstraints(5);
    expect(constraints.canPost).toBe(false);
  });

  it('should block heavy social in critical zone', () => {
    const constraints = getVitalityConstraints(5);
    expect(constraints.canDoHeavySocial).toBe(false);
  });

  it('should block content creation in critical zone', () => {
    const constraints = getVitalityConstraints(5);
    expect(constraints.canCreateContent).toBe(false);
  });

  it('should set intentMultiplier to 0.3 in critical zone', () => {
    const constraints = getVitalityConstraints(5);
    expect(constraints.intentMultiplier).toBe(0.3);
  });

  it('should set moodModifier to 好累...需要休息 in critical zone', () => {
    const constraints = getVitalityConstraints(5);
    expect(constraints.moodModifier).toBe('好累...需要休息');
  });

  it('intentMultiplier should be highest in high zone and lowest in critical zone', () => {
    const high = getVitalityConstraints(80);
    const normal = getVitalityConstraints(50);
    const low = getVitalityConstraints(20);
    const critical = getVitalityConstraints(5);
    expect(high.intentMultiplier).toBeGreaterThan(normal.intentMultiplier);
    expect(normal.intentMultiplier).toBeGreaterThan(low.intentMultiplier);
    expect(low.intentMultiplier).toBeGreaterThan(critical.intentMultiplier);
  });
});

// === DEFAULT_VITALITY ===

describe('DEFAULT_VITALITY', () => {
  it('should start at vitality 70', () => {
    expect(DEFAULT_VITALITY.vitality).toBe(70);
  });

  it('should have last_updated as null', () => {
    expect(DEFAULT_VITALITY.last_updated).toBeNull();
  });

  it('should have consecutive_low_days of 0', () => {
    expect(DEFAULT_VITALITY.consecutive_low_days).toBe(0);
  });
});
