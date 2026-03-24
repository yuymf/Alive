import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../sub-skills/platform/xhs-bridge/scripts/xhs-client', () => ({
  isXhsAvailable: vi.fn(),
  listXhsFeed: vi.fn(),
  searchXhsNotes: vi.fn(),
  getXhsNoteDetail: vi.fn(),
}));

vi.mock('../scripts/utils/llm-client', () => ({
  callLLMJSON: vi.fn(),
}));

vi.mock('../scripts/utils/exa-client', () => ({
  exaWebSearch: vi.fn(),
}));

vi.mock('../scripts/utils/file-utils', () => ({
  PATHS: {
    inspiration: '/tmp/test-inspiration.json',
    postHistory: '/tmp/test-post-history.json',
    socialMeta: '/tmp/test-social-meta.json',
    travelState: '/tmp/test-travel-state.json',
    postImpulse: '/tmp/test-post-impulse.json',
    inspirationRefs: '/tmp/test-inspiration-refs',
  },
  readJSON: vi.fn().mockReturnValue({
    instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: 0 },
    acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: 0 },
    visual_trends: { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: 0 },
    self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: 0 },
    xiaohongshu_trends: { feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [], saved_inspirations: [], updated_at: 0 },
  }),
  writeJSON: vi.fn(),
  readTemplate: vi.fn().mockReturnValue('template {feed_data} {search_data} {detail_data}'),
}));

vi.mock('../sub-skills/platform/instagram-bridge/scripts/bridge-client', () => ({
  hashtagRecent: vi.fn(),
  callInstagramBridge: vi.fn(),
}));

describe('collectACGHotspots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use live web search results before calling LLM', async () => {
    const { exaWebSearch } = await import('../scripts/utils/exa-client');
    (exaWebSearch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        { title: '2026春季热门 Cos 角色', url: 'https://example.com/chars', snippet: 'Furina、Frieren、Mavuika 是近期 cosplay 热门角色。' },
      ])
      .mockResolvedValueOnce([
        { title: '上海 COMICUP 31', url: 'https://example.com/cp31', snippet: 'COMICUP 31 将于 2026 年 4 月在上海举办。' },
      ])
      .mockResolvedValueOnce([
        { title: 'AnimeJapan 2026', url: 'https://example.com/aj2026', snippet: 'AnimeJapan 2026 将于东京 Big Sight 举办。' },
      ])
      .mockResolvedValueOnce([
        { title: '2026春季 ACG 审美', url: 'https://example.com/themes', snippet: '学院风、水手服、轻赛博霓虹是春季高频主题。' },
      ]);

    const { callLLMJSON } = await import('../scripts/utils/llm-client');
    (callLLMJSON as ReturnType<typeof vi.fn>).mockResolvedValue({
      trending_characters: ['Furina', 'Frieren'],
      upcoming_events: ['COMICUP 31 上海', 'AnimeJapan 2026 东京'],
      seasonal_themes: ['学院风', '轻赛博霓虹'],
    });

    const { collectACGHotspots } = await import('../../skill/scripts/inspiration-collector');
    const result = await collectACGHotspots();

    expect(exaWebSearch).toHaveBeenCalledTimes(4); // 4 searches: characters, china events, japan events, themes
    expect(callLLMJSON).toHaveBeenCalledTimes(1);
    expect(result.trending_characters).toContain('Furina');
    expect(result.upcoming_events).toContain('AnimeJapan 2026 东京');
    expect(result.updated_at).toBeGreaterThan(0);
  });

  it('should return empty arrays and skip LLM when live search returns nothing', async () => {
    const { exaWebSearch } = await import('../scripts/utils/exa-client');
    (exaWebSearch as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { callLLMJSON } = await import('../scripts/utils/llm-client');
    const { collectACGHotspots } = await import('../../skill/scripts/inspiration-collector');
    const result = await collectACGHotspots();

    expect(result.trending_characters).toEqual([]);
    expect(result.upcoming_events).toEqual([]);
    expect(result.seasonal_themes).toEqual([]);
    expect(result.updated_at).toBeGreaterThan(0);
    expect(callLLMJSON).not.toHaveBeenCalled();
  });
});

