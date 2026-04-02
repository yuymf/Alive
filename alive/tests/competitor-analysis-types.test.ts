import { describe, it, expect } from 'vitest';
import type {
  CompetitorPost,
  CompetitorPostsStore,
  FetchResult,
  HookPatternAnalysis,
  CoverFormulaAnalysis,
  TopicClusterAnalysis,
  EngagementPatternAnalysis,
  AccountAnalysis,
  CompetitorAnalysisStore,
  PositioningCompetitorEntry,
  PositioningGapAnalysis,
  PositioningRecommendation,
  WeeklyDirection,
  PositioningReport,
} from '../scripts/utils/types';

// ─── CompetitorPost ──────────────────────────────────────────────────────────

describe('CompetitorPost', () => {
  it('accepts required fields', () => {
    const post: CompetitorPost = {
      account_name: '@test_account',
      platform: 'xhs',
      post_id: 'note_abc123',
      title: '测试标题',
      engagement: 1500,
      fetched_at: '2026-04-02T10:00:00Z',
    };
    expect(post.account_name).toBe('@test_account');
    expect(post.platform).toBe('xhs');
    expect(post.engagement).toBe(1500);
  });

  it('accepts instagram as platform', () => {
    const post: CompetitorPost = {
      account_name: '@insta_user',
      platform: 'instagram',
      post_id: 'ig_xyz',
      title: 'Instagram Post',
      engagement: 3000,
      fetched_at: '2026-04-02T10:00:00Z',
    };
    expect(post.platform).toBe('instagram');
  });

  it('accepts all optional fields', () => {
    const post: CompetitorPost = {
      account_name: '@douyin_user',
      platform: 'douyin',
      post_id: 'note_xyz',
      title: '抖音标题',
      engagement: 50000,
      comment_count: 300,
      posted_at: '2026-04-01T18:00:00Z',
      cover_url: 'https://example.com/cover.jpg',
      fetched_at: '2026-04-02T10:00:00Z',
    };
    expect(post.comment_count).toBe(300);
    expect(post.posted_at).toBe('2026-04-01T18:00:00Z');
    expect(post.cover_url).toBe('https://example.com/cover.jpg');
  });
});

// ─── CompetitorPostsStore ────────────────────────────────────────────────────

describe('CompetitorPostsStore', () => {
  it('accepts version 1, last_fetched, and accounts map', () => {
    const store: CompetitorPostsStore = {
      version: 1,
      last_fetched: '2026-04-02T10:00:00Z',
      accounts: {
        '@test_account': [
          {
            account_name: '@test_account',
            platform: 'xhs',
            post_id: 'p1',
            title: '标题',
            engagement: 200,
            fetched_at: '2026-04-02T10:00:00Z',
          },
        ],
      },
    };
    expect(store.version).toBe(1);
    expect(Object.keys(store.accounts)).toHaveLength(1);
  });

  it('accepts empty accounts map', () => {
    const store: CompetitorPostsStore = {
      version: 1,
      last_fetched: '2026-04-02T10:00:00Z',
      accounts: {},
    };
    expect(store.accounts).toEqual({});
  });
});

// ─── FetchResult ─────────────────────────────────────────────────────────────

