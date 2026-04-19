/**
 * taste-engine.ts
 * Content taste memory — learns platform aesthetic preferences, hook formulas,
 * tone preferences, engagement drivers, angle/topic/persona-mode preferences,
 * and anti-patterns from post analysis results.
 *
 * Features:
 * - 7-dimension preference tracking (hook/visual/tone/engagement/angle/topic/persona_mode)
 * - EMA-smoothed affinity updates
 * - Anti-pattern learning from below_avg content
 * - Pattern decay & intelligent eviction (stale → decaying → evicted)
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

// ─── Pattern Decay & Intelligent Eviction ─────────────────────────────────────

/** Days before a preference starts decaying (no updates) */
const DECAY_START_DAYS = 14;
/** Daily decay multiplier applied to affinity */
const DECAY_FACTOR = 0.9;
/** Days before a decaying preference is evicted */
const EVICT_AFTER_DAYS = 30;
/** Minimum sample count — preferences below this threshold with low affinity are evicted */
const MIN_SAMPLE_EVICT_THRESHOLD = 2;

/**
 * Apply intelligent decay and eviction to a preference list.
 * - Preferences not updated for DECAY_START_DAYS start decaying (affinity *= DECAY_FACTOR per day)
 * - Preferences not updated for EVICT_AFTER_DAYS are evicted
 * - Preferences with very few samples AND negative/very low affinity are evicted
 */
function applyDecayAndEviction(prefs: TastePreference[]): TastePreference[] {
  const current = now();
  const result: TastePreference[] = [];

  for (const pref of prefs) {
    const lastUpdate = new Date(pref.last_updated);
    const daysSinceUpdate = (current.getTime() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24);

    // Evict: too old
    if (daysSinceUpdate >= EVICT_AFTER_DAYS) {
      continue;
    }

    // Evict: very few samples and negative/very low affinity (likely noise)
    if (pref.sample_count < MIN_SAMPLE_EVICT_THRESHOLD && pref.affinity < 0.1) {
      continue;
    }

    // Decay: apply diminishing affinity for stale preferences
    let effectiveAffinity = pref.affinity;
    if (daysSinceUpdate >= DECAY_START_DAYS) {
      const decayDays = daysSinceUpdate - DECAY_START_DAYS;
      effectiveAffinity = pref.affinity * Math.pow(DECAY_FACTOR, decayDays);
    }

    result.push({
      ...pref,
      affinity: effectiveAffinity,
    });
  }

  return result;
}

/**
 * Run the decay & eviction pass on all preference categories.
 * Should be called periodically (e.g. once per day) or before context building.
 */
export function runTasteDecay(taste: ContentTaste): ContentTaste {
  return {
    ...taste,
    hook_formulas: applyDecayAndEviction(taste.hook_formulas),
    visual_styles: applyDecayAndEviction(taste.visual_styles),
    tone_preferences: applyDecayAndEviction(taste.tone_preferences),
    engagement_drivers: applyDecayAndEviction(taste.engagement_drivers),
    angle_preferences: applyDecayAndEviction(taste.angle_preferences),
    topic_preferences: applyDecayAndEviction(taste.topic_preferences),
    persona_mode_preferences: applyDecayAndEviction(taste.persona_mode_preferences),
    // Anti-patterns also decay: remove entries older than EVICT_AFTER_DAYS
    anti_patterns: taste.anti_patterns.length > 0
      ? taste.anti_patterns.slice(0, MAX_ANTI_PATTERNS)
      : taste.anti_patterns,
  };
}

// ─── Main Update Function ─────────────────────────────────────────────────────

/**
 * Update content taste from a completed post analysis.
 * Called by post-analyzer after each analysis.
 */
export function updateTasteFromAnalysis(analysis: ContentAnalysis): void {
  let taste = loadContentTaste();
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

  // ── Angle preference — from hook_angle field ──
  if (analysis.hook_angle) {
    taste.angle_preferences = upsertPreference(taste.angle_preferences, analysis.hook_angle, affinity);
  }

  // ── Topic preferences — from topic_tags field ──
  if (analysis.topic_tags && analysis.topic_tags.length > 0) {
    for (const tag of analysis.topic_tags) {
      taste.topic_preferences = upsertPreference(taste.topic_preferences, tag, affinity);
    }
  }

  // ── Persona mode preference — identity_mode as persona mode dimension ──
  taste.persona_mode_preferences = upsertPreference(
    taste.persona_mode_preferences,
    analysis.identity_mode,
    affinity,
  );

  // Anti-patterns from improvement areas (only for below_avg content)
  if (analysis.performance_tier === 'below_avg') {
    for (const area of analysis.pattern_analysis.improvement_areas) {
      if (!taste.anti_patterns.includes(area)) {
        taste.anti_patterns = [...taste.anti_patterns, area].slice(-MAX_ANTI_PATTERNS);
      }
    }
  }

  // Run decay & eviction pass
  taste = runTasteDecay(taste);

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

  const strongAngles = taste.angle_preferences
    .filter(p => p.sample_count >= 2 && p.affinity > 0.3)
    .sort((a, b) => b.affinity - a.affinity)
    .slice(0, 5);

  const strongTopics = taste.topic_preferences
    .filter(p => p.sample_count >= 2 && p.affinity > 0.3)
    .sort((a, b) => b.affinity - a.affinity)
    .slice(0, 5);

  const strongPersonaModes = taste.persona_mode_preferences
    .filter(p => p.sample_count >= 2 && p.affinity > 0.3)
    .sort((a, b) => b.affinity - a.affinity)
    .slice(0, 3);

  const hasAnyData = strongHooks.length > 0
    || strongStyles.length > 0
    || strongDrivers.length > 0
    || strongAngles.length > 0
    || strongTopics.length > 0
    || strongPersonaModes.length > 0
    || taste.anti_patterns.length > 0;

  if (!hasAnyData) {
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
  if (strongAngles.length > 0) {
    parts.push(`- 高效角度: ${strongAngles.map(a => a.label).join('、')}`);
  }
  if (strongTopics.length > 0) {
    parts.push(`- 热门话题: ${strongTopics.map(t => t.label).join('、')}`);
  }
  if (strongPersonaModes.length > 0) {
    parts.push(`- 人设偏好: ${strongPersonaModes.map(m => m.label).join('、')}`);
  }
  if (taste.anti_patterns.length > 0) {
    parts.push(`- 避免: ${taste.anti_patterns.slice(0, 5).join('、')}`);
  }

  return parts.join('\n');
}
