/**
 * ops-competitor-analysis.test.ts
 * Integration tests for the ops-competitor-analysis cron entry point.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  PersonaConfig,
  CompetitorPostsStore,
  CompetitorAnalysisStore,
  PositioningReport,
  QueueItem,
} from '../scripts/utils/types';

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock('../scripts/utils/llm-client', () => ({
  createRealLLMClient: vi.fn(() => ({
    call: vi.fn(),
    callJSON: vi.fn(),
  })),
}));

vi.mock('../scripts/persona/persona-loader', () => ({
  loadPersona: vi.fn(),
}));

vi.mock('../scripts/utils/time-utils', () => ({
  wallNow: vi.fn(() => new Date('2026-04-06T10:00:00Z')), // Monday
  getLocalWeekday: vi.fn(() => 1), // Monday = 1
  now: vi.fn(() => new Date('2026-04-06T10:00:00Z')),
}));

vi.mock('../scripts/utils/file-utils', () => ({
  PATHS: {},
  readJSON: vi.fn(),
  writeJSON: vi.fn(),
}));

vi.mock('../scripts/ops/competitor-tracker', () => ({
  resolveCompetitorAccounts: vi.fn(() => ({ xhs: ['@testuser'], xhsUserIds: new Map(), douyin: ['testdouyin'] })),
}));

vi.mock('../scripts/ops/competitor-fetcher', () => ({
  fetchCompetitorPosts: vi.fn(async () => ({ success: ['@testuser:xhs'], failed: [] })),
  loadCompetitorPosts: vi.fn(() => ({
    version: 1,
    last_fetched: '2026-04-06T10:00:00Z',
    accounts: {
      '@testuser:xhs': [
        {
          post_id: 'p1',
          account_name: '@testuser',
          platform: 'xhs',
          title: '测试帖子',
          engagement: 1000,
          fetched_at: '2026-04-06T10:00:00Z',
        },
      ],
    },
  } as CompetitorPostsStore)),
}));

vi.mock('../scripts/ops/competitor-analyzer', () => ({
  analyzeCompetitors: vi.fn(async () => ({
    version: 1,
    analyses: {
      '@testuser:xhs': {
        account_name: '@testuser',
        platform: 'xhs',
        analyzed_at: '2026-04-06T10:00:00Z',
        post_count: 10,
        hook_patterns: [{ pattern: '悬念式', examples: [], frequency: '高' }],
        cover_formulas: [],
        topic_clusters: [
          { cluster_name: '电竞', post_count: 7, avg_engagement: 800, sample_titles: [] },
        ],
        engagement_pattern: {
          avg_engagement: 800,
          best_performing_type: '图文',
          best_posting_time: '20:00',
        },
        key_insight: '测试洞察',
      },
    },
    insufficient_data: [],
    last_analyzed: '2026-04-06T10:00:00Z',
  } as CompetitorAnalysisStore)),
  saveCompetitorAnalysis: vi.fn(),
}));

vi.mock('../scripts/ops/positioning-analyzer', () => ({
  analyzePositioning: vi.fn(async (): Promise<PositioningReport> => ({
    generated_at: '2026-04-06T10:00:00Z',
    report_period: '2026-03-30 ~ 2026-04-05',
    competitor_matrix: [
      {
        account_name: '@testuser',
        platform: 'xhs',
        strengths: ['内容稳定'],
        weaknesses: ['缺乏互动'],
        content_focus: '电竞解说',
        avg_engagement: 800,
      },
    ],
    gap_analysis: {
      underserved_niches: ['女性向电竞'],
      oversaturated_areas: ['赛车'],
      miss_v_advantages: ['三重身份差异化'],
    },
    recommendations: [
      {
        recommendation: '深耕女性电竞内容',
        identity_mode: 'esports',
        priority: 'high',
        rationale: '竞品缺口明显',
      },
    ],
    weekly_direction: {
      focus_identities: ['esports'],
      avoid_topics: ['赛车重复内容'],
      suggested_templates: ['电竞解说模板'],
    },
  })),
  savePositioningReport: vi.fn(),
}));

vi.mock('../scripts/ops/brief-generator', () => ({
  sendToWechatWork: vi.fn(() => true),
}));

vi.mock('../scripts/ops/review-queue', () => ({
  loadQueue: vi.fn(async () => ({
    items: [
      {
        id: 'q1',
        status: 'published',
        topic: '已发布选题',
        trend_hook: '热度钩子',
        identity_mode: 'esports',
        created_at: '2026-04-01T08:00:00Z',
        updated_at: '2026-04-01T08:00:00Z',
        content: {
          xhs: { title: '标题', body: '正文', tags: [], cover_images: [] },
          douyin: { script: '脚本', bgm_suggestion: '', key_captions: [], cover_images: [] },
        },
        edit_history: [],
      } as QueueItem,
    ],
    last_updated: '2026-04-06T10:00:00Z',
  })),
}));

// ─── Lazy imports (after mocks are set up) ────────────────────────────────────

const { runCompetitorAnalysisPipeline, formatWeeklyReportCard } = await import(
  '../scripts/lifecycle/ops-competitor-analysis'
);
const { loadPersona } = await import('../scripts/persona/persona-loader');
const { fetchCompetitorPosts, loadCompetitorPosts } = await import(
  '../scripts/ops/competitor-fetcher'
);
const { analyzeCompetitors, saveCompetitorAnalysis } = await import(
  '../scripts/ops/competitor-analyzer'
);
const { analyzePositioning, savePositioningReport } = await import(
  '../scripts/ops/positioning-analyzer'
);
const { sendToWechatWork } = await import('../scripts/ops/brief-generator');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePersona(opsEnabled: boolean): PersonaConfig {
  return {
    meta: { id: 'miss-v', name: 'Miss V', version: '1.0.0' },
    personality: {
      mbti: 'ENTJ',
      core_traits: ['自信', '进取'],
      communication_style: '直接',
      values: [],
      fears: [],
      humor_style: '幽默',
    },
    voice: { language: 'zh-CN', style: 'casual', formality: 'informal' },
    social: { platforms: [] },
    content: { themes: [], formats: [] },
    ops: opsEnabled
      ? {
          enabled: true,
          competitor_accounts: { xhs: ['@testuser'], douyin: ['testdouyin'] },
          competitors: [],
          content_templates: [],
          trend_score_threshold: 2.0,
          topic_count: 3,
          brief_time: '09:00',
          identities: ['esports', 'singer'],
        }
      : {
          enabled: false,
          competitor_accounts: { xhs: [], douyin: [] },
          competitors: [],
          content_templates: [],
          trend_score_threshold: 2.0,
          topic_count: 3,
          brief_time: '09:00',
          identities: [],
        },
  } as unknown as PersonaConfig;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runCompetitorAnalysisPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exits early when ops.enabled is false', async () => {
    vi.mocked(loadPersona).mockResolvedValueOnce(makePersona(false));

    await runCompetitorAnalysisPipeline();

    expect(fetchCompetitorPosts).not.toHaveBeenCalled();
    expect(analyzeCompetitors).not.toHaveBeenCalled();
    expect(analyzePositioning).not.toHaveBeenCalled();
  });

  it('runs Layer 1 + 2 (fetch + analyze) on any day', async () => {
    vi.mocked(loadPersona).mockResolvedValueOnce(makePersona(true));
    // Override to non-Monday
    const { getLocalWeekday } = await import('../scripts/utils/time-utils');
    vi.mocked(getLocalWeekday).mockReturnValueOnce(3); // Wednesday

    await runCompetitorAnalysisPipeline(false); // explicitly not Monday

    expect(fetchCompetitorPosts).toHaveBeenCalledOnce();
    expect(loadCompetitorPosts).toHaveBeenCalledOnce();
    expect(analyzeCompetitors).toHaveBeenCalledOnce();
    expect(saveCompetitorAnalysis).toHaveBeenCalledOnce();

    // Layer 3 skipped
    expect(analyzePositioning).not.toHaveBeenCalled();
    expect(savePositioningReport).not.toHaveBeenCalled();
  });

  it('also runs Layer 3 (positioning) when isMondayOverride is true', async () => {
    vi.mocked(loadPersona).mockResolvedValueOnce(makePersona(true));

    await runCompetitorAnalysisPipeline(true); // force Monday

    expect(fetchCompetitorPosts).toHaveBeenCalledOnce();
    expect(analyzeCompetitors).toHaveBeenCalledOnce();
    expect(saveCompetitorAnalysis).toHaveBeenCalledOnce();
    expect(analyzePositioning).toHaveBeenCalledOnce();
    expect(savePositioningReport).toHaveBeenCalledOnce();
    expect(sendToWechatWork).toHaveBeenCalledOnce();
  });

  it('skips Layer 3 when no accounts were analyzed', async () => {
    vi.mocked(loadPersona).mockResolvedValueOnce(makePersona(true));
    // Return empty analyses
    const { analyzeCompetitors: ac } = await import('../scripts/ops/competitor-analyzer');
    vi.mocked(ac).mockResolvedValueOnce({
      version: 1,
      analyses: {},
      insufficient_data: [],
      last_analyzed: '2026-04-06T10:00:00Z',
    });

    await runCompetitorAnalysisPipeline(true); // Monday, but no data

    expect(analyzePositioning).not.toHaveBeenCalled();
    expect(savePositioningReport).not.toHaveBeenCalled();
  });

  it('handles analyzePositioning returning null gracefully', async () => {
    vi.mocked(loadPersona).mockResolvedValueOnce(makePersona(true));
    vi.mocked(analyzePositioning).mockResolvedValueOnce(null);

    await expect(runCompetitorAnalysisPipeline(true)).resolves.not.toThrow();

    expect(savePositioningReport).not.toHaveBeenCalled();
    expect(sendToWechatWork).not.toHaveBeenCalled();
  });
});

// ─── formatWeeklyReportCard ───────────────────────────────────────────────────

describe('formatWeeklyReportCard', () => {
  const sampleReport: PositioningReport = {
    generated_at: '2026-04-06T10:00:00Z',
    report_period: '2026-03-30 ~ 2026-04-05',
    competitor_matrix: [
      {
        account_name: '@testuser',
        platform: 'xhs',
        strengths: ['内容稳定', '粉丝黏性高'],
        weaknesses: ['缺乏互动'],
        content_focus: '电竞解说',
        avg_engagement: 800,
      },
    ],
    gap_analysis: {
      underserved_niches: ['女性向电竞'],
      oversaturated_areas: ['赛车内容'],
      miss_v_advantages: ['三重身份差异化'],
    },
    recommendations: [
      {
        recommendation: '深耕女性电竞内容',
        identity_mode: 'esports',
        priority: 'high',
        rationale: '竞品缺口明显',
      },
      {
        recommendation: '打造音乐电竞跨界',
        identity_mode: 'singer',
        priority: 'medium',
        rationale: '独特差异化路线',
      },
    ],
    weekly_direction: {
      focus_identities: ['esports', 'singer'],
      avoid_topics: ['赛车重复内容'],
      suggested_templates: ['电竞解说模板', '音乐日常'],
    },
  };

  it('includes the report period in the header', () => {
    const card = formatWeeklyReportCard(sampleReport);
    expect(card).toContain('📊 周度竞品定位分析');
    expect(card).toContain('2026-03-30 ~ 2026-04-05');
  });

  it('includes competitor matrix entries', () => {
    const card = formatWeeklyReportCard(sampleReport);
    expect(card).toContain('@testuser');
    expect(card).toContain('xhs');
    expect(card).toContain('800');
    expect(card).toContain('电竞解说');
  });

  it('includes gap analysis sections', () => {
    const card = formatWeeklyReportCard(sampleReport);
    expect(card).toContain('🟢');
    expect(card).toContain('女性向电竞');
    expect(card).toContain('🔴');
    expect(card).toContain('赛车内容');
    expect(card).toContain('⭐');
    expect(card).toContain('三重身份差异化');
  });

  it('includes recommendations with priority markers', () => {
    const card = formatWeeklyReportCard(sampleReport);
    expect(card).toContain('🔥');
    expect(card).toContain('深耕女性电竞内容');
    expect(card).toContain('💡');
    expect(card).toContain('打造音乐电竞跨界');
    expect(card).toContain('竞品缺口明显');
  });

  it('includes weekly direction section', () => {
    const card = formatWeeklyReportCard(sampleReport);
    expect(card).toContain('━━ 本周方向 ━━');
    expect(card).toContain('esports');
    expect(card).toContain('singer');
    expect(card).toContain('赛车重复内容');
    expect(card).toContain('电竞解说模板');
  });
});
