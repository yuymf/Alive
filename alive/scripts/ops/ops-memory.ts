/**
 * ops-memory.ts
 * Unified ops memory layer — aggregates scattered operational knowledge
 * into a single context string for LLM prompt injection.
 *
 * Sources aggregated:
 * 1. Operator preference profile (operator-preference.ts)
 * 2. Content taste / 网感记忆 (taste-engine.ts)
 * 3. Recent review learning (review-queue.ts)
 * 4. Audience perception (audience-perception.ts)
 * 5. Content strategy (strategy-engine.ts)
 * 6. Proactive advisor insights (proactive-advisor.ts)
 *
 * The memory layer provides:
 * - `buildOpsMemoryContext()` for topic-generator / brief-generator injection
 * - `getOpsMemorySnapshot()` for dashboard / debug introspection
 *
 * Design: Pure read-only aggregator — never writes state.
 * Each source is loaded independently with try-catch for cold-start safety.
 *
 * Storage: None (read-only aggregator). Sources persist their own state.
 */

import { buildPreferenceContext, loadPreference, type OperatorPreferenceProfile } from './operator-preference';
import { buildTasteContext } from './taste-engine';
import { buildAudiencePerceptionContext } from './audience-perception';
import { loadStrategy } from './strategy-engine';
import { generateProactiveAdvice, type ProactiveAdvisorContext, type ProactiveAdvice } from './proactive-advisor';
import type { ContentStrategy, ContentTaste, AudiencePerceptionStore } from '../utils/types';
import { PATHS, readJSON } from '../utils/file-utils';

// ─── Review Learning Helper ──────────────────────────────────────────────────

/**
 * Build a compact review-learning context string from recent review feedback.
 * Uses dynamic import to avoid hard dependency on review-queue.
 * Returns '' if no feedback data or module unavailable.
 */
