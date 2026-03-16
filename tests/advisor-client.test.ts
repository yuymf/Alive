import { describe, it, expect, vi, afterEach } from 'vitest';

// Import module for spying — do this BEFORE stubbing
import * as llmClient from '../skill/scripts/llm-client';

import { consultAdvisor, AdvisorContext } from '../skill/scripts/advisor-client';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('consultAdvisor', () => {
  it('returns a non-empty string on success', async () => {
    vi.spyOn(llmClient, 'callLLM').mockResolvedValueOnce({
      content: '最近旅行帖不错，今天试试发一条美食探店。#kyoto_food #travel_japan',
      finishReason: 'stop',
    } as any);

    const result = await consultAdvisor({
      currentCity: '京都',
      country: '日本',
      followerCount: 1200,
      recentPostsSummary: '本周发了 3 条旅行帖，互动平均 80 赞',
      trendingTopics: '京都秋叶, 日本旅行',
    });

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns empty string on LLM error (graceful degradation)', async () => {
    vi.spyOn(llmClient, 'callLLM').mockRejectedValueOnce(new Error('network timeout'));

    const result = await consultAdvisor({
      currentCity: '京都',
      country: '日本',
      followerCount: 1200,
      recentPostsSummary: '',
      trendingTopics: '',
    });

    expect(result).toBe('');
  });

  it('returns string without throwing on any input', async () => {
    vi.spyOn(llmClient, 'callLLM').mockResolvedValueOnce({ content: 'something', finishReason: 'stop' } as any);

    const result = await consultAdvisor({
      currentCity: '大阪',
      country: '日本',
      followerCount: 500,
      recentPostsSummary: '',
      trendingTopics: '',
    });

    // Either '' (file missing) or non-empty (file found) — just verify no throw
    expect(typeof result).toBe('string');
  });
});
