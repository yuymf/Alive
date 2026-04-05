/**
 * taste-engine.ts
 * Content taste memory — learns platform aesthetic preferences, hook formulas,
 * tone preferences, and engagement drivers from post analysis results.
 *
 * Writes to: content-taste.json
 * Read by: topic-generator (for context injection)
 */

import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now } from '../utils/time-utils';
import { ContentTaste, TastePreference, DEFAULT_CONTENT_TASTE, ContentAnalysis, PerformanceTier } from '../utils/types';

// ─── I/O ──────────────────────────────────────────────────────────────────────

export function loadContentTaste(): ContentTaste {
  return readJSON<ContentTaste>(PATHS.contentTaste, { ...DEFAULT_CONTENT_TASTE });
}

export function saveContentTaste(taste: ContentTaste): void {
  writeJSON(PATHS.contentTaste, { ...taste, last_updated: now().toISOString() });
}

// ─── Preference Update Logic ──────────────────────────────────────────────────

const MAX_PREFERENCES_PER_CATEGORY = 20;
const MAX_ANTI_PATTERNS = 10;

/** Exponential moving average factor for affinity updates */
const EMA_ALPHA = 0.3;

/**
 * Update a preference list with a new data point.
 * Uses EMA to smooth affinity scores.
 */
function upsertPreference(
  prefs: TastePreference[],
  label: string,
  observedAffinity: number,
): TastePreference[] {
  const existing = prefs.find(p => p.label === label);
  if (existing) {
    existing.affinity = existing.affinity * (1 - EMA_ALPHA) + observedAffinity * EMA_ALPHA;
    existing.sample_count += 1;
    existing.last_updated = now().toISOString();
    return prefs;
  }

  const newPref: TastePreference = {
    label,
    affinity: observedAffinity,
    sample_count: 1,
    last_updated: now().toISOString(),
  };

  const updated = [...prefs, newPref];

  // Trim: keep top N by sample_count * affinity (combined relevance)
  if (updated.length > MAX_PREFERENCES_PER_CATEGORY) {
    updated.sort((a, b) => (b.sample_count * b.affinity) - (a.sample_count * a.affinity));
    return updated.slice(0, MAX_PREFERENCES_PER_CATEGORY);
  }

  return updated;
}

// ─── Tier → Affinity Mapping ──────────────────────────────────────────────────

function tierToAffinity(tier: PerformanceTier): number {
  switch (tier) {
    case 'viral': return 1.0;
    case 'above_avg': return 0.6;
    case 'normal': return 0.1;
    case 'below_avg': return -0.5;
  }
}

// ─── Main Update Function ─────────────────────────────────────────────────────

/**
 * Update content taste from a completed post analysis.
 * Called by post-analyzer after each analysis.
 */
export function updateTasteFromAnalysis(analysis: ContentAnalysis): void {
  const taste = loadContentTaste();
  const affinity = tierToAffinity(analysis.performance_tier);

  // Hook formula preferences — from key_success_factors
  for (const factor of analysis.pattern_analysis.key_success_factors) {
    taste.hook_formulas = upsertPreference(taste.hook_formulas, factor, affinity);
  }

  // Extracted patterns → hook formulas
  if (analysis.extracted_patterns) {
    for (const p of analysis.extracted_patterns) {
      taste.hook_formulas = upsertPreference(taste.hook_formulas, p.pattern_type, affinity * p.confidence);
    }
  }

  // Template type → visual style preference (proxy for visual aesthetics)
  taste.visual_styles = upsertPreference(taste.visual_styles, analysis.template_type, affinity);

  // Identity mode → tone preference
  taste.tone_preferences = upsertPreference(taste.tone_preferences, analysis.identity_mode, affinity);

  // Anti-patterns from improvement areas (only for below_avg content)
  if (analysis.performance_tier === 'below_avg') {
    for (const area of analysis.pattern_analysis.improvement_areas) {
      if (!taste.anti_patterns.includes(area)) {
        taste.anti_patterns = [...taste.anti_patterns, area].slice(-MAX_ANTI_PATTERNS);
      }
    }
  }

  saveContentTaste(taste);
}

// ─── Context Building for Topic Generator ─────────────────────────────────────

/**
 * Build a taste context string for injection into content generation prompts.
 * Returns empty string if no taste data is available.
 */
export function buildTasteContext(): string {
  const taste = loadContentTaste();

  // Only include preferences with sufficient data
  const strongHooks = taste.hook_formulas
    .filter(p => p.sample_count >= 2 && p.affinity > 0.3)
    .sort((a, b) => b.affinity - a.affinity)
    .slice(0, 5);

  const strongStyles = taste.visual_styles
    .filter(p => p.sample_count >= 2 && p.affinity > 0.3)
    .sort((a, b) => b.affinity - a.affinity)
    .slice(0, 3);

  const strongDrivers = taste.engagement_drivers
    .filter(p => p.sample_count >= 2 && p.affinity > 0.3)
    .sort((a, b) => b.affinity - a.affinity)
    .slice(0, 3);

  if (strongHooks.length === 0 && strongStyles.length === 0 && strongDrivers.length === 0 && taste.anti_patterns.length === 0) {
    return '';
  }

  const parts: string[] = ['【网感偏好（历史数据学习）】'];

  if (strongHooks.length > 0) {
    parts.push(`- 高效钩子: ${strongHooks.map(h => h.label).join('、')}`);
  }
  if (strongStyles.length > 0) {
    parts.push(`- 偏好风格: ${strongStyles.map(s => s.label).join('、')}`);
  }
  if (strongDrivers.length > 0) {
    parts.push(`- 互动驱动: ${strongDrivers.map(d => d.label).join('、')}`);
  }
  if (taste.anti_patterns.length > 0) {
    parts.push(`- 避免: ${taste.anti_patterns.slice(0, 5).join('、')}`);
  }

  return parts.join('\n');
}
