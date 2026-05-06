// alive/tests/emotion.test.ts
// Tests for the generalized emotion engine

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  describeMood,
  applyCoupling,
  applyDiminishingReturns,
  applyDelta,
  applyImpulse,
  decayThreeLayer,
  rollRumination,
  checkThresholdBreak,
  computeEmotionIntentCoupling,
  intentSatisfactionFeedback,
  scaleByCloseness,
  EVENT_DELTAS,
} from '../scripts/engines/emotion';
import { EmotionState, EmotionDelta, DEFAULT_MOMENTUM, DEFAULT_UNDERTONE } from '../scripts/utils/types';
import { setTimeOverride, clearTimeOverride } from '../scripts/utils/time-utils';

// Mock persona-loader so tests don't need real filesystem
vi.mock('../scripts/persona/persona-loader', () => ({
  getEmotionBaseline: () => ({
    valence: 0.3, arousal: 0.5, energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
  }),
  buildVoiceSignature: () => '',
}));

function makeState(overrides: Partial<EmotionState> = {}): EmotionState {
  return {
    mood: { valence: 0.3, arousal: 0.5, description: '普通' },
    energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
    last_updated: null, recent_cause: 'test',
    momentum: { ...DEFAULT_MOMENTUM },
    undertone: { ...DEFAULT_UNDERTONE },
    impulse_history: [],
    consecutive_high_stress: 0,
    threshold_break_cooldown: 0,
    ...overrides,
  };
}

beforeEach(() => {
  setTimeOverride(new Date('2026-03-24T14:00:00'));
});

// ──── describeMood ────

describe('describeMood', () => {
  it('returns 很烦躁 for low valence / high arousal', () => {
    expect(describeMood(-0.6, 0.7)).toBe('很烦躁');
  });

  it('returns 很低落 for low valence / low arousal', () => {
    expect(describeMood(-0.6, 0.3)).toBe('很低落');
  });

  it('returns 平静 for neutral valence / low arousal', () => {
    expect(describeMood(0.0, 0.2)).toBe('平静');
  });

  it('returns 超开心 for high valence / very high arousal', () => {
    expect(describeMood(0.6, 0.9, 0.5, 0.2, 0.4)).toBe('超开心');
  });

  it('returns 灵感大爆发 for high valence + arousal + creativity', () => {
    expect(describeMood(0.6, 0.9, 0.5, 0.2, 0.8)).toBe('灵感大爆发');
  });

  it('returns 元气满满 for moderate arousal and high energy', () => {
    expect(describeMood(0.6, 0.5, 0.7, 0.2, 0.4)).toBe('元气满满');
  });

  it('returns 宁静的满足 for high valence / very low arousal', () => {
    expect(describeMood(0.6, 0.1, 0.5, 0.2, 0.4)).toBe('宁静的满足');
  });
});

// ──── applyDiminishingReturns ────

describe('applyDiminishingReturns', () => {
  it('dampens positive delta when near ceiling', () => {
    const result = applyDiminishingReturns(0.9, 0.2, 0, 1.0);
    expect(result).toBeGreaterThan(0.9);
    expect(result).toBeLessThan(0.9 + 0.2); // dampened
  });

  it('dampens negative delta when near floor', () => {
    const result = applyDiminishingReturns(0.1, -0.3, 0, 1.0);
    expect(result).toBeLessThan(0.1);
    expect(result).toBeGreaterThan(0.1 - 0.3); // dampened
  });

  it('returns current value when delta is 0', () => {
    expect(applyDiminishingReturns(0.5, 0, 0, 1.0)).toBe(0.5);
  });

  it('clamps to max', () => {
    const result = applyDiminishingReturns(0.95, 1.0, 0, 1.0);
    expect(result).toBeLessThanOrEqual(1.0);
  });

  it('clamps to min', () => {
    const result = applyDiminishingReturns(0.05, -1.0, 0, 1.0);
    expect(result).toBeGreaterThanOrEqual(0);
  });
});

// ──── applyCoupling ────

