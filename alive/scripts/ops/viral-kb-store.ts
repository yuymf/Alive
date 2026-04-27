/**
 * viral-kb-store.ts
 * CRUD + query functions for the viral content knowledge base.
 * Storage layout (under MEMORY_BASE):
 *   viral-kb/entries.json       — ViralEntry[]
 *   viral-kb/formulas.json      — UniversalFormula[]
 *   viral-kb/dissect-queue.json — DissectQueueItem[] (bare array, not wrapped)
 *
 * All operations are immutable — no in-place mutation.
 * File I/O via readJSON / writeJSON from file-utils (includes .bak backup).
 */

import * as path from 'path';
import * as crypto from 'crypto';
import { readJSON, writeJSON } from '../utils/file-utils';
import { wallNow } from '../utils/time-utils';
import { ViralEntry, UniversalFormula, DissectQueueItem, ViralPlatform, ViralConfidenceLevel } from '../utils/types';

// ─── Path helpers ─────────────────────────────────────────────────────────────

// ─── Emotion lexicon for trigger word extraction ─────────────────────────────

export const EMOTION_LEXICON: readonly string[] = [
  '震惊', '感动', '一定要', '千万别', '没想到', '居然', '太绝了', '泪目',
  '笑死', '绝绝子', '离谱', '破防', '真香', '后悔', '心疼', '爆哭',
  '上头', '救命', '无语', '崩溃', '炸裂', '封神', '绝了', '太牛了',
] as const;

/**
 * Scan titles for emotion lexicon words and return those appearing ≥ minFreq times.
 * Returns words sorted by frequency descending.
 * Pure function — no side effects.
 */
export function extractTriggerWords(
  titles: readonly string[],
  minFreq = 2,
): string[] {
  const freqMap = new Map<string, number>();

  for (const title of titles) {
    for (const word of EMOTION_LEXICON) {
      if (title.includes(word)) {
        freqMap.set(word, (freqMap.get(word) ?? 0) + 1);
      }
    }
  }

  return [...freqMap.entries()]
    .filter(([, count]) => count >= minFreq)
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word);
}

// ─── Path helpers (file system) ──────────────────────────────────────────────

function kbDir(basePath: string): string {
  return path.join(basePath, 'viral-kb');
}

function entriesPath(basePath: string): string {
  return path.join(kbDir(basePath), 'entries.json');
}

function formulasPath(basePath: string): string {
  return path.join(kbDir(basePath), 'formulas.json');
}

function queuePath(basePath: string): string {
  return path.join(kbDir(basePath), 'dissect-queue.json');
}

// ─── ID builder (shared, exported for use in viral-detector & content-dissector) ──

export function buildEntryId(platform: string, sourceId: string): string {
  return crypto.createHash('md5').update(`${platform}:${sourceId}`).digest('hex');
}

// ─── Statistics ───────────────────────────────────────────────────────────────

export interface KBStats {
  total: number;
  by_platform: Record<string, number>;
  by_tier: Record<string, number>;
  by_status: Record<string, number>;
  queue_length: number;
  formula_count: number;
  failed_count: number;
  hollow_count: number;
  usable_count: number;
  by_content_type: Record<string, number>;
  by_hook_type: Record<string, number>;
}

export interface KBAuditReport {
  total: number;
  failed_count: number;
  hollow_count: number;
  usable_count: number;
  hollow_entry_ids: string[];
}

export interface RepairResult {
  scanned: number;
  requeued: number;
  skipped: number;
}

// ─── PromotionResult ─────────────────────────────────────────────────────────

export interface PromotionResult {
  promoted: boolean;
  formula?: UniversalFormula;
}

// ─── Eviction ─────────────────────────────────────────────────────────────────

/**
 * Prune entries older than maxAgeDays UNLESS they:
 * - are referenced in any formula (source_entry_ids), or
 * - have times_referenced > 0
 *
 * This keeps the entries file from growing unboundedly.
 */
function pruneOldEntries(
  entries: ViralEntry[],
  formulas: UniversalFormula[],
  maxAgeDays = 30,
): ViralEntry[] {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  // Build a fast-lookup set of all entry ids that are in at least one formula
  const referencedIds = new Set<string>();
  for (const f of formulas) {
    for (const id of f.source_entry_ids) {
      referencedIds.add(id);
    }
  }

  return entries.filter(e => {
    // Keep if referenced in a formula
    if (referencedIds.has(e.id)) return true;
    // Keep if has been used as context
    if (e.times_referenced > 0) return true;
    // Keep if within the age window (treat invalid/missing timestamps as "keep")
    const age = new Date(e.collected_at).getTime();
    if (isNaN(age)) return true;
    return age >= cutoff;
  });
}

