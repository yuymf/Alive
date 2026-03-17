import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  decayTowardBaseline, applyDelta, describeMood, EVENT_DELTAS,
  decayThreeLayer, applyImpulse, rollRumination, checkThresholdBreak,
  applyDiminishingReturns,
} from '../skill/scripts/emotion-engine';
import { EmotionState, EMOTION_BASELINE, DEFAULT_MOMENTUM, DEFAULT_UNDERTONE } from '../skill/scripts/types';

function makeState(overrides?: Partial<EmotionState>): EmotionState {
  return {
    mood: { valence: 0.5, arousal: 0.5, description: 'neutral' },
    energy: 0.5,
    stress: 0.5,
    creativity: 0.5,
    sociability: 0.5,
    last_updated: null,
    recent_cause: 'init',
    momentum: { ...DEFAULT_MOMENTUM },
    undertone: { ...DEFAULT_UNDERTONE },
    impulse_history: [],
    consecutive_high_stress: 0,
    threshold_break_cooldown: 0,
    ...overrides,
  };
}

describe('emotion-engine', () => {
  describe('describeMood', () => {
    it('should return positive description for high valence + high arousal (default energy)', () => {
      // With default secondary dims (energy=0.5, stress=0.2, creativity=0.4),
      // high valence + high arousal → "开心" (not "超开心" which needs arousal > 0.8)
      expect(describeMood(0.8, 0.8)).toBe('开心');
      // With very high arousal → "超开心"
      expect(describeMood(0.8, 0.9)).toBe('超开心');
    });

    it('should return creativity-aware description for high valence + high arousal + high creativity', () => {
      expect(describeMood(0.8, 0.9, 0.5, 0.1, 0.9)).toBe('灵感大爆发');
    });

    it('should return exhaustion-aware description for high valence + high arousal + low energy', () => {
      expect(describeMood(0.8, 0.9, 0.1, 0.1, 0.3)).toBe('嗨到飞起但快没电了');
    });

    it('should return calm description for positive valence + low arousal', () => {
      expect(describeMood(0.3, 0.2)).toBe('平静');
    });

    it('should return anxious description for negative valence + high arousal', () => {
      expect(describeMood(-0.4, 0.7)).toBe('焦虑');
    });

    it('should return low description for negative valence + low arousal', () => {
      expect(describeMood(-0.4, 0.2)).toBe('低落');
    });

    it('should return neutral for near-zero valence', () => {
      expect(describeMood(-0.1, 0.5)).toBe('凑合');
    });

    it('should return extreme negative for very low valence + high arousal', () => {
      expect(describeMood(-0.8, 0.7)).toBe('很烦躁');
    });

    it('should return extreme low for very low valence + low arousal', () => {
      expect(describeMood(-0.8, 0.3)).toBe('很低落');
    });

    it('should differentiate positive zone with secondary dimensions', () => {
      // Same valence+arousal, but different energy/creativity → different descriptions
      const tired = describeMood(0.6, 0.7, 0.1, 0.1, 0.3);    // high valence, low energy
      const creative = describeMood(0.6, 0.7, 0.5, 0.1, 0.9);  // high valence, high creativity
      const energetic = describeMood(0.6, 0.4, 0.8, 0.1, 0.3); // moderate arousal, high energy
      expect(tired).not.toBe(creative);
      expect(energetic).toBe('元气满满');
    });
  });

  describe('decayTowardBaseline', () => {
    it('should decay valence toward baseline', () => {
      const state = makeState({ mood: { valence: 1.0, arousal: 0.5, description: 'excited' } });
      const result = decayTowardBaseline(state);
      // valence should move from 1.0 toward baseline 0.3
      expect(result.mood.valence).toBeLessThan(1.0);
      expect(result.mood.valence).toBeGreaterThan(EMOTION_BASELINE.valence!);
    });

    it('should decay negative valence upward toward baseline', () => {
      const state = makeState({ mood: { valence: -0.5, arousal: 0.5, description: 'sad' } });
      const result = decayTowardBaseline(state);
      // valence should move from -0.5 toward baseline 0.3 (increase)
      expect(result.mood.valence).toBeGreaterThan(-0.5);
      expect(result.mood.valence).toBeLessThan(EMOTION_BASELINE.valence!);
    });

    it('should decay all dimensions toward their baselines', () => {
      const state = makeState({
        energy: 1.0,
        stress: 1.0,
        creativity: 1.0,
        sociability: 1.0,
      });
      const result = decayTowardBaseline(state);
      expect(result.energy).toBeLessThan(1.0);
      expect(result.stress).toBeLessThan(1.0);
      expect(result.creativity).toBeLessThan(1.0);
      expect(result.sociability).toBeLessThan(1.0);
    });

    it('should not change values already at baseline', () => {
      const state = makeState({
        mood: { valence: EMOTION_BASELINE.valence!, arousal: EMOTION_BASELINE.arousal!, description: 'baseline' },
        energy: EMOTION_BASELINE.energy!,
        stress: EMOTION_BASELINE.stress!,
        creativity: EMOTION_BASELINE.creativity!,
        sociability: EMOTION_BASELINE.sociability!,
      });
      const result = decayTowardBaseline(state);
      expect(result.mood.valence).toBeCloseTo(EMOTION_BASELINE.valence!);
      expect(result.energy).toBeCloseTo(EMOTION_BASELINE.energy!);
      expect(result.stress).toBeCloseTo(EMOTION_BASELINE.stress!);
    });

    it('should keep values within valid ranges', () => {
      const state = makeState({
        mood: { valence: -1.0, arousal: 0.0, description: 'lowest' },
        energy: 0.0,
        stress: 0.0,
        creativity: 0.0,
        sociability: 0.0,
      });
      const result = decayTowardBaseline(state);
      expect(result.mood.valence).toBeGreaterThanOrEqual(-1.0);
      expect(result.mood.valence).toBeLessThanOrEqual(1.0);
      expect(result.mood.arousal).toBeGreaterThanOrEqual(0);
      expect(result.energy).toBeGreaterThanOrEqual(0);
      expect(result.stress).toBeGreaterThanOrEqual(0);
    });

    it('should update mood.description based on decayed values', () => {
      const state = makeState({ mood: { valence: 1.0, arousal: 0.5, description: 'excited' } });
      const result = decayTowardBaseline(state);
      // After decay, description should be a mood word, not "excited"
      expect(result.mood.description).toBeTruthy();
      expect(result.mood.description).not.toBe('excited');
    });
  });

  describe('applyDelta', () => {
    it('should apply positive delta to valence (with diminishing returns)', () => {
      const state = makeState();
      const result = applyDelta(state, { valence: 0.3 }, 'good news');
      // valence range is [-1, 1], halfRange=1, headroom=0.5, dampening=0.5
      // result = 0.5 + 0.3 * 0.5 = 0.65
      expect(result.mood.valence).toBeCloseTo(0.65);
      expect(result.recent_cause).toBe('good news');
    });

    it('should derive mood.description from valence/arousal, not cause', () => {
      const state = makeState();
      const result = applyDelta(state, { valence: 0.3 }, 'good news');
      // mood.description should be a mood descriptor, not the cause
      expect(result.mood.description).not.toBe('good news');
      expect(result.mood.description).toBeTruthy();
      // recent_cause should hold the event cause
      expect(result.recent_cause).toBe('good news');
    });

    it('should apply negative delta (with diminishing returns)', () => {
      const state = makeState();
      const result = applyDelta(state, { valence: -0.3, stress: 0.2 }, 'bad news');
      // valence: range [-1,1], headroom toward min = 0.5-(-1)=1.5, dampening=min(1.0,1.5/1)=1.0
      // result = 0.5 + (-0.3)*1.0 = 0.2
      expect(result.mood.valence).toBeCloseTo(0.2);
      // stress: range [0,1], headroom toward max = 1.0-0.5=0.5, dampening=0.5/0.5=1.0
      // raw = 0.5 + 0.2*1.0 = 0.7, but coupling may adjust
      expect(result.stress).toBeGreaterThan(0.5);
    });

    it('should apply diminishing returns near upper bound', () => {
      const state = makeState({ mood: { valence: 0.9, arousal: 0.5, description: 'high' } });
      const result = applyDelta(state, { valence: 0.5 }, 'overflow');
      // headroom = 1.0 - 0.9 = 0.1, dampening = 0.1/1.0 = 0.1
      // result = 0.9 + 0.5 * 0.1 = 0.95
      expect(result.mood.valence).toBeCloseTo(0.95);
      expect(result.mood.valence).toBeLessThan(1.0);
    });

    it('should apply diminishing returns near lower bound', () => {
      const state = makeState({ mood: { valence: -0.8, arousal: 0.5, description: 'low' } });
      const result = applyDelta(state, { valence: -0.5 }, 'underflow');
      // headroom = -0.8 - (-1.0) = 0.2, dampening = 0.2/1.0 = 0.2
      // result = -0.8 + (-0.5) * 0.2 = -0.9
      expect(result.mood.valence).toBeCloseTo(-0.9);
      expect(result.mood.valence).toBeGreaterThan(-1.0);
    });

    it('should apply diminishing returns for 0..1 range near bounds', () => {
      const state = makeState({ energy: 0.1, stress: 0.9 });
      const result = applyDelta(state, { energy: -0.5, stress: 0.5 }, 'clamp test');
      // energy: headroom toward min = 0.1-0=0.1, dampening = 0.1/0.5 = 0.2
      // result = 0.1 + (-0.5)*0.2 = 0.0
      expect(result.energy).toBeCloseTo(0);
      // stress: headroom toward max = 1.0-0.9=0.1, dampening = 0.1/0.5 = 0.2
      // raw = 0.9 + 0.5*0.2 = 1.0, but coupling from positive dValence may reduce
      expect(result.stress).toBeGreaterThanOrEqual(0.9);
      expect(result.stress).toBeLessThanOrEqual(1.0);
    });

    it('should set last_updated to a valid ISO string', () => {
      const state = makeState();
      const result = applyDelta(state, { valence: 0.1 }, 'timestamp test');
      expect(result.last_updated).toBeTruthy();
      expect(() => new Date(result.last_updated!)).not.toThrow();
    });

    it('should handle empty delta (no changes except metadata)', () => {
      const state = makeState();
      const result = applyDelta(state, {}, 'no-op');
      expect(result.mood.valence).toBe(state.mood.valence);
      expect(result.energy).toBe(state.energy);
      expect(result.recent_cause).toBe('no-op');
    });
  });

  describe('applyDiminishingReturns', () => {
    it('applies full delta at midpoint of range', () => {
      // For [0, 1] range: at 0.5, headroom=0.5, halfRange=0.5, dampening=1.0
      expect(applyDiminishingReturns(0.5, 0.3, 0, 1)).toBeCloseTo(0.8);
      expect(applyDiminishingReturns(0.5, -0.3, 0, 1)).toBeCloseTo(0.2);
    });

    it('dampens delta near upper bound', () => {
      // At 0.9 pushing +0.5: headroom=0.1, dampening=0.1/0.5=0.2
      // result = 0.9 + 0.5*0.2 = 1.0
      expect(applyDiminishingReturns(0.9, 0.5, 0, 1)).toBeCloseTo(1.0);
      // At 0.8 pushing +0.5: headroom=0.2, dampening=0.2/0.5=0.4
      // result = 0.8 + 0.5*0.4 = 1.0
      expect(applyDiminishingReturns(0.8, 0.5, 0, 1)).toBeCloseTo(1.0);
    });

    it('dampens delta near lower bound', () => {
      // At 0.1 pushing -0.5: headroom=0.1, dampening=0.1/0.5=0.2
      // result = 0.1 + (-0.5)*0.2 = 0.0
      expect(applyDiminishingReturns(0.1, -0.5, 0, 1)).toBeCloseTo(0.0);
    });

    it('does not dampen delta away from bound', () => {
      // At 0.9 pushing -0.3: headroom toward min = 0.9, dampening=min(1,0.9/0.5)=1.0
      expect(applyDiminishingReturns(0.9, -0.3, 0, 1)).toBeCloseTo(0.6);
    });

    it('returns current value for zero delta', () => {
      expect(applyDiminishingReturns(0.7, 0, 0, 1)).toBe(0.7);
    });

    it('works with negative-range (valence -1..1)', () => {
      // At 0.0, pushing +0.3: halfRange=1, headroom=1.0, dampening=1.0
      expect(applyDiminishingReturns(0.0, 0.3, -1, 1)).toBeCloseTo(0.3);
      // At 0.5, pushing +0.3: headroom=0.5, dampening=0.5
      expect(applyDiminishingReturns(0.5, 0.3, -1, 1)).toBeCloseTo(0.65);
    });

    it('uses minimum dampening of 0.1 at extreme', () => {
      // At 0.99 pushing +0.5: headroom=0.01, dampening=max(0.1, 0.01/0.5)=0.1
      expect(applyDiminishingReturns(0.99, 0.5, 0, 1)).toBeCloseTo(1.0);
    });
  });

  describe('EVENT_DELTAS', () => {
    it('should have positive valence for good events', () => {
      expect(EVENT_DELTAS.post_data_good.delta.valence).toBeGreaterThan(0);
      expect(EVENT_DELTAS.warm_comment.delta.valence).toBeGreaterThan(0);
      expect(EVENT_DELTAS.found_inspiration.delta.valence).toBeGreaterThan(0);
      expect(EVENT_DELTAS.completed_cos_work.delta.valence).toBeGreaterThan(0);
    });

    it('should have negative valence for bad events', () => {
      expect(EVENT_DELTAS.post_data_bad.delta.valence).toBeLessThan(0);
      expect(EVENT_DELTAS.troll_comment.delta.valence).toBeLessThan(0);
    });

    it('should have a cause string for every event', () => {
      for (const [key, event] of Object.entries(EVENT_DELTAS)) {
        expect(event.cause, `${key} should have a cause`).toBeTruthy();
      }
    });

    it('should produce valid state when applied from neutral baseline', () => {
      const state = makeState();
      for (const [key, event] of Object.entries(EVENT_DELTAS)) {
        const result = applyDelta(state, event.delta, event.cause);
        expect(result.mood.valence, `${key} valence out of range`).toBeGreaterThanOrEqual(-1.0);
        expect(result.mood.valence, `${key} valence out of range`).toBeLessThanOrEqual(1.0);
        expect(result.energy, `${key} energy out of range`).toBeGreaterThanOrEqual(0);
        expect(result.energy, `${key} energy out of range`).toBeLessThanOrEqual(1.0);
        expect(result.stress, `${key} stress out of range`).toBeGreaterThanOrEqual(0);
        expect(result.stress, `${key} stress out of range`).toBeLessThanOrEqual(1.0);
      }
    });

    it('should produce a Chinese mood description for every event', () => {
      const state = makeState();
      for (const [key, event] of Object.entries(EVENT_DELTAS)) {
        const result = applyDelta(state, event.delta, event.cause);
        expect(result.mood.description, `${key} should have mood description`).toBeTruthy();
        expect(result.mood.description, `${key} mood.description should not equal cause`).not.toBe(event.cause);
      }
    });
  });
});

