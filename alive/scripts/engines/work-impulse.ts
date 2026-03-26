// alive/scripts/engines/work-impulse.ts
// Manages the character's organic core-output impulse (0-100 value).
// Generalized from post-impulse — "posting" is one instance of "producing output".
// For a blogger it's posting, for a director it's editing, for a scientist it's writing papers.

import { WorkImpulseState } from '../utils/types';
import { now, getLocalDate } from '../utils/time-utils';
import { WORK_IMPULSE_CONFIG } from '../config';

const BASE_DECAY = WORK_IMPULSE_CONFIG.BASE_DECAY;
const EXTRA_DECAY_1_OUTPUT = 5;
const EXTRA_DECAY_2_OUTPUTS = 15;
const IMPULSE_THRESHOLD = WORK_IMPULSE_CONFIG.IMPULSE_THRESHOLD;
const DORMANCY_DAYS = WORK_IMPULSE_CONFIG.DORMANCY_DAYS;
const DORMANCY_BOOST = WORK_IMPULSE_CONFIG.DORMANCY_BOOST;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Accumulate work impulse by delta, clamped to 0-100.
 * Returns new state without mutating the original.
 */
export function accumulateImpulse(state: WorkImpulseState, delta: number): WorkImpulseState {
  return {
    ...state,
    value: clamp(state.value + delta, 0, 100),
  };
}

/**
 * Apply hourly decay to work impulse.
 * Base decay is -3/tick. Extra penalty applies if outputs were already made today.
 * Resets outputs_today count on date rollover.
 * Returns new state without mutating the original.
 */
export function decayImpulse(state: WorkImpulseState): WorkImpulseState {
  const today = getLocalDate();
  const outputsToday = state.outputs_today_date === today ? state.outputs_today : 0;
  const todayDate = state.outputs_today_date === today ? state.outputs_today_date : today;

  let totalDecay = BASE_DECAY;
  if (outputsToday >= 2) {
    totalDecay += EXTRA_DECAY_2_OUTPUTS;
  } else if (outputsToday >= 1) {
    totalDecay += EXTRA_DECAY_1_OUTPUT;
  }

  return {
    ...state,
    value: clamp(state.value - totalDecay, 0, 100),
    outputs_today: outputsToday,
    outputs_today_date: todayDate,
  };
}

/**
 * Reset impulse after a core output is produced.
 * Sets value to 0, records current timestamp, increments outputs_today.
 * Returns new state without mutating the original.
 */
export function resetImpulseAfterOutput(state: WorkImpulseState): WorkImpulseState {
  const today = getLocalDate();
  const outputsToday = state.outputs_today_date === today ? state.outputs_today : 0;

  return {
    value: 0,
    last_output_at: now().getTime(),
    outputs_today_date: today,
    outputs_today: outputsToday + 1,
  };
}

/**
 * Returns true when impulse is high enough to inject a produce desire into the intent system.
 */
export function shouldInjectProduceDesire(state: WorkImpulseState): boolean {
  return state.value >= IMPULSE_THRESHOLD;
}

/**
 * Returns a dormancy boost amount if no output has been made in DORMANCY_DAYS days.
 * Returns 0 if never produced (last_output_at = 0) to avoid false dormancy on fresh install.
 */
export function checkDormancy(state: WorkImpulseState): number {
  if (state.last_output_at === 0) return 0;
  const daysSinceOutput = (now().getTime() - state.last_output_at) / (24 * 60 * 60 * 1000);
  return daysSinceOutput >= DORMANCY_DAYS ? DORMANCY_BOOST : 0;
}
