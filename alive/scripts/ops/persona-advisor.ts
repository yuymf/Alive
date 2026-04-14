/**
 * persona-advisor.ts
 * D v1: 人设建议 — 人设×热点契合度报告 + 选题方向推荐
 * Reads persona identities, current trends, and competitor context
 * to produce an alignment report with actionable topic suggestions.
 */

import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now } from '../utils/time-utils';
import {
  PersonaConfig,
  PersonaAlignmentReport,
  PersonaReportLog,
  CompetitorUpdate,
} from '../utils/types';
import { LLMClient } from '../utils/llm-client';
import { FilteredTrend } from './trend-analyzer';
import { buildCompetitorContext } from './competitor-tracker';

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_REPORT_LOG_ENTRIES = 30;

// ─── Pure functions (exported for testing) ───────────────────────────────────

/**
 * Extract structured identity descriptions from persona config.
 * Sources: identities map → content_templates identity_modes → core_traits
 */
export function extractPersonaIdentities(
  persona: PersonaConfig,
): { key: string; description: string }[] {
  const identities: { key: string; description: string }[] = [];

  // 1. Try identities field (custom top-level field on some personas)
  const rawIdentities = (persona as unknown as Record<string, unknown>).identities as
    Record<string, { tagline?: string; description?: string }> | undefined;
  if (rawIdentities && typeof rawIdentities === 'object') {
    for (const [key, val] of Object.entries(rawIdentities)) {
      const desc = val?.tagline ?? val?.description ?? key;
      identities.push({ key, description: String(desc) });
    }
  }

  // 2. Supplement from content_templates unique identity_modes
  if (persona.ops?.content_templates) {
    const seenModes = new Set(identities.map(i => i.key));
    for (const tpl of persona.ops.content_templates) {
      if (tpl.identity_mode && !seenModes.has(tpl.identity_mode)) {
        seenModes.add(tpl.identity_mode);
        identities.push({
          key: tpl.identity_mode,
          description: `${tpl.category}领域的${tpl.type}内容创作者`,
        });
      }
    }
  }

  // 3. Fallback to core_traits if no identities found
  if (identities.length === 0 && persona.personality?.core_traits) {
    for (const trait of persona.personality.core_traits) {
      identities.push({ key: trait, description: trait });
    }
  }

  return identities;
}

/**
 * Build LLM prompt for persona alignment analysis.
 */
export function buildAlignmentPrompt(
  identities: { key: string; description: string }[],
  trends: FilteredTrend[],
  competitorCtx: string,
  voiceStyle: string,
): string {
  const identityList = identities
    .map(i => `- ${i.key}: ${i.description}`)
    .join('\n');

  const trendList = trends.length > 0
    ? trends.slice(0, 8).map(t =>
        `- ${t.keyword}（${t.platform}，velocity=${t.velocity_score.toFixed(1)}x，角度：${t.hook_angle}）`,
      ).join('\n')
    : '暂无今日热点数据';

  const competitorSection = competitorCtx
    ? `\n【竞品参考】\n${competitorCtx}`
    : '';

  return `你是虚拟人设运营顾问。请根据以下信息，输出人设×热点契合度诊断报告。

【人设身份】
${identityList}

【语气风格】${voiceStyle || '未指定'}

【今日热点】
${trendList}
${competitorSection}

请分析：
1. 每个身份与今日热点的契合度（0-10分），说明理由
2. 综合契合度评分（0-10）
3. 恰好 3 条选题方向建议，每条需指定使用哪个身份模式和切入钩子
4. 风险/注意事项（如人设偏移风险、争议话题等）

返回 JSON：
\`\`\`json
{
  "alignment_score": 7,
  "identity_analysis": [
    {"identity":"身份名","fit_score":8,"reasoning":"原因"}
  ],
  "topic_suggestions": [
    {"direction":"选题方向","identity_mode":"身份模式","hook":"切入钩子","reasoning":"理由"}
  ],
  "warnings": ["注意事项1"]
}
\`\`\``;
}

/**
 * Format full alignment card for WeChat Work push.
 */