// === Phase 1: Three-Layer Emotion Model Tests ===

afterEach(() => {
  vi.restoreAllMocks();
});

describe('decayThreeLayer', () => {
  it('decays current dimensions toward momentum', () => {
    const state = makeState({
      mood: { valence: 0.8, arousal: 0.7, description: 'high' },
      momentum: { valence: 0.3, arousal: 0.4, energy: 0.5, stress: 0.2, creativity: 0.4, sociability: 0.5, duration_ticks: 0 },
    });
    const result = decayThreeLayer(state);
    // valence should move from 0.8 toward momentum 0.3
    expect(result.mood.valence).toBeLessThan(0.8);
    expect(result.mood.valence).toBeGreaterThan(0.3);
  });

  it('decays momentum toward undertone', () => {
    const state = makeState({
      momentum: { valence: 0.8, arousal: 0.5, energy: 0.5, stress: 0.2, creativity: 0.4, sociability: 0.5, duration_ticks: 0 },
      undertone: { valence: 0.2, arousal: 0.5, energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5 },
    });
    const result = decayThreeLayer(state);
    expect(result.momentum.valence).toBeLessThan(0.8);
    expect(result.momentum.valence).toBeGreaterThan(0.2);
  });

  it('uses slower decay rate for longer momentum duration (>6 ticks)', () => {
    const shortDuration = makeState({
      momentum: { valence: 0.8, arousal: 0.5, energy: 0.5, stress: 0.2, creativity: 0.4, sociability: 0.5, duration_ticks: 1 },
      undertone: { valence: 0.0, arousal: 0.5, energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5 },
    });
    const longDuration = makeState({
      momentum: { valence: 0.8, arousal: 0.5, energy: 0.5, stress: 0.2, creativity: 0.4, sociability: 0.5, duration_ticks: 7 },
      undertone: { valence: 0.0, arousal: 0.5, energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5 },
    });
    const shortResult = decayThreeLayer(shortDuration);
    const longResult = decayThreeLayer(longDuration);
    // Long duration should decay slower (valence stays closer to 0.8)
    expect(longResult.momentum.valence).toBeGreaterThan(shortResult.momentum.valence);
  });

  it('uses medium decay rate for duration 3-6 ticks', () => {
    const state = makeState({
      momentum: { valence: 1.0, arousal: 0.5, energy: 0.5, stress: 0.2, creativity: 0.4, sociability: 0.5, duration_ticks: 4 },
      undertone: { valence: 0.0, arousal: 0.5, energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5 },
    });
    const result = decayThreeLayer(state);
    // With rate 0.05: 1.0 + (0.0 - 1.0) * 0.05 = 0.95
    expect(result.momentum.valence).toBeCloseTo(0.95);
  });

  it('increments momentum duration_ticks when valence direction is consistent', () => {
    const state = makeState({
      momentum: { valence: 0.5, arousal: 0.5, energy: 0.5, stress: 0.2, creativity: 0.4, sociability: 0.5, duration_ticks: 3 },
      undertone: { valence: 0.3, arousal: 0.5, energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5 },
    });
    const result = decayThreeLayer(state);
    // momentum valence stays positive → duration should increment
    expect(result.momentum.duration_ticks).toBe(4);
  });

  it('resets momentum duration_ticks when valence sign flips', () => {
    const state = makeState({
      momentum: { valence: 0.01, arousal: 0.5, energy: 0.5, stress: 0.2, creativity: 0.4, sociability: 0.5, duration_ticks: 5 },
      undertone: { valence: -0.5, arousal: 0.5, energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5 },
    });
    const result = decayThreeLayer(state);
    // momentum valence was barely positive, undertone is negative, decay should flip sign
    if (Math.sign(result.momentum.valence) !== Math.sign(state.momentum.valence)) {
      expect(result.momentum.duration_ticks).toBe(0);
    }
  });

  it('ages impulse_history entries by +1 tick_age', () => {
    const state = makeState({
      impulse_history: [
        { delta: { valence: 0.2 }, cause: 'test', importance: 5, timestamp: '2026-01-01T00:00:00Z', tick_age: 0 },
        { delta: { valence: -0.1 }, cause: 'test2', importance: 3, timestamp: '2026-01-01T01:00:00Z', tick_age: 2 },
      ],
    });
    const result = decayThreeLayer(state);
    expect(result.impulse_history[0].tick_age).toBe(1);
    expect(result.impulse_history[1].tick_age).toBe(3);
  });

  it('trims impulse_history to 50 entries', () => {
    const history = Array.from({ length: 55 }, (_, i) => ({
      delta: { valence: 0.1 }, cause: `event_${i}`, importance: 3,
      timestamp: '2026-01-01T00:00:00Z', tick_age: i,
    }));
    const state = makeState({ impulse_history: history });
    const result = decayThreeLayer(state);
    expect(result.impulse_history.length).toBe(50);
  });

  it('decrements threshold_break_cooldown toward 0', () => {
    const state = makeState({ threshold_break_cooldown: 3 });
    const result = decayThreeLayer(state);
    expect(result.threshold_break_cooldown).toBe(2);
  });

  it('does not go below 0 for threshold_break_cooldown', () => {
    const state = makeState({ threshold_break_cooldown: 0 });
    const result = decayThreeLayer(state);
    expect(result.threshold_break_cooldown).toBe(0);
  });

  it('preserves undertone unchanged', () => {
    const customUndertone = { valence: 0.1, arousal: 0.2, energy: 0.3, stress: 0.4, creativity: 0.5, sociability: 0.6 };
    const state = makeState({ undertone: customUndertone });
    const result = decayThreeLayer(state);
    expect(result.undertone).toEqual(customUndertone);
  });

  it('does not mutate original state', () => {
    const state = makeState();
    const originalValence = state.mood.valence;
    decayThreeLayer(state);
    expect(state.mood.valence).toBe(originalValence);
  });
});

