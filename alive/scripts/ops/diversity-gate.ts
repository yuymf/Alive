/**
 * diversity-gate.ts
 * Content diversity gating — prevents topic-generator from producing
 * repetitive content by checking new topics against recent queue history.
 *
 * Checks:
 * 1. Keyword overlap: same trend keyword used for the same identity mode
 * 2. Identity mode saturation: too many consecutive items in one mode
 * 3. Template type repetition: same template used back-to-back
 * 4. Hook angle similarity: LLM-free keyword jaccard overlap
 *
 * Design: Pure function, no side effects, no LLM calls.
 * Returns a DiversityVerdict with pass/fail + reason for logging.
 */

import type { QueueItem, IdentityMode } from '../utils/types';
import type { FilteredTrend } from './trend-analyzer';
import { extractTrendHookKeyword } from '../utils/text-utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DiversityVerdict {
  pass: boolean;
  reason: string;
}

export interface DiversityGateOptions {
  /** Max items with same identity mode in recent window. Default: 3 */
  maxSameModeInWindow?: number;
  /** Minimum Jaccard distance for hook_angle text. Default: 0.5 */
  minAngleDistance?: number;
  /** Recent window size (number of queue items to check). Default: 10 */
  windowSize?: number;
  /**
   * If true, when diversity gate filters ALL topics out (result is empty),
   * fall back to keeping the first (best) topic as a minimum guarantee.
   * This prevents the worst UX of "0 topics after LLM generation".
   * Default: true
   */
  ensureMinimum?: boolean;
  /** If true, relax thresholds for user-specified direction mode. Default: false */
  relaxedForDirection?: boolean;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Tokenize a Chinese/English string into unique word/character bigrams.
 * Simple but effective for Jaccard overlap detection.
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const cleaned = text.toLowerCase().replace(/[^\w\u4e00-\u9fff]/g, ' ');

  // Chinese character bigrams
  const chars = [...cleaned.replace(/\s+/g, '')];
  for (let i = 0; i < chars.length - 1; i++) {
    tokens.add(chars[i] + chars[i + 1]);
  }

  // English word unigrams
  const words = cleaned.split(/\s+/).filter(w => w.length > 1 && /^[a-z]/.test(w));
  for (const w of words) {
    tokens.add(w);
  }

  return tokens;
}

/**
 * Jaccard similarity between two strings.
 * Returns 0.0 (completely different) to 1.0 (identical).
 */
function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }

  return intersection / (setA.size + setB.size - intersection);
}

// ─── Core Gate ───────────────────────────────────────────────────────────────

/**
 * Check whether a new trend should be generated, given recent queue history.
 * Returns a verdict with pass=true if diverse enough.
 */