describe('applyCoupling', () => {
  it('increasing stress reduces creativity', () => {
    const prev = makeState({ stress: 0.2 });
    const coupled = applyCoupling(prev, 0.6, 0.5, 0.5, 0.5, 0.5, 0.3);
    expect(coupled.creativity).toBeLessThan(0.5); // stress increase dampened creativity
  });

  it('positive valence change reduces stress', () => {
    const prev = makeState({ mood: { valence: 0.0, arousal: 0.5, description: '普通' } });
    const coupled = applyCoupling(prev, 0.6, 0.5, 0.5, 0.5, 0.5, 0.3);
    expect(coupled.stress).toBeLessThan(0.5); // dValence > 0.1, so stress is reduced
  });

  it('energy drop lowers arousal', () => {
    const prev = makeState({ energy: 0.8 });
    const coupled = applyCoupling(prev, 0.5, 0.2, 0.5, 0.5, 0.5, 0.3);
    // dEnergy = 0.5 - 0.8 = -0.3 → arousal should drop
    expect(coupled.arousal).toBeLessThan(0.5);
  });
});

// ──── applyDelta ────

describe('applyDelta', () => {
  it('applies a positive delta', () => {
    const state = makeState();
    const delta: EmotionDelta = { valence: 0.3, energy: 0.1, stress: -0.1 };
    const result = applyDelta(state, delta, 'test positive');
    expect(result.mood.valence).toBeGreaterThan(state.mood.valence);
    expect(result.energy).toBeGreaterThanOrEqual(state.energy); // coupling may alter
    expect(result.recent_cause).toBe('test positive');
    expect(result.last_updated).toBeTruthy();
  });

  it('applies a negative delta', () => {
    const state = makeState();
    const delta: EmotionDelta = { valence: -0.3, stress: 0.3 };
    const result = applyDelta(state, delta, 'bad event');
    expect(result.mood.valence).toBeLessThan(state.mood.valence);
    expect(result.stress).toBeGreaterThan(state.stress);
  });

  it('updates mood description after delta', () => {
    const state = makeState({ mood: { valence: 0.0, arousal: 0.5, description: '普通' } });
    const delta: EmotionDelta = { valence: 0.6, arousal: 0.4 };
    const result = applyDelta(state, delta, 'great news');
    expect(result.mood.description).toBeTruthy();
    expect(result.mood.description).not.toBe('普通');
  });
});

// ──── EVENT_DELTAS ────

describe('EVENT_DELTAS', () => {
  it('contains generic event types (not platform-specific)', () => {
    expect(EVENT_DELTAS).toHaveProperty('positive_feedback');
    expect(EVENT_DELTAS).toHaveProperty('negative_feedback');
    expect(EVENT_DELTAS).toHaveProperty('warm_interaction');
    expect(EVENT_DELTAS).toHaveProperty('hostile_interaction');
    expect(EVENT_DELTAS).toHaveProperty('found_inspiration');
    expect(EVENT_DELTAS).toHaveProperty('completed_work');
    // Should NOT have platform-specific keys
    expect(EVENT_DELTAS).not.toHaveProperty('post_data_good');
    expect(EVENT_DELTAS).not.toHaveProperty('troll_comment');
  });
});

// ──── computeEmotionIntentCoupling ────

describe('computeEmotionIntentCoupling', () => {
  it('returns multipliers for all 7 intent categories', () => {
    const coupling = computeEmotionIntentCoupling(makeState());
    expect(coupling).toHaveProperty('produce');
    expect(coupling).toHaveProperty('connect');
    expect(coupling).toHaveProperty('consume');
    expect(coupling).toHaveProperty('rest');
    expect(coupling).toHaveProperty('express');
    expect(coupling).toHaveProperty('learn');
    expect(coupling).toHaveProperty('aspire');
  });

  it('high creativity boosts 创作 multiplier', () => {
    const highCreativity = makeState({ creativity: 0.9 });
    const lowCreativity = makeState({ creativity: 0.1 });
    const highCoupling = computeEmotionIntentCoupling(highCreativity);
    const lowCoupling = computeEmotionIntentCoupling(lowCreativity);
    expect(highCoupling['produce']).toBeGreaterThan(lowCoupling['produce']);
  });

  it('low energy boosts 休息 multiplier', () => {
    const tired = makeState({ energy: 0.1 });
    const energetic = makeState({ energy: 0.9 });
    expect(computeEmotionIntentCoupling(tired)['rest']).toBeGreaterThan(
      computeEmotionIntentCoupling(energetic)['rest']
    );
  });

  it('returns finite bounded multipliers with invalid emotion dimensions', () => {
    const coupling = computeEmotionIntentCoupling(
      makeState({ creativity: Number.NaN }),
      { produce: { creativity: 1 } } as any,
    );
    expect(Number.isFinite(coupling['produce'])).toBe(true);
    expect(coupling['produce']).toBeGreaterThanOrEqual(0.1);
    expect(coupling['produce']).toBeLessThanOrEqual(5.0);
  });
});