// ─── Read / Write ─────────────────────────────────────────────────────────────

export function loadEntries(basePath: string): ViralEntry[] {
  return readJSON<ViralEntry[]>(entriesPath(basePath), []);
}

export function saveEntries(basePath: string, entries: ViralEntry[]): void {
  const formulas = loadFormulas(basePath);
  const pruned = pruneOldEntries(entries, formulas);
  writeJSON(entriesPath(basePath), pruned);
}

export function loadFormulas(basePath: string): UniversalFormula[] {
  return readJSON<UniversalFormula[]>(formulasPath(basePath), []);
}

export function saveFormulas(basePath: string, formulas: UniversalFormula[]): void {
  writeJSON(formulasPath(basePath), formulas);
}

export function loadQueue(basePath: string): DissectQueueItem[] {
  return readJSON<DissectQueueItem[]>(queuePath(basePath), []);
}

export function saveQueue(basePath: string, items: DissectQueueItem[]): void {
  writeJSON(queuePath(basePath), items);
}

// ─── Queue operations ─────────────────────────────────────────────────────────

/**
 * Add a single item to the dissect queue if it is not already present.
 * Deduplication is by item.id.
 */
export function addToQueue(basePath: string, item: DissectQueueItem): void {
  const current = loadQueue(basePath);
  if (current.some(q => q.id === item.id)) return;
  saveQueue(basePath, [...current, item]);
}

/**
 * Add multiple items to the dissect queue in a single read+write pass.
 * Items already present (by id) are silently skipped.
 * More efficient than calling addToQueue N times.
 */
export function addManyToQueue(basePath: string, items: DissectQueueItem[]): void {
  if (items.length === 0) return;
  const current = loadQueue(basePath);
  const existingIds = new Set(current.map(q => q.id));
  const toAdd = items.filter(item => !existingIds.has(item.id));
  if (toAdd.length === 0) return;
  saveQueue(basePath, [...current, ...toAdd]);
}

/**
 * Remove and return the first n items from the dissect queue.
 * The queue is mutated (items taken are removed).
 */
export function dequeueItems(basePath: string, n: number): DissectQueueItem[] {
  const current = loadQueue(basePath);
  if (current.length === 0) return [];
  const taken = current.slice(0, n);
  saveQueue(basePath, current.slice(n));
  return taken;
}

// ─── Quality audit / repair helpers ──────────────────────────────────────────

function hasMeaningfulValue(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return !['无', '未知', '无法判断', 'N/A', 'n/a', 'null', 'undefined', '—', '-'].includes(trimmed);
}

export function isHollowEntry(entry: ViralEntry): boolean {
  if (entry.dissection_status !== 'done') return false;
  // Original data check: title must be meaningful — empty title means the source data itself is hollow
  if (!hasMeaningfulValue(entry.title)) return true;
  const dissection = entry.dissection;
  if (!dissection) return true;

  return !hasMeaningfulValue(dissection.hook_type)
    || !hasMeaningfulValue(dissection.content_type)
    || !hasMeaningfulValue(dissection.summary);
}

export function auditEntries(basePath: string): KBAuditReport {
  const entries = loadEntries(basePath);
  const hollowEntries = entries.filter(isHollowEntry);
  const failed_count = entries.filter(entry => entry.dissection_status === 'failed').length;
  const usable_count = entries.filter(entry => entry.dissection_status === 'done' && !isHollowEntry(entry)).length;

  return {
    total: entries.length,
    failed_count,
    hollow_count: hollowEntries.length,
    usable_count,
    hollow_entry_ids: hollowEntries.map(entry => entry.id),
  };
}

function buildRepairQueueItem(entry: ViralEntry): DissectQueueItem {
  return {
    id: entry.id,
    platform: entry.platform,
    source_id: entry.source_id,
    source_type: entry.source_type,
    title: entry.title,
    description: entry.description,
    likes: entry.likes,
    comments: entry.comments,
    shares: entry.shares,
    queued_at: wallNow().toISOString(),
    ...(entry.dissection?.identity_mode ? { identity_mode: entry.dissection.identity_mode } : {}),
  };
}

