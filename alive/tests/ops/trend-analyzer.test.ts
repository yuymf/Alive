import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  computeVelocityScore,
  filterByThreshold,
  buildRelevancePrompt,
  injectTagVocabularyItems,
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
    expect(items[0].velocity_score).toBeCloseTo(0.5); // score/100 = 50/100
    expect(items[0].rank).toBe(999);
  });

  it('injectTagVocabularyItems returns empty array when no vocabulary file', () => {
    const items = injectTagVocabularyItems();
    expect(items).toEqual([]);
  });
});
