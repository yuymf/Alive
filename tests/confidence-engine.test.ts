import { describe, it, expect } from 'vitest';
import {
  updateConfidence,
  decayConfidence,
  getCreationRateMultiplier,
  getConfidenceMoodHint,
  DEFAULT_CONFIDENCE,
} from '../skill/scripts/confidence-engine';
import { ConfidenceState, PostHistory } from '../skill/scripts/types';

function makeState(overrides?: Partial<ConfidenceState>): ConfidenceState {
  return {
    confidence: 1.0,
    streak: 0,
    last_updated: null,
    ...overrides,
  };
}

const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

/** Build a PostHistory with n posts inside the 7-day window, each with equal engagement. */
function makeHistory(posts: Array<{ likes: number; comments: number; daysAgo?: number }>): PostHistory {
  return {
    posts: posts.map((p, i) => ({
      media_id: `post_${i}`,
      timestamp: Date.now() - (p.daysAgo ?? 1) * 24 * 60 * 60 * 1000,
      style: 'cute' as any,
      caption: '',
      hashtags: [],
      image_local_path: '',
      stats: {
        likes: p.likes,
        comments: p.comments,
        reach: 0,
        follows: 0,
        checked_at: Date.now(),
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// updateConfidence
// ---------------------------------------------------------------------------
describe('updateConfidence', () => {
  it('returns unchanged state when fewer than 2 posts have stats', () => {
    const state = makeState();
    const history: PostHistory = { posts: [] };
    const result = updateConfidence(state, history);
    expect(result).toBe(state);
  });

  it('returns unchanged state when only 1 post has stats', () => {
    const state = makeState();
    const history = makeHistory([{ likes: 100, comments: 10 }]);
    const result = updateConfidence(state, history);
    expect(result).toBe(state);
  });

  it('increases confidence when latest post outperforms average', () => {
    // Three posts: two average (100 likes), one stellar (500 likes)
    const state = makeState({ confidence: 1.0, streak: 0 });
    const history = makeHistory([
      { likes: 100, comments: 0 },
      { likes: 100, comments: 0 },
      { likes: 500, comments: 0 }, // latest — above average
    ]);
    const result = updateConfidence(state, history);
    expect(result.confidence).toBeGreaterThan(1.0);
  });

  it('decreases confidence when latest post underperforms average', () => {
    const state = makeState({ confidence: 1.0, streak: 0 });
    const history = makeHistory([
      { likes: 500, comments: 0 },
      { likes: 500, comments: 0 },
      { likes: 10, comments: 0 }, // latest — below average
    ]);
    const result = updateConfidence(state, history);
    expect(result.confidence).toBeLessThan(1.0);
  });

  it('streak bonus amplifies positive change for consecutive wins', () => {
    // streak: 2 → new streak becomes 3 → bonus = min(3,3)*0.02 = 0.06
    const stateNoStreak = makeState({ confidence: 1.0, streak: 0 });
    const stateWithStreak = makeState({ confidence: 1.0, streak: 2 });
    const history = makeHistory([
      { likes: 100, comments: 0 },
      { likes: 100, comments: 0 },
      { likes: 500, comments: 0 },
    ]);
    const resultNoStreak = updateConfidence(stateNoStreak, history);
    const resultWithStreak = updateConfidence(stateWithStreak, history);
    expect(resultWithStreak.confidence).toBeGreaterThan(resultNoStreak.confidence);
  });

  it('streak bonus amplifies negative change for consecutive losses', () => {
    const stateNoStreak = makeState({ confidence: 1.0, streak: 0 });
    const stateWithStreak = makeState({ confidence: 1.0, streak: -2 });
    const history = makeHistory([
      { likes: 500, comments: 0 },
      { likes: 500, comments: 0 },
      { likes: 10, comments: 0 },
    ]);
    const resultNoStreak = updateConfidence(stateNoStreak, history);
    const resultWithStreak = updateConfidence(stateWithStreak, history);
    expect(resultWithStreak.confidence).toBeLessThan(resultNoStreak.confidence);
  });

  it('clamps confidence at upper bound 1.5', () => {
    const state = makeState({ confidence: 1.48, streak: 5 });
    const history = makeHistory([
      { likes: 100, comments: 0 },
      { likes: 100, comments: 0 },
      { likes: 500, comments: 0 },
    ]);
    const result = updateConfidence(state, history);
    expect(result.confidence).toBeLessThanOrEqual(1.5);
  });

  it('clamps confidence at lower bound 0.5', () => {
    const state = makeState({ confidence: 0.52, streak: -5 });
    const history = makeHistory([
      { likes: 500, comments: 0 },
      { likes: 500, comments: 0 },
      { likes: 5, comments: 0 },
    ]);
    const result = updateConfidence(state, history);
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('is immutable — does not mutate the input state', () => {
    const state = makeState({ confidence: 1.0, streak: 1 });
    const originalConfidence = state.confidence;
    const originalStreak = state.streak;
    const history = makeHistory([
      { likes: 100, comments: 0 },
      { likes: 100, comments: 0 },
      { likes: 500, comments: 0 },
    ]);
    updateConfidence(state, history);
    expect(state.confidence).toBe(originalConfidence);
    expect(state.streak).toBe(originalStreak);
  });

  it('is immutable — does not mutate the input history', () => {
    const history = makeHistory([
      { likes: 100, comments: 0 },
      { likes: 100, comments: 0 },
      { likes: 500, comments: 0 },
    ]);
    const originalLength = history.posts.length;
    const state = makeState();
    updateConfidence(state, history);
    expect(history.posts.length).toBe(originalLength);
  });

  it('returns a new object (not the same reference)', () => {
    const state = makeState();
    const history = makeHistory([
      { likes: 100, comments: 0 },
      { likes: 100, comments: 0 },
      { likes: 500, comments: 0 },
    ]);
    const result = updateConfidence(state, history);
    expect(result).not.toBe(state);
  });

  it('updates last_updated to a valid ISO timestamp', () => {
    const state = makeState({ last_updated: null });
    const history = makeHistory([
      { likes: 100, comments: 0 },
      { likes: 100, comments: 0 },
      { likes: 500, comments: 0 },
    ]);
    const result = updateConfidence(state, history);
    expect(result.last_updated).toBeTruthy();
    expect(() => new Date(result.last_updated!)).not.toThrow();
  });

  it('resets streak direction when performance flips from positive to negative', () => {
    const state = makeState({ streak: 3 });
    const history = makeHistory([
      { likes: 500, comments: 0 },
      { likes: 500, comments: 0 },
      { likes: 10, comments: 0 }, // below average — flip to negative
    ]);
    const result = updateConfidence(state, history);
    expect(result.streak).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// decayConfidence
// ---------------------------------------------------------------------------
describe('decayConfidence', () => {
  it('drifts confidence toward 1.0 when above neutral', () => {
    const state = makeState({ confidence: 1.4 });
    const result = decayConfidence(state);
    expect(result.confidence).toBeLessThan(1.4);
    expect(result.confidence).toBeGreaterThan(1.0);
  });

  it('drifts confidence toward 1.0 when below neutral', () => {
    const state = makeState({ confidence: 0.6 });
    const result = decayConfidence(state);
    expect(result.confidence).toBeGreaterThan(0.6);
    expect(result.confidence).toBeLessThan(1.0);
  });

  it('does not move confidence when already at 1.0', () => {
    const state = makeState({ confidence: 1.0 });
    const result = decayConfidence(state);
    expect(result.confidence).toBeCloseTo(1.0);
  });

  it('decay rate is approximately 0.0033 per tick (about 5% per day)', () => {
    // From confidence 1.4, expected decay: (1.4 - 1.0) * 0.0033 = 0.00132
    const state = makeState({ confidence: 1.4 });
    const result = decayConfidence(state);
    const delta = 1.4 - result.confidence;
    expect(delta).toBeCloseTo(1.4 * 0.0033 - 1.0 * 0.0033, 5); // (1.4 - 1.0) * DECAY_RATE
  });

  it('after ~15 ticks from 1.4 the confidence is roughly 5% closer to neutral', () => {
    let state = makeState({ confidence: 1.4 });
    for (let i = 0; i < 15; i++) {
      state = decayConfidence(state);
    }
    // Started 0.4 above neutral; after 15 ticks ~5% of 0.4 = 0.02 should have decayed
    expect(state.confidence).toBeLessThan(1.4);
    expect(state.confidence).toBeGreaterThan(1.0);
    // Should be roughly around 1.38 (0.4 * (1 - 0.0033)^15 ≈ 0.379 above neutral)
    expect(state.confidence).toBeCloseTo(1.0 + 0.4 * Math.pow(1 - 0.0033, 15), 3);
  });

  it('is immutable — does not mutate the input state', () => {
    const state = makeState({ confidence: 1.3, streak: 2 });
    const originalConfidence = state.confidence;
    const originalStreak = state.streak;
    decayConfidence(state);
    expect(state.confidence).toBe(originalConfidence);
    expect(state.streak).toBe(originalStreak);
  });

  it('returns a new object (not the same reference)', () => {
    const state = makeState({ confidence: 1.3 });
    const result = decayConfidence(state);
    expect(result).not.toBe(state);
  });

  it('preserves streak and other fields', () => {
    const state = makeState({ confidence: 1.2, streak: 3, last_updated: '2026-01-01T00:00:00.000Z' });
    const result = decayConfidence(state);
    expect(result.streak).toBe(3);
    expect(result.last_updated).toBe('2026-01-01T00:00:00.000Z');
  });

  it('clamps at lower bound 0.5 even if confidence is at minimum', () => {
    const state = makeState({ confidence: 0.5 });
    const result = decayConfidence(state);
    // Decay from below-neutral moves toward 1.0, so 0.5 should increase slightly
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result.confidence).toBeLessThanOrEqual(1.5);
  });
});

// ---------------------------------------------------------------------------
// getCreationRateMultiplier
// ---------------------------------------------------------------------------
describe('getCreationRateMultiplier', () => {
  it('returns the confidence value directly', () => {
    expect(getCreationRateMultiplier(1.0)).toBe(1.0);
    expect(getCreationRateMultiplier(1.5)).toBe(1.5);
    expect(getCreationRateMultiplier(0.5)).toBe(0.5);
    expect(getCreationRateMultiplier(1.23)).toBe(1.23);
  });

  it('returns values in the expected [0.5, 1.5] range for valid confidence inputs', () => {
    const result = getCreationRateMultiplier(0.75);
    expect(result).toBeGreaterThanOrEqual(0.5);
    expect(result).toBeLessThanOrEqual(1.5);
  });
});

// ---------------------------------------------------------------------------
// getConfidenceMoodHint
// ---------------------------------------------------------------------------
describe('getConfidenceMoodHint', () => {
  it('returns high-confidence string for confidence > 1.2', () => {
    expect(getConfidenceMoodHint(1.21)).toBe('最近创作状态很好，信心满满');
    expect(getConfidenceMoodHint(1.5)).toBe('最近创作状态很好，信心满满');
  });

  it('returns good-state string for confidence in (1.05, 1.2]', () => {
    expect(getConfidenceMoodHint(1.06)).toBe('创作状态不错');
    expect(getConfidenceMoodHint(1.2)).toBe('创作状态不错');
  });

  it('returns empty string for neutral zone (0.95, 1.05]', () => {
    expect(getConfidenceMoodHint(1.0)).toBe('');
    expect(getConfidenceMoodHint(0.96)).toBe('');
    expect(getConfidenceMoodHint(1.05)).toBe('');
  });

  it('returns hesitant string for confidence in (0.8, 0.95]', () => {
    expect(getConfidenceMoodHint(0.81)).toBe('最近效果不太好，有点犹豫');
    expect(getConfidenceMoodHint(0.95)).toBe('最近效果不太好，有点犹豫');
  });

  it('returns low-confidence string for confidence <= 0.8', () => {
    expect(getConfidenceMoodHint(0.8)).toBe('创作信心比较低，需要重新找方向');
    expect(getConfidenceMoodHint(0.5)).toBe('创作信心比较低，需要重新找方向');
  });

  it('returns empty string for exact neutral value 1.0', () => {
    expect(getConfidenceMoodHint(1.0)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_CONFIDENCE
// ---------------------------------------------------------------------------
describe('DEFAULT_CONFIDENCE', () => {
  it('has confidence set to 1.0 (neutral)', () => {
    expect(DEFAULT_CONFIDENCE.confidence).toBe(1.0);
  });

  it('has streak set to 0', () => {
    expect(DEFAULT_CONFIDENCE.streak).toBe(0);
  });

  it('has last_updated set to null', () => {
    expect(DEFAULT_CONFIDENCE.last_updated).toBeNull();
  });
});
