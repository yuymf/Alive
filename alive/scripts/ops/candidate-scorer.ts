/**
 * candidate-scorer.ts
 * Pure-function composite scoring for candidate benchmark accounts.
 *
 * Score = track_overlap × 0.30 + burst_intensity × 0.25 + frequency × 0.15
 *       + account_freshness × 0.15 + data_stability × 0.15
 *
 * Dimensions:
 *   track_overlap    (0.30) — 赛道重叠率: candidate topics match persona identity tracks
 *   burst_intensity  (0.25) — 爆发强度: peak / avg engagement ratio (近期爆款)
 *   frequency        (0.15) — 出现频率: how often the author appears in high-engagement content
 *   account_freshness(0.15) — 起号新鲜度: recently-started accounts score higher (近两年起号)
 *   data_stability   (0.15) — 数据稳定性: low CV = consistent engagement (数据稳定)
 */

import type { CandidateAccount, CandidateAccountsStore } from './discovery-engine';
import { IDENTITY_TOPIC_KEYWORDS } from './ops-taxonomy';
import type { CandidateStatus } from '../utils/types';
import { readTunableJSON } from '../utils/file-utils';

export interface ScoredCandidate extends CandidateAccount {
  score_breakdown: {
    track_overlap: number;     // 0–1  赛道重叠率
    burst_intensity: number;   // 0–1  爆发强度
    frequency: number;         // 0–1  出现频率
    account_freshness: number; // 0–1  起号新鲜度
    data_stability: number;    // 0–1  数据稳定性
    composite: number;         // 0–1  综合分
  };
}

// Pre-computed lowercase keyword table for hot-path matching
const IDENTITY_KEYWORDS_LOWER: Record<string, string[]> = Object.fromEntries(
  Object.entries(IDENTITY_TOPIC_KEYWORDS).map(([k, v]) => [k, v.map(kw => kw.toLowerCase())]),
);

// ─── Weights ───────────────────────────────────────────────────────────────────
// Tunable override: harness/tunable/prompts/ops/candidate-scorer.weights.json
// Schema: { weights: { track_overlap, burst_intensity, frequency, account_freshness, data_stability },
//           burstCapRatio?: number,
//           frequencySaturationCount?: number,
//           freshnessWindowDays?: number }
// Weights SHOULD sum to ~1.0 (not enforced — caller is trusted) and MUST all be non-negative.

interface CandidateScorerTunable {
  weights?: Partial<Record<
    'track_overlap' | 'burst_intensity' | 'frequency' | 'account_freshness' | 'data_stability',
    number
  >>;
  burstCapRatio?: number;
  frequencySaturationCount?: number;
  freshnessWindowDays?: number;
}

const DEFAULT_WEIGHTS = {
  track_overlap: 0.30,
  burst_intensity: 0.25,
  frequency: 0.15,
  account_freshness: 0.15,
  data_stability: 0.15,
} as const;

const DEFAULT_BURST_CAP_RATIO = 5;
const DEFAULT_FREQUENCY_SATURATION_COUNT = 5;
const DEFAULT_FRESHNESS_WINDOW_DAYS = 730; // 2 years

type ScorerWeights = Record<
  'track_overlap' | 'burst_intensity' | 'frequency' | 'account_freshness' | 'data_stability',
  number
>;

interface ResolvedScorerConfig {
  weights: ScorerWeights;
  burstCapRatio: number;
  frequencySaturationCount: number;
  freshnessWindowDays: number;
}

