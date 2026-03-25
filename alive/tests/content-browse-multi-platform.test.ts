// alive/tests/content-browse-multi-platform.test.ts
// Integration test: Full chain from Registry → Providers → createContentBrowseConfig → content-browse action
//
// Verifies that multi-platform content bridge works end-to-end with mock providers + mock LLM.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentProviderRegistry } from '../scripts/adapters/content-provider';
import type { ContentProvider, ContentItem } from '../scripts/adapters/content-provider';
import { actions } from '../sub-skills/content-browse/scripts/index';
import type { SubSkillContext, EmotionState, MemoryAccessor, PersonaConfig } from '../scripts/utils/types';
import { DEFAULT_MOMENTUM, DEFAULT_UNDERTONE } from '../scripts/utils/types';

// ── Mock Provider Factory ────────────────────────────────────────

function makeMockProvider(
  name: string,
  feedItems: ContentItem[],
  searchItems: ContentItem[] = [],
  available = true,
): ContentProvider {
  return {
    meta: { name, displayName: name.charAt(0).toUpperCase() + name.slice(1), type: 'social' as const },
    isAvailable: vi.fn(async () => available),
    getFeed: vi.fn(async () => feedItems),
    search: vi.fn(async () => searchItems),
  };
}

// ── Test Helpers (same pattern as sub-skill-content-browse.test.ts) ──

function makeEmotion(overrides: Partial<EmotionState> = {}): EmotionState {
  return {
    mood: { valence: 0.3, arousal: 0.5, description: '平静' },
    energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
    last_updated: null, recent_cause: 'test',
    momentum: { ...DEFAULT_MOMENTUM },
    undertone: { ...DEFAULT_UNDERTONE },
    impulse_history: [], consecutive_high_stress: 0, threshold_break_cooldown: 0,
    ...overrides,
  };
}

function makeMemory(store: Record<string, unknown> = {}): MemoryAccessor {
  const jsonStore: Record<string, unknown> = { ...store };
  const diaryEntries: string[] = [];
  return {
    readDiary: vi.fn(() => diaryEntries.join('\n')),
    appendDiary: vi.fn((entry: string) => diaryEntries.push(entry)),
    readJSON: vi.fn(<T>(key: string, fallback: T) => (jsonStore[key] as T) ?? fallback),
    writeJSON: vi.fn(<T>(key: string, data: T) => { jsonStore[key] = data; }),
  };
}

function makeCtx(overrides: Partial<SubSkillContext> = {}): SubSkillContext {
  return {
    persona: {
      meta: { name: 'TestChar', tagline: '测试角色' },
      personality: { mbti: 'INFP', core_traits: ['cosplay', 'photography', 'anime'] },
      voice: { language: 'zh', style: '活泼', sample_lines: [] },
      content_sources: {
        platforms: ['reddit', 'bilibili', 'dailyhot'],
        keywords: ['anime', 'cosplay'],
        dailyhot_platforms: ['zhihu', 'weibo'],
        reddit_subreddits: ['cosplay', 'anime'],
      },
    } as PersonaConfig,
    emotion: makeEmotion(),
    vitality: 80,
    confidence: 1.0,
    intent: { id: 'i1', category: '窥屏' as const, description: '刷一下手机', intensity: 5, action: 'feed-browse' },
    memory: makeMemory(),
    socialGraph: { getRelations: vi.fn(() => []), updateRelation: vi.fn() },
    llm: {
      callJSON: vi.fn(async (prompt: string) => {
        // First LLM call: search-intent keyword generation (contains "搜索关键词" or "keywords")
        if (prompt.includes('搜索关键词') || prompt.includes('keywords') || prompt.includes('搜什么')) {
          return { keywords: ['cosplay trends', 'anime photography', 'virtual YouTuber'] };
        }
        // Second LLM call: feed analysis
        return {
          feed_highlights: [
            { title: 'Reddit cosplay trend', likes: 5000, topic: 'cosplay' },
            { title: 'Bilibili viral video', likes: 12000, topic: 'anime' },
          ],
          trending_topics: ['AI cosplay', 'virtual YouTuber', 'anime photography'],
          domain_insights: ['Cross-platform content performs best', 'Short-form video is king', 'Reddit discussions drive depth'],
          saved_inspirations: [
            { source_id: 'reddit_abc', source_title: 'Amazing cosplay', visual_description: 'Detailed sword prop', style_tags: ['cosplay', 'props'] },
            { source_id: 'bilibili_BV123', source_title: 'Dance cover', visual_description: 'Neon lighting setup', style_tags: ['dance', 'lighting'] },
          ],
        };
      }),
      call: vi.fn(async () => ''),
    },
    config: {},
    ...overrides,
  };
}

// ── Integration Tests ────────────────────────────────────────────