describe('refreshInspiration visual trends', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use live search evidence before summarizing stale visual trends', async () => {
    const now = Date.now();
    const { exaWebSearch } = await import('../scripts/utils/exa-client');
    (exaWebSearch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        { title: '2026 春季构图趋势', url: 'https://example.com/composition', snippet: '镜面反射、低机位仰拍、居中对称在 cos 拍摄里热度很高。' },
      ])
      .mockResolvedValueOnce([
        { title: '2026 日系写真色调', url: 'https://example.com/colors', snippet: '胶片复古、冷白肤色、轻赛博霓虹是近期高频配色。' },
      ])
      .mockResolvedValueOnce([
        { title: '2026 热门拍照场景', url: 'https://example.com/scenes', snippet: '便利店夜景、天台夕阳、车站月台是近期热门取景。' },
      ]);

    const { callLLMJSON } = await import('../scripts/utils/llm-client');
    (callLLMJSON as ReturnType<typeof vi.fn>).mockResolvedValue({
      composition_styles: ['镜面反射', '低机位仰拍'],
      color_palettes: ['胶片复古', '轻赛博霓虹'],
      scene_ideas: ['便利店夜景', '天台夕阳'],
    });

    const { PATHS, readJSON, writeJSON } = await import('../scripts/utils/file-utils');
    (readJSON as ReturnType<typeof vi.fn>).mockImplementation((targetPath: string) => {
      if (targetPath === PATHS.inspiration) {
        return {
          instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: now },
          acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: now },
          visual_trends: { composition_styles: ['旧构图'], color_palettes: ['旧色调'], scene_ideas: ['旧场景'], updated_at: now - 25 * 60 * 60 * 1000 },
          self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: now },
          xiaohongshu_trends: { feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [], saved_inspirations: [], updated_at: now },
        };
      }
      if (targetPath === PATHS.travelState) {
        return { current_city: '', country: '' };
      }
      return {};
    });

    const { refreshInspiration } = await import('../../skill/scripts/inspiration-collector');
    const result = await refreshInspiration();

    expect(exaWebSearch).toHaveBeenCalledTimes(3);
    expect(callLLMJSON).toHaveBeenCalledTimes(1);
    expect(result.visual_trends.composition_styles).toEqual(['镜面反射', '低机位仰拍']);
    expect(writeJSON).toHaveBeenCalledWith(
      PATHS.inspiration,
      expect.objectContaining({
        visual_trends: expect.objectContaining({
          color_palettes: ['胶片复古', '轻赛博霓虹'],
          scene_ideas: ['便利店夜景', '天台夕阳'],
        }),
      }),
    );
  });

  it('should skip LLM and keep visual trends empty when live evidence is missing', async () => {
    const now = Date.now();
    const { exaWebSearch } = await import('../scripts/utils/exa-client');
    (exaWebSearch as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { callLLMJSON } = await import('../scripts/utils/llm-client');
    (callLLMJSON as ReturnType<typeof vi.fn>).mockResolvedValue({
      composition_styles: ['通用构图'],
      color_palettes: ['通用色调'],
      scene_ideas: ['通用场景'],
    });

    const { PATHS, readJSON } = await import('../scripts/utils/file-utils');
    (readJSON as ReturnType<typeof vi.fn>).mockImplementation((targetPath: string) => {
      if (targetPath === PATHS.inspiration) {
        return {
          instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: now },
          acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: now },
          visual_trends: { composition_styles: ['旧构图'], color_palettes: ['旧色调'], scene_ideas: ['旧场景'], updated_at: now - 25 * 60 * 60 * 1000 },
          self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: now },
          xiaohongshu_trends: { feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [], saved_inspirations: [], updated_at: now },
        };
      }
      if (targetPath === PATHS.travelState) {
        return { current_city: '', country: '' };
      }
      return {};
    });

    const { refreshInspiration } = await import('../../skill/scripts/inspiration-collector');
    const result = await refreshInspiration();

    expect(exaWebSearch).toHaveBeenCalledTimes(3);
    expect(callLLMJSON).not.toHaveBeenCalled();
    expect(result.visual_trends.composition_styles).toEqual([]);
    expect(result.visual_trends.color_palettes).toEqual([]);
    expect(result.visual_trends.scene_ideas).toEqual([]);
    expect(result.visual_trends.updated_at).toBeGreaterThan(0);
  });
});

