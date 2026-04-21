/**
 * throttle.ts
 *
 * Producer-side throttling for platform IO in the ops pipeline.
 *
 * Background
 * ----------
 * Before async decoupling, every `analyzeTrends` call was user-facing:
 * /brief or /trends would block while 5 platforms + N keyword searches
 * were fired off in parallel, because the user was waiting. That pressure
 * leaked into the code — parallel fetches, greedy retries, no sleeps —
 * which is exactly the shape that trips platform anti-abuse detection.
 *
 * After the PR-1 decoupling, producers run exclusively inside cron. No
 * consumer is waiting; we can afford to take 10–20 minutes per round if
 * that keeps the request fingerprint calm and the cache fresh.
 *
 * This module centralises the pacing primitives:
 *   - `resolveThrottleConfig`: reads `ops.throttle` with safe defaults.
 *   - `RoundAbortController`: one-shot signal to abort the rest of a
 *     refresh round after a rate-limit status, a timeout, or a manual
 *     short-circuit. Producers check `controller.shouldAbort()` between
 *     platforms/keywords and exit early when it flips.
 *   - `sleepWithJitter`: randomised sleep honouring the abort signal.
 *
 * These primitives are deliberately boring — no exponential backoff, no
 * auto-retry, no parallel batching. If a platform misbehaves, we bail
 * out of the round and let the next cron invocation try again.
 */

import type { OpsConfig } from '../utils/types';

export interface ResolvedThrottleConfig {
  platform_gap_ms: readonly [number, number];
  keyword_gap_ms: readonly [number, number];
  account_gap_ms: readonly [number, number];
  abort_on_status: readonly number[];
  max_round_duration_ms: number;
}

/**
 * Safe defaults used when a persona does not override `ops.throttle`.
 *
 * These err on the side of caution rather than latency because no user
 * is blocked on the refresh:
 *   - 30–90s between platforms and competitor accounts.
 *   - 5–15s between keyword searches on the same platform.
 *   - 403 / 429 / 451 immediately abort the round.
 *   - 30 min hard wall-clock ceiling for a single round.
 */
export const DEFAULT_THROTTLE: ResolvedThrottleConfig = {
  platform_gap_ms: [30_000, 90_000],
  keyword_gap_ms: [5_000, 15_000],
  account_gap_ms: [30_000, 90_000],
  abort_on_status: [403, 429, 451],
  max_round_duration_ms: 30 * 60_000,
};

export function resolveThrottleConfig(ops: OpsConfig | undefined): ResolvedThrottleConfig {
  const user = ops?.throttle;
  if (!user) return DEFAULT_THROTTLE;

  return {
    platform_gap_ms: user.platform_gap_ms ?? DEFAULT_THROTTLE.platform_gap_ms,
    keyword_gap_ms: user.keyword_gap_ms ?? DEFAULT_THROTTLE.keyword_gap_ms,
    account_gap_ms: user.account_gap_ms ?? DEFAULT_THROTTLE.account_gap_ms,
    abort_on_status: user.abort_on_status ?? DEFAULT_THROTTLE.abort_on_status,
    max_round_duration_ms: user.max_round_duration_ms ?? DEFAULT_THROTTLE.max_round_duration_ms,
  };
}

/**
 * Short-circuit controller for a single refresh round.
 *
 * Producers poll `shouldAbort()` between expensive steps and bail out
 * when the flag is set. Reasons are kept for logging only — the caller
 * doesn't branch on them.
 */
export class RoundAbortController {
  private aborted = false;
  private reason: string | null = null;
  private readonly startedAtMs: number;
  private readonly deadlineMs: number;

  constructor(
    private readonly config: ResolvedThrottleConfig,
    private readonly label = 'round',
  ) {
    this.startedAtMs = Date.now();
    this.deadlineMs = this.startedAtMs + config.max_round_duration_ms;
  }

  /** @returns true if any further work in this round should be skipped. */
  shouldAbort(): boolean {
    if (this.aborted) return true;
    if (Date.now() >= this.deadlineMs) {
      this.abort(`deadline exceeded (${Math.round(this.config.max_round_duration_ms / 60_000)}min hard cap)`);
      return true;
    }
    return false;
  }

  abort(reason: string): void {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    console.warn(`[throttle:${this.label}] round aborted — ${reason}`);
  }

  /**
   * Inspect an HTTP status code and abort if it matches `abort_on_status`.
   * Returns true when aborted (so callers can `break` out of their loop).
   */
  observeStatus(status: number | undefined | null, where: string): boolean {
    if (status === undefined || status === null) return false;
    if (!this.config.abort_on_status.includes(status)) return false;
    this.abort(`platform returned ${status} at ${where}`);
    return true;
  }

  getReason(): string | null {
    return this.reason;
  }

  getElapsedMs(): number {
    return Date.now() - this.startedAtMs;
  }

  /** Remaining budget, >=0. Zero when the deadline has already passed. */
  getRemainingMs(): number {
    return Math.max(0, this.deadlineMs - Date.now());
  }
}

function pickRandomInRange(range: readonly [number, number]): number {
  const [lo, hi] = range;
  if (hi <= lo) return Math.max(0, lo);
  return Math.floor(lo + Math.random() * (hi - lo));
}

/**
 * Sleep for a random duration inside the given range, honouring the
 * abort controller and the round's remaining budget.
 *
 * - Returns immediately when `controller.shouldAbort()` is already true.
 * - Caps the sleep at the remaining round budget so we never sleep past
 *   the deadline.
 */
export async function sleepWithJitter(
  range: readonly [number, number],
  controller: RoundAbortController,
  label: string,
): Promise<void> {
  if (controller.shouldAbort()) return;

  const target = pickRandomInRange(range);
  const capped = Math.min(target, controller.getRemainingMs());
  if (capped <= 0) return;

  if (process.env.ALIVE_DEBUG === '1' || process.env.ALIVE_DEBUG === 'true') {
    console.error(`[throttle] sleeping ${Math.round(capped / 1000)}s before ${label}`);
  }

  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, capped);
    // If Node is closing and this timer is pending, don't keep the event
    // loop alive just for a jitter sleep.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}