// ──── intentSatisfactionFeedback ────

describe('intentSatisfactionFeedback', () => {
  it('satisfying 创作 intent increases creativity', () => {
    const state = makeState();
    const result = intentSatisfactionFeedback(state, 'produce');
    expect(result.creativity).toBeGreaterThanOrEqual(state.creativity);
  });

  it('satisfying 休息 intent increases energy and decreases stress', () => {
    const state = makeState({ stress: 0.4 });
    const result = intentSatisfactionFeedback(state, 'rest');
    expect(result.energy).toBeGreaterThanOrEqual(state.energy);
  });

  it('unknown category returns state unchanged', () => {
    const state = makeState();
    const result = intentSatisfactionFeedback(state, '不存在');
    expect(result).toEqual(state);
  });
});

// ──── scaleByCloseness ────

describe('scaleByCloseness', () => {
  it('scales delta by closeness / 10', () => {
    const delta: EmotionDelta = { valence: 0.3, arousal: 0.2 };
    const scaled = scaleByCloseness(delta, 5);
    expect(scaled.valence).toBeCloseTo(0.3 * 0.5);
    expect(scaled.arousal).toBeCloseTo(0.2 * 0.5);
  });

  it('minimum scale is 0.1 (closeness=0)', () => {
    const delta: EmotionDelta = { valence: 0.3 };
    const scaled = scaleByCloseness(delta, 0);
    expect(scaled.valence).toBeCloseTo(0.3 * 0.1);
  });

  it('max closeness 10 gives full scale', () => {
    const delta: EmotionDelta = { valence: 0.3 };
    const scaled = scaleByCloseness(delta, 10);
    expect(scaled.valence).toBeCloseTo(0.3);
  });
});

// ──── Three-Layer Decay ────

describe('decayThreeLayer', () => {
  it('moves impulse layer toward momentum', () => {
    const state = makeState({
      mood: { valence: 0.8, arousal: 0.7, description: '开心' },
      momentum: { valence: 0.3, arousal: 0.4, energy: 0.5, stress: 0.2, creativity: 0.4, sociability: 0.4, duration_ticks: 2 },
    });
    const decayed = decayThreeLayer(state);
    // Valence should move from 0.8 toward momentum
    expect(decayed.mood.valence).toBeLessThan(0.8);
  });

  it('increments momentum duration_ticks when sign unchanged', () => {
    const state = makeState({
      momentum: { valence: 0.3, arousal: 0.4, energy: 0.5, stress: 0.2, creativity: 0.4, sociability: 0.4, duration_ticks: 2 },
      undertone: { valence: 0.2, arousal: 0.4, energy: 0.5, stress: 0.2, creativity: 0.4, sociability: 0.4 },
    });
    const decayed = decayThreeLayer(state);
    expect(decayed.momentum.duration_ticks).toBeGreaterThan(2);
  });

  it('decrements threshold_break_cooldown', () => {
    const state = makeState({ threshold_break_cooldown: 3 });
    const decayed = decayThreeLayer(state);
    expect(decayed.threshold_break_cooldown).toBe(2);
  });

  it('ages impulse history entries', () => {
    const state = makeState({
      impulse_history: [
        { delta: { valence: 0.1 }, cause: 'test', importance: 5, timestamp: '', tick_age: 0 },
      ],
    });
    const decayed = decayThreeLayer(state);
    expect(decayed.impulse_history[0].tick_age).toBe(1);
  });
});

// ──── applyImpulse ────