describe('collectXiaohongshuTrends', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty data when MCP is unavailable', async () => {
    const { isXhsAvailable } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
    (isXhsAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { collectXiaohongshuTrends } = await import('../../skill/scripts/inspiration-collector');
    const result = await collectXiaohongshuTrends();
    expect(result.feed_highlights).toEqual([]);
    expect(result.updated_at).toBe(0);
  });

  it('should collect feed + latest search data and call LLM', async () => {
    const xhsMock = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
    (xhsMock.isXhsAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (xhsMock.listXhsFeed as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'n1', xsec_token: 't1', title: 'Feed Post', description: 'desc', likes: 100, user: 'u1', tags: [] },
    ]);
    (xhsMock.searchXhsNotes as ReturnType<typeof vi.fn>).mockImplementation(async (keyword: string) => {
      if (keyword === 'cosplay') {
        return [{ id: 'n2', xsec_token: 't2', title: 'Cos Post', description: 'desc', likes: 200, user: 'u2', tags: ['cos'] }];
      }
      return [];
    });

    const { callLLMJSON } = await import('../scripts/utils/llm-client');
    (callLLMJSON as ReturnType<typeof vi.fn>).mockResolvedValue({
      feed_highlights: [{ title: 'Feed Post', likes: 100, topic: 'fashion', takeaway: '构图干净' }],
      cosplay_notes: [{ title: 'Cos Post', likes: 200, topic: 'cosplay', takeaway: '妆造完成度高' }],
      trending_topics: ['jk制服'],
      cosplay_insights: ['镜面反射构图很火'],
      saved_inspirations: [],
    });

    const { collectXiaohongshuTrends } = await import('../../skill/scripts/inspiration-collector');
    const result = await collectXiaohongshuTrends();
    expect(result.feed_highlights).toHaveLength(1);
    expect(result.trending_topics).toContain('jk制服');
    expect(result.updated_at).toBeGreaterThan(0);
    expect(xhsMock.searchXhsNotes).toHaveBeenCalledWith('cosplay', { sortBy: '最新', publishTime: '一周内' });
  });

  it('should return empty arrays and skip LLM when live data is empty', async () => {
    const xhsMock = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
    (xhsMock.isXhsAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (xhsMock.listXhsFeed as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (xhsMock.searchXhsNotes as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { callLLMJSON } = await import('../scripts/utils/llm-client');
    const { collectXiaohongshuTrends } = await import('../../skill/scripts/inspiration-collector');
    const result = await collectXiaohongshuTrends();

    expect(result.feed_highlights).toEqual([]);
    expect(result.cosplay_notes).toEqual([]);
    expect(result.updated_at).toBeGreaterThan(0);
    expect(callLLMJSON).not.toHaveBeenCalled();
  });

  it('should merge saved_inspirations with existing ones and cap at 20', async () => {
    const xhsMock = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
    (xhsMock.isXhsAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (xhsMock.listXhsFeed as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (xhsMock.searchXhsNotes as ReturnType<typeof vi.fn>).mockImplementation(async (keyword: string) => {
      if (keyword === 'cosplay') {
        return [{ id: 'seed_1', xsec_token: 'tok_1', title: 'Seed Note', description: 'desc', likes: 1200, user: 'u1', tags: ['cos'] }];
      }
      return [];
    });
    (xhsMock.getXhsNoteDetail as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'seed_1', xsec_token: 'tok_1', title: 'Seed Note', description: 'desc', likes: 1200, user: 'u1', tags: ['cos'],
      comments: [], images: [], collected_count: 0, share_count: 0,
    });

    const { callLLMJSON } = await import('../scripts/utils/llm-client');
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

    const { readJSON } = await import('../scripts/utils/file-utils');
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

    const { collectXiaohongshuTrends } = await import('../../skill/scripts/inspiration-collector');
    const result = await collectXiaohongshuTrends();
    expect(result.saved_inspirations.length).toBeLessThanOrEqual(20);
    expect(result.saved_inspirations.some(s => s.source_note_id === 'new_0')).toBe(true);
  });

  it('should prefer new entries over old ones with same source_note_id', async () => {
    const xhsMock = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
    (xhsMock.isXhsAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (xhsMock.listXhsFeed as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (xhsMock.searchXhsNotes as ReturnType<typeof vi.fn>).mockImplementation(async (keyword: string) => {
      if (keyword === 'cosplay') {
        return [{ id: 'seed_1', xsec_token: 'tok_1', title: 'Seed Note', description: 'desc', likes: 900, user: 'u1', tags: ['cos'] }];
      }
      return [];
    });
    (xhsMock.getXhsNoteDetail as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'seed_1', xsec_token: 'tok_1', title: 'Seed Note', description: 'desc', likes: 900, user: 'u1', tags: ['cos'],
      comments: [], images: [], collected_count: 0, share_count: 0,
    });

    const { callLLMJSON } = await import('../scripts/utils/llm-client');
    (callLLMJSON as ReturnType<typeof vi.fn>).mockResolvedValue({
      feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [],
      saved_inspirations: [{
        source_note_id: 'overlap_1',
        source_title: 'Updated Title',
        visual_description: 'New description with better detail',
        style_tags: ['updated'],
      }],
    });

    const { readJSON } = await import('../scripts/utils/file-utils');
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

    const { collectXiaohongshuTrends } = await import('../../skill/scripts/inspiration-collector');
    const result = await collectXiaohongshuTrends();
    const overlapping = result.saved_inspirations.filter(s => s.source_note_id === 'overlap_1');
    expect(overlapping).toHaveLength(1);
    expect(overlapping[0].visual_description).toBe('New description with better detail');
    expect(overlapping[0].style_tags).toEqual(['updated']);
  });
});