export function requeueEntriesForRepair(
  basePath: string,
  opts: { limit?: number; reason?: string } = {},
): RepairResult {
  const entries = loadEntries(basePath);
  const limit = opts.limit && opts.limit > 0 ? opts.limit : Number.POSITIVE_INFINITY;
  const repairReason = opts.reason ?? 'repair_requested';

  const candidates = entries.filter(entry => isHollowEntry(entry));
  const selected = candidates.slice(0, limit);
  const selectedIds = new Set(selected.map(entry => entry.id));

  addManyToQueue(basePath, selected.map(buildRepairQueueItem));

  const updatedEntries = entries.map(entry => {
    if (!selectedIds.has(entry.id)) return entry;
    return {
      ...entry,
      dissection_status: 'failed' as const,
      dissection_error_reason: repairReason,
      repair_count: (entry.repair_count ?? 0) + 1,
      last_repaired_at: wallNow().toISOString(),
    };
  });

  if (selected.length > 0) {
    saveEntries(basePath, updatedEntries);
  }

  return {
    scanned: candidates.length,
    requeued: selected.length,
    skipped: Math.max(candidates.length - selected.length, 0),
  };
}

// ─── Title dedup helper ─────────────────────────────────────────────────────

/**
 * Compute character-level Jaccard similarity between two strings.
 * Returns a value in [0, 1] where 1 means identical char sets.
 */
