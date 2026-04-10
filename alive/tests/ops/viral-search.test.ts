/**
 * viral-search.test.ts
 * Tests for the three proactive viral-content discovery capabilities.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { setBasePaths, resetBasePaths, PATHS, writeJSON, readJSON } from '../../scripts/utils/file-utils';
import { clearPersonaCache } from '../../scripts/persona/persona-loader';
import { loadDiscoveryPool, saveDiscoveryPool } from '../../scripts/ops/discovery-engine';
import YAML from 'yaml';
import type { PersonaConfig, TrendHistory, PostAnalysisLog, TagVocabulary } from '../../scripts/utils/types';

// Must import after mocks are set up
import {
  searchXhsViral,
  searchDouyinViral,
  buildXhsUrl,
  extractTopTrendKeywords,
  runViralSearch,
  runCrossPlatformRadar,
  runAutoBreakdown,
  VIRAL_ENGAGEMENT_THRESHOLD,
  RADAR_ENGAGEMENT_THRESHOLD,
  AUTO_BREAKDOWN_THRESHOLD,
  MAX_AUTO_BREAKDOWNS,
} from '../../scripts/ops/viral-search';

// ─── Mock platform clients ─────────────────────────────────────────────────

const mockSearchXhsNotes = vi.fn().mockResolvedValue([]);
const mockSearchDouyinVideos = vi.fn().mockReturnValue({ success: true, videos: [] });
const mockAnalyzePost = vi.fn().mockResolvedValue({
  url: 'https://example.com',
  platform: 'xhs',
  title: 'Test',
  hook_patterns: [],
  core_selling_points: [],
  comment_sentiment: { positive_ratio: 0.5, negative_ratio: 0.2, neutral_ratio: 0.3, top_keywords: [], emotional_triggers: [] },
  content_structure: { opening_hook: '', body_flow: '', closing_cta: '', visual_strategy: '' },
  analyzed_at: new Date().toISOString(),
});
const mockPersistAnalysis = vi.fn();

vi.mock('../../sub-skills/platform/xhs-bridge/scripts/xhs-client', () => ({
  searchXhsNotes: (...args: unknown[]) => mockSearchXhsNotes(...args),
}));

vi.mock('../../sub-skills/platform/douyin-bridge/scripts/douyin-client', () => ({
  searchDouyinVideos: (...args: unknown[]) => mockSearchDouyinVideos(...args),
}));

vi.mock('../../scripts/ops/viral-analyzer', () => ({
  analyzePost: (...args: unknown[]) => mockAnalyzePost(...args),
  persistAnalysis: (...args: unknown[]) => mockPersistAnalysis(...args),
}));

// ─── Sandbox ────────────────────────────────────────────────────────────────

const TEST_DIR = path.join(__dirname, '__viral_search_test_sandbox__');

function cleanSandbox() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
  setBasePaths(TEST_DIR, path.join(TEST_DIR, '_skills'));
}

function writePersona(overrides: Partial<PersonaConfig> = {}) {
  const persona: any = {
    name: 'test-persona',
    personality: {
      mbti: 'ENFP',
      core_traits: ['creative'],
      tone: 'casual',
    },
    content_sources: {
      platforms: ['xhs'],
      keywords: ['AI agent', 'digital life', 'LLM'],
      dailyhot_platforms: [],
      reddit_subreddits: [],
    },
    ops: {
      competitors: [],
    },
    ...overrides,
  };
  fs.mkdirSync(path.dirname(PATHS.personaConfig), { recursive: true });
  fs.writeFileSync(PATHS.personaConfig, YAML.stringify(persona));
  clearPersonaCache();
}

beforeEach(() => {
  cleanSandbox();
  clearPersonaCache();
  // Ensure empty discovery pool for each test
  saveDiscoveryPool({ items: [], last_updated: '' });
  mockSearchXhsNotes.mockReset().mockResolvedValue([]);
  mockSearchDouyinVideos.mockReset().mockReturnValue({ success: true, videos: [] });
  mockAnalyzePost.mockReset().mockResolvedValue({
    url: 'https://example.com',
    platform: 'xhs',
    title: 'Test',
    hook_patterns: [],
    core_selling_points: [],
    comment_sentiment: { positive_ratio: 0.5, negative_ratio: 0.2, neutral_ratio: 0.3, top_keywords: [], emotional_triggers: [] },
    content_structure: { opening_hook: '', body_flow: '', closing_cta: '', visual_strategy: '' },
    analyzed_at: new Date().toISOString(),
  });
  mockPersistAnalysis.mockReset();
});

afterEach(() => {
  resetBasePaths();
  clearPersonaCache();
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ─── Unit Tests ─────────────────────────────────────────────────────────────

describe('searchXhsViral', () => {
  it('filters notes below engagement threshold', async () => {
    mockSearchXhsNotes.mockResolvedValue([
      { id: '1', xsec_token: 'tok1', title: 'Low engagement', description: '', likes: 100, user: 'u1', tags: [] },
      { id: '2', xsec_token: 'tok2', title: 'High engagement', description: '', likes: 6000, user: 'u2', tags: [] },
      { id: '3', xsec_token: 'tok3', title: 'Exact threshold', description: '', likes: 5000, user: 'u3', tags: [] },
    ]);

    const result = await searchXhsViral('test', VIRAL_ENGAGEMENT_THRESHOLD);

    expect(result).toHaveLength(2);
    expect(result.map(n => n.title)).toEqual(['High engagement', 'Exact threshold']);
    // Verify search options passed
    expect(mockSearchXhsNotes).toHaveBeenCalledWith('test', {
      sortBy: '最热',
      publishTime: '7天内',
    });
  });

  it('returns empty array on API error', async () => {
    mockSearchXhsNotes.mockRejectedValue(new Error('Network error'));
    const result = await searchXhsViral('test');
    expect(result).toEqual([]);
  });

  it('supports custom threshold', async () => {
    mockSearchXhsNotes.mockResolvedValue([
      { id: '1', xsec_token: 'tok1', title: 'Mid', description: '', likes: 2000, user: 'u1', tags: [] },
    ]);

    const result = await searchXhsViral('test', 1000);
    expect(result).toHaveLength(1);
  });
});

describe('searchDouyinViral', () => {
  it('filters videos below engagement threshold', () => {
    mockSearchDouyinVideos.mockReturnValue({
      success: true,
      videos: [
        { aweme_id: '1', desc: 'Low', create_time: 0, author: 'a1', digg_count: 100 },
        { aweme_id: '2', desc: 'High', create_time: 0, author: 'a2', digg_count: 8000 },
      ],
    });

    const result = searchDouyinViral('test', VIRAL_ENGAGEMENT_THRESHOLD);
    expect(result).toHaveLength(1);
    expect(result[0].desc).toBe('High');
  });

  it('returns empty array on failed result', () => {
    mockSearchDouyinVideos.mockReturnValue({ success: false, error: 'Timeout' });
    const result = searchDouyinViral('test');
    expect(result).toEqual([]);
  });

  it('returns empty array on exception', () => {
    mockSearchDouyinVideos.mockImplementation(() => { throw new Error('crash'); });
    const result = searchDouyinViral('test');
    expect(result).toEqual([]);
  });
});

describe('buildXhsUrl', () => {
  it('constructs proper URL with encoded token', () => {
    const url = buildXhsUrl('abc123', 'token/with+special');
    expect(url).toBe('https://www.xiaohongshu.com/explore/abc123?xsec_token=token%2Fwith%2Bspecial');
  });
});

describe('extractTopTrendKeywords', () => {
  it('extracts top velocity keywords from trend history', () => {
    const trendHistory: TrendHistory[] = [
      {
        date: '2025-01-01',
        trends: [
          { platform: 'douyin', keyword: '热搜1', current_volume: 100, avg_7d: 10, velocity_score: 10, rank: 1 },
          { platform: 'weibo', keyword: '热搜2', current_volume: 50, avg_7d: 10, velocity_score: 5, rank: 2 },
          { platform: 'bilibili', keyword: '热搜3', current_volume: 200, avg_7d: 10, velocity_score: 20, rank: 3 },
        ],
      },
    ];
    writeJSON(PATHS.trendHistory, trendHistory);

    const keywords = extractTopTrendKeywords(2);
    expect(keywords).toHaveLength(2);
    // Sorted by velocity_score desc: 热搜3(20) > 热搜1(10) > 热搜2(5)
    expect(keywords[0]).toBe('热搜3');
    expect(keywords[1]).toBe('热搜1');
  });

  it('deduplicates keywords (case-insensitive)', () => {
    const trendHistory: TrendHistory[] = [
      {
        date: '2025-01-01',
        trends: [
          { platform: 'douyin', keyword: 'AI Agent', current_volume: 100, avg_7d: 10, velocity_score: 10, rank: 1 },
          { platform: 'weibo', keyword: 'ai agent', current_volume: 50, avg_7d: 10, velocity_score: 5, rank: 2 },
        ],
      },
    ];
    writeJSON(PATHS.trendHistory, trendHistory);

    const keywords = extractTopTrendKeywords(5);
    expect(keywords).toHaveLength(1);
  });

  it('returns empty array when no trend history', () => {
    const keywords = extractTopTrendKeywords();
    expect(keywords).toEqual([]);
  });

  it('skips zero velocity entries', () => {
    const trendHistory: TrendHistory[] = [
      {
        date: '2025-01-01',
        trends: [
          { platform: 'douyin', keyword: 'hot', current_volume: 100, avg_7d: 10, velocity_score: 5, rank: 1 },
          { platform: 'weibo', keyword: 'cold', current_volume: 0, avg_7d: 0, velocity_score: 0, rank: 2 },
        ],
      },
    ];
    writeJSON(PATHS.trendHistory, trendHistory);

    const keywords = extractTopTrendKeywords(5);
    expect(keywords).toHaveLength(1);
    expect(keywords[0]).toBe('hot');
  });
});

describe('runViralSearch', () => {
  it('searches with provided keywords and injects results to pool', async () => {
    writePersona();

    mockSearchXhsNotes.mockResolvedValue([
      { id: '1', xsec_token: 'tok1', title: 'XHS Hit', description: 'desc', likes: 6000, user: 'creator1', tags: ['tag'] },
    ]);
    mockSearchDouyinVideos.mockReturnValue({
      success: true,
      videos: [
        { aweme_id: '1', desc: 'Douyin Hit', create_time: 0, author: 'creator2', digg_count: 7000 },
      ],
    });

    const result = await runViralSearch({
      keywords: ['test keyword'],
      forceFresh: true,
    });

    expect(result.searched_keywords).toEqual(['test keyword']);
    expect(result.xhs_found).toBe(1);
    expect(result.douyin_found).toBe(1);
    expect(result.injected).toBe(2);

    // Verify pool was updated
    const pool = loadDiscoveryPool();
    expect(pool.items).toHaveLength(2);
    expect(pool.items.map(i => i.title)).toContain('XHS Hit');
    expect(pool.items.map(i => i.title)).toContain('Douyin Hit');
  });

  it('deduplicates items already in pool', async () => {
    writePersona();

    // Pre-fill pool with an existing item
    const pool = loadDiscoveryPool();
    pool.items.push({
      title: 'XHS Hit',
      author: 'existing',
      source: 'old',
      engagement: 1000,
      topic: 'test',
      score: 50,
      discovered_at: new Date().toISOString(),
    });
    saveDiscoveryPool(pool);

    mockSearchXhsNotes.mockResolvedValue([
      { id: '1', xsec_token: 'tok1', title: 'XHS Hit', description: '', likes: 6000, user: 'u1', tags: [] },
      { id: '2', xsec_token: 'tok2', title: 'New Hit', description: '', likes: 8000, user: 'u2', tags: [] },
    ]);

    const result = await runViralSearch({
      keywords: ['test'],
      forceFresh: true,
    });

    // Only the new one should be injected
    expect(result.injected).toBe(1);
    const updatedPool = loadDiscoveryPool();
    expect(updatedPool.items.map(i => i.title)).toContain('New Hit');
  });

  it('returns early when no keywords available', async () => {
    writePersona({ content_sources: { platforms: [], keywords: [], dailyhot_platforms: [], reddit_subreddits: [] } });

    const result = await runViralSearch({
      keywords: [],
      forceFresh: true,
    });

    expect(result.searched_keywords).toEqual([]);
    expect(result.injected).toBe(0);
    expect(mockSearchXhsNotes).not.toHaveBeenCalled();
  });
});

describe('runCrossPlatformRadar', () => {
  it('uses trend keywords to search across platforms', async () => {
    writePersona();

    // Set up trend history
    const trendHistory: TrendHistory[] = [
      {
        date: '2025-01-01',
        trends: [
          { platform: 'douyin', keyword: '热门话题', current_volume: 100000, avg_7d: 10000, velocity_score: 10, rank: 1 },
        ],
      },
    ];
    writeJSON(PATHS.trendHistory, trendHistory);

    mockSearchXhsNotes.mockResolvedValue([
      { id: '1', xsec_token: 'tok1', title: '跨平台爆款', description: '', likes: 2000, user: 'u1', tags: [] },
    ]);

    const result = await runCrossPlatformRadar({ forceFresh: true });

    expect(result.trend_keywords_used).toEqual(['热门话题']);
    expect(result.xhs_found).toBe(1);  // 2000 >= RADAR_ENGAGEMENT_THRESHOLD (1000)
    expect(result.injected).toBeGreaterThanOrEqual(1);
  });

  it('respects lower radar threshold', async () => {
    writePersona();

    const trendHistory: TrendHistory[] = [
      {
        date: '2025-01-01',
        trends: [
          { platform: 'douyin', keyword: '测试', current_volume: 5000, avg_7d: 1000, velocity_score: 5, rank: 1 },
        ],
      },
    ];
    writeJSON(PATHS.trendHistory, trendHistory);

    mockSearchXhsNotes.mockResolvedValue([
      { id: '1', xsec_token: 'tok1', title: 'Medium hit', description: '', likes: 1500, user: 'u1', tags: [] },
      { id: '2', xsec_token: 'tok2', title: 'Low hit', description: '', likes: 500, user: 'u2', tags: [] },
    ]);

    const result = await runCrossPlatformRadar({ forceFresh: true });

    // 1500 >= 1000 (radar threshold) but 500 < 1000
    expect(result.xhs_found).toBe(1);
  });

  it('returns early when no trend data', async () => {
    writePersona();

    const result = await runCrossPlatformRadar({ forceFresh: true });

    expect(result.trend_keywords_used).toEqual([]);
    expect(result.injected).toBe(0);
    expect(mockSearchXhsNotes).not.toHaveBeenCalled();
  });
});

describe('runAutoBreakdown', () => {
  const mockLlm = {} as any;

  it('analyzes high-engagement items from discovery pool', async () => {
    writePersona();

    // Pre-fill pool with high-engagement items
    const pool = loadDiscoveryPool();
    pool.items.push(
      {
        title: 'Viral Post 1',
        author: 'author1',
        source: 'viral-search:xhs',
        engagement: 8000,
        topic: 'topic1',
        score: 80,
        discovered_at: new Date().toISOString(),
      },
      {
        title: 'Low Post',
        author: 'author2',
        source: 'search',
        engagement: 200,
        topic: 'topic2',
        score: 30,
        discovered_at: new Date().toISOString(),
      },
    );
    saveDiscoveryPool(pool);

    // Mock XHS search for URL building
    mockSearchXhsNotes.mockResolvedValue([
      { id: 'note1', xsec_token: 'token1', title: 'Viral Post 1', description: '', likes: 8000, user: 'author1', tags: [] },
    ]);

    const result = await runAutoBreakdown(mockLlm, { forceFresh: true });

    expect(result.candidates_found).toBe(1);  // Only Viral Post 1 > 5000
    expect(result.analyzed).toBe(1);
    expect(result.titles).toContain('Viral Post 1');
    expect(mockAnalyzePost).toHaveBeenCalledTimes(1);
    expect(mockPersistAnalysis).toHaveBeenCalledTimes(1);
  });

  it('skips already-analyzed items', async () => {
    writePersona();

    // Pre-fill pool
    const pool = loadDiscoveryPool();
    pool.items.push({
      title: 'Already Analyzed',
      author: 'a1',
      source: 'viral-search:xhs',
      engagement: 10000,
      topic: 'topic',
      score: 90,
      discovered_at: new Date().toISOString(),
    });
    saveDiscoveryPool(pool);

    // Pre-fill analysis log
    const analysisLog: PostAnalysisLog = {
      entries: [{
        url: 'https://example.com/1',
        platform: 'xhs',
        title: 'Already Analyzed',
        hook_patterns: [],
        core_selling_points: [],
        comment_sentiment: { positive_ratio: 0.5, negative_ratio: 0.2, neutral_ratio: 0.3, top_keywords: [], emotional_triggers: [] },
        content_structure: { opening_hook: '', body_flow: '', closing_cta: '', visual_strategy: '' },
        analyzed_at: new Date().toISOString(),
      }],
    };
    writeJSON(PATHS.postAnalysisLog, analysisLog);

    const result = await runAutoBreakdown(mockLlm, { forceFresh: true });

    expect(result.candidates_found).toBe(0);  // Filtered out by dedup
    expect(result.analyzed).toBe(0);
    expect(mockAnalyzePost).not.toHaveBeenCalled();
  });

  it('limits analysis to MAX_AUTO_BREAKDOWNS', async () => {
    writePersona();

    // Pre-fill pool with 5 high-engagement items
    const pool = loadDiscoveryPool();
    for (let i = 0; i < 5; i++) {
      pool.items.push({
        title: `Viral ${i}`,
        author: `a${i}`,
        source: 'viral-search:xhs',
        engagement: 10000 + i * 1000,
        topic: 'topic',
        score: 90 + i,
        discovered_at: new Date().toISOString(),
      });
    }
    saveDiscoveryPool(pool);

    // Mock search for URL building — return matching note for each title
    mockSearchXhsNotes.mockImplementation(async (keyword: string) => {
      return [{ id: `note-${keyword}`, xsec_token: 'tok', title: keyword, description: '', likes: 10000, user: 'u', tags: [] }];
    });

    const result = await runAutoBreakdown(mockLlm, { forceFresh: true });

    // Should only analyze MAX_AUTO_BREAKDOWNS = 2 (sorted by engagement desc: Viral 4, Viral 3)
    expect(result.analyzed).toBe(MAX_AUTO_BREAKDOWNS);
    expect(mockAnalyzePost).toHaveBeenCalledTimes(MAX_AUTO_BREAKDOWNS);
  });

  it('continues on individual analysis failure', async () => {
    writePersona();

    const pool = loadDiscoveryPool();
    pool.items.push(
      {
        title: 'Fail Post',
        author: 'a1',
        source: 'viral-search:xhs',
        engagement: 10000,
        topic: 'topic',
        score: 90,
        discovered_at: new Date().toISOString(),
      },
      {
        title: 'Success Post',
        author: 'a2',
        source: 'viral-search:xhs',
        engagement: 9000,
        topic: 'topic',
        score: 85,
        discovered_at: new Date().toISOString(),
      },
    );
    saveDiscoveryPool(pool);

    // First search succeeds, second succeeds
    mockSearchXhsNotes
      .mockResolvedValueOnce([{ id: 'n1', xsec_token: 't1', title: 'Fail Post', description: '', likes: 10000, user: 'a1', tags: [] }])
      .mockResolvedValueOnce([{ id: 'n2', xsec_token: 't2', title: 'Success Post', description: '', likes: 9000, user: 'a2', tags: [] }]);

    // First analysis fails, second succeeds
    mockAnalyzePost
      .mockRejectedValueOnce(new Error('LLM timeout'))
      .mockResolvedValueOnce({
        url: 'https://example.com/2',
        platform: 'xhs',
        title: 'Success Post',
        hook_patterns: [],
        core_selling_points: [],
        comment_sentiment: { positive_ratio: 0.5, negative_ratio: 0.2, neutral_ratio: 0.3, top_keywords: [], emotional_triggers: [] },
        content_structure: { opening_hook: '', body_flow: '', closing_cta: '', visual_strategy: '' },
        analyzed_at: new Date().toISOString(),
      });

    const result = await runAutoBreakdown(mockLlm, { forceFresh: true });

    // One failed, one succeeded
    expect(result.analyzed).toBe(1);
    expect(result.titles).toEqual(['Success Post']);
    expect(mockAnalyzePost).toHaveBeenCalledTimes(2);
    expect(mockPersistAnalysis).toHaveBeenCalledTimes(1);
  });

  it('returns empty when pool has no high-engagement items', async () => {
    writePersona();

    const pool = loadDiscoveryPool();
    pool.items.push({
      title: 'Low engagement',
      author: 'a1',
      source: 'search',
      engagement: 200,
      topic: 'topic',
      score: 30,
      discovered_at: new Date().toISOString(),
    });
    saveDiscoveryPool(pool);

    const result = await runAutoBreakdown(mockLlm, { forceFresh: true });

    expect(result.candidates_found).toBe(0);
    expect(result.analyzed).toBe(0);
    expect(mockAnalyzePost).not.toHaveBeenCalled();
  });
});

// ─── Tag vocabulary injection ─────────────────────────────────────────────

describe('runViralSearch — tag vocabulary injection', () => {
  it('includes active tag strings in searched keywords when tag-vocabulary.json exists', async () => {
    const vocab: TagVocabulary = {
      version: 1,
      last_updated: new Date().toISOString(),
      active: [
        {
          tag: '#tag_vocab_keyword', platform: 'xhs', score: 80,
          sources: [{ type: 'competitor', account: 'a1', platform: 'xhs' }],
          first_seen: new Date().toISOString(), last_hit: new Date().toISOString(),
          hit_count: 3, peak_score: 80,
        },
      ],
      dormant: [],
    };
    writeJSON(PATHS.tagVocabulary, vocab);
    mockSearchXhsNotes.mockResolvedValue([]);
    mockSearchDouyinVideos.mockReturnValue({ success: true, videos: [] });
    const result = await runViralSearch({ forceFresh: true });
    expect(result.searched_keywords).toContain('#tag_vocab_keyword');
  });
});
