import { describe, it, expect } from 'vitest';
import {
  computeFatigueScore,
  applyFatiguePenalty,
  buildTrendUsageMap,
} from '../../scripts/ops/trend-analyzer';
import type { TrendItem, TrendUsageRecord } from '../../scripts/ops/trend-analyzer';

// ─── computeFatigueScore ────────────────────────────────────────────────────

describe('computeFatigueScore', () => {
  const refTime = new Date('2026-04-16T12:00:00Z');

  it('returns 0 for no usage records', () => {
    expect(computeFatigueScore([], refTime)).toBe(0);
  });

  it('returns 0.5 for a single use today', () => {
    const records: TrendUsageRecord[] = [
      { keyword: 'test', identity_mode: 'lifestyle', used_at: '2026-04-16T10:00:00Z' },
    ];
    const score = computeFatigueScore(records, refTime);
    // 0.5 * e^(-0.3 * ~0.083 days) ≈ 0.5 * 0.975 ≈ 0.488
    expect(score).toBeCloseTo(0.5 * Math.exp(-0.3 * (2 / 24)), 1);
  });

  it('decays for older usage', () => {
    const recentRecords: TrendUsageRecord[] = [
      { keyword: 'test', identity_mode: 'lifestyle', used_at: '2026-04-16T10:00:00Z' },
    ];
    const oldRecords: TrendUsageRecord[] = [
      { keyword: 'test', identity_mode: 'lifestyle', used_at: '2026-04-09T10:00:00Z' },
    ];

    const recentScore = computeFatigueScore(recentRecords, refTime);
    const oldScore = computeFatigueScore(oldRecords, refTime);

    expect(recentScore).toBeGreaterThan(oldScore);
  });

  it('accumulates for multiple uses', () => {
    const records: TrendUsageRecord[] = [
      { keyword: 'test', identity_mode: 'lifestyle', used_at: '2026-04-16T10:00:00Z' },
      { keyword: 'test', identity_mode: 'lifestyle', used_at: '2026-04-16T08:00:00Z' },
    ];
    const score = computeFatigueScore(records, refTime);
    // Two recent uses: ~0.5 * 2 ≈ 1.0, but capped at 0.9
    expect(score).toBe(0.9);
  });

  it('caps at 0.9 maximum', () => {
    const records: TrendUsageRecord[] = Array.from({ length: 10 }, (_, i) => ({
      keyword: 'test',
      identity_mode: 'lifestyle',
      used_at: `2026-04-16T0${i}:00:00Z`,
    }));
    const score = computeFatigueScore(records, refTime);
    expect(score).toBe(0.9);
  });
});

// ─── applyFatiguePenalty ────────────────────────────────────────────────────

describe('applyFatiguePenalty', () => {
  const refTime = new Date('2026-04-16T12:00:00Z');

  function makeTrendItem(keyword: string, priority = 100): TrendItem {
    return {
      keyword,
      platform: 'xhs',
      velocity_score: 2.0,
      priority_score: priority,
      source_bucket: 'hot',
      identity_mode: 'lifestyle',
    };
  }

  it('returns items unchanged when usage map is empty', () => {
    const items = [makeTrendItem('fresh')];
    const result = applyFatiguePenalty(items, new Map(), refTime);
    expect(result[0].priority_score).toBe(100);
  });

  it('reduces priority for recently-used keywords', () => {
    const items = [makeTrendItem('王者荣耀')];
    const usageMap = new Map<string, TrendUsageRecord[]>([
      ['王者荣耀', [{ keyword: '王者荣耀', identity_mode: 'lifestyle', used_at: '2026-04-16T10:00:00Z' }]],
    ]);

    const result = applyFatiguePenalty(items, usageMap, refTime);
    expect(result[0].priority_score).toBeLessThan(100);
  });

  it('matches substrings for keyword variations', () => {
    const items = [makeTrendItem('王者荣耀新赛季')];
    const usageMap = new Map<string, TrendUsageRecord[]>([
      ['王者荣耀', [{ keyword: '王者荣耀', identity_mode: 'lifestyle', used_at: '2026-04-16T10:00:00Z' }]],
    ]);

    const result = applyFatiguePenalty(items, usageMap, refTime);
    expect(result[0].priority_score).toBeLessThan(100);
  });

  it('does not reduce priority for unused keywords', () => {
    const items = [makeTrendItem('全新话题')];
    const usageMap = new Map<string, TrendUsageRecord[]>([
      ['其他关键词', [{ keyword: '其他关键词', identity_mode: 'lifestyle', used_at: '2026-04-16T10:00:00Z' }]],
    ]);

    const result = applyFatiguePenalty(items, usageMap, refTime);
    expect(result[0].priority_score).toBe(100);
  });
});

// ─── buildTrendUsageMap ─────────────────────────────────────────────────────

describe('buildTrendUsageMap', () => {
  const refTime = new Date('2026-04-16T12:00:00Z');

  it('excludes expired items', () => {
    const items = [
      { trend_hook: '王者荣耀 (xhs, 2.0x)', identity_mode: 'lifestyle', created_at: '2026-04-15T10:00:00Z', status: 'expired' },
    ];
    const map = buildTrendUsageMap(items, 7, refTime);
    expect(map.size).toBe(0);
  });

  it('groups usage records by normalized keyword', () => {
    const items = [
      { trend_hook: '王者荣耀 (xhs, 2.0x)', identity_mode: 'lifestyle', created_at: '2026-04-15T10:00:00Z', status: 'pending' },
      { trend_hook: '王者荣耀 (douyin, 1.5x)', identity_mode: 'esports', created_at: '2026-04-14T10:00:00Z', status: 'approved' },
    ];
    const map = buildTrendUsageMap(items, 7, refTime);
    expect(map.get('王者荣耀')).toHaveLength(2);
  });

  it('excludes items beyond lookback window', () => {
    const items = [
      { trend_hook: '老话题 (xhs, 1.0x)', identity_mode: 'lifestyle', created_at: '2026-04-01T10:00:00Z', status: 'pending' },
    ];
    const map = buildTrendUsageMap(items, 7, refTime);
    expect(map.size).toBe(0);
  });
});
