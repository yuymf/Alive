import { describe, it, expect } from 'vitest';
import { formatBriefCard, BriefEnrichment } from '../scripts/ops/brief-generator';
import { QueueItem, PersonaAlignmentReport, CompetitorAnalysisStore } from '../scripts/utils/types';
import { FilteredTrend } from '../scripts/ops/trend-analyzer';

// ─── Test helpers ────────────────────────────────────────────────────────────

const sampleTrends: FilteredTrend[] = [
  {
    platform: 'douyin',
    keyword: 'LOL世界赛',
    current_volume: 5000000,
    avg_7d: 2000000,
    velocity_score: 2.5,
    rank: 1,
    hook_angle: '电竞解说',
    identity_mode: 'esports',
  },
];

const sampleQueueItem: QueueItem = {
  id: 'q1',
  status: 'pending',
  topic: '测试选题',
  trend_hook: '热度钩子',
  identity_mode: 'esports',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  content: {
    xhs: {
      title: '小红书标题',
      body: '小红书正文',
      tags: ['标签1'],
      cover_images: ['cover_desc.jpg'],
    },
    douyin: {
      script: '抖音脚本',
      bgm_suggestion: '流行BGM推荐',
      key_captions: ['字幕1：开场', '字幕2：高潮', '字幕3：结尾'],
      cover_images: [],
    },
  },
  edit_history: [],
  image_prompts: ['masterpiece, esports commentator in neon-lit gaming room, dramatic lighting'],
};

const samplePersonaReport: PersonaAlignmentReport = {
  alignment_score: 8,
  identity_analysis: [
    { identity: 'esports', fit_score: 9, reasoning: '今日LOL热度高' },
  ],
  topic_suggestions: [
    { direction: '方向1', identity_mode: 'esports', hook: '钩子1', reasoning: '理由1' },
    { direction: '方向2', identity_mode: 'singer', hook: '钩子2', reasoning: '理由2' },
    { direction: '方向3', identity_mode: 'daily', hook: '钩子3', reasoning: '理由3' },
  ],
  warnings: [],
  generated_at: '2026-04-02T10:00:00+09:00',
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('formatBriefCard', () => {
  it('should produce a basic brief without enrichment (backward compat)', () => {
    const card = formatBriefCard('2026-04-02', sampleTrends, [], [sampleQueueItem]);
    expect(card).toContain('📊 今日简报');
    expect(card).toContain('LOL世界赛');
    expect(card).toContain('测试选题');
    expect(card).toContain('操作');
  });

  it('should include 🎨生图Prompt section from enrichment', () => {
    const enrichment: BriefEnrichment = {
      fullQueueItems: [sampleQueueItem],
    };
    const card = formatBriefCard('2026-04-02', sampleTrends, [], [sampleQueueItem], enrichment);
    expect(card).toContain('🎨 今日生图 Prompt');
    expect(card).toContain('masterpiece');
    expect(card).toContain('esports commentator');
  });

  it('should include 🎬视频分镜 section from enrichment', () => {
    const enrichment: BriefEnrichment = {
      fullQueueItems: [sampleQueueItem],
    };
    const card = formatBriefCard('2026-04-02', sampleTrends, [], [sampleQueueItem], enrichment);
    expect(card).toContain('🎬 今日视频分镜');
    expect(card).toContain('字幕1：开场');
    expect(card).toContain('字幕2：高潮');
    expect(card).toContain('字幕3：结尾');
    expect(card).toContain('BGM: 流行BGM推荐');
  });

  it('should include 💡人设建议 section from enrichment', () => {
    const enrichment: BriefEnrichment = {
      personaReport: samplePersonaReport,
      fullQueueItems: [sampleQueueItem],
    };
    const card = formatBriefCard('2026-04-02', sampleTrends, [], [sampleQueueItem], enrichment);
    expect(card).toContain('💡人设建议');
    expect(card).toContain('esports');
    expect(card).toContain('9/10');
    expect(card).toContain('方向1');
  });

  it('should omit enrichment sections when no data available', () => {
    const emptyItem: QueueItem = {
      ...sampleQueueItem,
      image_prompts: undefined,
      content: {
        xhs: { title: '', body: '', tags: [], cover_images: [] },
        douyin: { script: '', bgm_suggestion: '', key_captions: [], cover_images: [] },
      },
    };
    const enrichment: BriefEnrichment = {
      personaReport: null,
      fullQueueItems: [emptyItem],
    };
    const card = formatBriefCard('2026-04-02', [], [], [emptyItem], enrichment);
    expect(card).not.toContain('🎨 今日生图 Prompt');
    expect(card).not.toContain('🎬 今日视频分镜');
    expect(card).not.toContain('💡人设建议');
  });

  it('should fall back to queueItems when fullQueueItems not provided', () => {
    const enrichment: BriefEnrichment = {
      personaReport: samplePersonaReport,
    };
    const card = formatBriefCard('2026-04-02', sampleTrends, [], [sampleQueueItem], enrichment);
    // Should still extract from pending items in queueItems
    expect(card).toContain('🎨 今日生图 Prompt');
    expect(card).toContain('🎬 今日视频分镜');
  });

  it('should include competitor analysis insights when provided', () => {
    const enrichment: BriefEnrichment = {
      fullQueueItems: [sampleQueueItem],
      competitorAnalysis: {
        version: 1 as const,
        analyses: {
          '天云:douyin': {
            account_name: '天云', platform: 'douyin', analyzed_at: '2026-04-02', post_count: 20,
            hook_patterns: [], cover_formulas: [], topic_clusters: [],
            engagement_pattern: { best_performing_type: '赛事复盘', avg_engagement: 12000, posting_frequency: '日更' },
            key_insight: '专业赛事复盘是流量主力',
          },
        },
        insufficient_data: [],
        last_analyzed: '2026-04-02',
      },
    };
    const competitors = [
      { account: '天云', platform: 'douyin' as const, latest_post: { time: '', content_type: '视频', topic: 'BP复盘', engagement: 12000, summary: '' }, days_since_last_post: 0, fetched_at: '' },
    ];
    const card = formatBriefCard('2026-04-02', sampleTrends, competitors, [sampleQueueItem], enrichment);
    expect(card).toContain('核心洞察');
    expect(card).toContain('专业赛事复盘是流量主力');
  });
});