function coerceNonNegative(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function coercePositive(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Resolve the effective scorer config: tunable JSON overrides defaults field-by-field.
 * Exported for tests; callers in hot path use `getScorerConfig()`.
 */
export function resolveScorerConfig(
  override?: CandidateScorerTunable | null,
): ResolvedScorerConfig {
  const src = override ?? {};
  const ow = src.weights ?? {};
  return {
    weights: {
      track_overlap: coerceNonNegative(ow.track_overlap, DEFAULT_WEIGHTS.track_overlap),
      burst_intensity: coerceNonNegative(ow.burst_intensity, DEFAULT_WEIGHTS.burst_intensity),
      frequency: coerceNonNegative(ow.frequency, DEFAULT_WEIGHTS.frequency),
      account_freshness: coerceNonNegative(ow.account_freshness, DEFAULT_WEIGHTS.account_freshness),
      data_stability: coerceNonNegative(ow.data_stability, DEFAULT_WEIGHTS.data_stability),
    },
    burstCapRatio: coercePositive(src.burstCapRatio, DEFAULT_BURST_CAP_RATIO),
    frequencySaturationCount: coercePositive(src.frequencySaturationCount, DEFAULT_FREQUENCY_SATURATION_COUNT),
    freshnessWindowDays: coercePositive(src.freshnessWindowDays, DEFAULT_FRESHNESS_WINDOW_DAYS),
  };
}

let _cachedConfig: ResolvedScorerConfig | null = null;

function getScorerConfig(): ResolvedScorerConfig {
  if (_cachedConfig) return _cachedConfig;
  const override = readTunableJSON<CandidateScorerTunable>('ops/candidate-scorer.weights.json');
  _cachedConfig = resolveScorerConfig(override);
  return _cachedConfig;
}

/** Test helper: force re-read of tunable on next access. */
export function resetScorerConfigCache(): void {
  _cachedConfig = null;
}

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

function calcBurstIntensity(candidate: CandidateAccount, burstCapRatio = DEFAULT_BURST_CAP_RATIO): number {
  const peak = candidate.peak_engagement ?? candidate.avg_engagement;
  const avg  = Math.max(candidate.avg_engagement, 1);
  const ratio = Math.min(peak / avg, burstCapRatio);
  return ratio / burstCapRatio;
}

function calcFrequency(appearanceCount: number, saturationCount = DEFAULT_FREQUENCY_SATURATION_COUNT): number {
  return Math.min(appearanceCount / saturationCount, 1);
}

/**
 * Account freshness: recently-started accounts score higher.
 * Uses first_seen as a proxy for when the account started being active.
 * - Within freshnessWindowDays (default 730 ≈ 2 years) → 1.0
 * - Beyond that, linearly decays to 0 over another freshnessWindowDays
 * - Unknown/empty first_seen → neutral 0.5
 */
function calcAccountFreshness(firstSeen: string | undefined, windowDays = DEFAULT_FRESHNESS_WINDOW_DAYS): number {
  if (!firstSeen) return 0.5; // unknown — neutral score
  try {
    const firstSeenDate = new Date(firstSeen);
    const nowMs = Date.now();
    const daysSince = (nowMs - firstSeenDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince <= windowDays) return 1.0;
    // Linear decay from 1.0 → 0.0 over the next windowDays
    const decay = Math.max(0, 1 - (daysSince - windowDays) / windowDays);
    return decay;
  } catch {
    return 0.5;
  }
}

/**
 * Data stability: low engagement CV = consistent output quality.
 * Inverse of content_driven_factor:
 *   - content_driven_factor ≈ 0 → engagement is stable → stability = 1.0
 *   - content_driven_factor ≈ 1 → engagement is volatile → stability = 0.0
 * If content_driven_factor is not computed, use burst_intensity as inverse proxy.
 */
function calcDataStability(candidate: CandidateAccount, burstCapRatio = DEFAULT_BURST_CAP_RATIO): number {
  if (candidate.content_driven_factor !== undefined) {
    return 1 - candidate.content_driven_factor;
  }
  // Fallback: low burst = high stability
  return 1 - calcBurstIntensity(candidate, burstCapRatio);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Score a single candidate account (pure function, safe to unit-test directly).
 */
export function scoreCandidateAccount(
  candidate: CandidateAccount,
  identityKeys: string[],
): ScoredCandidate {
  const cfg = getScorerConfig();
  const track_overlap    = calcTrackOverlap(candidate.topics, identityKeys);
  const burst_intensity  = calcBurstIntensity(candidate, cfg.burstCapRatio);
  const frequency        = calcFrequency(candidate.appearance_count, cfg.frequencySaturationCount);
  const account_freshness = calcAccountFreshness(candidate.first_seen, cfg.freshnessWindowDays);
  const data_stability   = calcDataStability(candidate, cfg.burstCapRatio);
  const composite =
    track_overlap     * cfg.weights.track_overlap     +
    burst_intensity   * cfg.weights.burst_intensity   +
    frequency         * cfg.weights.frequency         +
    account_freshness * cfg.weights.account_freshness +
    data_stability    * cfg.weights.data_stability;

  return {
    ...candidate,
    score_breakdown: { track_overlap, burst_intensity, frequency, account_freshness, data_stability, composite },
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
