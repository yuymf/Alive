import { describe, it, expect } from 'vitest';
import { decayTowardBaseline, applyDelta, describeMood, EVENT_DELTAS } from '../skill/scripts/emotion-engine';
import { EmotionState, EMOTION_BASELINE } from '../skill/scripts/types';

function makeState(overrides?: Partial<EmotionState>): EmotionState {
  return {
    mood: { valence: 0.5, arousal: 0.5, description: 'neutral' },
    energy: 0.5,
    stress: 0.5,
    creativity: 0.5,
    sociability: 0.5,
    last_updated: null,
    recent_cause: 'init',
    ...overrides,
  };
}

describe('emotion-engine', () => {
  describe('describeMood', () => {
    it('should return positive description for high valence + high arousal', () => {
      expect(describeMood(0.8, 0.8)).toBe('超开心');
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
      expect(describeMood(-0.1, 0.5)).toBe('普通');
    });

    it('should return extreme negative for very low valence + high arousal', () => {
      expect(describeMood(-0.8, 0.7)).toBe('很烦躁');
    });

    it('should return extreme low for very low valence + low arousal', () => {
      expect(describeMood(-0.8, 0.3)).toBe('很低落');
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
    it('should apply positive delta to valence', () => {
      const state = makeState();
      const result = applyDelta(state, { valence: 0.3 }, 'good news');
      expect(result.mood.valence).toBeCloseTo(0.8);
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

    it('should apply negative delta', () => {
      const state = makeState();
      const result = applyDelta(state, { valence: -0.3, stress: 0.2 }, 'bad news');
      expect(result.mood.valence).toBeCloseTo(0.2);
      expect(result.stress).toBeCloseTo(0.7);
    });

    it('should clamp valence at upper bound 1.0', () => {
      const state = makeState({ mood: { valence: 0.9, arousal: 0.5, description: 'high' } });
      const result = applyDelta(state, { valence: 0.5 }, 'overflow');
      expect(result.mood.valence).toBe(1.0);
    });

    it('should clamp valence at lower bound -1.0', () => {
      const state = makeState({ mood: { valence: -0.8, arousal: 0.5, description: 'low' } });
      const result = applyDelta(state, { valence: -0.5 }, 'underflow');
      expect(result.mood.valence).toBe(-1.0);
    });

    it('should clamp energy/stress/creativity/sociability within [0, 1]', () => {
      const state = makeState({ energy: 0.1, stress: 0.9 });
      const result = applyDelta(state, { energy: -0.5, stress: 0.5 }, 'clamp test');
      expect(result.energy).toBe(0);
      expect(result.stress).toBe(1.0);
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