export function formatAlignmentCard(report: PersonaAlignmentReport): string {
  const lines: string[] = [
    `💡 人设建议  总评 ${report.alignment_score}/10`,
    '',
  ];

  // Identity analysis
  if (report.identity_analysis.length > 0) {
    lines.push('━━ 身份契合度 ━━');
    for (const ia of report.identity_analysis) {
      const bar = '█'.repeat(Math.round(ia.fit_score)) + '░'.repeat(10 - Math.round(ia.fit_score));
      lines.push(`${ia.identity}  ${bar} ${ia.fit_score}/10`);
      lines.push(`  → ${ia.reasoning}`);
    }
    lines.push('');
  }

  // Topic suggestions
  if (report.topic_suggestions.length > 0) {
    lines.push('━━ 推荐选题 ━━');
    report.topic_suggestions.forEach((ts, idx) => {
      lines.push(`${idx + 1}️⃣  ${ts.direction}`);
      lines.push(`   身份：${ts.identity_mode} | 钩子：${ts.hook}`);
      lines.push(`   理由：${ts.reasoning}`);
    });
    lines.push('');
  }

  // Warnings
  if (report.warnings.length > 0) {
    lines.push('━━ ⚠️ 注意事项 ━━');
    report.warnings.forEach(w => lines.push(`• ${w}`));
  }

  return lines.join('\n');
}

/**
 * Format brief section for daily brief embedding (enriched version).
 * Shows: best identity + reasoning, topic directions with hook/reasoning, warnings.
 */
export function formatAlignmentBriefSection(report: PersonaAlignmentReport): string {
  const lines: string[] = ['━━ 💡人设建议 ━━'];

  // Best matching identity with reasoning
  const topIdentity = report.identity_analysis.length > 0
    ? report.identity_analysis.reduce((a, b) => a.fit_score > b.fit_score ? a : b)
    : null;

  if (topIdentity) {
    lines.push(`🏆 今日最佳：${topIdentity.identity} ${topIdentity.fit_score}/10`);
    if (topIdentity.reasoning) {
      lines.push(`   理由：${topIdentity.reasoning}`);
    }
  } else {
    lines.push(`综合契合度：${report.alignment_score}/10`);
  }
  lines.push('');

  // Topic suggestions with hook and reasoning
  if (report.topic_suggestions.length > 0) {
    lines.push('推荐方向：');
    const numEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
    report.topic_suggestions.forEach((ts, idx) => {
      const numIcon = idx < numEmojis.length ? numEmojis[idx] : `${idx + 1}.`;
      lines.push(`${numIcon} ${ts.direction}`);
      lines.push(`   🎭 ${ts.identity_mode}`);
      if (ts.hook) {
        lines.push(`   🪝 钩子：${ts.hook}`);
      }
      if (ts.reasoning) {
        lines.push(`   💡 理由：${ts.reasoning}`);
      }
    });
  }

  // Warnings
  if (report.warnings.length > 0) {
    lines.push('');
    for (const w of report.warnings) {
      lines.push(`⚠️ ${w}`);
    }
  }

  lines.push('🎯 /persona 完整报告');

  return lines.join('\n');
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function persistReport(report: PersonaAlignmentReport): void {
  const log = readJSON<PersonaReportLog>(PATHS.personaReportLog, { entries: [] });
  const updated: PersonaReportLog = {
    entries: [...log.entries, report].slice(-MAX_REPORT_LOG_ENTRIES),
  };
  writeJSON(PATHS.personaReportLog, updated);
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Generate persona alignment report: identities × trends → LLM → structured report.
 */
export async function generatePersonaReport(
  persona: PersonaConfig,
  trends: FilteredTrend[],
  competitors: CompetitorUpdate[],
  llm: LLMClient,
): Promise<PersonaAlignmentReport> {
  const identities = extractPersonaIdentities(persona);
  const profiles = persona.ops?.competitors ?? [];
  const competitorCtx = buildCompetitorContext(profiles, competitors);
  const voiceStyle = persona.voice?.style ?? '';

  const prompt = buildAlignmentPrompt(identities, trends, competitorCtx, voiceStyle);

  const raw = await llm.callJSON<{
    alignment_score: number;
    identity_analysis: PersonaAlignmentReport['identity_analysis'];
    topic_suggestions: PersonaAlignmentReport['topic_suggestions'];
    warnings: string[];
  }>(prompt, 4000);

  // Clamp score 0-10
  const clampedScore = Math.max(0, Math.min(10, raw.alignment_score ?? 5));

  // Ensure exactly 3 suggestions
  const suggestions = (raw.topic_suggestions ?? []).slice(0, 3);
  while (suggestions.length < 3) {
    suggestions.push({
      direction: '待补充',
      identity_mode: identities[0]?.key ?? 'default',
      hook: '待补充',
      reasoning: '建议数量不足，请手动补充',
    });
  }

  // Clamp identity scores
  const identityAnalysis = (raw.identity_analysis ?? []).map(ia => ({
    ...ia,
    fit_score: Math.max(0, Math.min(10, ia.fit_score ?? 5)),
  }));

  const report: PersonaAlignmentReport = {
    alignment_score: clampedScore,
    identity_analysis: identityAnalysis,
    topic_suggestions: suggestions,
    warnings: raw.warnings ?? [],
    generated_at: now().toISOString(),
  };

  persistReport(report);
  return report;
}
