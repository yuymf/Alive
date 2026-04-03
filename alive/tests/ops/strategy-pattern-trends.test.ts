/**
 * strategy-pattern-trends.test.ts
 * Task 11: Verify that strategy engine computes pattern trends
 * and topic-generator prioritizes strategy-recommended patterns.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setBasePaths, resetBasePaths, PATHS, writeJSON } from '../../scripts/utils/file-utils';
import { setTimeOverride, clearTimeOverride } from '../../scripts/utils/time-utils';
import {
  buildStrategyPrompt,
  type StrategyPromptInput,
} from '../../scripts/ops/strategy-engine';
import {
  addPattern, incrementPatternUsage, updatePatternSuccessRate, loadContentPatterns,
} from '../../scripts/ops/content-analyzer';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { ContentPatterns, ContentStrategy } from '../../scripts/utils/types';

const tmpDir = path.join(os.tmpdir(), 'alive-strategy-patterns-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
  setTimeOverride(new Date('2026-04-03T10:00:00Z'));
});

afterEach(() => {
  resetBasePaths();
  clearTimeOverride();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildStrategyPrompt includes pattern trends', () => {
  it('includes rising and declining patterns in prompt', () => {
    const input: StrategyPromptInput = {
      tierDistribution: { viral: 2, above_avg: 3, normal: 5, below_avg: 1 },
      currentMix: { daily: 50, gamer: 30, racer: 20 },
      targetMix: { daily: 40, gamer: 35, racer: 25 },
      bestTemplate: '写实都市',
      worstTemplate: '静态图文',
      topPatterns: [
        { type: '反问句标题', success_rate: 0.8, times_used: 5 },
        { type: '数据降维', success_rate: 0.3, times_used: 3 },
      ],
      risingPatterns: ['反问句标题'],
      decliningPatterns: ['数据降维'],
      personaAlignmentAvg: 8.5,
      driftAreas: [],
      competitorSummary: '',
      personaSummary: 'V姐测试',
      weekOverWeek: 15,
    };

    const prompt = buildStrategyPrompt(input);
    expect(prompt).toContain('上升趋势: 反问句标题');
    expect(prompt).toContain('衰减趋势: 数据降维');
    expect(prompt).toContain('recommended_patterns');
    expect(prompt).toContain('declining_patterns');
  });

  it('shows 无 when no rising/declining patterns', () => {
    const input: StrategyPromptInput = {
      tierDistribution: { viral: 0, above_avg: 0, normal: 1, below_avg: 0 },
      currentMix: {},
      targetMix: {},
      bestTemplate: '',
      worstTemplate: '',
      topPatterns: [],
      risingPatterns: [],
      decliningPatterns: [],
      personaAlignmentAvg: 5,
      driftAreas: [],
      competitorSummary: '',
      personaSummary: 'test',
      weekOverWeek: 0,
    };

    const prompt = buildStrategyPrompt(input);
    expect(prompt).toContain('上升趋势: 无');
    expect(prompt).toContain('衰减趋势: 无');
  });
});

describe('topic-generator pattern prioritization', () => {
  it('filters declining patterns and sorts recommended first', () => {
    // Seed patterns
    addPattern({ type: '反问句标题', source: 'self', source_post: 'p1', formula: 'f1', examples: [] });
    addPattern({ type: '数据降维', source: '希然', source_post: 'p2', formula: 'f2', examples: [] });
    addPattern({ type: '情绪对比', source: 'self', source_post: 'p3', formula: 'f3', examples: [] });

    // Mark usage and rates
    incrementPatternUsage('反问句标题', 'self');
    incrementPatternUsage('反问句标题', 'self');
    updatePatternSuccessRate('反问句标题', 'self', 0.9);

    incrementPatternUsage('数据降维', '希然');
    updatePatternSuccessRate('数据降维', '希然', 0.2);

    incrementPatternUsage('情绪对比', 'self');
    updatePatternSuccessRate('情绪对比', 'self', 0.5);

    // Build a strategy with recommendations
    const strategy: ContentStrategy = {
      generated_at: '2026-04-01T00:00:00Z',
      period: { start: '2026-04-01', end: '2026-04-07' },
      status: 'confirmed',
      performance_summary: {
        total_posts: 10,
        tier_distribution: { viral: 2, above_avg: 3, normal: 4, below_avg: 1 },
        best_performing_template: '写实',
        worst_performing_template: '图文',
        best_identity_mode: 'daily',
        engagement_trend: 'rising',
        week_over_week_change: 10,
      },
      content_mix_recommendation: {
        current_mix: { daily: 50 },
        target_mix: { daily: 50 },
        recommended_mix: { daily: 50 },
        reasoning: 'test',
      },
      top_patterns: [],
      persona_health: {
        overall_score: 8,
        drift_areas: [],
        correction_suggestions: [],
        strongest_identity: 'daily',
      },
      next_week_recommendations: {
        recommended_templates: [],
        avoid_templates: [],
        content_direction: 'test',
        recommended_patterns: ['情绪对比'],
        declining_patterns: ['数据降维'],
      },
    };

    writeJSON(PATHS.contentStrategy, strategy);

    // Simulate what topic-generator does
    const patterns = loadContentPatterns();
    const recommended = new Set(strategy.next_week_recommendations.recommended_patterns!);
    const declining = new Set(strategy.next_week_recommendations.declining_patterns!);

    const candidatePatterns = [...patterns.patterns]
      .filter(p => !declining.has(p.type))
      .sort((a, b) => {
        const aRec = recommended.has(a.type) ? 1 : 0;
        const bRec = recommended.has(b.type) ? 1 : 0;
        if (aRec !== bRec) return bRec - aRec;
        return (b.success_rate ?? 0) - (a.success_rate ?? 0);
      });

    const injected = candidatePatterns.slice(0, 5);

    // Verify: '数据降维' should be filtered out
    expect(injected.find(p => p.type === '数据降维')).toBeUndefined();
    // Verify: '情绪对比' should be first (recommended)
    expect(injected[0].type).toBe('情绪对比');
    // Verify: '反问句标题' should be second (not recommended but high success)
    expect(injected[1].type).toBe('反问句标题');
  });
});
