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
    const scored = scoreCandidateAccount(candidate, ['singer', 'racer', 'esports', 'daily'], []);
    expect(scored.score_breakdown.track_overlap).toBe(1.0);
  });

  it('no identity keys matched → 0.0', () => {
    const candidate = makeCandidate({ topics: ['cooking', 'fitness'] });
    const scored = scoreCandidateAccount(candidate, ['singer', 'racer', 'esports', 'daily'], []);
    expect(scored.score_breakdown.track_overlap).toBe(0.0);
  });

  it('empty identityKeys → fallback 0.5', () => {
    const candidate = makeCandidate({ topics: ['音乐', '赛车'] });
    const scored = scoreCandidateAccount(candidate, [], []);
    expect(scored.score_breakdown.track_overlap).toBe(0.5);
  });

  it('partial match: 2 out of 4 keys hit → 0.5', () => {
    const candidate = makeCandidate({ topics: ['赛车', '电竞'] });
    const scored = scoreCandidateAccount(candidate, ['singer', 'racer', 'esports', 'daily'], []);
    expect(scored.score_breakdown.track_overlap).toBe(0.5);
  });
});

// ─── burst_intensity ──────────────────────────────────────────────────────────

describe('burst_intensity', () => {
  it('peak / avg = 3 → burst_intensity = 0.6', () => {
    const candidate = makeCandidate({ avg_engagement: 1000, peak_engagement: 3000 } as CandidateAccount & { peak_engagement: number });
    const scored = scoreCandidateAccount(candidate, [], []);
    expect(scored.score_breakdown.burst_intensity).toBeCloseTo(0.6, 5);
  });

  it('peak / avg = 10 (exceeds cap of 5) → burst_intensity = 1.0', () => {
    const candidate = makeCandidate({ avg_engagement: 1000, peak_engagement: 10000 } as CandidateAccount & { peak_engagement: number });
    const scored = scoreCandidateAccount(candidate, [], []);
    expect(scored.score_breakdown.burst_intensity).toBe(1.0);
  });

  it('peak = avg → burst_intensity = 0.2', () => {
    const candidate = makeCandidate({ avg_engagement: 1000, peak_engagement: 1000 } as CandidateAccount & { peak_engagement: number });
    const scored = scoreCandidateAccount(candidate, [], []);
    expect(scored.score_breakdown.burst_intensity).toBeCloseTo(0.2, 5);
  });

  it('missing peak_engagement → fallback to avg_engagement, burst_intensity = 0.2', () => {
    // No peak_engagement field — should treat peak = avg
    const candidate = makeCandidate({ avg_engagement: 1000 });
    const scored = scoreCandidateAccount(candidate, [], []);
    expect(scored.score_breakdown.burst_intensity).toBeCloseTo(0.2, 5);
  });
});

// ─── frequency ────────────────────────────────────────────────────────────────

describe('frequency', () => {
  it('appearance_count = 5 → frequency = 1.0', () => {
    const candidate = makeCandidate({ appearance_count: 5 });
    const scored = scoreCandidateAccount(candidate, [], []);
    expect(scored.score_breakdown.frequency).toBe(1.0);
  });

  it('appearance_count > 5 → frequency capped at 1.0', () => {
    const candidate = makeCandidate({ appearance_count: 10 });
    const scored = scoreCandidateAccount(candidate, [], []);
    expect(scored.score_breakdown.frequency).toBe(1.0);
  });

  it('appearance_count = 2 → frequency = 0.4', () => {
    const candidate = makeCandidate({ appearance_count: 2 });
    const scored = scoreCandidateAccount(candidate, [], []);
    expect(scored.score_breakdown.frequency).toBeCloseTo(0.4, 5);
  });
});

// ─── composite formula ────────────────────────────────────────────────────────

describe('composite formula', () => {
  it('composite = track_overlap×0.45 + burst_intensity×0.35 + frequency×0.20', () => {
    // With empty identityKeys: track_overlap=0.5, peak=avg → burst=0.2, count=5 → freq=1.0
    const candidate = makeCandidate({ avg_engagement: 1000, appearance_count: 5 });
    const scored = scoreCandidateAccount(candidate, [], []);
    const { track_overlap, burst_intensity, frequency, composite } = scored.score_breakdown;
    const expected = track_overlap * 0.45 + burst_intensity * 0.35 + frequency * 0.20;
    expect(composite).toBeCloseTo(expected, 10);
    // Verify the exact values too
    expect(track_overlap).toBe(0.5);
    expect(burst_intensity).toBeCloseTo(0.2, 5);
    expect(frequency).toBe(1.0);
    expect(composite).toBeCloseTo(0.5 * 0.45 + 0.2 * 0.35 + 1.0 * 0.20, 10);
  });
});

// ─── rankCandidates ───────────────────────────────────────────────────────────

describe('rankCandidates', () => {
  it('returns candidates sorted by composite score descending', () => {
    // high scorer: all topics match, high peak, high frequency
    const high = makeCandidate({
      name: 'highscore',
      topics: ['音乐', '赛车', '电竞', '日常'],
      appearance_count: 5,
      avg_engagement: 1000,
      peak_engagement: 5000,
    } as CandidateAccount & { peak_engagement: number });

    // low scorer: no topics match, low peak, low frequency
    const low = makeCandidate({
      name: 'lowscore',
      topics: ['cooking'],
      appearance_count: 1,
      avg_engagement: 1000,
      peak_engagement: 1000,
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
});
