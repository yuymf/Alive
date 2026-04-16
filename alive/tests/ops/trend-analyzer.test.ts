import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  computeVelocityScore,
  filterByThreshold,
  buildRelevancePrompt,
  injectTagVocabularyItems,
  computeSyntheticSignalScore,
  computeTopicSpecificityPenalty,
  applySignalQuota,
} from '../../scripts/ops/trend-analyzer';
import { setBasePaths, resetBasePaths, PATHS, writeJSON } from '../../scripts/utils/file-utils';
import { TrendItem, TagVocabulary } from '../../scripts/utils/types';

// ─── Sandbox setup for tests that need file-system access ───────────────────

const SANDBOX = path.join(os.tmpdir(), '__trend_analyzer_tag_sandbox__');

beforeEach(() => {
  fs.mkdirSync(SANDBOX, { recursive: true });
  setBasePaths(SANDBOX, SANDBOX);
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function makeTrendItem(overrides: Partial<TrendItem> = {}): TrendItem {
  return {
    platform: 'douyin',
    keyword: '#默认',
    current_volume: 100,
    avg_7d: 100,
    velocity_score: 1.0,
    rank: 1,
    source_type: 'hot_list',
    source_bucket: '热榜',
    signal_kind: 'breakout',
    priority_score: 1.0,
    ...overrides,
  };
}

// ─── Pure function tests ─────────────────────────────────────────────────────

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
    makeTrendItem({ platform: 'douyin', keyword: '#电竞', current_volume: 300, avg_7d: 100, velocity_score: 3.0, rank: 1, priority_score: 3.0 }),
    makeTrendItem({ platform: 'weibo', keyword: '#音乐', current_volume: 150, avg_7d: 100, velocity_score: 1.5, rank: 2, priority_score: 1.5 }),
    makeTrendItem({ platform: 'bilibili', keyword: '#生活', current_volume: 90, avg_7d: 100, velocity_score: 0.9, rank: 3, priority_score: 0.9 }),
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
      makeTrendItem({ platform: 'douyin', keyword: '#电竞女孩', current_volume: 300, avg_7d: 100, velocity_score: 3.0, rank: 1, priority_score: 3.0 }),
    ];
    const prompt = buildRelevancePrompt(items, '赛车手、歌手', 3);
    expect(prompt).toContain('#电竞女孩');
    expect(prompt).toContain('赛车手、歌手');
  });
});

// ─── Tag vocabulary injection tests ─────────────────────────────────────────

describe('tag vocabulary injection into withVelocity', () => {
  it('injectTagVocabularyItems returns TrendItem array from active tags', () => {
    const vocab: TagVocabulary = {
      version: 1,
      last_updated: new Date().toISOString(),
      active: [
        {
          tag: '#注入测试', platform: 'xhs', score: 50,
          sources: [{ type: 'competitor', account: 'a1', platform: 'xhs' }],
          first_seen: new Date().toISOString(), last_hit: new Date().toISOString(),
          hit_count: 2, peak_score: 50,
        },
      ],
      dormant: [],
    };
    writeJSON(PATHS.tagVocabulary, vocab);

    const items = injectTagVocabularyItems();
    expect(items).toHaveLength(1);
    expect(items[0].keyword).toBe('#注入测试');
    expect(items[0].platform).toBe('xhs');
    expect(items[0].velocity_score).toBeCloseTo(computeSyntheticSignalScore({
      count: 2,
      avgEngagement: 50,
      floor: 0.9,
      ceiling: 1.5,
    }));
    expect(items[0].signal_kind).toBe('recommended_track');
    expect(items[0].display_metric).toBe('命中 2 次');
    expect(items[0].rank).toBe(999);
  });

  it('injectTagVocabularyItems returns empty array when no vocabulary file', () => {
    const items = injectTagVocabularyItems();
    expect(items).toEqual([]);
  });
});

describe('computeSyntheticSignalScore', () => {
  it('returns bounded score for non-breakout sources', () => {
    const score = computeSyntheticSignalScore({
      count: 20,
      avgEngagement: 999999,
      floor: 0.9,
      ceiling: 1.5,
    });
    expect(score).toBeLessThanOrEqual(1.5);
    expect(score).toBeGreaterThanOrEqual(0.9);
  });
});

describe('computeTopicSpecificityPenalty', () => {
  it('does not penalize breakout signals', () => {
    expect(computeTopicSpecificityPenalty('电竞', 'breakout')).toBe(1.0);
  });

  it('penalizes generic short non-breakout keywords', () => {
    const penalty = computeTopicSpecificityPenalty('电竞', 'recommended_track');
    expect(penalty).toBeLessThan(1.0);
  });
});

describe('applySignalQuota', () => {
  it('keeps breakout/search presence and caps recommended_track share', () => {
    const items: TrendItem[] = [
      makeTrendItem({ keyword: '推荐1', signal_kind: 'recommended_track', source_type: 'tag_engine', source_bucket: '赛道 Tag', priority_score: 9.9 }),
      makeTrendItem({ keyword: '推荐2', signal_kind: 'recommended_track', source_type: 'tag_engine', source_bucket: '赛道 Tag', priority_score: 9.7 }),
      makeTrendItem({ keyword: '推荐3', signal_kind: 'recommended_track', source_type: 'tag_engine', source_bucket: '赛道 Tag', priority_score: 9.5 }),
      makeTrendItem({ keyword: '推荐4', signal_kind: 'recommended_track', source_type: 'tag_engine', source_bucket: '赛道 Tag', priority_score: 9.3 }),
      makeTrendItem({ keyword: '热榜1', signal_kind: 'breakout', source_type: 'hot_list', source_bucket: '热榜', priority_score: 8.8 }),
      makeTrendItem({ keyword: '搜索1', signal_kind: 'search_demand', source_type: 'search_keyword', source_bucket: '搜索', priority_score: 8.6 }),
      makeTrendItem({ keyword: '热榜2', signal_kind: 'breakout', source_type: 'hot_list', source_bucket: '热榜', priority_score: 8.1 }),
    ];

    const picked = applySignalQuota(items, 5);
    const recommendedCount = picked.filter(i => i.signal_kind === 'recommended_track').length;

    expect(picked.length).toBe(5);
    expect(recommendedCount).toBeLessThanOrEqual(2);
    expect(picked.some(i => i.signal_kind === 'breakout')).toBe(true);
    expect(picked.some(i => i.signal_kind === 'search_demand')).toBe(true);
  });
});
