/**
 * personality-drift.ts
 * P4-2: Personality Drift Detection Engine.
 *
 * Upgrades from passive modifier recording to active drift detection:
 * - detectDrift(): Compare recent behavior vs persona config baseline
 * - computeDriftScore(): Quantify deviation on a 0-10 scale
 * - decayModifiers(): Auto-decay old modifiers (7-day half-life)
 * - capModifiers(): Limit modifier count to MAX_MODIFIERS
 * - generateDriftWarning(): Alert when drift score exceeds threshold
 */

import { PATHS, readJSON, writeJSON, readText } from '../utils/file-utils';
import { now } from '../utils/time-utils';
import { loadPersona } from '../persona/persona-loader';
import type { PersonalityDrift, PersonalityModifier, HeartbeatLog, PersonaConfig } from '../utils/types';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum number of active modifiers before capping */
const MAX_MODIFIERS = 10;
/** Half-life in days for modifier decay */
const DECAY_HALF_LIFE_DAYS = 7;
/** Drift score threshold for generating a warning (0-10) */
const WARNING_THRESHOLD = 6.0;
/** Minimum modifier strength after decay before removal */
const MIN_STRENGTH = 0.1;
/** How many recent diary entries to analyze for drift detection */
const RECENT_DIARY_LINES = 50;
/** How many recent heartbeat logs to analyze */
const RECENT_LOG_COUNT = 24;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DriftAnalysis {
  /** Current drift score (0-10) */
  score: number;
  /** Direction of primary drift */
  direction: string;
  /** Specific traits showing drift */
  drifting_traits: DriftingTrait[];
  /** Warning message if threshold exceeded, null otherwise */
  warning: string | null;
  /** Timestamp of analysis */
  analyzed_at: string;
}

export interface DriftingTrait {
  trait: string;
  /** How far the trait has drifted from baseline (0-10) */
  deviation: number;
  /** Evidence from recent behavior */
  evidence: string;
}

export interface DriftReport {
  analysis: DriftAnalysis;
  /** Modifiers after decay and cap */
  modifiers_after: PersonalityModifier[];
  /** Number of modifiers removed by decay */
  decayed_count: number;
  /** Number of modifiers removed by cap */
  capped_count: number;
}

// ─── I/O ────────────────────────────────────────────────────────────────────

export function loadPersonalityDrift(): PersonalityDrift {
  const persona = loadPersona();
  return readJSON<PersonalityDrift>(PATHS.personalityDrift, {
    base: persona.personality.mbti,
    modifiers: [],
  });
}

export function savePersonalityDrift(drift: PersonalityDrift): void {
  writeJSON(PATHS.personalityDrift, drift);
}

// ─── Modifier Decay ─────────────────────────────────────────────────────────

/**
 * Decay all modifiers based on their age using exponential decay.
 * Half-life = DECAY_HALF_LIFE_DAYS.
 * Removes modifiers whose strength drops below MIN_STRENGTH.
 *
 * @returns [surviving modifiers, count of decayed/removed modifiers]
 */
export function decayModifiers(modifiers: PersonalityModifier[]): [PersonalityModifier[], number] {
  const currentTime = now();
  const decayConstant = Math.LN2 / (DECAY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000);
  let removedCount = 0;

  const surviving = modifiers.map(m => {
    // Try to extract date from origin field (e.g., "night-reflect 2026-03-25")
    const dateMatch = m.origin.match(/\d{4}-\d{2}-\d{2}/);
    if (!dateMatch) return m; // No date info → no decay

    const originTime = new Date(dateMatch[0]).getTime();
    const elapsed = currentTime.getTime() - originTime;
    if (elapsed <= 0) return m;

    const decayFactor = Math.exp(-decayConstant * elapsed);
    const newStrength = m.strength * decayFactor;

    return { ...m, strength: Math.round(newStrength * 100) / 100 };
  }).filter(m => {
    if (Math.abs(m.strength) < MIN_STRENGTH) {
      removedCount++;
      return false;
    }
    return true;
  });

  return [surviving, removedCount];
}

// ─── Modifier Cap ───────────────────────────────────────────────────────────

/**
 * Cap modifiers to MAX_MODIFIERS.
 * Keeps highest-strength modifiers.
 *
 * @returns [capped modifiers, count of removed modifiers]
 */
export function capModifiers(modifiers: PersonalityModifier[]): [PersonalityModifier[], number] {
  if (modifiers.length <= MAX_MODIFIERS) {
    return [modifiers, 0];
  }

  const sorted = [...modifiers].sort((a, b) => Math.abs(b.strength) - Math.abs(a.strength));
  const kept = sorted.slice(0, MAX_MODIFIERS);
  return [kept, modifiers.length - MAX_MODIFIERS];
}

// ─── Drift Score Computation ────────────────────────────────────────────────

/**
 * Compute a drift score (0-10) based on the aggregate strength of all modifiers.
 * Uses the sum of absolute strengths, normalized to a 0-10 scale.
 */
export function computeDriftScore(modifiers: PersonalityModifier[]): number {
  if (modifiers.length === 0) return 0;

  const totalStrength = modifiers.reduce((sum, m) => sum + Math.abs(m.strength), 0);
  // Normalize: each modifier contributes up to ~1.0 strength typically
  // Score scale: 0 modifiers = 0, ~10 modifiers at strength 1.0 each = 10
  const score = Math.min(10, totalStrength);
  return Math.round(score * 100) / 100;
}

// ─── Drift Detection ────────────────────────────────────────────────────────