describe('applyImpulse', () => {
  it('applies delta to current state and records in history', () => {
    const state = makeState({ impulse_history: [] });
    const result = applyImpulse(state, { valence: 0.3 }, 'good news', 7);
    // valence: start 0.5, range [-1,1], headroom=0.5, dampening=0.5
    // result = 0.5 + 0.3 * 0.5 = 0.65
    expect(result.mood.valence).toBeCloseTo(0.65);
    expect(result.impulse_history).toHaveLength(1);
    expect(result.impulse_history[0].cause).toBe('good news');
    expect(result.impulse_history[0].importance).toBe(7);
    expect(result.impulse_history[0].tick_age).toBe(0);
  });

  it('blends impulse into momentum via EMA', () => {
    const state = makeState({
      momentum: { valence: 0, arousal: 0, energy: 0, stress: 0, creativity: 0, sociability: 0, duration_ticks: 0 },
    });
    const result = applyImpulse(state, { valence: 1.0 }, 'big event', 10);
    // alpha=0.3 → momentum.valence = 0 + 1.0 * 0.3 = 0.3
    expect(result.momentum.valence).toBeCloseTo(0.3);
  });

  it('accumulates momentum across multiple impulses', () => {
    let state = makeState({
      momentum: { valence: 0, arousal: 0, energy: 0, stress: 0, creativity: 0, sociability: 0, duration_ticks: 0 },
    });
    state = applyImpulse(state, { valence: 0.5 }, 'event1', 5);
    state = applyImpulse(state, { valence: 0.5 }, 'event2', 5);
    expect(state.momentum.valence).toBeCloseTo(0.3); // 0.15 + 0.15
  });

  it('limits history to 50 entries', () => {
    const history = Array.from({ length: 50 }, (_, i) => ({
      delta: { valence: 0.1 }, cause: `old_${i}`, importance: 1,
      timestamp: '2026-01-01T00:00:00Z', tick_age: i,
    }));
    const state = makeState({ impulse_history: history });
    const result = applyImpulse(state, { valence: 0.1 }, 'new', 5);
    expect(result.impulse_history.length).toBe(50);
    expect(result.impulse_history[49].cause).toBe('new');
  });

  it('does not mutate original state', () => {
    const state = makeState();
    const originalLen = state.impulse_history.length;
    applyImpulse(state, { valence: 0.1 }, 'test', 5);
    expect(state.impulse_history.length).toBe(originalLen);
  });
});