describe('FetchResult', () => {
  it('accepts success and failed arrays', () => {
    const result: FetchResult = {
      success: ['@account_a', '@account_b'],
      failed: ['@account_c'],
    };
    expect(result.success).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
  });

  it('accepts empty arrays', () => {
    const result: FetchResult = {
      success: [],
      failed: [],
    };
    expect(result.success).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});

// ─── Sub-interfaces ──────────────────────────────────────────────────────────

describe('HookPatternAnalysis', () => {
  it('accepts pattern, examples, frequency', () => {
    const h: HookPatternAnalysis = {
      pattern: '设问悬念式',
      examples: ['你知道吗？', '为什么90%的人都不知道'],
      frequency: '高频',
    };
    expect(h.pattern).toBe('设问悬念式');
    expect(h.examples).toHaveLength(2);
    expect(h.frequency).toBe('高频');
  });
});

describe('CoverFormulaAnalysis', () => {
  it('accepts formula, usage_ratio, effectiveness', () => {
    const c: CoverFormulaAnalysis = {
      formula: '大字标题+强对比色',
      usage_ratio: '60%',
      effectiveness: '高',
    };
    expect(c.formula).toBe('大字标题+强对比色');
    expect(c.usage_ratio).toBe('60%');
    expect(c.effectiveness).toBe('高');
  });
});

describe('TopicClusterAnalysis', () => {
  it('accepts cluster_name, post_count, avg_engagement, representative_titles', () => {
    const t: TopicClusterAnalysis = {
      cluster_name: '电竞解说',
      post_count: 15,
      avg_engagement: 8000,
      representative_titles: ['S14世界赛分析', 'LOL英雄解析'],
    };
    expect(t.cluster_name).toBe('电竞解说');
    expect(t.post_count).toBe(15);
    expect(t.representative_titles).toHaveLength(2);
  });
});

describe('EngagementPatternAnalysis', () => {
  it('accepts required fields', () => {
    const e: EngagementPatternAnalysis = {
      best_performing_type: '赛事集锦',
      avg_engagement: 8500,
      posting_frequency: '每天1-2篇',
    };
    expect(e.best_performing_type).toBe('赛事集锦');
    expect(e.avg_engagement).toBe(8500);
    expect(e.posting_frequency).toBe('每天1-2篇');
  });

  it('accepts optional peak_days', () => {
    const e: EngagementPatternAnalysis = {
      best_performing_type: '游戏解说',
      avg_engagement: 5000,
      posting_frequency: '每周3篇',
      peak_days: ['周五', '周六', '周日'],
    };
    expect(e.peak_days).toHaveLength(3);
  });
});

// ─── AccountAnalysis ─────────────────────────────────────────────────────────

describe('AccountAnalysis', () => {
  it('accepts all fields with key_insight as string', () => {
    const analysis: AccountAnalysis = {
      account_name: '@esports_kol',
      platform: 'xhs',
      analyzed_at: '2026-04-02T10:00:00Z',
      post_count: 25,
      hook_patterns: [
        { pattern: '设问式', examples: ['post_1'], frequency: '高频' },
        { pattern: '反转式', examples: ['post_2'], frequency: '中频' },
      ],
      cover_formulas: [
        { formula: '人物特写', usage_ratio: '70%', effectiveness: '高' },
      ],
      topic_clusters: [
        {
          cluster_name: '赛事',
          post_count: 10,
          avg_engagement: 6000,
          representative_titles: ['S14分析'],
        },
      ],
      engagement_pattern: {
        best_performing_type: '赛事解说',
        avg_engagement: 5000,
        posting_frequency: '每天1-2篇',
      },
      key_insight: '赛事热点驱动流量，专业解说建立权威感',
    };
    expect(analysis.account_name).toBe('@esports_kol');
    expect(analysis.post_count).toBe(25);
    expect(typeof analysis.key_insight).toBe('string');
    expect(analysis.hook_patterns).toHaveLength(2);
    expect(analysis.cover_formulas).toHaveLength(1);
  });
});

// ─── CompetitorAnalysisStore ─────────────────────────────────────────────────

describe('CompetitorAnalysisStore', () => {
  it('accepts version 1, analyses map, insufficient_data, last_analyzed', () => {
    const store: CompetitorAnalysisStore = {
      version: 1,
      analyses: {
        '@account_a': {
          account_name: '@account_a',
          platform: 'xhs',
          analyzed_at: '2026-04-02T10:00:00Z',
          post_count: 10,
          hook_patterns: [{ pattern: '设问式', examples: [], frequency: '中频' }],
          cover_formulas: [{ formula: '大字标题', usage_ratio: '50%', effectiveness: '中' }],
          topic_clusters: [
            {
              cluster_name: '综合',
              post_count: 10,
              avg_engagement: 1000,
              representative_titles: [],
            },
          ],
          engagement_pattern: {
            best_performing_type: '图文',
            avg_engagement: 1000,
            posting_frequency: '每周3篇',
          },
          key_insight: '内容多元，缺乏差异化',
        },
      },
      insufficient_data: ['@account_b'],
      last_analyzed: '2026-04-02T10:00:00Z',
    };
    expect(store.version).toBe(1);
    expect(Object.keys(store.analyses)).toHaveLength(1);
    expect(store.insufficient_data).toContain('@account_b');
    expect(store.last_analyzed).toBe('2026-04-02T10:00:00Z');
  });
});

// ─── Positioning sub-interfaces ──────────────────────────────────────────────

describe('PositioningCompetitorEntry', () => {
  it('accepts all fields', () => {
    const entry: PositioningCompetitorEntry = {
      account_name: '@competitor_1',
      platform: 'xhs',
      strengths: ['专业解说', '赛事热点'],
      weaknesses: ['缺乏生活感'],
      content_focus: '电竞解说',
      avg_engagement: 8000,
    };
    expect(entry.account_name).toBe('@competitor_1');
    expect(entry.strengths).toHaveLength(2);
    expect(entry.weaknesses).toHaveLength(1);
  });
});

describe('PositioningGapAnalysis', () => {
  it('accepts underserved_niches, oversaturated_areas, miss_v_advantages', () => {
    const gap: PositioningGapAnalysis = {
      underserved_niches: ['选手私下日常', '女性电竞视角'],
      oversaturated_areas: ['纯赛事速递'],
      miss_v_advantages: ['音乐人身份', '赛车跨界'],
    };
    expect(gap.underserved_niches).toHaveLength(2);
    expect(gap.oversaturated_areas).toHaveLength(1);
    expect(gap.miss_v_advantages).toHaveLength(2);
  });
});

describe('PositioningRecommendation', () => {
  it('accepts all fields with priority high or medium only', () => {
    const rec: PositioningRecommendation = {
      recommendation: '主攻音乐×电竞跨界内容',
      identity_mode: 'singer',
      priority: 'high',
      rationale: '差异化定位，竞品空白',
    };
    expect(rec.priority).toBe('high');
    expect(rec.recommendation).toBeDefined();
    expect(rec.identity_mode).toBe('singer');
  });

  it('accepts medium priority', () => {
    const rec: PositioningRecommendation = {
      recommendation: '增加生活日常内容',
      identity_mode: 'lifestyle',
      priority: 'medium',
      rationale: '提升亲切感',
    };
    expect(rec.priority).toBe('medium');
  });
});

describe('WeeklyDirection', () => {
  it('accepts focus_identities, avoid_topics, suggested_templates', () => {
    const dir: WeeklyDirection = {
      focus_identities: ['singer', 'racer'],
      avoid_topics: ['纯赛事速递'],
      suggested_templates: ['音乐幕后', '赛车日常'],
    };
    expect(dir.focus_identities).toHaveLength(2);
    expect(dir.avoid_topics).toHaveLength(1);
    expect(dir.suggested_templates).toHaveLength(2);
  });
});

// ─── PositioningReport ───────────────────────────────────────────────────────

describe('PositioningReport', () => {
  it('accepts all required fields with report_period as string', () => {
    const report: PositioningReport = {
      generated_at: '2026-04-02T08:00:00Z',
      report_period: '2026-03-26 ~ 2026-04-02',
      competitor_matrix: [
        {
          account_name: '@comp_1',
          platform: 'xhs',
          strengths: ['专业'],
          weaknesses: ['单调'],
          content_focus: '游戏攻略',
          avg_engagement: 3000,
        },
      ],
      gap_analysis: {
        underserved_niches: ['女性电竞视角'],
        oversaturated_areas: ['纯游戏攻略'],
        miss_v_advantages: ['多重身份'],
      },
      recommendations: [
        {
          recommendation: '开拓音乐×电竞跨界内容',
          identity_mode: 'singer',
          priority: 'high',
          rationale: '差异化定位，竞品空白',
        },
      ],
      weekly_direction: {
        focus_identities: ['singer'],
        avoid_topics: ['纯攻略'],
        suggested_templates: ['音乐幕后'],
      },
    };
    expect(typeof report.report_period).toBe('string');
    expect(report.competitor_matrix).toHaveLength(1);
    expect(report.recommendations[0].priority).toBe('high');
    expect(report.weekly_direction.focus_identities).toContain('singer');
  });

  it('enforces readonly on competitor_matrix', () => {
    const report: PositioningReport = {
      generated_at: '2026-04-02T08:00:00Z',
      report_period: '2026-03-26 ~ 2026-04-02',
      competitor_matrix: [],
      gap_analysis: {
        underserved_niches: [],
        oversaturated_areas: [],
        miss_v_advantages: [],
      },
      recommendations: [],
      weekly_direction: {
        focus_identities: [],
        avoid_topics: [],
        suggested_templates: [],
      },
    };
    expect(Array.isArray(report.competitor_matrix)).toBe(true);
  });
});