/** Helper: find the feed-analysis LLM call (not the keyword generation call) */
function getFeedAnalysisPrompt(llmCallJSON: ReturnType<typeof vi.fn>): string {
  const calls = llmCallJSON.mock.calls as Array<[string, ...unknown[]]>;
  // The feed-analysis prompt does NOT contain "搜什么" / "keywords" patterns
  // but DOES contain feed data items or "数据来源" section
  for (const call of calls) {
    const prompt = call[0];
    if (typeof prompt === 'string' && !prompt.includes('搜什么') && !prompt.includes('关键词1')) {
      return prompt;
    }
  }
  // fallback: return last call
  return calls[calls.length - 1][0] as string;
}

describe('Multi-Platform Content Bridge Integration', () => {
  let registry: ContentProviderRegistry;
  let redditProvider: ContentProvider;
  let bilibiliProvider: ContentProvider;
  let dailyhotProvider: ContentProvider;

  const redditItems: ContentItem[] = [
    { id: 'reddit_abc', source: 'reddit', title: 'Amazing cosplay WIP', url: 'https://reddit.com/r/cosplay/abc', likes: 5000, snippet: 'Working on a new sword prop...' },
    { id: 'reddit_def', source: 'reddit', title: 'Photography tips for cosplay', url: 'https://reddit.com/r/cosplay/def', likes: 3200 },
  ];

  const bilibiliItems: ContentItem[] = [
    { id: 'bilibili_BV123', source: 'bilibili', title: '【Cosplay】剑灵 角色还原', url: 'https://bilibili.com/video/BV123', likes: 12000 },
    { id: 'bilibili_BV456', source: 'bilibili', title: '动漫摄影技巧分享', url: 'https://bilibili.com/video/BV456', likes: 8000 },
  ];

  const dailyhotItems: ContentItem[] = [
    { id: 'dailyhot:zhihu_1', source: 'dailyhot:zhihu', title: '知乎热榜：Cosplay 圈年度盘点', likes: 9500 },
    { id: 'dailyhot:weibo_1', source: 'dailyhot:weibo', title: '微博热搜：漫展 coser 爆红', likes: 15000 },
  ];

  beforeEach(() => {
    registry = new ContentProviderRegistry();
    redditProvider = makeMockProvider('reddit', redditItems, [
      { id: 'reddit_search1', source: 'reddit', title: 'Anime cosplay search result', likes: 1500 },
    ]);
    bilibiliProvider = makeMockProvider('bilibili', bilibiliItems, [
      { id: 'bilibili_search1', source: 'bilibili', title: 'B站搜索：cosplay教程', likes: 6000 },
    ]);
    dailyhotProvider = makeMockProvider('dailyhot', dailyhotItems);

    registry.register(redditProvider);
    registry.register(bilibiliProvider);
    registry.register(dailyhotProvider);
  });

  // ── Registry → Aggregation ──

  describe('Registry aggregation', () => {
    it('aggregates feed from all registered providers', async () => {
      const feed = await registry.getAggregatedFeed();
      expect(feed).toHaveLength(6); // 2 reddit + 2 bilibili + 2 dailyhot
      expect(feed.map(i => i.source)).toEqual(
        expect.arrayContaining(['reddit', 'bilibili', 'dailyhot:zhihu', 'dailyhot:weibo'])
      );
    });

    it('filters by platform names', async () => {
      const feed = await registry.getAggregatedFeed({ platforms: ['reddit'] });
      expect(feed).toHaveLength(2);
      expect(feed.every(i => i.source === 'reddit')).toBe(true);
    });

    it('skips unavailable provider gracefully', async () => {
      const unavailableProvider = makeMockProvider('zhihu', [
        { id: 'zhihu_1', source: 'zhihu', title: '知乎问题', likes: 100 },
      ], [], false);
      registry.register(unavailableProvider);

      const feed = await registry.getAggregatedFeed();
      expect(feed).toHaveLength(6); // zhihu items not included
      expect(feed.some(i => i.source === 'zhihu')).toBe(false);
    });

    it('deduplicates items by id', async () => {
      // Register a provider with duplicate items
      const dupProvider = makeMockProvider('dup', [
        { id: 'reddit_abc', source: 'reddit-dup', title: 'Duplicate', likes: 1 }, // same id as redditItems[0]
      ]);
      registry.register(dupProvider);

      const feed = await registry.getAggregatedFeed();
      const abcItems = feed.filter(i => i.id === 'reddit_abc');
      expect(abcItems).toHaveLength(1);
      expect(abcItems[0].source).toBe('reddit'); // original source wins
    });

    it('handles provider error without breaking others', async () => {
      const errorProvider = makeMockProvider('error', []);
      (errorProvider.getFeed as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network timeout'));
      (errorProvider.isAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      registry.register(errorProvider);

      const feed = await registry.getAggregatedFeed();
      expect(feed).toHaveLength(6); // other providers still return data
    });

    it('aggregates search across providers', async () => {
      const results = await registry.search('cosplay');
      expect(results).toHaveLength(2); // 1 from reddit + 1 from bilibili (dailyhot returns [] for search)
      expect(results.map(i => i.source)).toEqual(
        expect.arrayContaining(['reddit', 'bilibili'])
      );
    });
  });

  // ── Full Chain: Registry → Config → content-browse action ──

  describe('Full chain: Registry → content-browse action', () => {
    it('feeds multi-platform data through to LLM analysis and saves inspiration', async () => {
      // Build config that mimics createContentBrowseConfig behavior
      const config = {
        async getFeedItems() {
          const items = await registry.getAggregatedFeed({ limit: 10 });
          return items.map(item => ({
            id: item.id,
            title: item.title,
            likes: item.likes ?? 0,
            source: item.source,
            url: item.url,
            tags: item.tags,
          }));
        },
        async searchContent(keyword: string) {
          const items = await registry.search(keyword, { limit: 10 });
          return items.map(item => ({
            id: item.id,
            title: item.title,
            likes: item.likes ?? 0,
            source: item.source,
            url: item.url,
            tags: item.tags,
          }));
        },
        searchKeywords: ['cosplay', 'anime'],
        sourcePlatforms: ['reddit', 'bilibili', 'dailyhot'],
      };

      const memory = makeMemory();
      const ctx = makeCtx({ config, memory });

      const result = await actions['feed-browse'](ctx);

      // Verify result structure
      expect(result.narrative).toContain('刷了');
      expect(result.vitality_cost).toBe(10);
      expect(result.emotion_deltas).toEqual(
        expect.arrayContaining([expect.objectContaining({ creativity: expect.any(Number) })])
      );

      // Verify LLM was called with multi-platform data
      const llmCallArgs = getFeedAnalysisPrompt(ctx.llm.callJSON as ReturnType<typeof vi.fn>);
      // The prompt should contain source platform info
      expect(llmCallArgs).toContain('reddit');
      expect(llmCallArgs).toContain('bilibili');
      expect(llmCallArgs).toContain('dailyhot');

      // Verify inspiration state saved
      expect(memory.writeJSON).toHaveBeenCalledWith(
        'inspiration-state',
        expect.objectContaining({
          last_refreshed_at: expect.any(String),
          feed_highlights: expect.any(Array),
          trending_topics: expect.any(Array),
          saved_inspirations: expect.arrayContaining([
            expect.objectContaining({ source_id: 'reddit_abc' }),
            expect.objectContaining({ source_id: 'bilibili_BV123' }),
          ]),
        }),
      );

      // Verify diary entry written
      expect(memory.appendDiary).toHaveBeenCalled();
    });

    it('works with persona content_sources platform filtering', async () => {
      // Only allow reddit
      const filteredRegistry = new ContentProviderRegistry();
      filteredRegistry.register(redditProvider);
      filteredRegistry.register(bilibiliProvider);
      filteredRegistry.register(dailyhotProvider);

      const config = {
        async getFeedItems() {
          // Simulate platform filter from persona content_sources
          const items = await filteredRegistry.getAggregatedFeed({ platforms: ['reddit'] });
          return items.map(item => ({
            id: item.id,
            title: item.title,
            likes: item.likes ?? 0,
            source: item.source,
          }));
        },
        async searchContent(keyword: string) {
          const items = await filteredRegistry.search(keyword, { platforms: ['reddit'] });
          return items.map(item => ({
            id: item.id,
            title: item.title,
            likes: item.likes ?? 0,
            source: item.source,
          }));
        },
        searchKeywords: ['cosplay'],
        sourcePlatforms: ['reddit'],
      };

      const memory = makeMemory();
      const ctx = makeCtx({ config, memory });

      const result = await actions['feed-browse'](ctx);
      expect(result.narrative).toContain('刷了');

      // Verify only reddit data reached the LLM
      const llmCallArgs = getFeedAnalysisPrompt(ctx.llm.callJSON as ReturnType<typeof vi.fn>);
      // Source platforms section should only list reddit
      expect(llmCallArgs).toContain('数据来源平台');
      // Extract the source_platforms line (between "数据来源平台" and next "##")
      const platformsMatch = llmCallArgs.match(/数据来源平台\n(.*?)(\n##|\n\n)/s);
      expect(platformsMatch).toBeTruthy();
      const platformsLine = platformsMatch![1].trim();
      expect(platformsLine).toBe('reddit');
      // Feed data should only contain reddit items
      expect(llmCallArgs).toContain('Amazing cosplay WIP');
      expect(llmCallArgs).not.toContain('剑灵');  // bilibili item should not be present
      expect(llmCallArgs).not.toContain('知乎热榜'); // dailyhot item should not be present
    });

    it('single provider failure does not break the full chain', async () => {
      // Make reddit provider fail
      (redditProvider.getFeed as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Reddit API timeout'));
      (redditProvider.isAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const config = {
        async getFeedItems() {
          const items = await registry.getAggregatedFeed({ limit: 10 });
          return items.map(item => ({
            id: item.id,
            title: item.title,
            likes: item.likes ?? 0,
            source: item.source,
          }));
        },
        searchKeywords: [] as string[],
      };

      const memory = makeMemory();
      const ctx = makeCtx({ config, memory });

      const result = await actions['feed-browse'](ctx);

      // Should still succeed with bilibili + dailyhot data
      expect(result.narrative).toContain('刷了');
      expect(result.vitality_cost).toBe(10);

      // Verify bilibili and dailyhot items still got through
      const llmCallArgs = getFeedAnalysisPrompt(ctx.llm.callJSON as ReturnType<typeof vi.fn>);
      expect(llmCallArgs).toContain('Cosplay');
      // inspiration saved despite partial failure
      expect(memory.writeJSON).toHaveBeenCalledWith(
        'inspiration-state',
        expect.objectContaining({ last_refreshed_at: expect.any(String) }),
      );
    });

    it('empty registry returns "no content" gracefully', async () => {
      const emptyRegistry = new ContentProviderRegistry();
      const config = {
        async getFeedItems() {
          return (await emptyRegistry.getAggregatedFeed()).map(item => ({
            id: item.id, title: item.title, likes: item.likes ?? 0,
          }));
        },
      };

      const ctx = makeCtx({ config });
      const result = await actions['feed-browse'](ctx);
      expect(result.narrative).toContain('没什么新鲜的');
      expect(result.vitality_cost).toBe(5);
    });

    it('all providers unavailable returns "no content"', async () => {
      const allDownRegistry = new ContentProviderRegistry();
      allDownRegistry.register(makeMockProvider('reddit', [], [], false));
      allDownRegistry.register(makeMockProvider('bilibili', [], [], false));

      const config = {
        async getFeedItems() {
          return (await allDownRegistry.getAggregatedFeed()).map(item => ({
            id: item.id, title: item.title, likes: item.likes ?? 0,
          }));
        },
      };

      const ctx = makeCtx({ config });
      const result = await actions['feed-browse'](ctx);
      expect(result.narrative).toContain('没什么新鲜的');
    });
  });

  // ── Feed item source annotation ──

  describe('Source annotation in LLM prompt', () => {
    it('includes source platform tags in feed item formatting', async () => {
      const config = {
        async getFeedItems() {
          return [
            { id: 'reddit_1', title: 'Reddit Post', likes: 100, source: 'reddit' },
            { id: 'bilibili_1', title: 'B站视频', likes: 200, source: 'bilibili' },
            { id: 'dailyhot_1', title: '热搜内容', likes: 300, source: 'dailyhot:weibo' },
          ];
        },
        sourcePlatforms: ['reddit', 'bilibili', 'dailyhot:weibo'],
      };

      const ctx = makeCtx({ config });
      await actions['feed-browse'](ctx);

      const llmCallArgs = getFeedAnalysisPrompt(ctx.llm.callJSON as ReturnType<typeof vi.fn>);
      // Feed items should include source annotation
      expect(llmCallArgs).toContain('(reddit)');
      expect(llmCallArgs).toContain('(bilibili)');
      expect(llmCallArgs).toContain('(dailyhot:weibo)');
      // Source platforms section should be present
      expect(llmCallArgs).toContain('reddit, bilibili, dailyhot:weibo');
    });
  });

  // ── Backward compatibility ──

  describe('Backward compatibility', () => {
    it('works without Registry (legacy XHS+IG mode)', async () => {
      // Simulate legacy config without registry
      const getFeedItems = vi.fn(async () => [
        { id: 'xhs_1', title: 'XHS Note', likes: 50, user: 'xhsUser', tags: ['cosplay'] },
        { id: 'ig_2', title: 'IG Post', likes: 80, user: 'igUser' },
      ]);
      const searchContent = vi.fn(async () => [
        { id: 'xhs_3', title: 'XHS Search Result', likes: 30, user: 'anotherUser' },
      ]);

      const memory = makeMemory();
      const ctx = makeCtx({
        config: { getFeedItems, searchContent, searchKeywords: ['cosplay'] },
        memory,
      });

      const result = await actions['feed-browse'](ctx);
      expect(result.narrative).toContain('刷了');
      expect(result.vitality_cost).toBe(10);
      expect(getFeedItems).toHaveBeenCalled();
      // searchContent is called with LLM-generated keywords (not raw searchKeywords)
      expect(searchContent).toHaveBeenCalled();
      expect(searchContent.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });
});
