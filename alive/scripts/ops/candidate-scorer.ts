/**
 * candidate-scorer.ts
 * Pure-function composite scoring for candidate benchmark accounts.
 * Score = track_overlap × 0.45 + burst_intensity × 0.35 + frequency × 0.20
 */

import type { CandidateAccount, CandidateAccountsStore } from './discovery-engine';

export interface ScoredCandidate extends CandidateAccount {
  score_breakdown: {
    track_overlap: number;    // 0–1  赛道重叠率
    burst_intensity: number;  // 0–1  爆发强度
    frequency: number;        // 0–1  出现频率
    composite: number;        // 0–1  综合分
  };
}

// ─── Identity keyword table ────────────────────────────────────────────────────

const IDENTITY_KEYWORDS: Record<string, string[]> = {
  singer:  ['音乐', '唱歌', '歌曲', 'vocal', '翻唱', '原创', 'mv', '歌手', '单曲'],
  racer:   ['赛车', '漂移', '赛道', 'motorsport', 'gt', '超跑', '驾驶', '改装'],
  esports: ['电竞', '游戏', '直播', '战队', '解说', 'fps', 'moba', '比赛'],
  daily:   ['日常', 'vlog', '生活', '穿搭', '美食', '旅行', '打卡', '探店'],
};

// ─── Weights ───────────────────────────────────────────────────────────────────

const WEIGHT_TRACK_OVERLAP   = 0.45;
const WEIGHT_BURST_INTENSITY = 0.35;
const WEIGHT_FREQUENCY       = 0.20;

// ─── Sub-calculators (pure functions) ─────────────────────────────────────────

function calcTrackOverlap(topics: string[], identityKeys: string[]): number {
  if (identityKeys.length === 0) return 0.5;
  const hitKeys = new Set<string>();
  for (const topic of topics) {
    const lowerTopic = topic.toLowerCase();
    for (const key of identityKeys) {
      const keywords = IDENTITY_KEYWORDS[key] ?? [];
      const matched = keywords.some(kw => lowerTopic.includes(kw.toLowerCase()));
      if (matched) hitKeys.add(key);
    }
  }
  return hitKeys.size / identityKeys.length;
}

function calcBurstIntensity(candidate: CandidateAccount): number {
  const peak = (candidate as { peak_engagement?: number }).peak_engagement ?? candidate.avg_engagement;
  const avg  = Math.max(candidate.avg_engagement, 1);
  const ratio = Math.min(peak / avg, 5);
  return ratio / 5;
}

function calcFrequency(appearanceCount: number): number {
  return Math.min(appearanceCount / 5, 1);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Score a single candidate account (pure function, safe to unit-test directly).
 * peerCandidates is reserved for future percentile-based scoring; currently unused.
 */
export function scoreCandidateAccount(
  candidate: CandidateAccount,
  identityKeys: string[],
  _peerCandidates: CandidateAccount[],
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
  statusFilter?: 'pending' | 'approved' | 'dismissed',
): ScoredCandidate[] {
  const filtered = statusFilter
    ? store.candidates.filter(c => c.status === statusFilter)
    : store.candidates;

  return filtered
    .map(c => scoreCandidateAccount(c, identityKeys, filtered))
    .sort((a, b) => b.score_breakdown.composite - a.score_breakdown.composite);
}
