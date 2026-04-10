/**
 * candidate-scorer.ts
 * Pure-function composite scoring for candidate benchmark accounts.
 * Score = track_overlap × 0.45 + burst_intensity × 0.35 + frequency × 0.20
 */

import type { CandidateAccount, CandidateAccountsStore } from './discovery-engine';
import { IDENTITY_TOPIC_KEYWORDS } from './ops-taxonomy';
import type { CandidateStatus } from '../utils/types';

export interface ScoredCandidate extends CandidateAccount {
  score_breakdown: {
    track_overlap: number;    // 0–1  赛道重叠率
    burst_intensity: number;  // 0–1  爆发强度
    frequency: number;        // 0–1  出现频率
    composite: number;        // 0–1  综合分
  };
}

// Pre-computed lowercase keyword table for hot-path matching
const IDENTITY_KEYWORDS_LOWER: Record<string, string[]> = Object.fromEntries(
  Object.entries(IDENTITY_TOPIC_KEYWORDS).map(([k, v]) => [k, v.map(kw => kw.toLowerCase())]),
);

// ─── Weights ───────────────────────────────────────────────────────────────────

const WEIGHT_TRACK_OVERLAP   = 0.45;
const WEIGHT_BURST_INTENSITY = 0.35;
const WEIGHT_FREQUENCY       = 0.20;

const BURST_CAP_RATIO           = 5;  // peak/avg ratio that saturates burst score
const FREQUENCY_SATURATION_COUNT = 5; // appearances needed to reach frequency = 1.0

// ─── Sub-calculators (pure functions) ─────────────────────────────────────────

function calcTrackOverlap(topics: string[], identityKeys: string[]): number {
  if (identityKeys.length === 0) return 0.5;
  const hitKeys = new Set<string>();
  for (const topic of topics) {
    const lowerTopic = topic.toLowerCase();
    for (const key of identityKeys) {
      const keywords = IDENTITY_KEYWORDS_LOWER[key] ?? [];
      const matched = keywords.some(kw => lowerTopic.includes(kw));
      if (matched) hitKeys.add(key);
    }
  }
  return hitKeys.size / identityKeys.length;
}

function calcBurstIntensity(candidate: CandidateAccount): number {
  const peak = candidate.peak_engagement ?? candidate.avg_engagement;
  const avg  = Math.max(candidate.avg_engagement, 1);
  const ratio = Math.min(peak / avg, BURST_CAP_RATIO);
  return ratio / BURST_CAP_RATIO;
}

function calcFrequency(appearanceCount: number): number {
  return Math.min(appearanceCount / FREQUENCY_SATURATION_COUNT, 1);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Score a single candidate account (pure function, safe to unit-test directly).
 */
export function scoreCandidateAccount(
  candidate: CandidateAccount,
  identityKeys: string[],
): ScoredCandidate {
  const track_overlap   = calcTrackOverlap(candidate.topics, identityKeys);
  const burst_intensity = calcBurstIntensity(candidate);
  const frequency       = calcFrequency(candidate.appearance_count);
  const composite =
    track_overlap   * WEIGHT_TRACK_OVERLAP   +
    burst_intensity * WEIGHT_BURST_INTENSITY +
    frequency       * WEIGHT_FREQUENCY;

  return {
    ...candidate,
    score_breakdown: { track_overlap, burst_intensity, frequency, composite },
  };
}

/**
 * Score and rank all candidates in a store.
 * Returns candidates sorted by composite score descending.
 */
export function rankCandidates(
  store: CandidateAccountsStore,
  identityKeys: string[],
  statusFilter?: CandidateStatus,
): ScoredCandidate[] {
  const filtered = statusFilter
    ? store.candidates.filter(c => c.status === statusFilter)
    : store.candidates;

  return filtered
    .map(c => scoreCandidateAccount(c, identityKeys))
    .sort((a, b) => b.score_breakdown.composite - a.score_breakdown.composite);
}
