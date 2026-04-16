/**
 * operator-preference.ts
 * Learns operator preferences from review feedback using EMA smoothing.
 *
 * The profile captures:
 * - preferred_angles: content angles/directions the operator consistently approves
 * - avoided_topics: topics/patterns the operator consistently discards
 * - common_edit_directions: recurring edit instructions (e.g. "标题要更抓人")
 * - preferred_identity_modes: identity modes with higher approval rates
 * - tone_corrections: recurring persona-drift corrections
 *
 * Updated after each addReviewFeedback() call; consumed by topic-generator
 * and brief-generator for personalized context injection.
 *
 * Storage: {MEMORY_BASE}/state/operator-preference.json
 */

import * as path from 'path';
import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import type { QueueItem, QueueItemReviewFeedback } from '../utils/types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PreferenceSignal {
  label: string;
  /** Affinity: -1.0 (strong dislike) to 1.0 (strong preference) */
  affinity: number;
  /** Number of observations contributing to this signal */
  sample_count: number;
  last_updated: string;
}

export interface OperatorPreferenceProfile {
  /** Content angles/directions the operator favours */
  preferred_angles: PreferenceSignal[];
  /** Topics or patterns the operator tends to discard */
  avoided_topics: PreferenceSignal[];
  /** Recurring edit instruction themes */
  common_edit_directions: PreferenceSignal[];
  /** Identity modes ranked by approval rate */
  identity_mode_affinity: PreferenceSignal[];
  /** Persona-drift corrections the operator keeps flagging */
  tone_corrections: string[];
  last_updated: string;
}

export const DEFAULT_PREFERENCE_PROFILE: OperatorPreferenceProfile = {
  preferred_angles: [],
  avoided_topics: [],
  common_edit_directions: [],
  identity_mode_affinity: [],
  tone_corrections: [],
  last_updated: '',
};

// ─── EMA config ──────────────────────────────────────────────────────────────

/** Exponential moving average alpha — higher = more weight on recent data */
const EMA_ALPHA = 0.3;
/** Max signals per category (trim oldest when exceeded) */
const MAX_SIGNALS = 20;
/** Max tone corrections to keep */
const MAX_TONE_CORRECTIONS = 10;

// ─── Persistence ─────────────────────────────────────────────────────────────

function getPreferencePath(): string {
  return path.join(path.dirname(PATHS.contentStrategy), 'operator-preference.json');
}

export function loadPreference(): OperatorPreferenceProfile {
  return readJSON<OperatorPreferenceProfile>(getPreferencePath(), DEFAULT_PREFERENCE_PROFILE);
}

export function savePreference(profile: OperatorPreferenceProfile): void {
  writeJSON(getPreferencePath(), profile);
}

// ─── EMA Update Logic ────────────────────────────────────────────────────────

function upsertSignal(
  signals: PreferenceSignal[],
  label: string,
  newAffinity: number,
  ts: string,
): PreferenceSignal[] {
  const existing = signals.find(s => s.label === label);
  if (existing) {
    // EMA update
    existing.affinity = EMA_ALPHA * newAffinity + (1 - EMA_ALPHA) * existing.affinity;
    existing.sample_count += 1;
    existing.last_updated = ts;
    return signals;
  }

  // New signal
  signals.push({ label, affinity: newAffinity, sample_count: 1, last_updated: ts });

  // Trim to max: remove lowest sample_count entries
  if (signals.length > MAX_SIGNALS) {
    signals.sort((a, b) => b.sample_count - a.sample_count);
    signals.length = MAX_SIGNALS;
  }

  return signals;
}

// ─── Core: Update Preference from Feedback ───────────────────────────────────

/**
 * Update the operator preference profile based on a single review feedback event.
 * Should be called after `addReviewFeedback()`.
 */