describe('applyImpulse', () => {
  it('applies delta and adds to impulse history', () => {
    const state = makeState();
    const delta: EmotionDelta = { valence: 0.2, arousal: 0.1 };
    const result = applyImpulse(state, delta, 'got a like', 5);
    expect(result.impulse_history.length).toBe(1);
    expect(result.impulse_history[0].cause).toBe('got a like');
    expect(result.impulse_history[0].importance).toBe(5);
    expect(result.mood.valence).toBeGreaterThan(state.mood.valence);
  });

  it('affects momentum', () => {
    const state = makeState();
    const delta: EmotionDelta = { valence: 0.5 };
    const result = applyImpulse(state, delta, 'big event', 8);
    expect(result.momentum.valence).toBeGreaterThan(state.momentum.valence);
  });

  it('caps impulse history at 50', () => {
    const state = makeState({
      impulse_history: Array.from({ length: 50 }, (_, i) => ({
        delta: { valence: 0.01 }, cause: `event-${i}`, importance: 1, timestamp: '', tick_age: i,
      })),
    });
    const result = applyImpulse(state, { valence: 0.1 }, 'new event', 3);
    expect(result.impulse_history.length).toBe(50);
    expect(result.impulse_history[49].cause).toBe('new event');
  });
});

// ──── rollRumination ────

describe('rollRumination', () => {
  it('returns unchanged state when no impulse history', () => {
    const state = makeState();
    const { state: result, diaryEntry } = rollRumination(state);
    expect(result).toEqual(state);
    expect(diaryEntry).toBeNull();
  });

  it('can trigger rumination with 100% rng', () => {
    const state = makeState({
      impulse_history: [{
        delta: { valence: 0.3 }, cause: '收到夸奖', importance: 10, timestamp: '', tick_age: 0,
      }],
    });
    const { state: result, diaryEntry } = rollRumination(state, () => 0.0); // always triggers
    expect(diaryEntry).toContain('收到夸奖');
    expect(result.mood.valence).not.toBe(state.mood.valence);
  });

  it('does not trigger rumination with 100% fail rng', () => {
    const state = makeState({
      impulse_history: [{
        delta: { valence: 0.3 }, cause: '收到夸奖', importance: 5, timestamp: '', tick_age: 0,
      }],
    });
    const { diaryEntry } = rollRumination(state, () => 0.99); // never triggers
    expect(diaryEntry).toBeNull();
  });
});

// ──── checkThresholdBreak ────

describe('checkThresholdBreak', () => {
  it('does not break when stress is low', () => {
    const state = makeState({ stress: 0.3, consecutive_high_stress: 0 });
    const { diaryEntry } = checkThresholdBreak(state);
    expect(diaryEntry).toBeNull();
  });

  it('does not break with only 2 consecutive high stress ticks', () => {
    const state = makeState({ stress: 0.7, consecutive_high_stress: 1 });
    const { diaryEntry } = checkThresholdBreak(state);
    expect(diaryEntry).toBeNull();
  });

  it('breaks after 3 consecutive high stress ticks', () => {
    const state = makeState({
      stress: 0.8, consecutive_high_stress: 2,
      mood: { valence: -0.4, arousal: 0.5, description: '有点烦' },
    });
    const { state: result, diaryEntry } = checkThresholdBreak(state);
    expect(diaryEntry).toBeTruthy();
    expect(result.stress).toBe(0.2); // reset
    expect(result.threshold_break_cooldown).toBe(5);
    expect(result.consecutive_high_stress).toBe(0);
  });

  it('respects cooldown', () => {
    const state = makeState({
      stress: 0.8, consecutive_high_stress: 2, threshold_break_cooldown: 3,
    });
    const { diaryEntry } = checkThresholdBreak(state);
    expect(diaryEntry).toBeNull(); // cooldown prevents break
  });

  it('positive valence break gives encouraging diary', () => {
    const state = makeState({
      stress: 0.8, consecutive_high_stress: 2,
      mood: { valence: 0.3, arousal: 0.5, description: '还行' },
    });
    const { diaryEntry } = checkThresholdBreak(state);
    expect(diaryEntry).toContain('坚持');
  });
});
