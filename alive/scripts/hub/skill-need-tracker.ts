// alive/scripts/hub/skill-need-tracker.ts
// Records, deduplicates, and queries skill needs (capability gaps).
// Design refs: D3, D4, D5

import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import type { SkillNeed, SkillNeedsStore, IntentCategory } from '../utils/types';

// ─── Helpers ────────────────────────────────────────────

function generateId(): string {
  return `sn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Extract significant keywords from a description for fuzzy matching.
 * Strips common stop words and returns lowercased tokens ≥ 3 chars.
 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'is', 'was', 'it',
  'and', 'or', 'but', 'with', 'that', 'this', 'from', 'not', 'no', 'be',
  'at', 'by', 'as', 'do', 'if', 'so', 'up',
]);

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * Check if two keyword arrays share enough overlap for fuzzy dedup.
 * Requires ≥ 50% of the shorter set to overlap.
 */
function keywordsOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const setB = new Set(b);
  const shared = a.filter(w => setB.has(w)).length;
  const threshold = Math.ceil(Math.min(a.length, b.length) * 0.5);
  return shared >= threshold;
}

// ─── Store I/O ──────────────────────────────────────────

function loadStore(): SkillNeedsStore {
  return readJSON<SkillNeedsStore>(PATHS.skillNeeds, { needs: [], last_scan: null });
}

function saveStore(store: SkillNeedsStore): void {
  writeJSON(PATHS.skillNeeds, store);
}

// ─── Public API ─────────────────────────────────────────

export interface RecordSkillNeedParams {
  intent_category: string;
  description: string;
  wished_skill_name: string | null;
  source: 'unhandled' | 'wished';
  original_action: string;
  intensity: number;
}

/**
 * Record a skill need (capability gap). Deduplicates by:
 * 1. Exact match on `wished_skill_name` (if non-null)
 * 2. Fuzzy match on description keywords (if wished_skill_name is null)
 *
 * On match: increments occurrences, updates last_seen and intensity_peak.
 * On miss: creates a new SkillNeed with status 'pending'.
 */
export function recordSkillNeed(params: RecordSkillNeedParams): void {
  const store = loadStore();
  const now = nowISO();

  // Try to find an existing match among pending/searching needs
  let existing: SkillNeed | undefined;

  if (params.wished_skill_name) {
    // Strategy 1: exact match on wished_skill_name
    existing = store.needs.find(
      n => n.wished_skill_name === params.wished_skill_name
        && (n.status === 'pending' || n.status === 'searching'),
    );
  } else {
    // Strategy 2: fuzzy match on description keywords
    const incomingKw = extractKeywords(params.description);
    existing = store.needs.find(n => {
      if (n.status !== 'pending' && n.status !== 'searching') return false;
      if (n.wished_skill_name) return false; // only fuzzy-match nameless needs
      return keywordsOverlap(incomingKw, extractKeywords(n.description));
    });
  }

  if (existing) {
    existing.occurrences += 1;
    existing.last_seen = now;
    existing.intensity_peak = Math.max(existing.intensity_peak, params.intensity);
  } else {
    const need: SkillNeed = {
      id: generateId(),
      intent_category: params.intent_category as IntentCategory,
      description: params.description,
      wished_skill_name: params.wished_skill_name,
      source: params.source,
      original_action: params.original_action,
      first_seen: now,
      occurrences: 1,
      last_seen: now,
      intensity_peak: params.intensity,
      status: 'pending',
    };
    store.needs.push(need);
  }

  saveStore(store);
}

/**
 * Get all needs with status 'pending'.
 */
export function getPendingNeeds(): SkillNeed[] {
  const store = loadStore();
  return store.needs.filter(n => n.status === 'pending');
}

/**
 * Update the status of a need by ID.
 */
export function updateNeedStatus(
  id: string,
  status: SkillNeed['status'],
): void {
  const store = loadStore();
  const need = store.needs.find(n => n.id === id);
  if (need) {
    need.status = status;
    saveStore(store);
  }
}

/**
 * Build a hint string for pending skill needs, to be injected into
 * the heartbeat prompt's `{pending_skill_needs}` placeholder.
 *
 * Returns '' if no pending needs exist.
 */
export function buildPendingNeedsHint(): string {
  const pending = getPendingNeeds();
  if (pending.length === 0) return '';

  const lines = pending.map(n => {
    const name = n.wished_skill_name ?? n.description;
    return `- ${name}（已出现 ${n.occurrences} 次，最高强度 ${n.intensity_peak}）`;
  });

  return lines.join('\n');
}
