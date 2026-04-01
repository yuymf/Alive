/**
 * strategy-engine.ts
 * Weekly strategy computation — aggregates analysis data, computes content mix
 * recommendations, ranks patterns, and produces actionable strategy.
 */

import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now } from '../utils/time-utils';
import { LLMClient } from '../utils/llm-client';
import {
  ContentAnalysis, AnalysisLog, ContentStrategy, PerformanceTier,
  PerformanceLog, ContentPatterns, CompetitorLog,
  PersonaConfig, OpsConfig,
} from '../utils/types';
import { buildCompetitorSummary } from './competitor-tracker';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_ANALYSIS_LOG: AnalysisLog = { entries: [], last_updated: '' };
const DEFAULT_CONTENT_PATTERNS: ContentPatterns = {
  updated_at: '', patterns: [], competitor_insights: [], cover_trends: [],
};
const DEFAULT_COMPETITOR_LOG: CompetitorLog = { entries: [], last_updated: '' };

// ─── Aggregation Functions ────────────────────────────────────────────────────

export function computeTierDistribution(
  entries: ContentAnalysis[],
): Record<PerformanceTier, number> {
  const dist: Record<PerformanceTier, number> = { viral: 0, above_avg: 0, normal: 0, below_avg: 0 };
  for (const e of entries) {
    dist[e.performance_tier] = (dist[e.performance_tier] ?? 0) + 1;
  }
  return dist;
}

export function computeContentMix(entries: ContentAnalysis[]): Record<string, number> {
  if (entries.length === 0) return {};
  const counts: Record<string, number> = {};
  for (const e of entries) {
    counts[e.identity_mode] = (counts[e.identity_mode] ?? 0) + 1;
  }
  const mix: Record<string, number> = {};
  for (const [mode, count] of Object.entries(counts)) {
    mix[mode] = Math.round((count / entries.length) * 100);
  }
  return mix;
}

export function findBestWorstTemplate(
  entries: ContentAnalysis[],
): { best: string; worst: string } {
  const byTemplate: Record<string, number[]> = {};
  for (const e of entries) {
    const arr = byTemplate[e.template_type] ?? [];
    arr.push(e.engagement_score);
    byTemplate[e.template_type] = arr;
  }

  let best = '';
  let worst = '';
  let bestAvg = -Infinity;
  let worstAvg = Infinity;

  for (const [template, scores] of Object.entries(byTemplate)) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (avg > bestAvg) { bestAvg = avg; best = template; }
    if (avg < worstAvg) { worstAvg = avg; worst = template; }
  }

  return { best, worst };
}

// ─── Strategy Prompt ──────────────────────────────────────────────────────────

export interface StrategyPromptInput {
  tierDistribution: Record<PerformanceTier, number>;
  currentMix: Record<string, number>;
  targetMix: Record<string, number>;
  bestTemplate: string;
  worstTemplate: string;
  topPatterns: { type: string; success_rate: number | null; times_used: number }[];
  personaAlignmentAvg: number;
  driftAreas: string[];
  competitorSummary: string;
  personaSummary: string;
  weekOverWeek: number;
}