function titleSimilarity(a: string, b: string): number {
  const setA = new Set(a.split(''));
  const setB = new Set(b.split(''));
  const intersection = [...setA].filter(c => setB.has(c)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/** Minimum Jaccard similarity to consider two titles as duplicates. */
const TITLE_SIMILARITY_THRESHOLD = 0.85;

/**
 * Normalize a title for dedup comparison: remove emoji, punctuation, whitespace.
 * This catches cases where the same content title has minor formatting differences.
 */
function normalizeTitle(title: string): string {
  return title
    // Remove emoji (Unicode ranges for common emoji blocks)
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '')
    // Remove CJK punctuation & common punctuation
    .replace(/[\s\p{P}]/gu, '')
    .toLowerCase();
}

// ─── Upsert ───────────────────────────────────────────────────────────────────

/**
 * Insert a new ViralEntry or replace an existing one.
 *
 * Deduplication strategy:
 * 1. Exact match by entry.id (platform:sourceId hash) — replace if found.
 * 2. Title fuzzy dedup — same platform + highly similar title → keep the one
 *    with higher likes. This prevents the same content from different source_ids
 *    (e.g. different platforms re-sharing the same post) from creating duplicates.
 */
export function upsertEntry(basePath: string, entry: ViralEntry): void {
  const current = loadEntries(basePath);

  // 1. Exact dedup by id
  const exactIdx = current.findIndex(e => e.id === entry.id);
  if (exactIdx !== -1) {
    const updated = [
      ...current.slice(0, exactIdx),
      entry,
      ...current.slice(exactIdx + 1),
    ];
    saveEntries(basePath, updated);
    try {
      const { boostTagsFromViralEntry } = require('./tag-engine');
      boostTagsFromViralEntry(entry);
    } catch { /* non-blocking */ }
    return;
  }

  // 2. Title fuzzy dedup — same platform + similar title (exact, normalized, or Jaccard)
  const dupIdx = current.findIndex(e =>
    e.platform === entry.platform &&
    (
      e.title === entry.title ||
      normalizeTitle(e.title) === normalizeTitle(entry.title) ||
      titleSimilarity(e.title, entry.title) >= TITLE_SIMILARITY_THRESHOLD
    )
  );
  if (dupIdx !== -1) {
    // Keep one canonical entry id for title-deduped duplicates so downstream
    // formula promotion does not treat the same content as multiple samples.
    const existing = current[dupIdx];
    if (entry.likes > existing.likes) {
      const mergedEntry: ViralEntry = {
        ...existing,
        ...entry,
        id: existing.id,
        source_id: existing.source_id,
      };
      const updated = [
        ...current.slice(0, dupIdx),
        mergedEntry,
        ...current.slice(dupIdx + 1),
      ];
      saveEntries(basePath, updated);
      try {
        const { boostTagsFromViralEntry } = require('./tag-engine');
        boostTagsFromViralEntry(mergedEntry);
      } catch { /* non-blocking */ }
    }
    // else: existing entry is better, silently skip the duplicate
    return;
  }

  // 3. New entry — no duplicates found
  saveEntries(basePath, [...current, entry]);

  // Boost tag scores from newly inserted viral entry (feedback loop)
  try {
    const { boostTagsFromViralEntry } = require('./tag-engine');
    boostTagsFromViralEntry(entry);
  } catch {
    // tag-engine not available or failed — silent, non-blocking
  }
}

// ─── Lifecycle operations ───────────────────────────────────────────────────

/**
 * Mark an entry as deprecated instead of deleting it.
 * Deprecated entries are excluded from generation context but preserved for learning history.
 */
export function deprecateEntry(basePath: string, entryId: string): boolean {
  const entries = loadEntries(basePath);
  const idx = entries.findIndex(e => e.id === entryId);
  if (idx === -1) return false;

  const updated = [
    ...entries.slice(0, idx),
    { ...entries[idx], entry_status: 'deprecated' as const },
    ...entries.slice(idx + 1),
  ];
  saveEntries(basePath, updated);
  return true;
}

/**
 * Set the confidence level for an entry's dissection quality.
 */
export function setEntryConfidence(
  basePath: string,
  entryId: string,
  confidence: ViralConfidenceLevel,
): boolean {
  const entries = loadEntries(basePath);
  const idx = entries.findIndex(e => e.id === entryId);
  if (idx === -1) return false;

  const updated = [
    ...entries.slice(0, idx),
    { ...entries[idx], confidence_level: confidence },
    ...entries.slice(idx + 1),
  ];
  saveEntries(basePath, updated);
  return true;
}

// ─── Formula promotion ────────────────────────────────────────────────────────

/** Minimum promotion threshold — same combo must appear ≥ this many times */
const FORMULA_PROMOTION_THRESHOLD = 3;

/**
 * Compute a 0-1 confidence score for a formula based on:
 * - occurrence count (more = higher, logarithmic)
 * - distinct source diversity (source_type variety among contributing entries)
 * - recency (more recent last_seen = higher)
 */
function computeConfidence(
  occurrenceCount: number,
  distinctSourceCount: number,
  lastSeenIso: string,
): number {
  // Occurrence factor: log curve, max at ~15 occurrences
  const occFactor = Math.min(Math.log2(occurrenceCount + 1) / Math.log2(16), 1);
  // Diversity factor: ≥3 distinct sources = full score
  const divFactor = Math.min(distinctSourceCount / 3, 1);
  // Recency factor: full score if seen within 7 days, decays linearly over 30 days
  const daysSinceLastSeen = (Date.now() - new Date(lastSeenIso).getTime()) / (24 * 60 * 60 * 1000);
  const recencyFactor = Math.max(1 - daysSinceLastSeen / 30, 0);

  return Math.round((occFactor * 0.4 + divFactor * 0.3 + recencyFactor * 0.3) * 100) / 100;
}

/**
 * Build a structural template from example titles by extracting recurring patterns.
 * Extracts the most common hook pattern as a simple placeholder template.
 * Returns undefined if titles are too few or too diverse.
 */
function buildStructuralTemplate(titles: string[]): string | undefined {
  if (titles.length < 2) return undefined;

  // Detect common structural elements across titles
  const hasNumbers = titles.filter(t => /\d+/.test(t)).length >= Math.ceil(titles.length * 0.5);
  const hasQuestion = titles.filter(t => /[？?]/.test(t)).length >= Math.ceil(titles.length * 0.5);
  const hasExclamation = titles.filter(t => /[！!]/.test(t)).length >= Math.ceil(titles.length * 0.5);
  const hasCommand = titles.filter(t => /一定要|千万别|必须|赶紧/.test(t)).length >= Math.ceil(titles.length * 0.5);
  const hasContrast = titles.filter(t => /但是|却|居然|没想到|竟然/.test(t)).length >= Math.ceil(titles.length * 0.5);

  const parts: string[] = [];
  if (hasNumbers) parts.push('[数字]');
  if (hasCommand) parts.push('[命令式开头]');
  if (hasContrast) parts.push('[反转/意外]');
  if (hasQuestion) parts.push('[疑问收尾]');
  if (hasExclamation) parts.push('[感叹强调]');

  // Need at least 2 structural elements to form a meaningful template
  if (parts.length < 2) {
    // Fallback: describe the general pattern in natural language
    return undefined;
  }

  return parts.join(' + ');
}

/**
 * Check whether the given entry triggers a new UniversalFormula promotion.
 *
 * v2 Logic (案例驱动，公式辅助):
 * - Only successfully-dissected universal entries (dissection_status == 'done'
 *   AND identity_mode == null) participate.
 * - Find an existing formula matching platform + content_type + hook_type.
 * - If none: create with count = 1.
 * - If count < FORMULA_PROMOTION_THRESHOLD: increment count.
 * - On promotion (count reaches threshold): enrich with example_titles,
 *   structural_template, distinct_source_count, confidence.
 * - **No longer writes to persona.yaml** — formulas are injected at runtime
 *   via buildViralFormulaContext() in topic-generator.
 * - Same entry.id never inflates occurrence_count twice (dedup via source_entry_ids).
 *
 * @param personaConfigPath Kept for API backward compat but **no longer used**.
 */
export function checkFormulaPromotion(
  basePath: string,
  entry: ViralEntry,
  personaConfigPath?: string,
): PromotionResult {
  // Only successfully-dissected universal entries count towards formula promotion
  if (
    !entry.dissection ||
    entry.dissection_status !== 'done' ||
    entry.dissection.identity_mode !== null
  ) {
    return { promoted: false };
  }

  const storedEntries = loadEntries(basePath);
  const canonicalStoredEntry = storedEntries.find(e => e.id === entry.id)
    ?? storedEntries.find(e =>
      e.platform === entry.platform &&
      (e.title === entry.title || titleSimilarity(e.title, entry.title) >= TITLE_SIMILARITY_THRESHOLD)
    );
  if (canonicalStoredEntry && canonicalStoredEntry.id !== entry.id) {
    return { promoted: false };
  }

  const { content_type, hook_type } = entry.dissection;
  const formulas = loadFormulas(basePath);

  const existingIdx = formulas.findIndex(
    f =>
      f.platform === entry.platform &&
      f.content_type === content_type &&
      f.hook_type === hook_type,
  );

  if (existingIdx === -1) {
    // Create new formula with count = 1
    const newFormula: UniversalFormula = {
      id: crypto.createHash('md5').update(`${entry.platform}:${content_type}:${hook_type}`).digest('hex'),
      platform: entry.platform,
      content_type,
      hook_type,
      formula_summary: entry.dissection.summary,
      source_entry_ids: [entry.id],
      occurrence_count: 1,
      injected_to_templates: false,
      created_at: wallNow().toISOString(),
      last_seen_at: wallNow().toISOString(),
      example_titles: [entry.title],
      distinct_source_count: 1,
    };
    saveFormulas(basePath, [...formulas, newFormula]);
    return { promoted: false };
  }

  const existing = formulas[existingIdx];

  // Dedup: same entry.id must not inflate occurrence_count more than once
  const alreadyCounted = existing.source_entry_ids.includes(entry.id);
  const updatedCount = alreadyCounted ? existing.occurrence_count : existing.occurrence_count + 1;
  const updatedSourceIds = alreadyCounted
    ? existing.source_entry_ids
    : [...existing.source_entry_ids, entry.id];

  const isFirstPromotion = existing.occurrence_count < FORMULA_PROMOTION_THRESHOLD
    && updatedCount >= FORMULA_PROMOTION_THRESHOLD;
  const now = wallNow().toISOString();

  // Collect enrichment data from source entries
  const allEntries = loadEntries(basePath);
  const sourceEntries = allEntries.filter(e => updatedSourceIds.includes(e.id));
  const sourceTitles = sourceEntries.map(e => e.title);

  // Count distinct source types (competitor / search / trending_feed) as diversity proxy
  const distinctSourceTypes = new Set(sourceEntries.map(e => e.source_type));

  // Build example_titles: keep up to 3 most-liked titles
  const exampleTitles = sourceEntries
    .sort((a, b) => b.likes - a.likes)
    .slice(0, 3)
    .map(e => e.title);

  // Refresh trigger words when promoted or new entry added post-promotion
  const shouldRefreshTriggerWords = !alreadyCounted && updatedCount >= FORMULA_PROMOTION_THRESHOLD;
  const triggerWords = shouldRefreshTriggerWords
    ? extractTriggerWords(sourceTitles, 2)
    : (existing.trigger_words ?? []);

  // Build structural template on promotion or when new data arrives post-promotion
  const structuralTemplate = updatedCount >= FORMULA_PROMOTION_THRESHOLD
    ? (buildStructuralTemplate(sourceTitles) ?? existing.structural_template)
    : existing.structural_template;

  const confidence = computeConfidence(updatedCount, distinctSourceTypes.size, now);

  const updatedFormula: UniversalFormula = {
    ...existing,
    occurrence_count: updatedCount,
    last_seen_at: alreadyCounted ? existing.last_seen_at : now,
    source_entry_ids: updatedSourceIds,
    injected_to_templates: existing.injected_to_templates, // preserve old value, no new writes
    example_titles: exampleTitles,
    structural_template: structuralTemplate,
    distinct_source_count: distinctSourceTypes.size,
    confidence,
    ...(triggerWords.length > 0 ? { trigger_words: triggerWords } : {}),
  };

  const updatedFormulas = [
    ...formulas.slice(0, existingIdx),
    updatedFormula,
    ...formulas.slice(existingIdx + 1),
  ];
  saveFormulas(basePath, updatedFormulas);

  if (isFirstPromotion) {
    return { promoted: true, formula: updatedFormula };
  }
  return { promoted: false, formula: updatedFormula };
}

// NOTE: injectTemplateIntoPersona() has been removed in v2.
// Formulas are no longer auto-written into persona.yaml.
// They are injected at runtime via buildViralFormulaContext() in topic-generator.ts.

// ─── Sort helper ──────────────────────────────────────────────────────────────

/**
 * Return a sorted copy of entries.
 * 'likes'   → descending by likes
 * 'recency' (default) → descending by collected_at
 */
function sortEntries(entries: ViralEntry[], sort?: 'recency' | 'likes'): ViralEntry[] {
  if (sort === 'likes') {
    return [...entries].sort((a, b) => b.likes - a.likes);
  }
  // default: recency (collected_at descending)
  return [...entries].sort(
    (a, b) => new Date(b.collected_at).getTime() - new Date(a.collected_at).getTime(),
  );
}

// ─── Query ────────────────────────────────────────────────────────────────────

export interface QueryTrackOptions {
  platform?: ViralPlatform;
  identity_mode?: string;
  limit?: number;
  sort?: 'recency' | 'likes';
}

/**
 * Query track-tier entries filtered by platform and identity_mode.
 */
export function queryTrack(basePath: string, opts: QueryTrackOptions): ViralEntry[] {
  const allEntries = loadEntries(basePath);
  return queryTrackInMemory(allEntries, opts);
}

/**
 * Query track-tier entries from an already-loaded array (no disk I/O).
 * Use this inside loops to avoid repeated reads.
 */
export function queryTrackInMemory(entries: ViralEntry[], opts: QueryTrackOptions): ViralEntry[] {
  let filtered = entries.filter(e => e.kb_tier === 'track');

  // Exclude deprecated entries by default
  filtered = filtered.filter(e => e.entry_status !== 'deprecated');

  if (opts.platform) {
    filtered = filtered.filter(e => e.platform === opts.platform);
  }
  if (opts.identity_mode) {
    filtered = filtered.filter(e => e.dissection?.identity_mode === opts.identity_mode);
  }

  filtered = sortEntries(filtered, opts.sort);

  return opts.limit ? filtered.slice(0, opts.limit) : filtered;
}

export interface QueryAllOptions {
  platform?: ViralPlatform;
  type?: string;
  keyword?: string;
  source?: ViralEntry['source_type'];
  status?: 'done' | 'failed' | 'hollow';
  /** Include deprecated entries in results (default: false) */
  include_deprecated?: boolean;
  limit?: number;
  sort?: 'recency' | 'likes';
}

/**
 * General-purpose query across all entries.
 */
export function queryAll(basePath: string, opts: QueryAllOptions = {}): ViralEntry[] {
  let entries = loadEntries(basePath);

  // Exclude deprecated entries unless explicitly requested
  if (!opts.include_deprecated) {
    entries = entries.filter(e => e.entry_status !== 'deprecated');
  }

  if (opts.platform) {
    entries = entries.filter(e => e.platform === opts.platform);
  }
  if (opts.type) {
    entries = entries.filter(e => e.dissection?.content_type === opts.type);
  }
  if (opts.source) {
    entries = entries.filter(e => e.source_type === opts.source);
  }
  if (opts.status) {
    entries = entries.filter(entry => {
      if (opts.status === 'hollow') return isHollowEntry(entry);
      if (opts.status === 'failed') return entry.dissection_status === 'failed';
      return entry.dissection_status === 'done' && !isHollowEntry(entry);
    });
  }
  if (opts.keyword) {
    const kw = opts.keyword.toLowerCase();
    entries = entries.filter(
      e =>
        e.title.toLowerCase().includes(kw) ||
        e.description.toLowerCase().includes(kw) ||
        e.dissection?.summary?.toLowerCase().includes(kw) ||
        e.dissection?.content_type?.toLowerCase().includes(kw),
    );
  }

  entries = sortEntries(entries, opts.sort);

  return opts.limit ? entries.slice(0, opts.limit) : entries;
}

export interface QueryFormulasOptions {
  platform?: ViralPlatform;
}

/**
 * Query all UniversalFormulas, optionally filtered by platform.
 */
export function queryFormulas(basePath: string, opts: QueryFormulasOptions = {}): UniversalFormula[] {
  const formulas = loadFormulas(basePath);
  if (opts.platform) {
    return formulas.filter(f => f.platform === opts.platform);
  }
  return formulas;
}

/**
 * Return summary statistics for the knowledge base.
 */
export function getStats(basePath: string): KBStats {
  const entries = loadEntries(basePath);
  const queueItems = loadQueue(basePath);
  const formulas = loadFormulas(basePath);

  const by_platform: Record<string, number> = {};
  const by_tier: Record<string, number> = {};
  const by_status: Record<string, number> = {};
  const by_content_type: Record<string, number> = {};
  const by_hook_type: Record<string, number> = {};

  let failed_count = 0;
  let hollow_count = 0;
  let usable_count = 0;

  for (const e of entries) {
    by_platform[e.platform] = (by_platform[e.platform] ?? 0) + 1;
    by_tier[e.kb_tier] = (by_tier[e.kb_tier] ?? 0) + 1;

    const status = e.entry_status ?? 'active';
    by_status[status] = (by_status[status] ?? 0) + 1;

    if (e.dissection_status === 'failed') {
      failed_count += 1;
    }

    if (isHollowEntry(e)) {
      hollow_count += 1;
      continue;
    }

    if (e.dissection_status === 'done') {
      usable_count += 1;
    }

    const contentType = e.dissection?.content_type?.trim();
    const hookType = e.dissection?.hook_type?.trim();
    if (contentType) {
      by_content_type[contentType] = (by_content_type[contentType] ?? 0) + 1;
    }
    if (hookType) {
      by_hook_type[hookType] = (by_hook_type[hookType] ?? 0) + 1;
    }
  }

  return {
    total: entries.length,
    by_platform,
    by_tier,
    by_status,
    queue_length: queueItems.length,
    formula_count: formulas.length,
    failed_count,
    hollow_count,
    usable_count,
    by_content_type,
    by_hook_type,
  };
}

// ─── Dedup & clear ───────────────────────────────────────────────────────────

export interface DedupResult {
  before: number;
  after: number;
  removed: number;
}

/**
 * Remove duplicate entries from the KB.
 * Two entries are considered duplicates if they share the same platform AND
 * have the same normalized title (emoji/punctuation/whitespace stripped).
 * Among duplicates, keep the one with the highest likes.
 */
export function dedupEntries(basePath: string): DedupResult {
  const entries = loadEntries(basePath);
  const before = entries.length;

  const keepMap = new Map<string, ViralEntry>(); // key = platform:normalizedTitle

  for (const e of entries) {
    const key = `${e.platform}:${normalizeTitle(e.title)}`;
    const existing = keepMap.get(key);
    if (!existing || e.likes > existing.likes) {
      keepMap.set(key, e);
    }
  }

  const deduped = [...keepMap.values()];
  const removed = before - deduped.length;

  if (removed > 0) {
    writeJSON(entriesPath(basePath), deduped);
  }

  return { before, after: deduped.length, removed };
}

/**
 * Clear all entries and formulas from the KB (keeps the dissect queue).
 */
export function clearEntries(basePath: string): number {
  const entries = loadEntries(basePath);
  const count = entries.length;
  writeJSON(entriesPath(basePath), []);
  return count;
}
