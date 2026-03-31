import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeVelocityScore, filterByThreshold, buildRelevancePrompt } from '../../scripts/ops/trend-analyzer';
import { TrendItem } from '../../scripts/utils/types';

describe('computeVelocityScore', () => {
  it('returns current/avg when avg > 0', () => {
    expect(computeVelocityScore(200, 100)).toBeCloseTo(2.0);
  });

  it('returns 1.0 when avg is 0 (unknown history)', () => {
    expect(computeVelocityScore(500, 0)).toBeCloseTo(1.0);
  });

  it('returns 1.0 when equal', () => {
    expect(computeVelocityScore(100, 100)).toBeCloseTo(1.0);
  });
});

describe('filterByThreshold', () => {
  const items: TrendItem[] = [
    { platform: 'douyin', keyword: '#电竞', current_volume: 300, avg_7d: 100, velocity_score: 3.0, rank: 1 },
    { platform: 'weibo', keyword: '#音乐', current_volume: 150, avg_7d: 100, velocity_score: 1.5, rank: 2 },
    { platform: 'bilibili', keyword: '#生活', current_volume: 90, avg_7d: 100, velocity_score: 0.9, rank: 3 },
  ];

  it('returns only items above threshold', () => {
    const result = filterByThreshold(items, 1.8);
    expect(result).toHaveLength(1);
    expect(result[0].keyword).toBe('#电竞');
  });

  it('returns all items when threshold is 0', () => {
    expect(filterByThreshold(items, 0)).toHaveLength(3);
  });
});

describe('buildRelevancePrompt', () => {
  it('contains trend keywords in prompt', () => {
    const items: TrendItem[] = [
      { platform: 'douyin', keyword: '#电竞女孩', current_volume: 300, avg_7d: 100, velocity_score: 3.0, rank: 1 },
    ];
    const prompt = buildRelevancePrompt(items, '赛车手、歌手', 3);
    expect(prompt).toContain('#电竞女孩');
    expect(prompt).toContain('赛车手、歌手');
  });
});