export function buildStrategyPrompt(input: StrategyPromptInput): string {
  const {
    tierDistribution: td, currentMix, targetMix, bestTemplate, worstTemplate,
    topPatterns, personaAlignmentAvg, driftAreas, competitorSummary,
    personaSummary, weekOverWeek,
  } = input;

  const tierStr = Object.entries(td).map(([k, v]) => `${k}: ${v}`).join(', ');
  const currentMixStr = Object.entries(currentMix).map(([k, v]) => `${k}: ${v}%`).join(', ');
  const targetMixStr = Object.entries(targetMix).map(([k, v]) => `${k}: ${v}%`).join(', ');
  const patternStr = topPatterns.length > 0
    ? topPatterns.map(p =>
        `- ${p.type}（成功率${p.success_rate !== null ? (p.success_rate * 100).toFixed(0) + '%' : '未知'}，使用${p.times_used}次）`,
      ).join('\n')
    : '暂无模式数据';
  const driftStr = driftAreas.length > 0 ? driftAreas.join('、') : '无明显偏移';
  const totalPosts = Object.values(td).reduce((a, b) => a + b, 0);

  return `你是虚拟偶像的内容策略顾问。请根据上周表现数据，给出下周内容策略建议。

【人设】${personaSummary}

【上周表现】
- 总发布数: ${totalPosts}
- 效果分布: ${tierStr}
- 环比变化: ${weekOverWeek > 0 ? '+' : ''}${weekOverWeek}%
- 最佳模板: ${bestTemplate}
- 最差模板: ${worstTemplate}

【当前内容配比】${currentMixStr}
【目标配比】${targetMixStr}

【高效模式排名】
${patternStr}

【人设一致性】
- 平均分: ${personaAlignmentAvg.toFixed(1)}/10
- 偏移: ${driftStr}

【竞品动态】
${competitorSummary || '无竞品数据'}

请返回 JSON:
\`\`\`json
{
  "performance_summary": {
    "engagement_trend": "rising|stable|declining",
    "best_identity_mode": "最强身份"
  },
  "content_mix_recommendation": {
    "recommended_mix": {"identity": 百分比},
    "reasoning": "建议理由"
  },
  "top_patterns": [
    {"pattern_type": "模式名", "recommended_frequency": "每周N次"}
  ],
  "persona_health": {
    "overall_score": 0-10,
    "drift_areas": ["偏移1"],
    "correction_suggestions": ["建议1"],
    "strongest_identity": "最强身份"
  },
  "next_week_recommendations": {
    "recommended_templates": ["模板1"],
    "avoid_templates": ["模板2"],
    "content_direction": "总体方向",
    "experiment_suggestion": "实验建议"
  }
}
\`\`\``;
}

// ─── Strategy Response Parsing ────────────────────────────────────────────────

export interface StrategyContext {
  totalPosts: number;
  tierDistribution: Record<PerformanceTier, number>;
  currentMix: Record<string, number>;
  targetMix: Record<string, number>;
  bestTemplate: string;
  worstTemplate: string;
  topPatterns: { type: string; success_rate: number | null; times_used: number }[];
  weekOverWeek: number;
}

export function parseStrategyResponse(
  response: Record<string, unknown>,
  ctx: StrategyContext,
): ContentStrategy {
  const perfSummary = response.performance_summary as Record<string, unknown> | undefined;
  const mixRec = response.content_mix_recommendation as Record<string, unknown> | undefined;
  const patterns = response.top_patterns as Record<string, unknown>[] | undefined;
  const health = response.persona_health as Record<string, unknown> | undefined;
  const recs = response.next_week_recommendations as Record<string, unknown> | undefined;

  const today = now();
  const weekEnd = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

  return {
    generated_at: today.toISOString(),
    period: {
      start: today.toISOString().slice(0, 10),
      end: weekEnd.toISOString().slice(0, 10),
    },
    status: 'pending',
    performance_summary: {
      total_posts: ctx.totalPosts,
      tier_distribution: ctx.tierDistribution,
      best_performing_template: ctx.bestTemplate,
      worst_performing_template: ctx.worstTemplate,
      best_identity_mode: (perfSummary?.best_identity_mode as string) ?? '',
      engagement_trend: (perfSummary?.engagement_trend as 'rising' | 'stable' | 'declining') ?? 'stable',
      week_over_week_change: ctx.weekOverWeek,
    },
    content_mix_recommendation: {
      current_mix: ctx.currentMix,
      target_mix: ctx.targetMix,
      recommended_mix: (mixRec?.recommended_mix as Record<string, number>) ?? ctx.currentMix,
      reasoning: (mixRec?.reasoning as string) ?? '',
    },
    top_patterns: (patterns ?? ctx.topPatterns).map(p => {
      const raw = p as Record<string, unknown>;
      return {
        pattern_type: (raw.pattern_type as string) ?? (raw.type as string) ?? '',
        success_rate: (raw.success_rate as number) ?? 0,
        usage_count: (raw.times_used as number) ?? (raw.usage_count as number) ?? 0,
        recommended_frequency: (raw.recommended_frequency as string) ?? '',
      };
    }),
    persona_health: {
      overall_score: (health?.overall_score as number) ?? 5,
      drift_areas: (health?.drift_areas as string[]) ?? [],
      correction_suggestions: (health?.correction_suggestions as string[]) ?? [],
      strongest_identity: (health?.strongest_identity as string) ?? '',
    },
    next_week_recommendations: {
      recommended_templates: (recs?.recommended_templates as string[]) ?? [],
      avoid_templates: (recs?.avoid_templates as string[]) ?? [],
      content_direction: (recs?.content_direction as string) ?? '',
      experiment_suggestion: (recs?.experiment_suggestion as string) ?? undefined,
    },
  };
}