export function checkDiversity(
  trend: FilteredTrend,
  identityMode: IdentityMode,
  recentItems: QueueItem[],
  options?: DiversityGateOptions,
): DiversityVerdict {
  const maxSameMode = options?.maxSameModeInWindow ?? 3;
  const minDistance = options?.minAngleDistance ?? 0.5;
  const windowSize = options?.windowSize ?? 10;

  const window = recentItems.slice(-windowSize);

  // 1. Exact keyword dedup (already in review-queue.addItem, but catch upstream)
  const keywordMatch = window.find(
    item => item.status === 'pending'
      && extractTrendHookKeyword(item.trend_hook) === trend.keyword
      && item.identity_mode === identityMode,
  );
  if (keywordMatch) {
    return {
      pass: false,
      reason: `重复关键词「${trend.keyword}」已在队列中 (id: ${keywordMatch.id})`,
    };
  }

  // 2. Identity mode saturation
  const sameModeCount = window
    .filter(item => item.identity_mode === identityMode && item.status === 'pending')
    .length;
  if (sameModeCount >= maxSameMode) {
    return {
      pass: false,
      reason: `身份「${identityMode}」在最近${windowSize}个选题中已有${sameModeCount}个，超过阈值${maxSameMode}`,
    };
  }

  // 3. Template type repetition (last 3 items)
  if (trend.identity_mode) {
    const last3 = window.slice(-3);
    const templateTypes = last3
      .filter(item => item.template_spec)
      .map(item => item.template_spec!.content_type);
    // If all 3 most recent items used the same template type, block
    if (templateTypes.length >= 3 && new Set(templateTypes).size === 1) {
      return {
        pass: false,
        reason: `最近3个选题都使用了模板「${templateTypes[0]}」，需要变换`,
      };
    }
  }

  // 4. Hook angle similarity
  const hookAngle = trend.hook_angle;
  if (hookAngle) {
    for (const item of window) {
      // Extract hook angle from topic: "蹭 keyword：hook_angle"
      const colonIdx = item.topic.indexOf('：');
      if (colonIdx === -1) continue;
      const existingAngle = item.topic.slice(colonIdx + 1).trim();

      const similarity = jaccardSimilarity(hookAngle, existingAngle);
      if (similarity > (1 - minDistance)) {
        return {
          pass: false,
          reason: `切入角度「${hookAngle}」与已有选题「${existingAngle}」相似度 ${(similarity * 100).toFixed(0)}%`,
        };
      }
    }
  }

  return { pass: true, reason: '' };
}

/**
 * Filter trends through the diversity gate.
 * Returns only trends that pass diversity checks.
 * Logs skipped trends to console.
 *
 * If ensureMinimum is true (default) and ALL trends are filtered out,
 * falls back to the first (best-scoring) trend as a minimum guarantee,
 * preventing the worst UX of "0 topics after LLM generation".
 */
export function filterByDiversity(
  trends: FilteredTrend[],
  recentItems: QueueItem[],
  getIdentityMode: (trend: FilteredTrend) => IdentityMode,
  options?: DiversityGateOptions,
): FilteredTrend[] {
  const ensureMinimum = options?.ensureMinimum ?? true;
  const relaxedForDirection = options?.relaxedForDirection ?? false;

  // For direction mode, use relaxed thresholds
  const effectiveOptions: DiversityGateOptions | undefined = relaxedForDirection
    ? { ...options, maxSameModeInWindow: Math.max(options?.maxSameModeInWindow ?? 3, 5), minAngleDistance: Math.min(options?.minAngleDistance ?? 0.5, 0.3) }
    : options;

  const passed: FilteredTrend[] = [];

  for (const trend of trends) {
    const mode = getIdentityMode(trend);
    const verdict = checkDiversity(trend, mode, [...recentItems, ...passed.map(toFakeQueueItem)], effectiveOptions);

    if (verdict.pass) {
      passed.push(trend);
    } else {
      console.log(`[diversity-gate] Skipped「${trend.keyword}」: ${verdict.reason}`);
    }
  }

  // Minimum guarantee: if all filtered out but we had input, keep the best one
  if (ensureMinimum && passed.length === 0 && trends.length > 0) {
    const best = trends[0];
    const mode = getIdentityMode(best);
    console.log(`[diversity-gate] All topics filtered out — minimum guarantee: keeping「${best.keyword}」(${mode})`);
    return [best];
  }

  return passed;
}

/**
 * Create a minimal fake QueueItem for intra-batch diversity checking.
 * Used so that trends selected within the same batch don't duplicate each other.
 */
function toFakeQueueItem(trend: FilteredTrend): QueueItem {
  return {
    id: `fake_${trend.keyword}`,
    status: 'pending',
    topic: `蹭 ${trend.keyword}：${trend.hook_angle}`,
    trend_hook: `${trend.keyword} (${trend.platform}, ${trend.velocity_score.toFixed(1)}x)`,
    identity_mode: trend.identity_mode,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    content: {
      xhs: { title: '', body: '', tags: [], cover_images: [] },
      douyin: { script: '', bgm_suggestion: '', key_captions: [], cover_images: [] },
    },
    edit_history: [],
  };
}
