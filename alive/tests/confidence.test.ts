// alive/tests/confidence.test.ts
// Tests for the generalized confidence engine

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  updateConfidenceFromFeedback,
  updateConfidenceFromBatch,
  decayConfidence,
  getCreationRateMultiplier,
  getConfidenceMoodHint,
  DEFAULT_CONFIDENCE,
} from '../scripts/engines/confidence';
import { ConfidenceState, FeedbackEvent } from '../scripts/utils/types';
import { setTimeOverride } from '../scripts/utils/time-utils';

vi.mock('../scripts/persona/persona-loader', () => ({
  getEmotionBaseline: () => ({ valence: 0.3, arousal: 0.5, energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5 }),
}));

function makeState(overrides: Partial<ConfidenceState> = {}): ConfidenceState {
  return { ...DEFAULT_CONFIDENCE, ...overrides };
}

function makeFeedback(overrides: Partial<FeedbackEvent> = {}): FeedbackEvent {
  return {
    source: 'test',
    metric: 100,
    baseline: 80,
    timestamp: '2026-03-24T14:00:00',
    ...overrides,
  };
}

beforeEach(() => {
  setTimeOverride(new Date('2026-03-24T14:00:00'));
});

// ──── updateConfidenceFromFeedback ────

describe('updateConfidenceFromFeedback', () => {
  it('increases confidence on positive feedback', () => {
    const state = makeState();
    const result = updateConfidenceFromFeedback(state, makeFeedback({ metric: 100, baseline: 80 }));
    expect(result.confidence).toBeGreaterThan(1.0);
    expect(result.streak).toBe(1);
  });

  it('decreases confidence on negative feedback', () => {
    const state = makeState();
    const result = updateConfidenceFromFeedback(state, makeFeedback({ metric: 50, baseline: 80 }));
    expect(result.confidence).toBeLessThan(1.0);
    expect(result.streak).toBe(-1);
  });

  it('builds positive streak', () => {
    let state = makeState({ streak: 2 });
    state = updateConfidenceFromFeedback(state, makeFeedback({ metric: 100, baseline: 80 }));
    expect(state.streak).toBe(3);
    // streak bonus: min(3, 3) * 0.02 = 0.06 total
    expect(state.confidence).toBeGreaterThan(1.0 + 0.05); // base + some streak
  });

  it('builds negative streak', () => {
    let state = makeState({ streak: -2 });
    state = updateConfidenceFromFeedback(state, makeFeedback({ metric: 50, baseline: 80 }));
    expect(state.streak).toBe(-3);
    expect(state.confidence).toBeLessThan(1.0 - 0.05);
  });

  it('resets streak on direction change', () => {
    const state = makeState({ streak: 3 });
    const result = updateConfidenceFromFeedback(state, makeFeedback({ metric: 50, baseline: 80 }));
    expect(result.streak).toBe(-1); // reset
  });

  it('caps confidence at 1.5', () => {
    const state = makeState({ confidence: 1.48, streak: 3 });
    const result = updateConfidenceFromFeedback(state, makeFeedback({ metric: 200, baseline: 80 }));
    expect(result.confidence).toBeLessThanOrEqual(1.5);
  });

  it('floors confidence at 0.5', () => {
    const state = makeState({ confidence: 0.52, streak: -3 });
    const result = updateConfidenceFromFeedback(state, makeFeedback({ metric: 10, baseline: 80 }));
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('updates last_updated', () => {
    const state = makeState({ last_updated: null });
    const result = updateConfidenceFromFeedback(state, makeFeedback());
    expect(result.last_updated).toBeTruthy();
  });
});

// ──── updateConfidenceFromBatch ────

describe('updateConfidenceFromBatch', () => {
  it('processes multiple feedbacks in order', () => {
    const state = makeState();
    const feedbacks = [
      makeFeedback({ metric: 100, baseline: 80 }), // positive
      makeFeedback({ metric: 100, baseline: 80 }), // positive
      makeFeedback({ metric: 50, baseline: 80 }),   // negative (breaks streak)
    ];
    const result = updateConfidenceFromBatch(state, feedbacks);
    expect(result.streak).toBe(-1); // last was negative
  });

  it('returns unchanged for empty batch', () => {
    const state = makeState();
    const result = updateConfidenceFromBatch(state, []);
    expect(result).toEqual(state);
  });
});

// ──── decayConfidence ────

describe('decayConfidence', () => {
  it('moves confidence toward 1.0 (neutral)', () => {
    const highState = makeState({ confidence: 1.3 });
    const decayed = decayConfidence(highState);
    expect(decayed.confidence).toBeLessThan(1.3);
    expect(decayed.confidence).toBeGreaterThan(1.0);
  });

  it('moves low confidence up toward 1.0', () => {
    const lowState = makeState({ confidence: 0.7 });
    const decayed = decayConfidence(lowState);
    expect(decayed.confidence).toBeGreaterThan(0.7);
    expect(decayed.confidence).toBeLessThan(1.0);
  });

  it('barely changes confidence at 1.0', () => {
    const neutralState = makeState({ confidence: 1.0 });
    const decayed = decayConfidence(neutralState);
    expect(decayed.confidence).toBeCloseTo(1.0, 4);
  });
});

// ──── getCreationRateMultiplier ────

describe('getCreationRateMultiplier', () => {
  it('returns confidence value directly', () => {
    expect(getCreationRateMultiplier(1.2)).toBe(1.2);
    expect(getCreationRateMultiplier(0.8)).toBe(0.8);
  });
});

// ──── getConfidenceMoodHint ────

describe('getConfidenceMoodHint', () => {
  it('returns encouraging hint for high confidence', () => {
    const hint = getConfidenceMoodHint(1.3);
    expect(hint).toContain('信心满满');
  });

  it('returns empty for neutral', () => {
    const hint = getConfidenceMoodHint(1.0);
    expect(hint).toBe('');
  });

  it('returns worried hint for low confidence', () => {
    const hint = getConfidenceMoodHint(0.85);
    expect(hint).toContain('犹豫');
  });

  it('returns serious hint for very low confidence', () => {
    const hint = getConfidenceMoodHint(0.6);
    expect(hint).toContain('信心比较低');
  });
});