export function updatePreferenceFromFeedback(
  item: QueueItem,
  feedback: QueueItemReviewFeedback,
): void {
  const profile = loadPreference();
  const ts = new Date().toISOString();

  const decision = feedback.decision;

  // 1. Identity mode affinity
  if (item.identity_mode) {
    const affinityDelta = decision === 'approved' ? 0.8
      : decision === 'discarded' ? -0.6
      : 0; // edit_requested is neutral
    if (affinityDelta !== 0) {
      upsertSignal(profile.identity_mode_affinity, item.identity_mode, affinityDelta, ts);
    }
  }

  // 2. Content angle / topic preference
  if (decision === 'approved' && feedback.reason_summary) {
    upsertSignal(profile.preferred_angles, feedback.reason_summary, 0.7, ts);
  }

  if (decision === 'discarded' && feedback.reason_summary) {
    upsertSignal(profile.avoided_topics, feedback.reason_summary, 0.7, ts);
  }

  // 3. Edit directions (from edit_requested feedback)
  if (decision === 'edit_requested' && feedback.improvement_directions) {
    for (const dir of feedback.improvement_directions) {
      upsertSignal(profile.common_edit_directions, dir, 0.6, ts);
    }
  }

  // 4. Persona deviation → tone corrections
  if (feedback.persona_deviation_tags && feedback.persona_deviation_tags.length > 0) {
    for (const tag of feedback.persona_deviation_tags) {
      if (!profile.tone_corrections.includes(tag)) {
        profile.tone_corrections.push(tag);
      }
    }
    // Trim
    if (profile.tone_corrections.length > MAX_TONE_CORRECTIONS) {
      profile.tone_corrections = profile.tone_corrections.slice(-MAX_TONE_CORRECTIONS);
    }
  }

  profile.last_updated = ts;
  savePreference(profile);
}

// ─── Context Builder for LLM Prompt Injection ────────────────────────────────

/**
 * Build a natural-language preference context string for LLM prompt injection.
 * Returns '' if profile is empty (cold-start safe).
 */
export function buildPreferenceContext(options?: {
  maxAngles?: number;
  maxAvoid?: number;
  maxEdits?: number;
}): string {
  const profile = loadPreference();
  const maxAngles = options?.maxAngles ?? 5;
  const maxAvoid = options?.maxAvoid ?? 5;
  const maxEdits = options?.maxEdits ?? 3;

  const parts: string[] = [];

  // Preferred angles (sorted by affinity desc)
  const topAngles = [...profile.preferred_angles]
    .filter(s => s.affinity > 0.2)
    .sort((a, b) => b.affinity - a.affinity)
    .slice(0, maxAngles);
  if (topAngles.length > 0) {
    parts.push(`✅ 运营偏好方向：${topAngles.map(s => s.label).join('；')}`);
  }

  // Avoided topics (sorted by affinity desc — higher affinity = more avoided)
  const topAvoid = [...profile.avoided_topics]
    .filter(s => s.affinity > 0.2)
    .sort((a, b) => b.affinity - a.affinity)
    .slice(0, maxAvoid);
  if (topAvoid.length > 0) {
    parts.push(`❌ 运营回避方向：${topAvoid.map(s => s.label).join('；')}`);
  }

  // Common edit directions
  const topEdits = [...profile.common_edit_directions]
    .filter(s => s.sample_count >= 2)
    .sort((a, b) => b.sample_count - a.sample_count)
    .slice(0, maxEdits);
  if (topEdits.length > 0) {
    parts.push(`🔄 高频修改方向：${topEdits.map(s => s.label).join('；')}`);
  }

  // Identity mode preferences
  const modePrefs = [...profile.identity_mode_affinity]
    .sort((a, b) => b.affinity - a.affinity);
  const topModes = modePrefs.filter(s => s.affinity > 0.2).slice(0, 3);
  const lowModes = modePrefs.filter(s => s.affinity < -0.2).slice(0, 2);
  if (topModes.length > 0) {
    parts.push(`🎯 偏好身份：${topModes.map(s => s.label).join('、')}`);
  }
  if (lowModes.length > 0) {
    parts.push(`⚠️ 低通过率身份：${lowModes.map(s => s.label).join('、')}`);
  }

  // Tone corrections
  if (profile.tone_corrections.length > 0) {
    parts.push(`🎭 人设偏移警告：${profile.tone_corrections.slice(-3).join('、')}`);
  }

  if (parts.length === 0) return '';

  return `【运营偏好画像】\n${parts.join('\n')}`;
}

/**
 * Get raw preference signals for a specific category.
 * Useful for proactive advisor rules.
 */
export function getPreferenceSignals(
  category: 'preferred_angles' | 'avoided_topics' | 'common_edit_directions' | 'identity_mode_affinity',
): PreferenceSignal[] {
  const profile = loadPreference();
  return profile[category];
}
