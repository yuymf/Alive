// alive/tests/sub-skill-content-browse.test.ts
// Tests for the content-browse sub-skill

import { describe, it, expect, vi } from 'vitest';
import { actions } from '../sub-skills/content-browse/scripts/index';
import type { SubSkillContext, EmotionState, MemoryAccessor, PersonaConfig } from '../scripts/utils/types';
import { DEFAULT_MOMENTUM, DEFAULT_UNDERTONE } from '../scripts/utils/types';

// ── Mock helpers ─────────────────────────────────────────────────

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
    } as PersonaConfig,
    emotion: makeEmotion(),
    vitality: 80,
    confidence: 1.0,
    intent: { id: 'i1', category: 'consume' as const, description: '刷一下手机', intensity: 5, action: 'feed-browse' },
    memory: makeMemory(),
    socialGraph: { getRelations: vi.fn(() => []), updateRelation: vi.fn() },
    llm: {
      callJSON: vi.fn(async () => ({
        feed_highlights: [{ title: 'Cool post', likes: 100, topic: 'art' }],
        trending_topics: ['AI art', 'cosplay trends'],
        domain_insights: ['Visual quality matters', 'Story-driven content wins'],
        saved_inspirations: [{ source_id: 's1', source_title: 'Inspo', visual_description: 'Beautiful', style_tags: ['anime'] }],
      })),
      call: vi.fn(async () => ''),
    },
    config: {},
    ...overrides,
  };
}

// ── feed-browse action ───────────────────────────────────────────

describe('content-browse/feed-browse', () => {
  it('returns "no content" when no platform functions configured', async () => {
    const ctx = makeCtx();
    const result = await actions['feed-browse'](ctx);
    expect(result.narrative).toContain('没什么新鲜的');
    expect(result.vitality_cost).toBe(5);
  });

  it('fetches feed items and runs LLM analysis', async () => {
    const getFeedItems = vi.fn(async () => [
      { id: '1', title: 'Cool post', likes: 100, user: 'alice', tags: ['art'] },
      { id: '2', title: 'Nice photo', likes: 50, user: 'bob' },
    ]);

    const ctx = makeCtx({
      config: { getFeedItems },
    });

    const result = await actions['feed-browse'](ctx);
    expect(getFeedItems).toHaveBeenCalled();
    expect(result.narrative).toContain('刷了');
    expect(result.vitality_cost).toBe(10);
    expect(result.emotion_deltas).toEqual(expect.arrayContaining([
      expect.objectContaining({ creativity: 0.08 }),
    ]));
  });

  it('saves inspiration state to memory', async () => {
    const getFeedItems = vi.fn(async () => [
      { id: '1', title: 'Post', likes: 10 },
    ]);

    const memory = makeMemory();
    const ctx = makeCtx({ config: { getFeedItems }, memory });

    await actions['feed-browse'](ctx);
    expect(memory.writeJSON).toHaveBeenCalledWith(
      'inspiration-state',
      expect.objectContaining({
        last_refreshed_at: expect.any(String),
        feed_highlights: expect.any(Array),
        trending_topics: expect.any(Array),
      }),
    );
  });

  it('writes diary entry', async () => {
    const getFeedItems = vi.fn(async () => [
      { id: '1', title: 'Post', likes: 10 },
    ]);

    const memory = makeMemory();
    const ctx = makeCtx({ config: { getFeedItems }, memory });

    await actions['feed-browse'](ctx);
    expect(memory.appendDiary).toHaveBeenCalled();
  });

  it('deduplicates feed + search items by id', async () => {
    const getFeedItems = vi.fn(async () => [
      { id: '1', title: 'Post A', likes: 10 },
    ]);
    const searchContent = vi.fn(async () => [
      { id: '1', title: 'Post A dup', likes: 10 }, // duplicate
      { id: '2', title: 'Post B', likes: 20 },
    ]);

    const ctx = makeCtx({
      config: { getFeedItems, searchContent, searchKeywords: ['test'] },
    });

    const result = await actions['feed-browse'](ctx);
    expect(result.narrative).toContain('2'); // only 2 unique items
  });

  it('handles feed fetch failure gracefully', async () => {
    const getFeedItems = vi.fn(async () => { throw new Error('network error'); });
    const searchContent = vi.fn(async () => [
      { id: '1', title: 'Search result', likes: 5 },
    ]);

    const ctx = makeCtx({
      config: { getFeedItems, searchContent, searchKeywords: ['test'] },
    });

    const result = await actions['feed-browse'](ctx);
    // Should still work with search results
    expect(result.narrative).toContain('1'); // at least 1 item from search
  });

  it('merges new inspirations with existing (max 20)', async () => {
    const existingInspos = Array.from({ length: 18 }, (_, i) => ({
      source_id: `old${i}`, source_title: `Old ${i}`,
      visual_description: 'desc', style_tags: ['tag'],
    }));

    const getFeedItems = vi.fn(async () => [
      { id: '1', title: 'Post', likes: 10 },
    ]);

    const memory = makeMemory({
      'inspiration-state': {
        last_refreshed_at: null,
        feed_highlights: [],
        trending_topics: [],
        domain_insights: [],
        saved_inspirations: existingInspos,
      },
    });

    const ctx = makeCtx({ config: { getFeedItems }, memory });
    await actions['feed-browse'](ctx);

    const writeCall = (memory.writeJSON as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'inspiration-state'
    );
    const state = writeCall![1] as any;
    expect(state.saved_inspirations.length).toBeLessThanOrEqual(20);
  });

  it('adds extra creativity boost when >2 insights found', async () => {
    const getFeedItems = vi.fn(async () => [
      { id: '1', title: 'Post', likes: 10 },
    ]);

    const ctx = makeCtx({
      config: { getFeedItems },
      llm: {
        callJSON: vi.fn(async () => ({
          feed_highlights: [],
          trending_topics: [],
          domain_insights: ['insight1', 'insight2', 'insight3'], // >2
          saved_inspirations: [],
        })),
        call: vi.fn(async () => ''),
      },
    });

    const result = await actions['feed-browse'](ctx);
    // Should have both base creativity + bonus
    const totalCreativity = (result.emotion_deltas ?? [])
      .reduce((sum, d) => sum + (d.creativity ?? 0), 0);
    expect(totalCreativity).toBeGreaterThan(0.08);
  });
});

