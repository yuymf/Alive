/**
 * positioning-analyzer.ts
 * Layer 3 — Cross-account positioning analysis for the competitor analysis pipeline.
 *
 * Synthesizes per-account AccountAnalysis results into a PositioningReport
 * that identifies content gaps, competitor matrix, and weekly strategic direction
 * for the persona.
 */

import * as fs from 'fs';
import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { wallNow, getLocalDate } from '../utils/time-utils';
import type {
  CompetitorAnalysisStore,
  PersonaConfig,
  QueueItem,
  PositioningReport,
} from '../utils/types';
import type { LLMClient } from '../utils/llm-client';

// ─── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Build a Chinese-language LLM prompt for cross-account positioning analysis.
 * Includes all competitor analyses, persona info, and published items summary.
 */
export function buildPositioningPrompt(
  analysisStore: CompetitorAnalysisStore,
  persona: PersonaConfig,
  publishedItems: readonly QueueItem[],
): string {
  const today = getLocalDate();

  // Build competitor analyses section
  const competitorLines = Object.entries(analysisStore.analyses)
    .map(([accountKey, analysis]) => {
      const topicClusters = analysis.topic_clusters
        .map(tc => `    - ${tc.cluster_name}（${tc.post_count}篇，均互动${tc.avg_engagement}）`)
        .join('\n');

      const hookPatterns = analysis.hook_patterns
        .map(hp => `    - ${hp.pattern}（${hp.frequency}）`)
        .join('\n');

      return `### ${analysis.account_name}（${analysis.platform}）
  - 核心洞察：${analysis.key_insight}
  - 最佳内容类型：${analysis.engagement_pattern.best_performing_type}（均互动 ${analysis.engagement_pattern.avg_engagement}）
  - 话题集群：
${topicClusters}
  - 钩子模式：
${hookPatterns}`;
    })
    .join('\n\n');

  // Build persona info section
  const identitiesLine = (persona.ops as unknown as Record<string, unknown> | undefined)?.identities
    ? `- 三重身份：${JSON.stringify((persona.ops as unknown as Record<string, unknown>).identities)}`
    : '';

  const coreTraits = persona.personality.core_traits.join('、');

  // Build published items summary (last 10)
  const recentItems = publishedItems.slice(-10);
  const publishedLines = recentItems.length > 0
    ? recentItems
        .map((item, i) => `${i + 1}. ${item.topic}`)
        .join('\n')
    : '（暂无已发布内容）';

  return `你是一位专业的社交媒体竞品定位分析师。请基于以下竞品分析数据，为 ${persona.meta.name} 生成定位分析报告。

## 分析日期

${today}

## 竞品分析数据

${competitorLines}

## 我方 Persona 信息

- 名称：${persona.meta.name}
- 简介：${persona.meta.tagline}
- MBTI：${persona.personality.mbti}
- 核心特质：${coreTraits}
${identitiesLine}

## 近期已发布内容（最近 ${recentItems.length} 条）

${publishedLines}

## 输出要求

请基于以上竞品数据，分析内容空白区、竞品矩阵优劣势，并给出本周创作方向建议。

严格按照以下 JSON 格式输出，不要包含任何额外说明：

\`\`\`json
{
  "report_period": "报告时间范围（如：2026-03-26 至 2026-04-02）",
  "competitor_matrix": [
    {
      "account_name": "账号名",
      "platform": "平台",
      "strengths": ["优势1", "优势2"],
      "weaknesses": ["劣势1"],
      "content_focus": "主要内容方向",
      "avg_engagement": 0
    }
  ],
  "gap_analysis": {
    "underserved_niches": ["未被充分覆盖的细分领域1", "细分领域2"],
    "oversaturated_areas": ["过于拥挤的内容领域1"],
    "miss_v_advantages": ["${persona.meta.name}的独特优势1", "独特优势2"]
  },
  "recommendations": [
    {
      "recommendation": "具体创作建议",
      "identity_mode": "对应身份模式",
      "priority": "high",
      "rationale": "推荐理由"
    }
  ],
  "weekly_direction": {
    "focus_identities": ["本周主推身份1", "身份2"],
    "avoid_topics": ["本周应回避的话题"],
    "suggested_templates": ["推荐使用的内容模板"]
  }
}
\`\`\``;
}

// ─── Response parser ───────────────────────────────────────────────────────────

/**
 * Parse the LLM's raw string response into a PositioningReport.
 * Strips markdown fences, validates required fields, and overrides generated_at.
 */
export function parsePositioningResponse(raw: string): PositioningReport | null {
  try {
    const stripped = raw
      .replace(/^```(?:json)?\s*/im, '')
      .replace(/\s*```\s*$/im, '')
      .trim();

    const parsed = JSON.parse(stripped) as Record<string, unknown>;

    // Validate required fields
    const requiredFields = ['competitor_matrix', 'gap_analysis', 'recommendations', 'weekly_direction'];
    for (const field of requiredFields) {
      if (!(field in parsed)) {
        return null;
      }
    }

    const report: PositioningReport = {
      ...(parsed as Omit<PositioningReport, 'generated_at'>),
      generated_at: wallNow().toISOString(),
    };

    return report;
  } catch {
    return null;
  }
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

/**
 * Run cross-account positioning analysis via LLM.
 * Returns null if no analyses exist or if LLM call/parsing fails.
 */
export async function analyzePositioning(
  analysisStore: CompetitorAnalysisStore,
  persona: PersonaConfig,
  publishedItems: readonly QueueItem[],
  llm: LLMClient,
): Promise<PositioningReport | null> {
  // No data to compare — skip
  if (Object.keys(analysisStore.analyses).length === 0) {
    return null;
  }

  const prompt = buildPositioningPrompt(analysisStore, persona, publishedItems);

  try {
    const raw = await llm.call(prompt);
    return parsePositioningResponse(raw);
  } catch {
    return null;
  }
}

// ─── Persistence ──────────────────────────────────────────────────────────────

/**
 * Save a positioning report. If an existing report exists, copies it to
 * PATHS.positioningReportPrev before writing the new one.
 */
export function savePositioningReport(report: PositioningReport): void {
  if (fs.existsSync(PATHS.positioningReport)) {
    fs.copyFileSync(PATHS.positioningReport, PATHS.positioningReportPrev);
  }
  writeJSON(PATHS.positioningReport, report);
}

/**
 * Load the current positioning report. Returns null if the file doesn't exist.
 */
export function loadPositioningReport(): PositioningReport | null {
  return readJSON<PositioningReport | null>(PATHS.positioningReport, null);
}
