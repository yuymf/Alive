import { describe, it, expect } from 'vitest';
import { scoreCandidateAccount, rankCandidates } from '../../scripts/ops/candidate-scorer';
import type { CandidateAccount, CandidateAccountsStore } from '../../scripts/ops/discovery-engine';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCandidate(overrides: Partial<CandidateAccount> & { peak_engagement?: number } = {}): CandidateAccount {
  return {
    name: 'testuser',
    platform: 'xhs',
    status: 'pending',
    avg_engagement: 1000,
    appearance_count: 3,
    topics: [],
    first_seen: '2026-01-01',
    last_seen: '2026-01-03',
    ...overrides,
  } as CandidateAccount;
}

function makeStore(candidates: CandidateAccount[]): CandidateAccountsStore {
  return { candidates, last_updated: '' };
}

// ─── track_overlap ────────────────────────────────────────────────────────────

describe('track_overlap', () => {
  it('all identity keys matched → 1.0', () => {
    const candidate = makeCandidate({ topics: ['音乐', '赛车', '电竞', '日常'] });
    const scored = scoreCandidateAccount(candidate, ['singer', 'racer', 'esports', 'daily']);
    expect(scored.score_breakdown.track_overlap).toBe(1.0);
  });

  it('no identity keys matched → 0.0', () => {
    const candidate = makeCandidate({ topics: ['cooking', 'fitness'] });
    const scored = scoreCandidateAccount(candidate, ['singer', 'racer', 'esports', 'daily']);
    expect(scored.score_breakdown.track_overlap).toBe(0.0);
  });

  it('empty identityKeys → fallback 0.5', () => {
    const candidate = makeCandidate({ topics: ['音乐', '赛车'] });
    const scored = scoreCandidateAccount(candidate, []);
    expect(scored.score_breakdown.track_overlap).toBe(0.5);
  });

  it('partial match: 2 out of 4 keys hit → 0.5', () => {
    const candidate = makeCandidate({ topics: ['赛车', '电竞'] });
    const scored = scoreCandidateAccount(candidate, ['singer', 'racer', 'esports', 'daily']);
    expect(scored.score_breakdown.track_overlap).toBe(0.5);
  });
});

// ─── burst_intensity ──────────────────────────────────────────────────────────

describe('burst_intensity', () => {
  it('peak / avg = 3 → burst_intensity = 0.6', () => {
    const candidate = makeCandidate({ avg_engagement: 1000, peak_engagement: 3000 } as CandidateAccount & { peak_engagement: number });
    const scored = scoreCandidateAccount(candidate, []);
    expect(scored.score_breakdown.burst_intensity).toBeCloseTo(0.6, 5);
  });

  it('peak / avg = 10 (exceeds cap of 5) → burst_intensity = 1.0', () => {
    const candidate = makeCandidate({ avg_engagement: 1000, peak_engagement: 10000 } as CandidateAccount & { peak_engagement: number });
    const scored = scoreCandidateAccount(candidate, []);
    expect(scored.score_breakdown.burst_intensity).toBe(1.0);
  });

  it('peak = avg → burst_intensity = 0.2', () => {
    const candidate = makeCandidate({ avg_engagement: 1000, peak_engagement: 1000 } as CandidateAccount & { peak_engagement: number });
    const scored = scoreCandidateAccount(candidate, []);
    expect(scored.score_breakdown.burst_intensity).toBeCloseTo(0.2, 5);
  });

  it('missing peak_engagement → fallback to avg_engagement, burst_intensity = 0.2', () => {
    const candidate = makeCandidate({ avg_engagement: 1000 });
    const scored = scoreCandidateAccount(candidate, []);
    expect(scored.score_breakdown.burst_intensity).toBeCloseTo(0.2, 5);
  });

  it('avg_engagement = 0 → does not divide by zero', () => {
    const candidate = makeCandidate({ avg_engagement: 0 });
    const scored = scoreCandidateAccount(candidate, []);
    expect(scored.score_breakdown.burst_intensity).toBe(0);
  });
});

// ─── frequency ────────────────────────────────────────────────────────────────

describe('frequency', () => {
  it('appearance_count = 5 → frequency = 1.0', () => {
    const candidate = makeCandidate({ appearance_count: 5 });
    const scored = scoreCandidateAccount(candidate, []);
    expect(scored.score_breakdown.frequency).toBe(1.0);
  });

  it('appearance_count > 5 → frequency capped at 1.0', () => {
    const candidate = makeCandidate({ appearance_count: 10 });
    const scored = scoreCandidateAccount(candidate, []);
    expect(scored.score_breakdown.frequency).toBe(1.0);
  });

  it('appearance_count = 2 → frequency = 0.4', () => {
    const candidate = makeCandidate({ appearance_count: 2 });
    const scored = scoreCandidateAccount(candidate, []);
    expect(scored.score_breakdown.frequency).toBeCloseTo(0.4, 5);
  });
});

