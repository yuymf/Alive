// alive/tests/ops/tag-engine.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setBasePaths, resetBasePaths, PATHS, writeJSON, readJSON } from '../../scripts/utils/file-utils';
import type { TagVocabulary, TagEntry, TagSource } from '../../scripts/utils/types';

// ─── Sandbox paths ────────────────────────────────────────────────────────────
const TEST_DIR = path.join(__dirname, '__tag_engine_sandbox__');
const MEMORY_DIR = path.join(TEST_DIR, 'memory');
const SKILL_DIR = path.join(TEST_DIR, 'skill');

// ─── Platform client mocks ────────────────────────────────────────────────────
const { mockSearchXhsNotes, mockSearchDouyinVideos } = vi.hoisted(() => ({
  mockSearchXhsNotes: vi.fn(),
  mockSearchDouyinVideos: vi.fn(),
}));

vi.mock('../../sub-skills/platform/xhs-bridge/scripts/xhs-client', () => ({
  searchXhsNotes: mockSearchXhsNotes,
}));

vi.mock('../../sub-skills/platform/douyin-bridge/scripts/douyin-client', () => ({
  searchDouyinVideos: mockSearchDouyinVideos,
}));

// ─── Sandbox lifecycle ────────────────────────────────────────────────────────
beforeEach(() => {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.mkdirSync(SKILL_DIR, { recursive: true });
  setBasePaths(MEMORY_DIR, SKILL_DIR);
  vi.clearAllMocks();
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ─── Types smoke test ─────────────────────────────────────────────────────────
describe('TagVocabulary types', () => {
  it('can construct a TagVocabulary value', () => {
    const vocab: TagVocabulary = {
      version: 1,
      last_updated: new Date().toISOString(),
      active: [],
      dormant: [],
    };
    expect(vocab.version).toBe(1);
    expect(vocab.active).toEqual([]);
  });

  it('can construct a TagEntry with competitor source', () => {
    const entry: TagEntry = {
      tag: '#电竞女生',
      platform: 'xhs',
      score: 25,
      sources: [{ type: 'competitor', account: 'test_account', platform: 'xhs' }],
      first_seen: new Date().toISOString(),
      last_hit: new Date().toISOString(),
      hit_count: 1,
      peak_score: 25,
    };
    expect(entry.tag).toBe('#电竞女生');
    expect(entry.sources[0].type).toBe('competitor');
  });

  it('can construct a TagEntry with keyword_search source', () => {
    const entry: TagEntry = {
      tag: '#赛车手日常',
      platform: 'douyin',
      score: 15,
      sources: [{ type: 'keyword_search', keyword: '赛车', platform: 'douyin' }],
      first_seen: new Date().toISOString(),
      last_hit: new Date().toISOString(),
      hit_count: 1,
      peak_score: 15,
    };
    expect(entry.sources[0].type).toBe('keyword_search');
  });
});

// ─── Hashtag extraction ───────────────────────────────────────────────────

import {
  extractHashtags,
  scoreForPlatform,
  buildInitialEntry,
  mergeTags,
  runColdStart,
} from '../../scripts/ops/tag-engine';

describe('extractHashtags', () => {
  it('extracts hashtags from a string with # prefix', () => {
    const tags = extractHashtags('#电竞女生 我的日常 #赛车手');
    expect(tags).toContain('#电竞女生');
    expect(tags).toContain('#赛车手');
    expect(tags).not.toContain('我的日常');
  });
  it('extracts hashtags from combined title and description', () => {
    const tags = extractHashtags('今天去赛车了 #赛车日常', '好开心 #电竞');
    expect(tags).toContain('#赛车日常');
    expect(tags).toContain('#电竞');
  });
  it('returns empty array when no hashtags present', () => {
    expect(extractHashtags('这是一段没有话题标签的文字')).toEqual([]);
  });
  it('deduplicates hashtags', () => {
    const tags = extractHashtags('#电竞 #电竞');
    expect(tags.filter(t => t === '#电竞')).toHaveLength(1);
  });
});

describe('scoreForPlatform', () => {
  it('returns 10 for xhs', () => { expect(scoreForPlatform('xhs')).toBe(10); });
  it('returns 15 for douyin', () => { expect(scoreForPlatform('douyin')).toBe(15); });
});

describe('buildInitialEntry', () => {
  it('builds a TagEntry with correct fields', () => {
    const source: TagSource = { type: 'competitor', account: 'v_jie', platform: 'xhs' };
    const entry = buildInitialEntry('#电竞女生', 'xhs', 10, source, '2026-04-09T10:00:00.000Z');
    expect(entry.tag).toBe('#电竞女生');
    expect(entry.platform).toBe('xhs');
    expect(entry.score).toBe(10);
    expect(entry.hit_count).toBe(1);
    expect(entry.peak_score).toBe(10);
    expect(entry.sources).toHaveLength(1);
    expect(entry.sources[0]).toEqual(source);
  });
});

describe('mergeTags', () => {
  const ts = '2026-04-09T10:00:00.000Z';
  it('merges two sources for same tag into one entry, sums scores', () => {
    const maps = [
      new Map([['#电竞', { score: 10, sources: [{ type: 'competitor' as const, account: 'a1', platform: 'xhs' }] }]]),
      new Map([['#电竞', { score: 15, sources: [{ type: 'keyword_search' as const, keyword: 'gaming', platform: 'douyin' }] }]]),
    ];
    const { active, dormant } = mergeTags(maps, ts);
    expect(active).toHaveLength(1);
    expect(active[0].tag).toBe('#电竞');
    expect(active[0].score).toBe(25);
    expect(dormant).toHaveLength(0);
  });
  it('puts single-source tags into dormant with score 5', () => {
    const maps = [
      new Map([['#新手标签', { score: 10, sources: [{ type: 'competitor' as const, account: 'a1', platform: 'xhs' }] }]]),
    ];
    const { active, dormant } = mergeTags(maps, ts);
    expect(active).toHaveLength(0);
    expect(dormant).toHaveLength(1);
    expect(dormant[0].score).toBe(5);
  });
  it('adds multi-competitor bonus +20 when same tag appears from 2+ competitor sources', () => {
    const maps = [
      new Map([['#电竞', { score: 10, sources: [{ type: 'competitor' as const, account: 'a1', platform: 'xhs' }] }]]),
      new Map([['#电竞', { score: 10, sources: [{ type: 'competitor' as const, account: 'a2', platform: 'xhs' }] }]]),
    ];
    const { active } = mergeTags(maps, ts);
    expect(active[0].score).toBe(40); // 10+10+20
  });
});

describe('runColdStart', () => {
  it('writes tag-vocabulary.json with active and dormant lists', async () => {
    mockSearchXhsNotes.mockResolvedValue([
      { id: '1', title: '#电竞女生 测试帖子', description: '', likes: 2000, tags: [], user: 'user1', url: 'http://x', cover: '' },
    ]);
    mockSearchDouyinVideos.mockReturnValue({ success: true, videos: [] });
    const ops = {
      enabled: true,
      competitors: [
        { account: 'competitor_a', platform: 'xhs' },
        { account: 'competitor_b', platform: 'xhs' },
      ],
      trend_score_threshold: 1.5,
      topic_count: 3,
      brief_time: '09:00',
    };
    await runColdStart(ops as any, '2026-04-09T10:00:00.000Z');
    const vocab = readJSON<TagVocabulary>(PATHS.tagVocabulary, null as unknown as TagVocabulary);
    expect(vocab).not.toBeNull();
    expect(vocab.version).toBe(1);
    expect(vocab.active.some(e => e.tag === '#电竞女生')).toBe(true);
  });
  it('skips low-engagement XHS posts (likes < 1000)', async () => {
    mockSearchXhsNotes.mockResolvedValue([
      { id: '1', title: '#低流量', description: '', likes: 500, tags: [], user: 'user1', url: 'http://x', cover: '' },
    ]);
    const ops = {
      enabled: true,
      competitors: [{ account: 'comp', platform: 'xhs' }],
      trend_score_threshold: 1.5,
      topic_count: 3,
      brief_time: '09:00',
    };
    await runColdStart(ops as any, '2026-04-09T10:00:00.000Z');
    const vocab = readJSON<TagVocabulary>(PATHS.tagVocabulary, null as unknown as TagVocabulary);
    expect(vocab.active).toHaveLength(0);
    expect(vocab.dormant).toHaveLength(0);
  });
});

import {
  applyDailyDecay,
  reviveDormantSample,
  refreshActiveTags,
  runDailyMaintenance,
} from '../../scripts/ops/tag-engine';

// ─── Daily maintenance ───────────────────────────────────────────────────────

describe('applyDailyDecay', () => {
  it('multiplies scores by 0.85 (floor)', () => {
    const entry: TagEntry = {
      tag: '#test', platform: 'xhs', score: 100,
      sources: [], first_seen: '2026-04-01T00:00:00.000Z',
      last_hit: '2026-04-09T00:00:00.000Z', hit_count: 5, peak_score: 100,
    };
    const decayed = applyDailyDecay([entry]);
    expect(decayed[0].score).toBe(85); // floor(100 * 0.85)
  });

  it('moves entry to dormant list when score < 5 and last_hit > 7 days ago', () => {
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const entry: TagEntry = {
      tag: '#stale', platform: 'xhs', score: 6,
      sources: [], first_seen: oldDate, last_hit: oldDate, hit_count: 1, peak_score: 10,
    };
    const { stillActive, newDormant } = applyDailyDecay([entry], { returnSplit: true });
    // After decay: 6 * 0.85 = 5.1 → floor → 5 (still >= 5, stays active)
    // Let's test with score 5 → 5*0.85=4.25 → floor=4 < 5 AND last_hit > 7 days
    const entry2: TagEntry = { ...entry, score: 5 };
    const result = applyDailyDecay([entry2], { returnSplit: true });
    expect(result.newDormant).toHaveLength(1);
    expect(result.stillActive).toHaveLength(0);
  });
});

describe('reviveDormantSample', () => {
  it('removes dormant entries where last_hit > 30 days', async () => {
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const stale: TagEntry = {
      tag: '#ancient', platform: 'xhs', score: 3,
      sources: [], first_seen: oldDate, last_hit: oldDate, hit_count: 1, peak_score: 5,
    };
    const { kept } = await reviveDormantSample([stale], []);
    expect(kept).toHaveLength(0);
  });

  it('moves entries to active list when revival search finds high-engagement content', () => {
    // mockSearchXhsNotes returns a high-engagement post — revival should trigger
    mockSearchXhsNotes.mockResolvedValueOnce([
      { id: '1', title: '#复活词 测试', description: '', likes: 2000, tags: [], user: 'u1', url: '', cover: '' },
    ]);

    const recentDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const dormantEntry: TagEntry = {
      tag: '#复活词', platform: 'xhs', score: 3,
      sources: [], first_seen: recentDate, last_hit: recentDate, hit_count: 1, peak_score: 8,
    };

    return reviveDormantSample([dormantEntry], []).then(result => {
      expect(result.revived).toHaveLength(1);
      expect(result.revived[0].score).toBe(15);
    });
  });
});

describe('runDailyMaintenance', () => {
  it('returns a TagVocabulary and updates last_updated', async () => {
    // Seed an existing vocabulary
    const existing: TagVocabulary = {
      version: 1,
      last_updated: '2026-04-08T10:00:00.000Z',
      active: [
        {
          tag: '#电竞', platform: 'xhs', score: 50,
          sources: [{ type: 'competitor', account: 'a1', platform: 'xhs' }],
          first_seen: '2026-04-01T00:00:00.000Z',
          last_hit: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
          hit_count: 5, peak_score: 50,
        },
      ],
      dormant: [],
    };
    writeJSON(PATHS.tagVocabulary, existing);

    mockSearchXhsNotes.mockResolvedValue([]);
    mockSearchDouyinVideos.mockReturnValue({ success: true, videos: [] });

    const result = await runDailyMaintenance('2026-04-09T10:00:00.000Z');
    expect(result.last_updated).toBe('2026-04-09T10:00:00.000Z');
    // Score decayed: 50 * 0.85 = 42
    expect(result.active[0].score).toBe(42);
  });
});
