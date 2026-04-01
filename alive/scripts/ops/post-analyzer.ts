/**
 * post-analyzer.ts
 * Per-post performance analysis — engagement scoring, tier classification,
 * pattern extraction, and persona alignment checking.
 * Triggered at T+24h after publish for every published content item.
 */

import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now } from '../utils/time-utils';
import {
  PerformanceMetrics, AnalysisLog, PerformanceTier,
} from '../utils/types';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_ANALYSIS_LOG: AnalysisLog = { entries: [], last_updated: '' };
const DEFAULT_BASELINE = 50;

// ─── Engagement Scoring ───────────────────────────────────────────────────────

export function computeEngagementScore(
  metrics: PerformanceMetrics,
  platform: 'xhs' | 'douyin',
): number {
  const likes = metrics.likes ?? 0;
  const comments = metrics.comments ?? 0;
  const saves = metrics.saves ?? 0;
  const shares = metrics.shares ?? 0;
  const views = metrics.views ?? 0;

  if (platform === 'douyin') {
    return likes * 1.0 + comments * 2.0 + saves * 3.0 + shares * 5.0 + views * 0.01;
  }
  // XHS
  return likes * 1.0 + comments * 3.0 + saves * 5.0 + shares * 4.0;
}

// ─── Tier Classification ──────────────────────────────────────────────────────

export function classifyTier(score: number, baseline: number): PerformanceTier {
  const effectiveBaseline = baseline > 0 ? baseline : DEFAULT_BASELINE;
  if (score > effectiveBaseline * 2.0) return 'viral';
  if (score > effectiveBaseline * 1.3) return 'above_avg';
  if (score >= effectiveBaseline * 0.7) return 'normal';
  return 'below_avg';
}

// ─── Analysis Log I/O ─────────────────────────────────────────────────────────

export function loadAnalysisLog(): AnalysisLog {
  return readJSON<AnalysisLog>(PATHS.analysisLog, DEFAULT_ANALYSIS_LOG);
}

export function saveAnalysisLog(log: AnalysisLog): void {
  writeJSON(PATHS.analysisLog, { ...log, last_updated: now().toISOString() });
}
