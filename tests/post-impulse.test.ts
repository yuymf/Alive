import { describe, it, expect } from 'vitest';
import {
  accumulateImpulse,
  decayImpulse,
  resetImpulseAfterPost,
  shouldInjectPostDesire,
  checkDormancy,
} from '../skill/scripts/post-impulse';
import { PostImpulseState, DEFAULT_POST_IMPULSE } from '../skill/scripts/types';
import { getLocalDate } from '../skill/scripts/time-utils';

function makeState(overrides?: Partial<PostImpulseState>): PostImpulseState {
  return { ...DEFAULT_POST_IMPULSE, ...overrides };
}

describe('accumulateImpulse', () => {
  it('adds delta to value, clamped to 0-100', () => {
    const state = makeState({ value: 50 });
    const result = accumulateImpulse(state, 25);
    expect(result.value).toBe(75);
  });

  it('clamps at 100', () => {
    const state = makeState({ value: 90 });
    const result = accumulateImpulse(state, 20);
    expect(result.value).toBe(100);
  });

  it('clamps at 0 for negative delta', () => {
    const state = makeState({ value: 5 });
    const result = accumulateImpulse(state, -10);
    expect(result.value).toBe(0);
  });

  it('is immutable', () => {
    const state = makeState({ value: 50 });
    const original = state.value;
    accumulateImpulse(state, 10);
    expect(state.value).toBe(original);
  });

  it('returns new object', () => {
    const state = makeState();
    const result = accumulateImpulse(state, 10);
    expect(result).not.toBe(state);
  });
});

describe('decayImpulse', () => {
  it('applies base decay of -3', () => {
    const state = makeState({ value: 50, posts_today: 0 });
    const result = decayImpulse(state);
    expect(result.value).toBe(47);
  });

  it('applies extra -5 when 1 post today', () => {
    const today = getLocalDate();
    const state = makeState({ value: 50, posts_today: 1, posts_today_date: today });
    const result = decayImpulse(state);
    expect(result.value).toBe(42);
  });

  it('applies extra -15 when 2 posts today', () => {
    const today = getLocalDate();
    const state = makeState({ value: 50, posts_today: 2, posts_today_date: today });
    const result = decayImpulse(state);
    expect(result.value).toBe(32);
  });

  it('clamps at 0', () => {
    const state = makeState({ value: 2 });
    const result = decayImpulse(state);
    expect(result.value).toBe(0);
  });

  it('resets posts_today on date rollover', () => {
    const state = makeState({ value: 50, posts_today: 2, posts_today_date: '2020-01-01' });
    const result = decayImpulse(state);
    expect(result.posts_today).toBe(0);
    expect(result.value).toBe(47);
  });

  it('is immutable', () => {
    const state = makeState({ value: 50 });
    const original = state.value;
    decayImpulse(state);
    expect(state.value).toBe(original);
  });
});

describe('resetImpulseAfterPost', () => {
  it('sets value to 0', () => {
    const state = makeState({ value: 80 });
    const result = resetImpulseAfterPost(state);
    expect(result.value).toBe(0);
  });

  it('updates last_post_at to now', () => {
    const before = Date.now();
    const state = makeState({ last_post_at: 0 });
    const result = resetImpulseAfterPost(state);
    expect(result.last_post_at).toBeGreaterThanOrEqual(before);
  });

  it('increments posts_today', () => {
    const today = getLocalDate();
    const state = makeState({ posts_today: 1, posts_today_date: today });
    const result = resetImpulseAfterPost(state);
    expect(result.posts_today).toBe(2);
  });

  it('resets posts_today to 1 if date changed', () => {
    const state = makeState({ posts_today: 2, posts_today_date: '2020-01-01' });
    const result = resetImpulseAfterPost(state);
    expect(result.posts_today).toBe(1);
  });

  it('is immutable', () => {
    const state = makeState({ value: 80 });
    resetImpulseAfterPost(state);
    expect(state.value).toBe(80);
  });
});

describe('shouldInjectPostDesire', () => {
  it('returns true when value >= 70', () => {
    expect(shouldInjectPostDesire(makeState({ value: 70 }))).toBe(true);
    expect(shouldInjectPostDesire(makeState({ value: 100 }))).toBe(true);
  });

  it('returns false when value < 70', () => {
    expect(shouldInjectPostDesire(makeState({ value: 69 }))).toBe(false);
    expect(shouldInjectPostDesire(makeState({ value: 0 }))).toBe(false);
  });
});

describe('checkDormancy', () => {
  it('returns 0 when last post was less than 5 days ago', () => {
    const state = makeState({ last_post_at: Date.now() - 3 * 24 * 60 * 60 * 1000 });
    expect(checkDormancy(state)).toBe(0);
  });

  it('returns 50 when last post was 5+ days ago', () => {
    const state = makeState({ last_post_at: Date.now() - 6 * 24 * 60 * 60 * 1000 });
    expect(checkDormancy(state)).toBe(50);
  });

  it('returns 0 when never posted (last_post_at = 0)', () => {
    const state = makeState({ last_post_at: 0 });
    expect(checkDormancy(state)).toBe(0);
  });
});

describe('impulse rhythm simulation', () => {
  it('simulates 5-day dormancy triggering a boost', () => {
    let state = makeState({ last_post_at: Date.now() - 6 * 24 * 60 * 60 * 1000, value: 10 });
    const boost = checkDormancy(state);
    expect(boost).toBe(50);
    state = accumulateImpulse(state, boost);
    expect(state.value).toBe(60);
    state = accumulateImpulse(state, 10);
    expect(shouldInjectPostDesire(state)).toBe(true);
  });

  it('simulates daily limit preventing 4th post', () => {
    const today = getLocalDate();
    let state = makeState({ value: 80, posts_today: 0, posts_today_date: today });
    state = resetImpulseAfterPost(state);
    expect(state.posts_today).toBe(1);
    state = accumulateImpulse(state, 80);
    state = resetImpulseAfterPost(state);
    expect(state.posts_today).toBe(2);
    state = accumulateImpulse(state, 80);
    state = resetImpulseAfterPost(state);
    expect(state.posts_today).toBe(3);
  });

  it('simulates rapid decay after 2 posts today', () => {
    const today = getLocalDate();
    let state = makeState({ value: 80, posts_today: 2, posts_today_date: today });
    for (let i = 0; i < 5; i++) { state = decayImpulse(state); }
    expect(state.value).toBe(0);
  });
});