// ─── account_freshness ────────────────────────────────────────────────────────

describe('account_freshness', () => {
  it('first_seen within 2 years → freshness = 1.0', () => {
    // Use a date within the last 2 years
    const recentDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const candidate = makeCandidate({ first_seen: recentDate });
    const scored = scoreCandidateAccount(candidate, []);
    expect(scored.score_breakdown.account_freshness).toBe(1.0);
  });

  it('first_seen exactly 2 years ago → freshness ≈ 1.0 (at boundary)', () => {
    const twoYearsAgo = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const candidate = makeCandidate({ first_seen: twoYearsAgo });
    const scored = scoreCandidateAccount(candidate, []);
    // Allow small floating-point variance from Date.now() timing
    expect(scored.score_breakdown.account_freshness).toBeGreaterThanOrEqual(0.999);
    expect(scored.score_breakdown.account_freshness).toBeLessThanOrEqual(1.0);
  });

  it('first_seen 3 years ago → freshness decays below 1.0', () => {
    const threeYearsAgo = new Date(Date.now() - 1095 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const candidate = makeCandidate({ first_seen: threeYearsAgo });
    const scored = scoreCandidateAccount(candidate, []);
    expect(scored.score_breakdown.account_freshness).toBeGreaterThan(0);
    expect(scored.score_breakdown.account_freshness).toBeLessThan(1.0);
  });

  it('first_seen 4+ years ago → freshness ≈ 0', () => {
    const fourYearsAgo = new Date(Date.now() - 1461 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const candidate = makeCandidate({ first_seen: fourYearsAgo });
    const scored = scoreCandidateAccount(candidate, []);
    expect(scored.score_breakdown.account_freshness).toBeCloseTo(0, 1);
  });

  it('missing first_seen → neutral 0.5', () => {
    const candidate = makeCandidate({ first_seen: undefined } as Partial<CandidateAccount>);
    // Remove first_seen entirely
    const { first_seen: _, ...withoutFirstSeen } = candidate;
    const scored = scoreCandidateAccount(withoutFirstSeen as CandidateAccount, []);
    expect(scored.score_breakdown.account_freshness).toBe(0.5);
  });
});

// ─── data_stability ───────────────────────────────────────────────────────────

describe('data_stability', () => {
  it('content_driven_factor = 0 → stability = 1.0 (account-driven, consistent)', () => {
    const candidate = makeCandidate({ content_driven_factor: 0 });
    const scored = scoreCandidateAccount(candidate, []);
    expect(scored.score_breakdown.data_stability).toBe(1.0);
  });

  it('content_driven_factor = 1 → stability = 0.0 (content-driven, volatile)', () => {
    const candidate = makeCandidate({ content_driven_factor: 1 });
    const scored = scoreCandidateAccount(candidate, []);
    expect(scored.score_breakdown.data_stability).toBe(0.0);
  });

  it('content_driven_factor = 0.5 → stability = 0.5', () => {
    const candidate = makeCandidate({ content_driven_factor: 0.5 });
    const scored = scoreCandidateAccount(candidate, []);
    expect(scored.score_breakdown.data_stability).toBeCloseTo(0.5, 5);
  });

  it('no content_driven_factor → falls back to inverse burst_intensity', () => {
    // peak = avg → burst = 0.2 → stability = 0.8
    const candidate = makeCandidate({ avg_engagement: 1000, peak_engagement: 1000 } as CandidateAccount & { peak_engagement: number });
    const scored = scoreCandidateAccount(candidate, []);
    expect(scored.score_breakdown.data_stability).toBeCloseTo(0.8, 5);
  });
});

// ─── composite formula ────────────────────────────────────────────────────────

describe('composite formula', () => {
  it('composite = track_overlap×0.30 + burst_intensity×0.25 + frequency×0.15 + account_freshness×0.15 + data_stability×0.15', () => {
    // With empty identityKeys: track_overlap=0.5, peak=avg → burst=0.2, count=5 → freq=1.0
    // first_seen in 2026 → freshness=1.0, no cdf → stability=1-0.2=0.8
    const candidate = makeCandidate({ avg_engagement: 1000, appearance_count: 5, first_seen: '2026-01-01' });
    const scored = scoreCandidateAccount(candidate, []);
    const { track_overlap, burst_intensity, frequency, account_freshness, data_stability, composite } = scored.score_breakdown;
    const expected = track_overlap * 0.30 + burst_intensity * 0.25 + frequency * 0.15 + account_freshness * 0.15 + data_stability * 0.15;
    expect(composite).toBeCloseTo(expected, 10);
    // Verify the exact values
    expect(track_overlap).toBe(0.5);
    expect(burst_intensity).toBeCloseTo(0.2, 5);
    expect(frequency).toBe(1.0);
    expect(account_freshness).toBe(1.0); // 2026-01-01 is recent
    expect(data_stability).toBeCloseTo(0.8, 5); // fallback: 1 - burst
  });
});

// ─── rankCandidates ───────────────────────────────────────────────────────────

describe('rankCandidates', () => {
  it('returns candidates sorted by composite score descending', () => {
    // high scorer: all topics match, high peak, high frequency, recent start, low cdf
    const high = makeCandidate({
      name: 'highscore',
      topics: ['音乐', '赛车', '电竞', '日常'],
      appearance_count: 5,
      avg_engagement: 1000,
      peak_engagement: 5000,
      first_seen: '2025-06-01',
      content_driven_factor: 0.2,
    } as CandidateAccount & { peak_engagement: number });

    // low scorer: no topics match, low peak, low frequency, old start, high cdf
    const low = makeCandidate({
      name: 'lowscore',
      topics: ['cooking'],
      appearance_count: 1,
      avg_engagement: 1000,
      peak_engagement: 1000,
      first_seen: '2020-01-01',
      content_driven_factor: 0.9,
    } as CandidateAccount & { peak_engagement: number });

    const store = makeStore([low, high]); // intentionally reversed
    const ranked = rankCandidates(store, ['singer', 'racer', 'esports', 'daily']);
    expect(ranked[0].name).toBe('highscore');
    expect(ranked[1].name).toBe('lowscore');
    expect(ranked[0].score_breakdown.composite).toBeGreaterThan(ranked[1].score_breakdown.composite);
  });

  it('statusFilter "pending" only returns pending candidates', () => {
    const pending = makeCandidate({ name: 'pendingUser', status: 'pending' });
    const approved = makeCandidate({ name: 'approvedUser', status: 'approved' });
    const dismissed = makeCandidate({ name: 'dismissedUser', status: 'dismissed' });

    const store = makeStore([pending, approved, dismissed]);
    const ranked = rankCandidates(store, [], 'pending');
    expect(ranked).toHaveLength(1);
    expect(ranked[0].name).toBe('pendingUser');
  });

  it('no statusFilter returns all candidates', () => {
    const pending = makeCandidate({ name: 'pendingUser', status: 'pending' });
    const approved = makeCandidate({ name: 'approvedUser', status: 'approved' });

    const store = makeStore([pending, approved]);
    const ranked = rankCandidates(store, []);
    expect(ranked).toHaveLength(2);
  });

  it('empty candidates array → returns empty array', () => {
    const store = makeStore([]);
    const ranked = rankCandidates(store, ['singer']);
    expect(ranked).toHaveLength(0);
  });

  it('statusFilter "approved" isolates approved candidates', () => {
    const pending = makeCandidate({ name: 'p', status: 'pending' });
    const approved = makeCandidate({ name: 'a', status: 'approved' });
    const store = makeStore([pending, approved]);
    const ranked = rankCandidates(store, [], 'approved');
    expect(ranked).toHaveLength(1);
    expect(ranked[0].name).toBe('a');
  });

  it('recently-started account ranks higher than old account with same engagement', () => {
    const recent = makeCandidate({
      name: 'recent_acct',
      topics: ['音乐'],
      appearance_count: 3,
      avg_engagement: 1000,
      peak_engagement: 3000,
      first_seen: '2025-06-01',
    } as CandidateAccount & { peak_engagement: number });

    const old = makeCandidate({
      name: 'old_acct',
      topics: ['音乐'],
      appearance_count: 3,
      avg_engagement: 1000,
      peak_engagement: 3000,
      first_seen: '2020-01-01',
    } as CandidateAccount & { peak_engagement: number });

    const store = makeStore([recent, old]);
    const ranked = rankCandidates(store, ['singer']);
    expect(ranked[0].name).toBe('recent_acct');
    expect(ranked[0].score_breakdown.account_freshness).toBeGreaterThan(ranked[1].score_breakdown.account_freshness);
  });

  it('stable account ranks higher than volatile account with same track and burst', () => {
    const stable = makeCandidate({
      name: 'stable_acct',
      topics: ['电竞'],
      appearance_count: 3,
      avg_engagement: 1000,
      peak_engagement: 1500,
      first_seen: '2025-01-01',
      content_driven_factor: 0.1,
    } as CandidateAccount & { peak_engagement: number });

    const volatile = makeCandidate({
      name: 'volatile_acct',
      topics: ['电竞'],
      appearance_count: 3,
      avg_engagement: 1000,
      peak_engagement: 1500,
      first_seen: '2025-01-01',
      content_driven_factor: 0.8,
    } as CandidateAccount & { peak_engagement: number });

    const store = makeStore([stable, volatile]);
    const ranked = rankCandidates(store, ['esports']);
    expect(ranked[0].name).toBe('stable_acct');
    expect(ranked[0].score_breakdown.data_stability).toBeGreaterThan(ranked[1].score_breakdown.data_stability);
  });
});