// ── inspiration-collect action ───────────────────────────────────

describe('content-browse/inspiration-collect', () => {
  it('returns early when webSearch not configured', async () => {
    const ctx = makeCtx({
      intent: { id: 'i1', category: 'learn' as const, description: '找灵感', intensity: 5, action: 'inspiration-collect' },
    });
    const result = await actions['inspiration-collect'](ctx);
    expect(result.narrative).toContain('未配置');
    expect(result.vitality_cost).toBe(0);
  });

  it('runs parallel web searches and saves trend data', async () => {
    const webSearch = vi.fn(async (query: string) => [
      { title: `Result for ${query}`, url: 'https://x.com', snippet: 'snippet' },
    ]);

    const memory = makeMemory();
    const ctx = makeCtx({
      config: { webSearch, trendQueries: ['query1', 'query2'] },
      memory,
      intent: { id: 'i1', category: 'learn' as const, description: '找灵感', intensity: 5, action: 'inspiration-collect' },
      llm: {
        callJSON: vi.fn(async () => ({
          hot_styles: ['style1', 'style2'],
          high_engagement_patterns: ['pattern1'],
          trending_hashtags: ['#tag1'],
        })),
        call: vi.fn(async () => ''),
      },
    });

    const result = await actions['inspiration-collect'](ctx);
    expect(webSearch).toHaveBeenCalledTimes(2);
    expect(result.narrative).toContain('灵感');
    expect(result.vitality_cost).toBe(10);
    expect(memory.writeJSON).toHaveBeenCalledWith(
      'trend-insights',
      expect.objectContaining({ hot_styles: ['style1', 'style2'] }),
    );
  });

  it('returns early when all searches fail', async () => {
    const webSearch = vi.fn(async () => { throw new Error('fail'); });

    const ctx = makeCtx({
      config: { webSearch, trendQueries: ['q1'] },
      intent: { id: 'i1', category: 'learn' as const, description: '找灵感', intensity: 5, action: 'inspiration-collect' },
    });

    const result = await actions['inspiration-collect'](ctx);
    expect(result.narrative).toContain('没找到');
    expect(result.vitality_cost).toBe(10);
  });

  it('uses persona core_traits for default queries when trendQueries not provided', async () => {
    const webSearch = vi.fn(async () => [
      { title: 'R', url: 'https://x.com', snippet: 's' },
    ]);

    const ctx = makeCtx({
      config: { webSearch }, // no trendQueries
      intent: { id: 'i1', category: 'learn' as const, description: '找灵感', intensity: 5, action: 'inspiration-collect' },
      llm: {
        callJSON: vi.fn(async () => ({
          hot_styles: [], high_engagement_patterns: [], trending_hashtags: [],
        })),
        call: vi.fn(async () => ''),
      },
    });

    await actions['inspiration-collect'](ctx);
    // Should search for each core trait
    expect(webSearch).toHaveBeenCalledTimes(3); // cosplay, photography, anime
  });
});
