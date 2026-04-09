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
import * as fs from 'fs';
import YAML from 'yaml';
import { readJSON, writeJSON } from '../utils/file-utils';
import { wallNow } from '../utils/time-utils';
import { ViralEntry, UniversalFormula, DissectQueueItem, ViralPlatform } from '../utils/types';

// ─── Path helpers ─────────────────────────────────────────────────────────────

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
  queue_length: number;
  formula_count: number;
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

// ─── Upsert ───────────────────────────────────────────────────────────────────

/**
 * Insert a new ViralEntry or replace an existing one by id.
 * Immutable — returns a new array; saves to disk.
 */
export function upsertEntry(basePath: string, entry: ViralEntry): void {
  const current = loadEntries(basePath);
  const idx = current.findIndex(e => e.id === entry.id);
  const updated = idx === -1
    ? [...current, entry]
    : [
        ...current.slice(0, idx),
        entry,
        ...current.slice(idx + 1),
      ];
  saveEntries(basePath, updated);
}

// ─── Formula promotion ────────────────────────────────────────────────────────

/**
 * Check whether the given entry triggers a new UniversalFormula promotion.
 *
 * Logic:
 * - Only successfully-dissected universal entries (dissection_status == 'done'
 *   AND identity_mode == null) participate.
 * - Find an existing formula matching platform + content_type + hook_type.
 * - If none: create with count = 1.
 * - If count < 3: increment count, update last_seen_at.
 * - If count reaches 3 for the first time: attempt persona injection;
 *   only mark injected_to_templates = true if the write succeeded.
 * - At most 1 formula can be promoted per call (protection mechanism).
 * - Same entry.id never inflates occurrence_count twice (dedup via source_entry_ids).
 *
 * When promotion occurs and personaConfigPath is provided:
 * - Reads the persona.yaml at personaConfigPath
 * - Appends a new ContentTemplate object to ops.content_templates[]
 * - Writes back with .bak backup
 * - Marks the formula as injected_to_templates = true ONLY if write succeeded
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
    };
    saveFormulas(basePath, [...formulas, newFormula]);
    return { promoted: false };
  }

  const existing = formulas[existingIdx];

  // Already promoted — no-op
  if (existing.injected_to_templates) {
    return { promoted: false };
  }

  // Dedup: same entry.id must not inflate occurrence_count more than once
  const alreadyCounted = existing.source_entry_ids.includes(entry.id);
  const updatedCount = alreadyCounted ? existing.occurrence_count : existing.occurrence_count + 1;
  const updatedSourceIds = alreadyCounted
    ? existing.source_entry_ids
    : [...existing.source_entry_ids, entry.id];

  const shouldPromote = updatedCount >= 3;

  // Attempt persona injection BEFORE saving the formula so we know whether it succeeded.
  // If no personaConfigPath is provided, skip injection but still mark as promoted.
  let injectionSucceeded = false;
  if (shouldPromote && personaConfigPath) {
    const tentativeFormula: UniversalFormula = {
      ...existing,
      occurrence_count: updatedCount,
      last_seen_at: wallNow().toISOString(),
      source_entry_ids: updatedSourceIds,
      injected_to_templates: false, // will be set to true only on success
    };
    injectionSucceeded = injectTemplateIntoPersona(personaConfigPath, tentativeFormula);
  }

  // injected_to_templates = true when:
  //   - promoted AND no personaConfigPath provided (no write required, promotion gate is reached)
  //   - promoted AND personaConfigPath write succeeded
  // injected_to_templates = false when promoted AND write failed (allows retry on next run)
  const injectedToTemplates = shouldPromote
    ? (personaConfigPath ? injectionSucceeded : true)
    : existing.injected_to_templates;

  const updatedFormula: UniversalFormula = {
    ...existing,
    occurrence_count: updatedCount,
    last_seen_at: wallNow().toISOString(),
    source_entry_ids: updatedSourceIds,
    injected_to_templates: injectedToTemplates,
  };

  const updatedFormulas = [
    ...formulas.slice(0, existingIdx),
    updatedFormula,
    ...formulas.slice(existingIdx + 1),
  ];
  saveFormulas(basePath, updatedFormulas);

  if (shouldPromote) {
    return { promoted: true, formula: updatedFormula };
  }
  return { promoted: false };
}

/**
 * Append a new ContentTemplate derived from a promoted formula to persona.yaml.
 * Uses YAML parse + stringify with .bak backup (via fs rename before write).
 * Returns true if the write succeeded, false otherwise.
 * Callers must check the return value before marking injected_to_templates = true.
 */
function injectTemplateIntoPersona(personaConfigPath: string, formula: UniversalFormula): boolean {
  try {
    const raw = fs.readFileSync(personaConfigPath, 'utf8');
    const doc = YAML.parse(raw) as Record<string, unknown>;

    // Build the new content template from the formula
    const newTemplate: Record<string, unknown> = {
      type: `${formula.content_type}_${formula.hook_type}`.replace(/\s+/g, '_'),
      category: formula.content_type,
      priority: 'normal',
      scene: formula.formula_summary,
      camera: '常规镜头',
      styling: '根据内容调整',
      highlights: [formula.hook_type, formula.content_type],
      platforms: [formula.platform],
      source: 'auto_promoted',
      promoted_at: wallNow().toISOString(),
    };

    // Navigate to ops.content_templates — create if absent
    const ops = (doc.ops ?? {}) as Record<string, unknown>;
    const existingTemplates = Array.isArray(ops.content_templates)
      ? ops.content_templates as unknown[]
      : [];

    const updatedOps = {
      ...ops,
      content_templates: [...existingTemplates, newTemplate],
    };

    const updatedDoc = { ...doc, ops: updatedOps };

    // Write with .bak backup
    const bakPath = `${personaConfigPath}.bak`;
    if (fs.existsSync(personaConfigPath)) {
      fs.copyFileSync(personaConfigPath, bakPath);
    }
    fs.writeFileSync(personaConfigPath, YAML.stringify(updatedDoc), 'utf8');
    return true;
  } catch (err) {
    console.error('[viral-kb-store] Failed to inject template into persona.yaml:', (err as Error).message);
    return false;
  }
}

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
  limit?: number;
  sort?: 'recency' | 'likes';
}

/**
 * General-purpose query across all entries.
 */
export function queryAll(basePath: string, opts: QueryAllOptions = {}): ViralEntry[] {
  let entries = loadEntries(basePath);

  if (opts.platform) {
    entries = entries.filter(e => e.platform === opts.platform);
  }
  if (opts.type) {
    entries = entries.filter(e => e.dissection?.content_type === opts.type);
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

  for (const e of entries) {
    by_platform[e.platform] = (by_platform[e.platform] ?? 0) + 1;
    by_tier[e.kb_tier] = (by_tier[e.kb_tier] ?? 0) + 1;
  }

  return {
    total: entries.length,
    by_platform,
    by_tier,
    queue_length: queueItems.length,
    formula_count: formulas.length,
  };
}
