/**
 * topic-scorer.ts
 * 6-factor topic scoring gate — evaluates trend potential before content generation.
 * Inspired by xiaohongshu-ops-skill's multi-dimensional scoring framework.
 *
 * Each dimension scores 0-2. Total score range: 0-12.
 * Topics scoring below threshold (default 6) are filtered out.
 */

import { LLMClient } from '../utils/llm-client';
import { FilteredTrend } from './trend-analyzer';
import { readTunablePrompt, renderTunablePrompt } from '../utils/file-utils';

/** 6-factor topic score */
export interface TopicScore {
  /** 可讲性: Can this be explained clearly in spoken language? */
  articulability: number;
  /** 可争议: Does this topic have opposing viewpoints? */
  controversy: number;
  /** 可持续: Can this become a series (5+ posts)? */
  serialization: number;
  /** 可转发: Does this have social currency (shareability)? */
  shareability: number;
  /** 可执行: Can we actually create this content with our resources? */
  executability: number;
  /** 风险分: Compliance / reputation risk (higher = more dangerous) */
  risk: number;
  /** Total score (sum of first 5 dimensions, minus risk) */
  total: number;
}

export interface ScoredTrend {
  trend: FilteredTrend;
  score: TopicScore;
}

/** Default score used when LLM fails or returns no data for a trend */
const DEFAULT_SCORE: TopicScore = {
  articulability: 1,
  controversy: 1,
  serialization: 1,
  shareability: 1,
  executability: 1,
  risk: 0,
  total: 5,
};

/** Clamp a value to integer in range [0, 2] */
function clamp02(v: number): number {
  return Math.max(0, Math.min(2, Math.round(v)));
}

/** Compute total from individual dimension scores */
function computeTotal(a: number, c: number, s: number, sh: number, e: number, risk: number): number {
  return a + c + s + sh + e - risk;
}

/** Build the trend list text for the LLM prompt */
function buildTrendListText(trends: FilteredTrend[]): string {
  return trends.map((t, i) =>
    `${i + 1}. ${t.keyword}（${t.platform}，速度分 ${(Number.isFinite(t.velocity_score) ? t.velocity_score : 1.0).toFixed(1)}x）— 切入角度：${t.hook_angle}`,
  ).join('\n');
}

/** Build the fallback prompt when no tunable prompt file exists */
function buildDefaultPrompt(personaDescription: string, trendList: string, trendCount: number): string {
  return `你是内容策略评估专家。请对以下${trendCount}个热点话题进行6维评分。

角色背景：${personaDescription}

待评分话题：
${trendList}

对每个话题，按以下6个维度打分（每维0-2分）：
1. 可讲性（0-2）：能否用口语3分钟内讲清楚？
2. 可争议（0-2）：是否有对立观点，能引发讨论？
3. 可持续（0-2）：能否做成系列（5篇以上）？
4. 可转发（0-2）：有没有社交货币，让人想分享？
5. 可执行（0-2）：我们的人设和资源能否做出高质量内容？
6. 风险分（0-2）：合规/舆情/版权风险（0=安全，2=高风险）

输出 JSON 数组：
[{"index":1,"articulability":1,"controversy":2,"serialization":1,"shareability":2,"executability":2,"risk":0,"risk_detail":"无明显风险"},...]

risk_detail 用一句话描述风险点（如"涉及竞品比较，可能引战"）。
只输出 JSON，不要解释。`;
}

/** Parse a single LLM result item into a ScoredTrend */
function parseScoredResult(
  trend: FilteredTrend,
  result: {
    index: number;
    articulability: number;
    controversy: number;
    serialization: number;
    shareability: number;
    executability: number;
    risk: number;
    risk_detail?: string;
  } | undefined,
): ScoredTrend {
  if (!result) {
    return { trend, score: DEFAULT_SCORE };
  }

  const a = clamp02(result.articulability);
  const c = clamp02(result.controversy);
  const s = clamp02(result.serialization);
  const sh = clamp02(result.shareability);
  const e = clamp02(result.executability);
  const risk = clamp02(result.risk);
  const total = computeTotal(a, c, s, sh, e, risk);

  return {
    trend: { ...trend, risk_detail: result.risk_detail },
    score: { articulability: a, controversy: c, serialization: s, shareability: sh, executability: e, risk, total },
  };
}

/**
 * Score a batch of trends using LLM.
 * Returns scored trends sorted by total descending, filtered by threshold.
 * Failed scoring returns all trends with default scores — graceful degradation.
 */
export async function scoreTopics(
  trends: FilteredTrend[],
  llm: LLMClient,
  personaDescription: string,
  options?: { threshold?: number },
): Promise<ScoredTrend[]> {
  if (trends.length === 0) return [];

  const threshold = options?.threshold ?? 6;
  const trendList = buildTrendListText(trends);

  const tunable = readTunablePrompt('ops/topic-scorer.md');
  const prompt = tunable
    ? renderTunablePrompt(tunable, {
        persona_description: personaDescription,
        trend_list: trendList,
        trend_count: String(trends.length),
      }).trim()
    : buildDefaultPrompt(personaDescription, trendList, trends.length);

  try {
    const results = await llm.callJSON<Array<{
      index: number;
      articulability: number;
      controversy: number;
      serialization: number;
      shareability: number;
      executability: number;
      risk: number;
      risk_detail?: string;
    }>>(prompt, 1000);

    let normalizedResults = results;
    if (!Array.isArray(results)) {
      // Some models (e.g. hy3-preview) return a single object instead of an array when batch size is 1
      if (results && typeof results === 'object' && 'index' in results) {
        normalizedResults = [results] as typeof results;
      } else {
        const candidate =
          (results as Record<string, unknown>)?.results ??
          (results as Record<string, unknown>)?.data ??
          (results as Record<string, unknown>)?.topics ??
          (results as Record<string, unknown>)?.scores;
        if (Array.isArray(candidate)) {
          normalizedResults = candidate as typeof results;
        } else {
          throw new Error(`Expected JSON array from LLM, got ${typeof results}`);
        }
      }
    }

    const scored: ScoredTrend[] = trends.map((trend, i) => {
      const r = normalizedResults.find(item => item.index === i + 1);
      return parseScoredResult(trend, r);
    });

    // Sort by total descending, filter by threshold
    return scored
      .sort((a, b) => b.score.total - a.score.total)
      .filter(s => s.score.total >= threshold);
  } catch (err) {
    console.error('[topic-scorer] LLM scoring failed, passing all trends through:', err);
    // Graceful degradation: return all trends with default scores
    return trends.map(trend => ({
      trend,
      score: DEFAULT_SCORE,
    }));
  }
}
