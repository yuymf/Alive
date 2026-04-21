import { describe, it, expect } from 'vitest';
import type { OpsConfig } from '../../scripts/utils/types';
import {
  DEFAULT_THROTTLE,
  RoundAbortController,
  resolveThrottleConfig,
  sleepWithJitter,
} from '../../scripts/ops/throttle';

const BASE_OPS: OpsConfig = {
  enabled: true,
  brief_time: '08:30',
  competitor_accounts: { xhs: [], douyin: [] },
  trend_score_threshold: 1.8,
  topic_count: 3,
  topic_filter_prompt: '',
  platforms: {},
};

describe('resolveThrottleConfig', () => {
  it('returns the safe defaults when ops is undefined', () => {
    expect(resolveThrottleConfig(undefined)).toEqual(DEFAULT_THROTTLE);
  });

  it('returns the safe defaults when ops.throttle is absent', () => {
    expect(resolveThrottleConfig(BASE_OPS)).toEqual(DEFAULT_THROTTLE);
  });

  it('merges partial overrides with the defaults', () => {
    const ops: OpsConfig = {
      ...BASE_OPS,
      throttle: {
        keyword_gap_ms: [1_000, 2_000],
        max_round_duration_ms: 10 * 60_000,
      },
    };
    const resolved = resolveThrottleConfig(ops);
    expect(resolved.keyword_gap_ms).toEqual([1_000, 2_000]);
    expect(resolved.max_round_duration_ms).toBe(10 * 60_000);
    // Untouched fields still fall back to the defaults
    expect(resolved.platform_gap_ms).toEqual(DEFAULT_THROTTLE.platform_gap_ms);
    expect(resolved.abort_on_status).toEqual(DEFAULT_THROTTLE.abort_on_status);
  });
});

describe('RoundAbortController', () => {
  it('shouldAbort is false immediately after construction', () => {
    const round = new RoundAbortController(DEFAULT_THROTTLE, 'test');
    expect(round.shouldAbort()).toBe(false);
    expect(round.getReason()).toBeNull();
  });

  it('abort() sets the reason and flips shouldAbort', () => {
    const round = new RoundAbortController(DEFAULT_THROTTLE, 'test');
    round.abort('manual stop');
    expect(round.shouldAbort()).toBe(true);
    expect(round.getReason()).toBe('manual stop');
  });

  it('a second abort() is ignored — the first reason sticks', () => {
    const round = new RoundAbortController(DEFAULT_THROTTLE, 'test');
    round.abort('first');
    round.abort('second');
    expect(round.getReason()).toBe('first');
  });

  it('observeStatus aborts on codes listed in abort_on_status', () => {
    const round = new RoundAbortController(
      { ...DEFAULT_THROTTLE, abort_on_status: [429] },
      'test',
    );
    expect(round.observeStatus(200, 'ok call')).toBe(false);
    expect(round.shouldAbort()).toBe(false);
    expect(round.observeStatus(429, 'flagged call')).toBe(true);
    expect(round.shouldAbort()).toBe(true);
    expect(round.getReason()).toContain('429');
  });

  it('observeStatus accepts nullish status without aborting', () => {
    const round = new RoundAbortController(DEFAULT_THROTTLE, 'test');
    expect(round.observeStatus(undefined, 'timeout')).toBe(false);
    expect(round.observeStatus(null, 'timeout')).toBe(false);
    expect(round.shouldAbort()).toBe(false);
  });

  it('deadline exceed flips shouldAbort without an explicit call', async () => {
    const round = new RoundAbortController(
      { ...DEFAULT_THROTTLE, max_round_duration_ms: 10 },
      'test',
    );
    await new Promise<void>(resolve => setTimeout(resolve, 25));
    expect(round.shouldAbort()).toBe(true);
    expect(round.getReason()).toMatch(/deadline/);
  });
});

describe('sleepWithJitter', () => {
  it('returns immediately when the round is already aborted', async () => {
    const round = new RoundAbortController(DEFAULT_THROTTLE, 'test');
    round.abort('preempt');
    const start = Date.now();
    await sleepWithJitter([200, 400], round, 'test');
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('caps the sleep at the remaining round budget', async () => {
    const round = new RoundAbortController(
      { ...DEFAULT_THROTTLE, max_round_duration_ms: 30 },
      'test',
    );
    const start = Date.now();
    await sleepWithJitter([500, 800], round, 'test');
    // Should return well before the 500–800ms range because the round
    // budget is only 30ms.
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('sleeps for at least the low end of the range when budget permits', async () => {
    const round = new RoundAbortController(DEFAULT_THROTTLE, 'test');
    const start = Date.now();
    await sleepWithJitter([30, 50], round, 'test');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(20); // allow minor scheduler jitter
    expect(elapsed).toBeLessThan(200);
  });
});