async function buildReviewLearningContext(maxItems = 5): Promise<string> {
  try {
    const { getRecentReviewLearning } = await import('./review-queue');
    const learning = await getRecentReviewLearning(maxItems);
    const parts: string[] = [];
    if (learning.approveReasons.length > 0) {
      parts.push(`✅ 通过：${[...new Set(learning.approveReasons)].slice(-2).join('；')}`);
    }
    if (learning.discardReasons.length > 0) {
      parts.push(`❌ 淘汰：${[...new Set(learning.discardReasons)].slice(-2).join('；')}`);
    }
    if (learning.improvementDirections.length > 0) {
      parts.push(`🔄 改进：${[...new Set(learning.improvementDirections)].slice(-2).join('；')}`);
    }
    return parts.length > 0 ? `【审核共识】\n${parts.join('\n')}` : '';
  } catch {
    return '';
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OpsMemorySnapshot {
  /** Operator preference profile */
  preference: OperatorPreferenceProfile | null;
  /** Content taste memory */
  taste: string;
  /** Audience perception summary */
  audiencePerception: string;
  /** Current strategy summary */
  strategySummary: string;
  /** Proactive advice (if context provided) */
  proactiveAdvice: ProactiveAdvice[];
  /** Aggregation timestamp */
  snapshot_at: string;
}

export interface OpsMemoryContextOptions {
  /** Max characters for the entire context (soft limit). Default: 2000 */
  maxChars?: number;
  /** Identity mode for scoped queries. Optional. */
  identityMode?: string;
  /** Whether to include proactive advice. Default: false (expensive) */
  includeAdvice?: boolean;
  /** Proactive advisor context — required if includeAdvice is true */
  advisorContext?: ProactiveAdvisorContext;
}

// ─── Core: Unified Context Builder ───────────────────────────────────────────

/**
 * Build a unified ops memory context string for LLM prompt injection.
 * Aggregates all operational knowledge sources into a single coherent block.
 *
 * This is the primary integration point — call this instead of separately
 * calling buildPreferenceContext, buildTasteContext, etc.
 *
 * Returns '' if all sources are empty (cold-start safe).
 */
export async function buildOpsMemoryContext(options?: OpsMemoryContextOptions): Promise<string> {
  const maxChars = options?.maxChars ?? 2000;
  const sections: string[] = [];

  // 1. Operator preference (most important — directly from operator behavior)
  try {
    const prefCtx = buildPreferenceContext({
      maxAngles: 3,
      maxAvoid: 3,
      maxEdits: 2,
    });
    if (prefCtx) sections.push(prefCtx);
  } catch {
    // not available
  }

  // 2. Content taste / 网感记忆
  try {
    const tasteCtx = buildTasteContext();
    if (tasteCtx) sections.push(tasteCtx);
  } catch {
    // not available
  }

  // 3. Audience perception
  try {
    const perceptionCtx = buildAudiencePerceptionContext({
      maxEntries: 3,
      maxChars: 400,
      identityMode: options?.identityMode,
    });
    if (perceptionCtx) sections.push(`【受众感知】\n${perceptionCtx}`);
  } catch {
    // not available
  }

  // 4. Review learning (recent approval / discard / edit consensus)
  try {
    const reviewCtx = await buildReviewLearningContext(5);
    if (reviewCtx) sections.push(reviewCtx);
  } catch {
    // not available
  }

  // 5. Strategy summary (brief, not full strategy)
  try {
    const strategy = loadStrategy();
    if (strategy && strategy.status !== 'expired') {
      const strategySummary = buildStrategySummary(strategy);
      if (strategySummary) sections.push(strategySummary);
    }
  } catch {
    // not available
  }

  // 6. Proactive advice (optional)
  if (options?.includeAdvice && options.advisorContext) {
    try {
      const advice = generateProactiveAdvice(options.advisorContext);
      if (advice.length > 0) {
        const adviceLines = advice.map(a => `• ${a.message}`);
        sections.push(`【助手建议】\n${adviceLines.join('\n')}`);
      }
    } catch {
      // not available
    }
  }

  if (sections.length === 0) return '';

  // Soft truncation: if total exceeds maxChars, trim from the end
  let result = sections.join('\n\n');
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + '\n…（记忆截断）';
  }

  return result;
}

// ─── Strategy Summary (compact) ──────────────────────────────────────────────

function buildStrategySummary(strategy: ContentStrategy): string {
  const parts: string[] = ['【当前策略摘要】'];

  const recs = strategy.next_week_recommendations;
  if (recs.content_direction) {
    parts.push(`方向：${recs.content_direction}`);
  }

  if (recs.recommended_templates.length > 0) {
    parts.push(`推荐：${recs.recommended_templates.slice(0, 3).join('、')}`);
  }

  if (recs.avoid_templates.length > 0) {
    parts.push(`回避：${recs.avoid_templates.slice(0, 2).join('、')}`);
  }

  const trend = strategy.performance_summary.engagement_trend;
  if (trend !== 'stable') {
    parts.push(`趋势：${trend === 'rising' ? '📈 上升' : '📉 下降'}`);
  }

  if (strategy.ops_suggestions && strategy.ops_suggestions.length > 0) {
    parts.push(`运营提示：${strategy.ops_suggestions[0]}`);
  }

  return parts.length > 1 ? parts.join('\n') : '';
}

// ─── Snapshot (for debug/dashboard) ──────────────────────────────────────────

/**
 * Get a structured snapshot of all ops memory for debugging or dashboard display.
 */
export function getOpsMemorySnapshot(advisorContext?: ProactiveAdvisorContext): OpsMemorySnapshot {
  let preference: OperatorPreferenceProfile | null = null;
  try { preference = loadPreference(); } catch { /* cold start */ }

  let taste = '';
  try { taste = buildTasteContext(); } catch { /* cold start */ }

  let audiencePerception = '';
  try { audiencePerception = buildAudiencePerceptionContext({ maxEntries: 5, maxChars: 500 }); } catch { /* */ }

  let strategySummary = '';
  try {
    const strategy = loadStrategy();
    if (strategy) strategySummary = buildStrategySummary(strategy);
  } catch { /* */ }

  let proactiveAdvice: ProactiveAdvice[] = [];
  if (advisorContext) {
    try { proactiveAdvice = generateProactiveAdvice(advisorContext); } catch { /* */ }
  }

  return {
    preference,
    taste,
    audiencePerception,
    strategySummary,
    proactiveAdvice,
    snapshot_at: new Date().toISOString(),
  };
}