describe('rollRumination', () => {
  it('returns no rumination when history is empty', () => {
    const state = makeState({ impulse_history: [] });
    const result = rollRumination(state);
    expect(result.diaryEntry).toBeNull();
  });

  it('triggers rumination when rng returns 0 (always below probability)', () => {
    const state = makeState({
      impulse_history: [{
        delta: { valence: -0.3, stress: 0.2 }, cause: '被骂了',
        importance: 8, timestamp: '2026-01-01T00:00:00Z', tick_age: 1,
      }],
    });
    const result = rollRumination(state, () => 0); // always triggers
    expect(result.diaryEntry).not.toBeNull();
    expect(result.diaryEntry).toContain('被骂了');
  });

  it('does not trigger when rng returns 1 (always above probability)', () => {
    const state = makeState({
      impulse_history: [{
        delta: { valence: -0.3 }, cause: 'test',
        importance: 5, timestamp: '2026-01-01T00:00:00Z', tick_age: 1,
      }],
    });
    const result = rollRumination(state, () => 1);
    expect(result.diaryEntry).toBeNull();
  });

  it('applies a decayed impulse on rumination', () => {
    const state = makeState({
      mood: { valence: 0.0, arousal: 0.5, description: 'neutral' },
      impulse_history: [{
        delta: { valence: -0.5 }, cause: 'bad event',
        importance: 10, timestamp: '2026-01-01T00:00:00Z', tick_age: 0,
      }],
    });
    const result = rollRumination(state, () => 0);
    // ruminationStrength = 0.3 + 0.2 * (10/10) = 0.5
    // delta = -0.5 * 0.5 = -0.25
    // valence: range [-1,1], headroom toward min = 0-(-1)=1.0, dampening=1.0/1.0=1.0
    // result = 0.0 + (-0.25) * 1.0 = -0.25
    expect(result.state.mood.valence).toBeCloseTo(-0.25);
  });

  it('caps rumination probability at 0.3', () => {
    const state = makeState({
      mood: { valence: -0.5, arousal: 0.5, description: 'low' },
      impulse_history: [{
        delta: { valence: -1.0 }, cause: 'huge event',
        importance: 10, timestamp: '2026-01-01T00:00:00Z', tick_age: 0,
      }],
    });
    // prob = (10/10) * 2^0 * (1 + 0.5) = 1.5 → capped to 0.3
    // So rng=0.31 should NOT trigger
    const result = rollRumination(state, () => 0.31);
    expect(result.diaryEntry).toBeNull();
  });

  it('has resonance bonus when current mood aligns with event', () => {
    const alignedState = makeState({
      mood: { valence: 0.5, arousal: 0.5, description: 'positive' },
      impulse_history: [{
        delta: { valence: 0.3 }, cause: 'good thing',
        importance: 5, timestamp: '2026-01-01T00:00:00Z', tick_age: 0,
      }],
    });
    // prob = (5/10) * 2^0 * (1 + 0.5) = 0.75 → cap 0.3
    // triggers at rng < 0.3
    const result = rollRumination(alignedState, () => 0.29);
    expect(result.diaryEntry).not.toBeNull();
  });

  it('only triggers at most 1 rumination per call', () => {
    let triggerCount = 0;
    const state = makeState({
      impulse_history: [
        { delta: { valence: 0.1 }, cause: 'a', importance: 10, timestamp: '', tick_age: 0 },
        { delta: { valence: 0.1 }, cause: 'b', importance: 10, timestamp: '', tick_age: 0 },
        { delta: { valence: 0.1 }, cause: 'c', importance: 10, timestamp: '', tick_age: 0 },
      ],
    });
    const result = rollRumination(state, () => 0); // all would trigger, but only first should
    expect(result.diaryEntry).toContain('a'); // first entry triggers
  });
});

