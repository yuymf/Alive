/**
 * keyword-tracker.test.ts
 * Tests for the P4-1 active keyword/track search engine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { setBasePaths, resetBasePaths, PATHS, writeJSON, readJSON } from '../../scripts/utils/file-utils';
import { clearPersonaCache } from '../../scripts/persona/persona-loader';
import YAML from 'yaml';
import {
  loadKeywordState,
  saveKeywordState,
  collectKeywords,
  mergeKeywords,
  selectKeywordsForSearch,
  searchKeyword,
  injectSearchResultsToPool,
  updateKeywordAfterSearch,
  runKeywordSearch,
  buildKeywordContext,
  DEFAULT_KEYWORD_STATE,
  type KeywordEntry,
  type KeywordState,
} from '../../scripts/ops/keyword-tracker';
import type { PersonaConfig } from '../../scripts/utils/types';

const TEST_DIR = path.join(__dirname, '__keyword_tracker_test_sandbox__');

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
      core_traits: ['creative', 'curious'],
      tone: 'casual',
    },
    content_sources: {
      platforms: ['reddit'],
      keywords: ['AI agent', 'digital life', 'LLM'],
      dailyhot_platforms: [],
      reddit_subreddits: [],
    },
    ops: {
      competitors: [
        {
          name: 'Rival A',
          platform: 'twitter',
          url: 'https://twitter.com/rivala',
          tag: 'tech',
          tag_desc: 'Tech influencer',
          reference_type: 'primary',
          takeaways: ['关联话题: 自动化工具', 'very long takeaway that should be filtered because it exceeds twenty characters limit test'],
        },
      ],
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
});

afterEach(() => {
  resetBasePaths();
  clearPersonaCache();
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe('loadKeywordState / saveKeywordState', () => {
  it('returns default state when no file exists', () => {
    const state = loadKeywordState();
    expect(state).toEqual(DEFAULT_KEYWORD_STATE);
  });

  it('loads and saves keyword state correctly', () => {
    const state: KeywordState = {
      keywords: [{
        keyword: 'test',
        source: 'persona',
        search_count: 3,
        total_found: 15,
        last_searched: '2026-04-05T12:00:00.000Z',
        velocity: 5,
        added_at: '2026-04-01T00:00:00.000Z',
      }],
      last_updated: '2026-04-05T12:00:00.000Z',
      total_searches: 3,
    };
    saveKeywordState(state);
    const loaded = loadKeywordState();
    expect(loaded.keywords).toHaveLength(1);
    expect(loaded.keywords[0].keyword).toBe('test');
    expect(loaded.total_searches).toBe(3);
    // last_updated should be refreshed on save
    expect(loaded.last_updated).toBeTruthy();
  });
});

describe('collectKeywords', () => {
  it('collects keywords from persona config', () => {
    writePersona();
    const keywords = collectKeywords();
    const personaKws = keywords.filter(k => k.source === 'persona');
    expect(personaKws.length).toBeGreaterThanOrEqual(3);
    expect(personaKws.map(k => k.keyword)).toContain('ai agent');
    expect(personaKws.map(k => k.keyword)).toContain('digital life');
    expect(personaKws.map(k => k.keyword)).toContain('llm');
  });

  it('collects keywords from trending topics', () => {
    writePersona();
    writeJSON(PATHS.inspirationState, {
      trending_topics: ['quantum computing', 'web3'],
      feed_highlights: [],
      domain_insights: [],
      saved_inspirations: [],
      last_refreshed_at: new Date().toISOString(),
    });
    const keywords = collectKeywords();
    const trending = keywords.filter(k => k.source === 'trending');
    expect(trending.map(k => k.keyword)).toContain('quantum computing');
    expect(trending.map(k => k.keyword)).toContain('web3');
  });

  it('collects short competitor takeaways as keywords', () => {
    writePersona();
    const keywords = collectKeywords();
    const compKws = keywords.filter(k => k.source === 'competitor');
    // "自动化工具" should be extracted (after removing prefix)
    expect(compKws.length).toBeGreaterThanOrEqual(1);
    expect(compKws.map(k => k.keyword)).toContain('自动化工具');
  });

  it('deduplicates keywords across sources', () => {
    writePersona({
      content_sources: {
        platforms: ['reddit'],
        keywords: ['AI agent', 'ai agent'], // duplicate
        dailyhot_platforms: [],
        reddit_subreddits: [],
      },
    });
    const keywords = collectKeywords();
    const aiAgentKws = keywords.filter(k => k.keyword === 'ai agent');
    expect(aiAgentKws).toHaveLength(1);
  });
});

describe('mergeKeywords', () => {
  it('adds new keywords preserving existing search history', () => {
    const existing: KeywordState = {
      keywords: [{
        keyword: 'existing',
        source: 'persona',
        search_count: 5,
        total_found: 25,
        last_searched: '2026-04-05T00:00:00Z',
        velocity: 5,
        added_at: '2026-04-01T00:00:00Z',
      }],
      last_updated: '',
      total_searches: 5,
    };
    const newKws: KeywordEntry[] = [
      { keyword: 'new-one', source: 'trending', search_count: 0, total_found: 0, last_searched: null, velocity: 0, added_at: '' },
      { keyword: 'existing', source: 'trending', search_count: 0, total_found: 0, last_searched: null, velocity: 0, added_at: '' },
    ];
    const merged = mergeKeywords(existing, newKws);
    expect(merged.keywords).toHaveLength(2);
    // Existing keyword retains its search history
    const existingKw = merged.keywords.find(k => k.keyword === 'existing')!;
    expect(existingKw.search_count).toBe(5);
    // Existing keeps higher-priority source
    expect(existingKw.source).toBe('persona');
  });

  it('upgrades source priority when new source is higher', () => {
    const existing: KeywordState = {
      keywords: [{
        keyword: 'shared',
        source: 'trending',
        search_count: 2,
        total_found: 8,
        last_searched: null,
        velocity: 4,
        added_at: '',
      }],
      last_updated: '',
      total_searches: 2,
    };
    const newKws: KeywordEntry[] = [
      { keyword: 'shared', source: 'persona', search_count: 0, total_found: 0, last_searched: null, velocity: 0, added_at: '' },
    ];
    const merged = mergeKeywords(existing, newKws);
    const kw = merged.keywords.find(k => k.keyword === 'shared')!;
    expect(kw.source).toBe('persona'); // upgraded from trending to persona
    expect(kw.search_count).toBe(2); // retains search history
  });

  it('trims to MAX_KEYWORDS (30)', () => {
    const kws: KeywordEntry[] = Array.from({ length: 35 }, (_, i) => ({
      keyword: `kw-${i}`,
      source: 'trending' as const,
      search_count: 0,
      total_found: 0,
      last_searched: null,
      velocity: 0,
      added_at: '',
    }));
    const merged = mergeKeywords(DEFAULT_KEYWORD_STATE, kws);
    expect(merged.keywords.length).toBeLessThanOrEqual(30);
  });
});

describe('selectKeywordsForSearch', () => {
  it('selects never-searched keywords first', () => {
    const state: KeywordState = {
      keywords: [
        { keyword: 'searched', source: 'persona', search_count: 1, total_found: 5, last_searched: '2020-01-01T00:00:00Z', velocity: 5, added_at: '' },
        { keyword: 'never', source: 'trending', search_count: 0, total_found: 0, last_searched: null, velocity: 0, added_at: '' },
      ],
      last_updated: '',
      total_searches: 1,
    };
    const selected = selectKeywordsForSearch(state);
    expect(selected[0]).toBe('never');
  });

  it('respects cooldown period', () => {
    const recentTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1 hour ago (within 6h cooldown)
    const state: KeywordState = {
      keywords: [
        { keyword: 'recent', source: 'persona', search_count: 1, total_found: 5, last_searched: recentTime, velocity: 5, added_at: '' },
      ],
      last_updated: '',
      total_searches: 1,
    };
    const selected = selectKeywordsForSearch(state);
    expect(selected).toHaveLength(0); // Should be filtered out by cooldown
  });

  it('limits to MAX_SEARCHES_PER_TICK (3)', () => {
    const state: KeywordState = {
      keywords: Array.from({ length: 10 }, (_, i) => ({
        keyword: `kw-${i}`,
        source: 'persona' as const,
        search_count: 0,
        total_found: 0,
        last_searched: null,
        velocity: 0,
        added_at: '',
      })),
      last_updated: '',
      total_searches: 0,
    };
    const selected = selectKeywordsForSearch(state);
    expect(selected).toHaveLength(3);
  });
});

describe('injectSearchResultsToPool', () => {
  it('adds qualifying search results to discovery pool', () => {
    writePersona();
    const results = [
      { title: '爆款AI内容', source: 'reddit', url: 'http://example.com/1', snippet: 'great content', likes: 5000, user: 'author1' },
      { title: '低互动内容', source: 'reddit', url: 'http://example.com/2', snippet: 'meh', likes: 10, user: 'author2' }, // below threshold
    ];
    const added = injectSearchResultsToPool(results as any, 'AI agent');
    expect(added).toBe(1); // Only high-engagement one
    const pool = readJSON(PATHS.discoveryPool, { items: [], last_updated: '' });
    expect((pool as any).items).toHaveLength(1);
    expect((pool as any).items[0].title).toBe('爆款AI内容');
    expect((pool as any).items[0].source).toBe('search:reddit');
  });

  it('deduplicates by title', () => {
    writeJSON(PATHS.discoveryPool, {
      items: [{ title: '已存在', author: 'x', source: 'browse', engagement: 1000, topic: 'test', score: 50, discovered_at: '' }],
      last_updated: '',
    });
    const results = [
      { title: '已存在', source: 'reddit', url: 'http://example.com', snippet: '', likes: 5000, user: 'x' },
    ];
    const added = injectSearchResultsToPool(results as any, 'test');
    expect(added).toBe(0);
  });

  it('returns 0 for empty results', () => {
    expect(injectSearchResultsToPool([], 'test')).toBe(0);
  });
});

describe('updateKeywordAfterSearch', () => {
  it('updates search count and velocity', () => {
    const state: KeywordState = {
      keywords: [{
        keyword: 'test',
        source: 'persona',
        search_count: 2,
        total_found: 10,
        last_searched: null,
        velocity: 5,
        added_at: '',
      }],
      last_updated: '',
      total_searches: 2,
    };
    const updated = updateKeywordAfterSearch(state, 'test', 8);
    const kw = updated.keywords[0];
    expect(kw.search_count).toBe(3);
    expect(kw.total_found).toBe(18);
    expect(kw.velocity).toBe(6); // 18 / 3
    expect(kw.last_searched).toBeTruthy();
    expect(updated.total_searches).toBe(3);
  });

  it('does not modify other keywords', () => {
    const state: KeywordState = {
      keywords: [
        { keyword: 'a', source: 'persona', search_count: 1, total_found: 5, last_searched: null, velocity: 5, added_at: '' },
        { keyword: 'b', source: 'trending', search_count: 0, total_found: 0, last_searched: null, velocity: 0, added_at: '' },
      ],
      last_updated: '',
      total_searches: 1,
    };
    const updated = updateKeywordAfterSearch(state, 'a', 3);
    expect(updated.keywords[1].search_count).toBe(0);
  });
});

describe('buildKeywordContext', () => {
  it('returns empty string when no keywords', () => {
    expect(buildKeywordContext()).toBe('');
  });

  it('returns empty string when no keywords have been searched', () => {
    saveKeywordState({
      keywords: [{
        keyword: 'test',
        source: 'persona',
        search_count: 0,
        total_found: 0,
        last_searched: null,
        velocity: 0,
        added_at: '',
      }],
      last_updated: '',
      total_searches: 0,
    });
    expect(buildKeywordContext()).toBe('');
  });

  it('builds context with top velocity keywords', () => {
    saveKeywordState({
      keywords: [
        { keyword: 'ai agent', source: 'persona', search_count: 5, total_found: 30, last_searched: '', velocity: 6, added_at: '' },
        { keyword: 'web3', source: 'trending', search_count: 3, total_found: 9, last_searched: '', velocity: 3, added_at: '' },
      ],
      last_updated: '',
      total_searches: 8,
    });
    const ctx = buildKeywordContext();
    expect(ctx).toContain('关键词追踪');
    expect(ctx).toContain('ai agent');
    expect(ctx).toContain('累计搜索: 8次');
  });
});

describe('runKeywordSearch (integration)', () => {
  it('runs full search pipeline with mock registry', async () => {
    writePersona();
    const mockRegistry = {
      search: vi.fn().mockResolvedValue([
        { title: 'AI超级内容', source: 'reddit', url: 'http://reddit.com/1', snippet: 'great', likes: 2000, user: 'user1' },
      ]),
    };

    const result = await runKeywordSearch(mockRegistry as any);
    expect(result.searched).toBeGreaterThan(0);
    expect(result.keywords.length).toBeGreaterThan(0);
    // mockRegistry.search should have been called
    expect(mockRegistry.search).toHaveBeenCalled();

    // Keyword state should be saved
    const state = loadKeywordState();
    expect(state.total_searches).toBeGreaterThan(0);
    expect(state.keywords.length).toBeGreaterThan(0);
  });

  it('handles registry search failure gracefully', async () => {
    writePersona();
    const mockRegistry = {
      search: vi.fn().mockRejectedValue(new Error('Network error')),
    };

    const result = await runKeywordSearch(mockRegistry as any);
    // Should not throw
    expect(result.searched).toBeGreaterThan(0);
    expect(result.totalDiscovered).toBe(0);
  });

  it('returns zero when no keywords collected', async () => {
    // No persona, no inspiration state
    const mockRegistry = {
      search: vi.fn(),
    };
    const result = await runKeywordSearch(mockRegistry as any);
    expect(result.searched).toBe(0);
    expect(mockRegistry.search).not.toHaveBeenCalled();
  });
});
