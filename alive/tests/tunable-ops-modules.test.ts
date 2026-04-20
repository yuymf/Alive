import { describe, expect, it } from 'vitest';
import {
  resolveScorerConfig,
  scoreCandidateAccount,
} from '../scripts/ops/candidate-scorer';
import { resolveBriefLimits } from '../scripts/ops/brief-generator';
import type { CandidateAccount } from '../scripts/ops/discovery-engine';

describe('candidate-scorer tunable resolution', () => {
  it('uses defaults when override is null', () => {
    const cfg = resolveScorerConfig(null);
    expect(cfg.weights.track_overlap).toBe(0.30);
    expect(cfg.weights.burst_intensity).toBe(0.25);
    expect(cfg.burstCapRatio).toBe(5);
    expect(cfg.freshnessWindowDays).toBe(730);
  });

  it('partial override merges with defaults (missing keys fall back)', () => {
    const cfg = resolveScorerConfig({
      weights: { track_overlap: 0.50 },
    });
    expect(cfg.weights.track_overlap).toBe(0.50);
    expect(cfg.weights.burst_intensity).toBe(0.25); // default preserved
    expect(cfg.weights.frequency).toBe(0.15);       // default preserved
  });

  it('rejects negative or non-finite weights (falls back to default)', () => {
    const cfg = resolveScorerConfig({
      weights: {
        track_overlap: -0.5,
        burst_intensity: Number.NaN,
      },
    });
    expect(cfg.weights.track_overlap).toBe(0.30);
    expect(cfg.weights.burst_intensity).toBe(0.25);
  });

  it('rejects non-positive burstCapRatio / freshnessWindowDays', () => {
    const cfg = resolveScorerConfig({
      burstCapRatio: 0,
      frequencySaturationCount: -3,
      freshnessWindowDays: Number.POSITIVE_INFINITY, // finite check
    });
    expect(cfg.burstCapRatio).toBe(5);
    expect(cfg.frequencySaturationCount).toBe(5);
    expect(cfg.freshnessWindowDays).toBe(730);
  });

  it('scoreCandidateAccount still produces reasonable scores with default config', () => {
    const candidate: CandidateAccount = {
      name: 'u',
      platform: 'xhs',
      status: 'pending',
      avg_engagement: 1000,
      peak_engagement: 4000,
      appearance_count: 5,
      topics: [],
      first_seen: new Date().toISOString(),
      last_seen: new Date().toISOString(),
    } as CandidateAccount;
    const scored = scoreCandidateAccount(candidate, []);
    expect(scored.score_breakdown.composite).toBeGreaterThan(0);
    expect(scored.score_breakdown.composite).toBeLessThanOrEqual(1);
  });
});

describe('brief-generator tunable resolution', () => {
  it('uses defaults when override is null', () => {
    const l = resolveBriefLimits(null);
    expect(l.trendsPerSection).toBe(3);
    expect(l.staleThresholdDays).toBe(7);
    expect(l.maxRecentPosts).toBe(2);
    expect(l.maxViralEntries).toBe(3);
  });

  it('partial override only changes provided fields', () => {
    const l = resolveBriefLimits({
      trendsPerSection: 5,
      maxViralEntries: 10,
    });
    expect(l.trendsPerSection).toBe(5);
    expect(l.maxViralEntries).toBe(10);
    expect(l.staleThresholdDays).toBe(7); // default preserved
  });

  it('rejects non-positive values and falls back', () => {
    const l = resolveBriefLimits({
      trendsPerSection: -1,
      maxViralEntries: 0,
      staleThresholdDays: Number.NaN,
    });
    expect(l.trendsPerSection).toBe(3);
    expect(l.maxViralEntries).toBe(3);
    expect(l.staleThresholdDays).toBe(7);
  });
});
