/**
 * audience-perception.ts
 * Stores and queries structured audience perception entries.
 * Each entry captures how the audience perceives a published content item
 * and, by extension, the virtual persona behind it.
 *
 * Storage: queues/audience-perception.json
 * Primary producer: post-analyzer.ts (after LLM analysis of comments/metrics)
 * Primary consumers: brief-generator.ts, strategy-engine.ts, topic-generator.ts
 */

import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now, wallNow } from '../utils/time-utils';
import {
  AudiencePerceptionEntry,
  AudiencePerceptionStore,
  PerformanceEntry,
  CommentInsights,
} from '../utils/types';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_STORE: AudiencePerceptionStore = { entries: [], last_updated: '' };
const MAX_ENTRIES = 50; // Retention cap

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function loadAudiencePerception(): AudiencePerceptionStore {
  return readJSON<AudiencePerceptionStore>(PATHS.audiencePerception, DEFAULT_STORE);
}

export function saveAudiencePerception(store: AudiencePerceptionStore): void {
  writeJSON(PATHS.audiencePerception, {
    ...store,
    last_updated: wallNow().toISOString(),
  });
}

// ─── Build Entry ──────────────────────────────────────────────────────────────

/**
 * Build an audience perception entry from a performance entry and its comment analysis.
 * Pure function — no side effects.
 *
 * If no comment_analysis exists on the performance entry, falls back to
 * the aggregated CommentInsights (which may come from cross-item aggregation).
 */
export function buildAudiencePerceptionEntry(input: {
  item_id: string;
  platform: 'xhs' | 'douyin';
  identity_mode: string;
  comment_analysis?: PerformanceEntry['comment_analysis'];
  aggregatedInsights?: CommentInsights | null;
  /** Optional LLM-derived summary (if available) */
  llmSummary?: string;
}): AudiencePerceptionEntry {
  const ca = input.comment_analysis;
  const agg = input.aggregatedInsights;

  // Derive perceived traits from top keywords
  const perceivedTraits = ca?.top_keywords ?? agg?.topKeywords ?? [];

  // Emotional keywords: take top keywords that indicate emotion
  const emotionalKeywords = perceivedTraits.slice(0, 8);

  // Desire signals come from constructive feedback
  const desireSignals = ca?.constructive_feedback ?? agg?.constructiveFeedback ?? [];

  // Resistance signals: infer from negative_ratio if available
  const resistanceSignals: string[] = [];
  if (ca && ca.negative_ratio > 0.3) {
    resistanceSignals.push('负面反馈偏高');
  }

  const summary = input.llmSummary
    ?? (perceivedTraits.length > 0
      ? `受众将其视为：${perceivedTraits.slice(0, 5).join('、')}`
      : '暂无足够受众反馈');

  return {
    item_id: input.item_id,
    platform: input.platform,
    identity_mode: input.identity_mode,
    generated_at: now().toISOString(),
    summary,
    perceived_traits: perceivedTraits.slice(0, 10),
    emotional_keywords: emotionalKeywords,
    desire_signals: desireSignals.slice(0, 8),
    resistance_signals: resistanceSignals.slice(0, 5),
    representative_comments: [],
    source_refs: ca ? [`comment_analysis:${input.item_id}`] : [],
  };
}

// ─── Upsert ───────────────────────────────────────────────────────────────────

/**
 * Upsert an audience perception entry.
 * If an entry with the same item_id + platform exists, it is replaced.
 * Otherwise, the entry is appended.
 * Automatically caps the store to MAX_ENTRIES (keeps the most recent).
 */
export function upsertAudiencePerceptionEntry(entry: AudiencePerceptionEntry): AudiencePerceptionStore {
  const store = loadAudiencePerception();
  const key = (e: AudiencePerceptionEntry) => `${e.item_id}:${e.platform}`;

  const existingIdx = store.entries.findIndex(e => key(e) === key(entry));

  let updatedEntries: AudiencePerceptionEntry[];
  if (existingIdx >= 0) {
    updatedEntries = store.entries.map((e, i) => i === existingIdx ? entry : e);
  } else {
    updatedEntries = [...store.entries, entry];
  }

  // Sort by generated_at descending, then cap
  updatedEntries.sort((a, b) => b.generated_at.localeCompare(a.generated_at));
  if (updatedEntries.length > MAX_ENTRIES) {
    updatedEntries = updatedEntries.slice(0, MAX_ENTRIES);
  }

  const updatedStore: AudiencePerceptionStore = {
    entries: updatedEntries,
    last_updated: wallNow().toISOString(),
  };

  saveAudiencePerception(updatedStore);
  return updatedStore;
}

// ─── Context Builders ─────────────────────────────────────────────────────────

/**
 * Build a concise context string for prompt injection.
 * Used by brief-generator, strategy-engine, and topic-generator.
 *
 * @param maxEntries - How many recent entries to consider (default 5)
 * @param maxChars   - Character budget for the output (default 500)
 */
export function buildAudiencePerceptionContext(
  options: { maxEntries?: number; maxChars?: number; identityMode?: string } = {},
): string {
  const { maxEntries = 5, maxChars = 500, identityMode } = options;
  const store = loadAudiencePerception();

  let entries = store.entries;
  if (identityMode) {
    entries = entries.filter(e => e.identity_mode === identityMode);
  }
  entries = entries.slice(0, maxEntries);

  if (entries.length === 0) return '';

  const parts: string[] = [];

  // Aggregate perceived traits across entries
  const traitFreq = new Map<string, number>();
  const desireSet = new Set<string>();
  const resistanceSet = new Set<string>();

  for (const entry of entries) {
    for (const trait of entry.perceived_traits) {
      traitFreq.set(trait, (traitFreq.get(trait) ?? 0) + 1);
    }
    for (const d of entry.desire_signals) {
      desireSet.add(d);
    }
    for (const r of entry.resistance_signals) {
      resistanceSet.add(r);
    }
  }

  const topTraits = [...traitFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)
    .slice(0, 5);

  if (topTraits.length > 0) {
    parts.push(`受众眼中的人设特质：${topTraits.join('、')}`);
  }

  if (desireSet.size > 0) {
    const desires = [...desireSet].slice(0, 5);
    parts.push(`受众期待更多：${desires.join('；')}`);
  }

  if (resistanceSet.size > 0) {
    const resistances = [...resistanceSet].slice(0, 3);
    parts.push(`受众抵触点：${resistances.join('；')}`);
  }

  const result = parts.join('\n');

  // Enforce character budget
  if (result.length > maxChars) {
    return result.slice(0, maxChars - 3) + '...';
  }

  return result;
}

/**
 * Get recent audience perception entries (raw, for programmatic consumption).
 */
export function getRecentPerceptionEntries(
  options: { maxEntries?: number; identityMode?: string } = {},
): AudiencePerceptionEntry[] {
  const { maxEntries = 10, identityMode } = options;
  const store = loadAudiencePerception();

  let entries = store.entries;
  if (identityMode) {
    entries = entries.filter(e => e.identity_mode === identityMode);
  }

  return entries.slice(0, maxEntries);
}