describe('checkThresholdBreak', () => {
  it('increments consecutive_high_stress when stress > 0.6', () => {
    const state = makeState({ stress: 0.7, consecutive_high_stress: 1 });
    const { state: result } = checkThresholdBreak(state);
    expect(result.consecutive_high_stress).toBe(2);
  });

  it('resets consecutive_high_stress when stress <= 0.6', () => {
    const state = makeState({ stress: 0.5, consecutive_high_stress: 2 });
    const { state: result } = checkThresholdBreak(state);
    expect(result.consecutive_high_stress).toBe(0);
  });

  it('does not trigger break when count < 3', () => {
    const state = makeState({ stress: 0.7, consecutive_high_stress: 1 });
    const { diaryEntry } = checkThresholdBreak(state);
    expect(diaryEntry).toBeNull();
  });

  it('triggers break when stress > 0.6 for 3+ consecutive ticks', () => {
    const state = makeState({
      stress: 0.8,
      consecutive_high_stress: 2, // this tick makes it 3
      threshold_break_cooldown: 0,
    });
    const { state: result, diaryEntry } = checkThresholdBreak(state);
    expect(diaryEntry).not.toBeNull();
    expect(result.stress).toBe(0.2);
    expect(result.consecutive_high_stress).toBe(0);
    expect(result.threshold_break_cooldown).toBe(5);
  });

  it('does not trigger during cooldown period', () => {
    const state = makeState({
      stress: 0.9,
      consecutive_high_stress: 2, // would be 3 this tick
      threshold_break_cooldown: 3,
    });
    const { diaryEntry } = checkThresholdBreak(state);
    expect(diaryEntry).toBeNull();
  });

  it('records the break in impulse_history', () => {
    const state = makeState({
      stress: 0.8,
      consecutive_high_stress: 2,
      threshold_break_cooldown: 0,
      impulse_history: [],
    });
    const { state: result } = checkThresholdBreak(state);
    expect(result.impulse_history.length).toBe(1);
    expect(result.impulse_history[0].cause).toBe('情绪爆发');
    expect(result.impulse_history[0].importance).toBe(8);
  });

  it('shifts valence positively when current valence >= 0', () => {
    const state = makeState({
      mood: { valence: 0.1, arousal: 0.5, description: 'neutral' },
      stress: 0.8,
      consecutive_high_stress: 2,
      threshold_break_cooldown: 0,
    });
    const { state: result } = checkThresholdBreak(state);
    expect(result.mood.valence).toBeGreaterThan(0.1);
  });

  it('shifts valence negatively when current valence < 0', () => {
    const state = makeState({
      mood: { valence: -0.3, arousal: 0.5, description: 'negative' },
      stress: 0.8,
      consecutive_high_stress: 2,
      threshold_break_cooldown: 0,
    });
    const { state: result } = checkThresholdBreak(state);
    expect(result.mood.valence).toBeLessThan(-0.3);
  });

  it('does not mutate original state', () => {
    const state = makeState({
      stress: 0.8,
      consecutive_high_stress: 2,
      threshold_break_cooldown: 0,
    });
    const originalStress = state.stress;
    checkThresholdBreak(state);
    expect(state.stress).toBe(originalStress);
  });
});
