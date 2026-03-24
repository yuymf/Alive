// alive/tests/sub-skill-web-search.test.ts
// Tests for the web-search sub-skill

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractQuery,
  parseSearchResults,
  actions,
  resetExaRateLimitForTests,
} from '../sub-skills/web-search/scripts/index';
import type { SubSkillContext, EmotionState, PersonaConfig, ResolvedIntent, MemoryAccessor } from '../scripts/utils/types';
import { DEFAULT_MOMENTUM, DEFAULT_UNDERTONE } from '../scripts/utils/types';

// ── Mock helpers ─────────────────────────────────────────────────

function makePersona(overrides: Partial<PersonaConfig> = {}): PersonaConfig {
  return {
    meta: { name: 'TestChar', tagline: '测试角色' },
    personality: { mbti: 'INFP', core_traits: ['curious', 'creative'] },
    voice: { language: 'zh', style: '活泼', sample_lines: ['嗨！'] },
    ...overrides,
  } as PersonaConfig;
}

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

function makeIntent(overrides: Partial<ResolvedIntent> = {}): ResolvedIntent {
  return {
    id: 'i1', category: '学习', description: '搜一下最新的AI进展',
    intensity: 6, action: 'search-pipeline', ...overrides,
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

function makeContext(overrides: Partial<SubSkillContext> = {}): SubSkillContext {
  return {
    persona: makePersona(),
    emotion: makeEmotion(),
    vitality: 80,
    confidence: 1.0,
    intent: makeIntent(),
    memory: makeMemory(),
    socialGraph: { getRelations: vi.fn(() => []), updateRelation: vi.fn() },
    llm: {
      callJSON: vi.fn(async () => ({})),
      call: vi.fn(async () => '测试摘要'),
    },
    config: {},
    ...overrides,
  };
}

// ── extractQuery ─────────────────────────────────────────────────

describe('web-search/extractQuery', () => {
  it('strips "搜一下" prefix', () => {
    expect(extractQuery('搜一下最新AI进展')).toBe('最新AI进展');
  });

  it('strips "搜索一下" prefix', () => {
    expect(extractQuery('搜索一下cosplay技巧')).toBe('cosplay技巧');
  });

  it('strips "了解一下" prefix', () => {
    expect(extractQuery('了解一下TypeScript 5.0')).toBe('TypeScript 5.0');
  });

  it('strips "研究一下" prefix', () => {
    expect(extractQuery('研究一下机器学习算法')).toBe('机器学习算法');
  });

  it('strips English "search" prefix', () => {
    expect(extractQuery('search latest trends')).toBe('latest trends');
  });

  it('strips English "look up" prefix', () => {
    expect(extractQuery('look up cosplay materials')).toBe('cosplay materials');
  });

  it('returns original if no prefix match', () => {
    expect(extractQuery('最新AI进展')).toBe('最新AI进展');
  });

  it('returns original if stripping yields empty', () => {
    expect(extractQuery('搜索')).toBe('搜索');
  });

  it('handles "想知道" prefix', () => {
    expect(extractQuery('想知道今天天气')).toBe('今天天气');
  });
});

// ── parseSearchResults ───────────────────────────────────────────

describe('web-search/parseSearchResults', () => {
  it('parses SSE response with Title/URL/Text blocks', () => {
    const body = `data:${JSON.stringify({
      result: {
        content: [{
          type: 'text',
          text: 'Title: AI News\nURL: https://example.com/ai\nText: The latest in AI research\n\nTitle: ML Guide\nURL: https://example.com/ml\nText: Machine learning fundamentals',
        }],
      },
    })}`;

    const results = parseSearchResults(body);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'AI News',
      url: 'https://example.com/ai',
      snippet: 'The latest in AI research',
    });
    expect(results[1]).toEqual({
      title: 'ML Guide',
      url: 'https://example.com/ml',
      snippet: 'Machine learning fundamentals',
    });
  });

  it('returns empty array for non-SSE response', () => {
    expect(parseSearchResults('not an SSE response')).toEqual([]);
  });

  it('returns empty array when no text content', () => {
    const body = `data:${JSON.stringify({ result: { content: [] } })}`;
    expect(parseSearchResults(body)).toEqual([]);
  });

  it('throws on Exa error', () => {
    const body = `data:${JSON.stringify({ error: { message: 'rate limited' } })}`;
    expect(() => parseSearchResults(body)).toThrow('Exa error: rate limited');
  });

  it('skips entries without URL', () => {
    const body = `data:${JSON.stringify({
      result: {
        content: [{
          type: 'text',
          text: 'Title: No URL\nText: Some text\n\nTitle: Has URL\nURL: https://x.com\nText: Some text',
        }],
      },
    })}`;
    const results = parseSearchResults(body);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Has URL');
  });

  it('truncates long snippets to 300 chars', () => {
    const longText = 'A'.repeat(500);
    const body = `data:${JSON.stringify({
      result: {
        content: [{
          type: 'text',
          text: `Title: Test\nURL: https://x.com\nText: ${longText}`,
        }],
      },
    })}`;
    const results = parseSearchResults(body);
    expect(results[0].snippet.length).toBeLessThanOrEqual(300);
  });
});

// ── search-pipeline action ───────────────────────────────────────

describe('web-search/search-pipeline action', () => {
  beforeEach(() => {
    resetExaRateLimitForTests();
    // Mock global fetch for Exa calls
    vi.stubGlobal('fetch', vi.fn());
  });

  it('writes diary entry on successful search', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      text: async () => `data:${JSON.stringify({
        result: {
          content: [{ type: 'text', text: 'Title: Result\nURL: https://x.com\nText: Content' }],
        },
      })}`,
      headers: new Map(),
    };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

    const ctx = makeContext();
    const result = await actions['search-pipeline'](ctx);

    expect(result.narrative).toContain('搜了');
    expect(result.vitality_cost).toBe(20);
    expect(ctx.memory.appendDiary).toHaveBeenCalled();
    expect(ctx.memory.writeJSON).toHaveBeenCalledWith('search-state', expect.objectContaining({ count: 1 }));
  });

  it('returns degraded result on fetch failure', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network error'));

    const ctx = makeContext();
    const result = await actions['search-pipeline'](ctx);

    expect(result.narrative).toContain('搜索失败');
    expect(result.vitality_cost).toBe(10);
    expect(result.emotion_deltas).toEqual(expect.arrayContaining([
      expect.objectContaining({ stress: 0.05 }),
    ]));
  });

  it('increments search count for same day', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const mockResponse = {
      ok: true, status: 200,
      text: async () => `data:${JSON.stringify({ result: { content: [{ type: 'text', text: 'Title: R\nURL: https://x.com\nText: T' }] } })}`,
      headers: new Map(),
    };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

    const ctx = makeContext({
      memory: makeMemory({ 'search-state': { date: today, count: 3 } }),
    });
    await actions['search-pipeline'](ctx);

    expect(ctx.memory.writeJSON).toHaveBeenCalledWith('search-state', { date: today, count: 4 });
  });

  it('resets count on a new day', async () => {
    const mockResponse = {
      ok: true, status: 200,
      text: async () => `data:${JSON.stringify({ result: { content: [{ type: 'text', text: 'Title: R\nURL: https://x.com\nText: T' }] } })}`,
      headers: new Map(),
    };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

    const ctx = makeContext({
      memory: makeMemory({ 'search-state': { date: '2025-01-01', count: 99 } }),
    });
    await actions['search-pipeline'](ctx);

    const writeCall = (ctx.memory.writeJSON as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'search-state'
    );
    expect(writeCall![1].count).toBe(1);
  });

  it('includes creativity boost in emotion deltas', async () => {
    const mockResponse = {
      ok: true, status: 200,
      text: async () => `data:${JSON.stringify({ result: { content: [{ type: 'text', text: 'Title: R\nURL: https://x.com\nText: T' }] } })}`,
      headers: new Map(),
    };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

    const ctx = makeContext();
    const result = await actions['search-pipeline'](ctx);

    expect(result.emotion_deltas).toEqual(expect.arrayContaining([
      expect.objectContaining({ creativity: 0.08 }),
    ]));
  });
});
