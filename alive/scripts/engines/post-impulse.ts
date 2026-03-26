// alive/scripts/engines/post-impulse.ts
// Manages the character's organic posting impulse (0-100 value).
// Replaces the old 16-hour mechanical posting interval with an organic desire system.

import { PostImpulseState } from '../utils/types';
import { now, getLocalDate } from '../utils/time-utils';
import { POST_IMPULSE_CONFIG } from '../config';

const BASE_DECAY = POST_IMPULSE_CONFIG.BASE_DECAY;
const EXTRA_DECAY_1_POST = 5;
const EXTRA_DECAY_2_POSTS = 15;
const IMPULSE_THRESHOLD = POST_IMPULSE_CONFIG.IMPULSE_THRESHOLD;
const DORMANCY_DAYS = POST_IMPULSE_CONFIG.DORMANCY_DAYS;
const DORMANCY_BOOST = POST_IMPULSE_CONFIG.DORMANCY_BOOST;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Accumulate posting impulse by delta, clamped to 0-100.
 * Returns new state without mutating the original.
 */
export function accumulateImpulse(state: PostImpulseState, delta: number): PostImpulseState {
  return {
    ...state,
    value: clamp(state.value + delta, 0, 100),
  };
}

/**
 * Apply hourly decay to posting impulse.
 * Base decay is -3/tick. Extra penalty applies if posts were already made today.
 * Resets posts_today count on date rollover.
 * Returns new state without mutating the original.
 */
export function decayImpulse(state: PostImpulseState): PostImpulseState {
  const today = getLocalDate();
  const postsToday = state.posts_today_date === today ? state.posts_today : 0;
  const todayDate = state.posts_today_date === today ? state.posts_today_date : today;

  let totalDecay = BASE_DECAY;
  if (postsToday >= 2) {
    totalDecay += EXTRA_DECAY_2_POSTS;
  } else if (postsToday >= 1) {
    totalDecay += EXTRA_DECAY_1_POST;
  }

  return {
    ...state,
    value: clamp(state.value - totalDecay, 0, 100),
    posts_today: postsToday,
    posts_today_date: todayDate,
  };
}

/**
 * Reset impulse after a post is made.
 * Sets value to 0, records current timestamp, increments posts_today.
 * Returns new state without mutating the original.
 */
export function resetImpulseAfterPost(state: PostImpulseState): PostImpulseState {
  const today = getLocalDate();
  const postsToday = state.posts_today_date === today ? state.posts_today : 0;

  return {
    value: 0,
    last_post_at: now().getTime(),
    posts_today_date: today,
    posts_today: postsToday + 1,
  };
}

/**
 * Returns true when impulse is high enough to inject a post desire into the intent system.
 */
export function shouldInjectPostDesire(state: PostImpulseState): boolean {
  return state.value >= IMPULSE_THRESHOLD;
}

/**
 * Returns a dormancy boost amount if no post has been made in DORMANCY_DAYS days.
 * Returns 0 if never posted (last_post_at = 0) to avoid false dormancy on fresh install.
 */
export function checkDormancy(state: PostImpulseState): number {
  if (state.last_post_at === 0) return 0;
  const daysSincePost = (now().getTime() - state.last_post_at) / (24 * 60 * 60 * 1000);
  return daysSincePost >= DORMANCY_DAYS ? DORMANCY_BOOST : 0;
}