/**
 * Detect personality drift by comparing recent behavior with persona baseline.
 * Returns a DriftAnalysis with quantified deviation.
 *
 * @param persona - Optional persona config (loads from disk if omitted)
 * @param modifiers - Optional modifiers to analyze (loads from disk if omitted).
 *                    Pass directly when modifiers have been modified in-memory
 *                    but not yet saved, to avoid write-then-read coupling.
 */
export function detectDrift(persona?: PersonaConfig, modifiers?: PersonalityModifier[]): DriftAnalysis {
  const p = persona ?? loadPersona();
  const mods = modifiers ?? loadPersonalityDrift().modifiers;
  const timestamp = now().toISOString();

  // Analyze modifiers for trait-level drift
  const traitMap = new Map<string, { totalStrength: number; effects: string[] }>();

  for (const m of mods) {
    const existing = traitMap.get(m.trait) ?? { totalStrength: 0, effects: [] };
    existing.totalStrength += m.strength;
    existing.effects.push(m.effect);
    traitMap.set(m.trait, existing);
  }

  const drifting_traits: DriftingTrait[] = [];
  for (const [trait, data] of traitMap) {
    const deviation = Math.min(10, Math.abs(data.totalStrength));
    if (deviation >= 1.0) {
      drifting_traits.push({
        trait,
        deviation: Math.round(deviation * 100) / 100,
        evidence: data.effects.slice(0, 3).join('；'),
      });
    }
  }

  // Sort by deviation desc
  drifting_traits.sort((a, b) => b.deviation - a.deviation);

  const score = computeDriftScore(mods);
  const direction = drifting_traits.length > 0
    ? drifting_traits[0].trait
    : 'none';

  const warning = score >= WARNING_THRESHOLD
    ? generateDriftWarning(p, score, drifting_traits)
    : null;

  return {
    score,
    direction,
    drifting_traits,
    warning,
    analyzed_at: timestamp,
  };
}

// ─── Warning Generation ─────────────────────────────────────────────────────

/**
 * Generate a human-readable drift warning.
 */
export function generateDriftWarning(
  persona: PersonaConfig,
  score: number,
  traits: DriftingTrait[],
): string {
  const parts: string[] = [];
  parts.push(`⚠️ 人设漂移预警 (偏离度: ${score.toFixed(1)}/10)`);
  parts.push(`基准人设: ${persona.personality.mbti}，核心特质: ${persona.personality.core_traits.join('、')}`);

  if (traits.length > 0) {
    parts.push('主要偏移:');
    for (const t of traits.slice(0, 3)) {
      parts.push(`  • ${t.trait} (偏离: ${t.deviation.toFixed(1)}) — ${t.evidence}`);
    }
  }

  if (score >= 8) {
    parts.push('建议: 需要立即校正人设方向，回归核心特质');
  } else {
    parts.push('建议: 注意内容调性，适度回归基准人设');
  }

  return parts.join('\n');
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Run the full personality drift analysis pipeline.
 * Called during night-reflect.
 *
 * Flow:
 * 1. Load or use provided modifiers
 * 2. Decay old modifiers
 * 3. Cap to maximum count
 * 4. Detect trait-level drift
 * 5. Generate warning if needed
 * 6. Save updated drift state
 *
 * @param persona - Optional persona config (loads from disk if omitted)
 * @param existingDrift - Optional in-memory drift state (e.g. with a freshly
 *                        appended modifier from night-reflect). When provided,
 *                        skips loading from disk, avoiding double-write issues.
 */
export function runDriftAnalysis(persona?: PersonaConfig, existingDrift?: PersonalityDrift): DriftReport {
  const p = persona ?? loadPersona();
  const drift = existingDrift ?? loadPersonalityDrift();

  // 1. Decay
  const [afterDecay, decayedCount] = decayModifiers(drift.modifiers);

  // 2. Cap
  const [afterCap, cappedCount] = capModifiers(afterDecay);

  // 3. Detect drift using the processed modifiers directly (no write-then-read)
  const analysis = detectDrift(p, afterCap);

  // 4. Save updated modifiers after analysis
  const updatedDrift: PersonalityDrift = {
    ...drift,
    modifiers: afterCap,
  };
  savePersonalityDrift(updatedDrift);

  return {
    analysis,
    modifiers_after: afterCap,
    decayed_count: decayedCount,
    capped_count: cappedCount,
  };
}

// ─── Context Builders ───────────────────────────────────────────────────────

/**
 * Build drift context string for heartbeat-tick prompt injection.
 * Enhanced version of the existing simple context.
 */
export function buildDriftContext(persona?: PersonaConfig): string {
  const p = persona ?? loadPersona();
  const drift = loadPersonalityDrift();

  const base = `${p.personality.mbti}基底`;
  if (drift.modifiers.length === 0) {
    return `${base}。人设稳定，无偏移。`;
  }

  const modifierEffects = drift.modifiers
    .sort((a, b) => Math.abs(b.strength) - Math.abs(a.strength))
    .slice(0, 5)
    .map(m => m.effect)
    .join('；');

  const score = computeDriftScore(drift.modifiers);
  const scoreLabel = score < 3 ? '轻微' : score < 6 ? '中度' : '显著';

  return `${base}。${modifierEffects}（${scoreLabel}偏移: ${score.toFixed(1)}/10）`;
}

/**
 * Build a drift warning section for the daily brief.
 * Returns empty string if no warning needed.
 */
export function buildDriftBriefSection(): string {
  try {
    const drift = loadPersonalityDrift();
    const score = computeDriftScore(drift.modifiers);

    if (score < WARNING_THRESHOLD) return '';

    const persona = loadPersona();
    const analysis = detectDrift(persona);
    if (!analysis.warning) return '';

    return analysis.warning;
  } catch {
    return '';
  }
}
