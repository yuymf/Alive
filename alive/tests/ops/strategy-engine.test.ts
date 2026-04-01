import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { setBasePaths, resetBasePaths, writeJSON, PATHS } from '../../scripts/utils/file-utils';
import { setTimeOverride } from '../../scripts/utils/time-utils';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ContentAnalysis, ContentStrategy, PerformanceTier } from '../../scripts/utils/types';

const tmpDir = path.join(os.tmpdir(), 'alive-strategy-test-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
  setTimeOverride(new Date('2026-04-07T08:00:00Z')); // Monday morning
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeAnalysis(overrides: Partial<ContentAnalysis>): ContentAnalysis {
  return {
    item_id: 'q_test',
    analyzed_at: '2026-04-05T12:00:00Z',
    performance_tier: 'normal',
    engagement_score: 50,
    platform: 'xhs',
    identity_mode: 'esports',
    template_type: '赛场高燃瞬间',
    pattern_analysis: {
      hook_effectiveness: 5, emotional_resonance: 5, trending_alignment: 5,
      visual_impact: 5, call_to_action: 5,
      key_success_factors: [], improvement_areas: [],
    },
    persona_alignment: {
      score: 7, identity_mode_match: true,
      tone_consistency: 'on_brand', specific_notes: '',
    },
    ...overrides,
  };
}

describe('computeTierDistribution', () => {
  it('should count entries per tier', async () => {
    const { computeTierDistribution } = await import('../../scripts/ops/strategy-engine');
    const entries: ContentAnalysis[] = [
      makeAnalysis({ performance_tier: 'viral' }),
      makeAnalysis({ performance_tier: 'above_avg' }),
      makeAnalysis({ performance_tier: 'normal' }),
      makeAnalysis({ performance_tier: 'normal' }),
      makeAnalysis({ performance_tier: 'below_avg' }),
    ];
    const dist = computeTierDistribution(entries);
    expect(dist).toEqual({ viral: 1, above_avg: 1, normal: 2, below_avg: 1 });
  });
});

describe('computeContentMix', () => {
  it('should compute percentage by identity_mode', async () => {
    const { computeContentMix } = await import('../../scripts/ops/strategy-engine');
    const entries: ContentAnalysis[] = [
      makeAnalysis({ identity_mode: 'esports' }),
      makeAnalysis({ identity_mode: 'esports' }),
      makeAnalysis({ identity_mode: 'singer' }),
      makeAnalysis({ identity_mode: 'daily' }),
    ];
    const mix = computeContentMix(entries);
    expect(mix.esports).toBe(50);
    expect(mix.singer).toBe(25);
    expect(mix.daily).toBe(25);
  });
});

describe('findBestWorstTemplate', () => {
  it('should find best and worst performing templates by avg score', async () => {
    const { findBestWorstTemplate } = await import('../../scripts/ops/strategy-engine');
    const entries: ContentAnalysis[] = [
      makeAnalysis({ template_type: 'A', engagement_score: 90 }),
      makeAnalysis({ template_type: 'A', engagement_score: 80 }),
      makeAnalysis({ template_type: 'B', engagement_score: 30 }),
      makeAnalysis({ template_type: 'B', engagement_score: 20 }),
    ];
    const { best, worst } = findBestWorstTemplate(entries);
    expect(best).toBe('A');
    expect(worst).toBe('B');
  });
});

describe('buildStrategyPrompt', () => {
  it('should include aggregated data and persona context', async () => {
    const { buildStrategyPrompt } = await import('../../scripts/ops/strategy-engine');
    const prompt = buildStrategyPrompt({
      tierDistribution: { viral: 1, above_avg: 2, normal: 3, below_avg: 1 },
      currentMix: { esports: 50, singer: 25, daily: 25 },
      targetMix: { esports: 40, singer: 25, racer: 20, daily: 15 },
      bestTemplate: '赛场高燃瞬间',
      worstTemplate: '房间tour',
      topPatterns: [{ type: '反转式开头', success_rate: 0.8, times_used: 5 }],
      personaAlignmentAvg: 8.5,
      driftAreas: ['racer身份偏少'],
      competitorSummary: '天云发布频率提升',
      personaSummary: 'V姐：ENTJ三栖虚拟偶像',
      weekOverWeek: 15,
    });
    expect(prompt).toContain('viral: 1');
    expect(prompt).toContain('赛场高燃瞬间');
    expect(prompt).toContain('反转式开头');
    expect(prompt).toContain('V姐');
    expect(prompt).toContain('content_mix_recommendation');
  });
});

describe('parseStrategyResponse', () => {
  it('should parse LLM response into ContentStrategy', async () => {
    const { parseStrategyResponse } = await import('../../scripts/ops/strategy-engine');
    const response = {
      performance_summary: {
        engagement_trend: 'rising',
        best_identity_mode: 'esports',
      },
      content_mix_recommendation: {
        recommended_mix: { esports: 45, singer: 25, racer: 15, daily: 15 },
        reasoning: '电竞内容表现最好',
      },
      top_patterns: [{
        pattern_type: '反转式开头',
        recommended_frequency: '每周2-3次',
      }],
      persona_health: {
        overall_score: 8,
        drift_areas: ['racer偏少'],
        correction_suggestions: ['增加赛车相关内容'],
        strongest_identity: 'esports',
      },
      next_week_recommendations: {
        recommended_templates: ['赛场高燃瞬间', 'MV片段'],
        avoid_templates: ['房间tour'],
        content_direction: '加强电竞+音乐交叉',
        experiment_suggestion: '尝试赛车+电竞联动',
      },
    };

    const strategy = parseStrategyResponse(response, {
      totalPosts: 7,
      tierDistribution: { viral: 1, above_avg: 2, normal: 3, below_avg: 1 },
      currentMix: { esports: 50, singer: 25, daily: 25 },
      targetMix: { esports: 40, singer: 25, racer: 20, daily: 15 },
      bestTemplate: '赛场高燃瞬间',
      worstTemplate: '房间tour',
      topPatterns: [{ type: '反转式开头', success_rate: 0.8, times_used: 5 }],
      weekOverWeek: 15,
    });

    expect(strategy.status).toBe('pending');
    expect(strategy.performance_summary.total_posts).toBe(7);
    expect(strategy.content_mix_recommendation.recommended_mix.esports).toBe(45);
    expect(strategy.persona_health.overall_score).toBe(8);
    expect(strategy.next_week_recommendations.recommended_templates).toContain('赛场高燃瞬间');
  });
});

describe('loadStrategy / saveStrategy', () => {
  it('should persist and load strategy', async () => {
    const { saveStrategy, loadStrategy } = await import('../../scripts/ops/strategy-engine');

    const strategy: ContentStrategy = {
      generated_at: '2026-04-07T08:00:00Z',
      period: { start: '2026-04-07', end: '2026-04-14' },
      status: 'pending',
      performance_summary: {
        total_posts: 5, tier_distribution: { viral: 1, above_avg: 1, normal: 2, below_avg: 1 },
        best_performing_template: 'A', worst_performing_template: 'B',
        best_identity_mode: 'esports', engagement_trend: 'rising', week_over_week_change: 10,
      },
      content_mix_recommendation: {
        current_mix: { esports: 50 }, target_mix: { esports: 40 },
        recommended_mix: { esports: 45 }, reasoning: 'test',
      },
      top_patterns: [],
      persona_health: {
        overall_score: 8, drift_areas: [], correction_suggestions: [], strongest_identity: 'esports',
      },
      next_week_recommendations: {
        recommended_templates: [], avoid_templates: [], content_direction: 'test',
      },
    };
    saveStrategy(strategy);

    const loaded = loadStrategy();
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe('pending');
  });
});

describe('confirmStrategy', () => {
  it('should set status to confirmed', async () => {
    const { saveStrategy, confirmStrategy, loadStrategy } = await import('../../scripts/ops/strategy-engine');
    saveStrategy({
      generated_at: '2026-04-07T08:00:00Z',
      period: { start: '2026-04-07', end: '2026-04-14' },
      status: 'pending',
      performance_summary: {
        total_posts: 5, tier_distribution: { viral: 1, above_avg: 1, normal: 2, below_avg: 1 },
        best_performing_template: 'A', worst_performing_template: 'B',
        best_identity_mode: 'esports', engagement_trend: 'rising', week_over_week_change: 10,
      },
      content_mix_recommendation: {
        current_mix: {}, target_mix: {}, recommended_mix: {}, reasoning: '',
      },
      top_patterns: [],
      persona_health: { overall_score: 8, drift_areas: [], correction_suggestions: [], strongest_identity: '' },
      next_week_recommendations: { recommended_templates: [], avoid_templates: [], content_direction: '' },
    } as ContentStrategy);

    const result = confirmStrategy();
    expect(result).toBe(true);

    const loaded = loadStrategy();
    expect(loaded!.status).toBe('confirmed');
  });

  it('should return false when no pending strategy', async () => {
    const { confirmStrategy } = await import('../../scripts/ops/strategy-engine');
    expect(confirmStrategy()).toBe(false);
  });
});

describe('computeStrategy', () => {
  it('should compute strategy from analysis data', async () => {
    // Set up analysis log
    const analysisLog = {
      entries: [
        makeAnalysis({ item_id: 'a', performance_tier: 'viral' as PerformanceTier, engagement_score: 90, identity_mode: 'esports', template_type: 'A' }),
        makeAnalysis({ item_id: 'b', performance_tier: 'normal' as PerformanceTier, engagement_score: 50, identity_mode: 'singer', template_type: 'B' }),
      ],
      last_updated: '',
    };
    writeJSON(PATHS.analysisLog, analysisLog);
    writeJSON(PATHS.performanceLog, { entries: [], last_updated: '' });
    writeJSON(PATHS.contentPatterns, { updated_at: '', patterns: [], competitor_insights: [], cover_trends: [] });
    writeJSON(PATHS.competitorLog, { entries: [], last_updated: '' });

    const mockLLM = {
      call: vi.fn(),
      callJSON: vi.fn().mockResolvedValue({
        performance_summary: { engagement_trend: 'rising', best_identity_mode: 'esports' },
        content_mix_recommendation: { recommended_mix: { esports: 60, singer: 40 }, reasoning: 'good' },
        top_patterns: [],
        persona_health: { overall_score: 8, drift_areas: [], correction_suggestions: [], strongest_identity: 'esports' },
        next_week_recommendations: {
          recommended_templates: ['A'], avoid_templates: ['B'],
          content_direction: 'more esports', experiment_suggestion: 'try collab',
        },
      }),
    };

    const { computeStrategy, loadStrategy } = await import('../../scripts/ops/strategy-engine');
    const success = await computeStrategy(
      mockLLM as any,
      'V姐：ENTJ',
      { esports: 40, singer: 25, racer: 20, daily: 15 },
    );

    expect(success).toBe(true);
    expect(mockLLM.callJSON).toHaveBeenCalledTimes(1);

    const strategy = loadStrategy();
    expect(strategy).not.toBeNull();
    expect(strategy!.status).toBe('pending');
    expect(strategy!.performance_summary.total_posts).toBe(2);
  });
});
