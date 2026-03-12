import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all dependencies before importing
vi.mock('../skill/scripts/xhs-mcp-client', () => ({
  isXhsMcpAvailable: vi.fn(),
  listXhsFeed: vi.fn(),
  searchXhsNotes: vi.fn(),
  getXhsNoteDetail: vi.fn(),
}));

vi.mock('../skill/scripts/llm-client', () => ({
  callLLMJSON: vi.fn(),
}));

vi.mock('../skill/scripts/file-utils', () => ({
  PATHS: {
    inspiration: '/tmp/test-inspiration.json',
    postHistory: '/tmp/test-post-history.json',
    socialMeta: '/tmp/test-social-meta.json',
  },
  readJSON: vi.fn().mockReturnValue({
    instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: 0 },
    acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: 0 },
    visual_trends: { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: 0 },
    self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: 0 },
  }),
  writeJSON: vi.fn(),
  readTemplate: vi.fn().mockReturnValue('template {feed_data} {search_data} {detail_data}'),
}));

vi.mock('../skill/scripts/instagram-bridge-client', () => ({
  callInstagramBridge: vi.fn(),
}));

describe('collectXiaohongshuTrends', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty data when MCP is unavailable', async () => {
    const { isXhsMcpAvailable } = await import('../skill/scripts/xhs-mcp-client');
    (isXhsMcpAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { collectXiaohongshuTrends } = await import('../skill/scripts/inspiration-collector');
    const result = await collectXiaohongshuTrends();
    expect(result.feed_highlights).toEqual([]);
    expect(result.updated_at).toBe(0);
  });

  it('should collect feed + search data and call LLM', async () => {
    const xhsMock = await import('../skill/scripts/xhs-mcp-client');
    (xhsMock.isXhsMcpAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (xhsMock.listXhsFeed as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'n1', xsec_token: 't1', title: 'Feed Post', description: 'desc', likes: 100, user: 'u1', tags: [] },
    ]);
    (xhsMock.searchXhsNotes as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'n2', xsec_token: 't2', title: 'Cos Post', description: 'desc', likes: 200, user: 'u2', tags: ['cos'] },
    ]);

    const { callLLMJSON } = await import('../skill/scripts/llm-client');
    (callLLMJSON as ReturnType<typeof vi.fn>).mockResolvedValue({
      feed_highlights: [{ title: 'Feed Post', likes: 100, topic: 'fashion' }],
      cosplay_notes: [{ title: 'Cos Post', likes: 200, topic: 'cosplay' }],
      trending_topics: ['jk制服'],
      cosplay_insights: ['镜面反射构图很火'],
      saved_inspirations: [],
    });

    const { collectXiaohongshuTrends } = await import('../skill/scripts/inspiration-collector');
    const result = await collectXiaohongshuTrends();
    expect(result.feed_highlights).toHaveLength(1);
    expect(result.trending_topics).toContain('jk制服');
    expect(result.updated_at).toBeGreaterThan(0);
  });

  it('should merge saved_inspirations with existing ones and cap at 20', async () => {
    const xhsMock = await import('../skill/scripts/xhs-mcp-client');
    (xhsMock.isXhsMcpAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (xhsMock.listXhsFeed as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (xhsMock.searchXhsNotes as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { callLLMJSON } = await import('../skill/scripts/llm-client');
    const newInspos = Array.from({ length: 5 }, (_, i) => ({
      source_note_id: `new_${i}`,
      source_title: `New ${i}`,
      visual_description: `Description ${i}`,
      style_tags: ['tag'],
      saved_at: Date.now(),
    }));
    (callLLMJSON as ReturnType<typeof vi.fn>).mockResolvedValue({
      feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [],
      saved_inspirations: newInspos,
    });

    // Mock existing inspiration with 18 saved items
    const { readJSON } = await import('../skill/scripts/file-utils');
    const existingInspos = Array.from({ length: 18 }, (_, i) => ({
      source_note_id: `old_${i}`,
      source_title: `Old ${i}`,
      visual_description: `Old desc ${i}`,
      style_tags: ['old'],
      saved_at: Date.now() - 100000,
    }));
    (readJSON as ReturnType<typeof vi.fn>).mockReturnValue({
      instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: 0 },
      acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: 0 },
      visual_trends: { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: 0 },
      self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: 0 },
      xiaohongshu_trends: {
        feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [],
        saved_inspirations: existingInspos, updated_at: 0,
      },
    });

    const { collectXiaohongshuTrends } = await import('../skill/scripts/inspiration-collector');
    const result = await collectXiaohongshuTrends();
    // 18 existing + 5 new = 23, capped at 20, oldest removed
    expect(result.saved_inspirations.length).toBeLessThanOrEqual(20);
    // Should contain the new items (most recent)
    expect(result.saved_inspirations.some(s => s.source_note_id === 'new_0')).toBe(true);
  });

  it('should prefer new entries over old ones with same source_note_id', async () => {
    const xhsMock = await import('../skill/scripts/xhs-mcp-client');
    (xhsMock.isXhsMcpAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (xhsMock.listXhsFeed as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (xhsMock.searchXhsNotes as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { callLLMJSON } = await import('../skill/scripts/llm-client');
    (callLLMJSON as ReturnType<typeof vi.fn>).mockResolvedValue({
      feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [],
      saved_inspirations: [{
        source_note_id: 'overlap_1',
        source_title: 'Updated Title',
        visual_description: 'New description with better detail',
        style_tags: ['updated'],
      }],
    });

    const { readJSON } = await import('../skill/scripts/file-utils');
    (readJSON as ReturnType<typeof vi.fn>).mockReturnValue({
      instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: 0 },
      acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: 0 },
      visual_trends: { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: 0 },
      self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: 0 },
      xiaohongshu_trends: {
        feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [],
        saved_inspirations: [{
          source_note_id: 'overlap_1',
          source_title: 'Old Title',
          visual_description: 'Old description',
          style_tags: ['old'],
          saved_at: Date.now() - 100000,
        }],
        updated_at: 0,
      },
    });

    const { collectXiaohongshuTrends } = await import('../skill/scripts/inspiration-collector');
    const result = await collectXiaohongshuTrends();
    // Should have exactly 1 entry (not 2) — new replaces old
    const overlapping = result.saved_inspirations.filter(s => s.source_note_id === 'overlap_1');
    expect(overlapping).toHaveLength(1);
    expect(overlapping[0].visual_description).toBe('New description with better detail');
    expect(overlapping[0].style_tags).toEqual(['updated']);
  });
});