// ─── Strategy I/O ─────────────────────────────────────────────────────────────

export function loadStrategy(): ContentStrategy | null {
  const data = readJSON<ContentStrategy | null>(PATHS.contentStrategy, null);
  return data;
}

export function saveStrategy(strategy: ContentStrategy): void {
  writeJSON(PATHS.contentStrategy, strategy);
}

export function confirmStrategy(): boolean {
  const current = loadStrategy();
  if (!current || current.status !== 'pending') return false;
  saveStrategy({ ...current, status: 'confirmed' });
  return true;
}

// ─── Week-over-Week Calculation ───────────────────────────────────────────────

function computeWeekOverWeek(entries: ContentAnalysis[]): number {
  const currentTime = now();
  const oneWeekAgo = new Date(currentTime.getTime() - 7 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(currentTime.getTime() - 14 * 24 * 60 * 60 * 1000);

  const thisWeek = entries.filter(e => new Date(e.analyzed_at) >= oneWeekAgo);
  const lastWeek = entries.filter(e => {
    const d = new Date(e.analyzed_at);
    return d >= twoWeeksAgo && d < oneWeekAgo;
  });

  if (lastWeek.length === 0) return 0;

  const thisAvg = thisWeek.length > 0
    ? thisWeek.reduce((s, e) => s + e.engagement_score, 0) / thisWeek.length
    : 0;
  const lastAvg = lastWeek.reduce((s, e) => s + e.engagement_score, 0) / lastWeek.length;

  return Math.round(((thisAvg - lastAvg) / lastAvg) * 100);
}

// ─── Main Orchestration ───────────────────────────────────────────────────────

export async function computeStrategy(
  llm: LLMClient,
  personaSummary: string,
  targetMix: Record<string, number>,
): Promise<boolean> {
  const analysisLog = readJSON<AnalysisLog>(PATHS.analysisLog, DEFAULT_ANALYSIS_LOG);
  const patterns = readJSON<ContentPatterns>(PATHS.contentPatterns, DEFAULT_CONTENT_PATTERNS);
  const competitorLog = readJSON<CompetitorLog>(PATHS.competitorLog, DEFAULT_COMPETITOR_LOG);

  // Filter to last 7 days of analysis
  const oneWeekAgo = new Date(now().getTime() - 7 * 24 * 60 * 60 * 1000);
  const recentAnalysis = analysisLog.entries.filter(
    e => new Date(e.analyzed_at) >= oneWeekAgo,
  );

  if (recentAnalysis.length === 0) {
    console.log('[strategy-engine] No analysis data from last 7 days, skipping');
    return false;
  }

  const tierDistribution = computeTierDistribution(recentAnalysis);
  const currentMix = computeContentMix(recentAnalysis);
  const { best, worst } = findBestWorstTemplate(recentAnalysis);
  const weekOverWeek = computeWeekOverWeek(analysisLog.entries);

  const alignmentScores = recentAnalysis.map(e => e.persona_alignment.score);
  const alignmentAvg = alignmentScores.reduce((a, b) => a + b, 0) / alignmentScores.length;
  const driftAreas = recentAnalysis
    .filter(e => e.persona_alignment.tone_consistency !== 'on_brand')
    .map(e => e.persona_alignment.specific_notes)
    .filter(Boolean);

  const topPatterns = patterns.patterns
    .sort((a, b) => (b.success_rate ?? 0) - (a.success_rate ?? 0))
    .slice(0, 5);

  const competitorSummary = buildCompetitorSummary(competitorLog.entries.slice(-20));

  const prompt = buildStrategyPrompt({
    tierDistribution,
    currentMix,
    targetMix,
    bestTemplate: best,
    worstTemplate: worst,
    topPatterns,
    personaAlignmentAvg: alignmentAvg,
    driftAreas: [...new Set(driftAreas)],
    competitorSummary,
    personaSummary,
    weekOverWeek,
  });

  try {
    const response = await llm.callJSON<Record<string, unknown>>(prompt, 2000);
    const strategy = parseStrategyResponse(response, {
      totalPosts: recentAnalysis.length,
      tierDistribution,
      currentMix,
      targetMix,
      bestTemplate: best,
      worstTemplate: worst,
      topPatterns,
      weekOverWeek,
    });

    saveStrategy(strategy);
    return true;
  } catch (err) {
    console.error('[strategy-engine] Failed to compute strategy:', (err as Error).message);
    return false;
  }
}
