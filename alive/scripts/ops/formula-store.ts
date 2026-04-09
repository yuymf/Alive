/**
 * formula-store.ts
 * Data manager for the FormulaStore — competitor-sourced hook formula templates
 * indexed by IdentityMode. No LLM calls, no analysis logic; pure data management.
 *
 * Semantically distinct from ContentPatterns (which tracks Miss V's own outcomes).
 */

import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import type { FormulaStore, HookFormula, IdentityMode } from '../utils/types';

// ─── Empty store factory ──────────────────────────────────────────────────────

function emptyFormulaStore(): FormulaStore {
  return {
    version: 1,
    formulas: {},
    last_updated: new Date(0).toISOString(),
  };
}

// ─── Load / Save ──────────────────────────────────────────────────────────────

/** Load FormulaStore from disk, returning an empty store if missing. */
export function loadFormulaStore(): FormulaStore {
  return readJSON<FormulaStore>(PATHS.formulaStore, emptyFormulaStore());
}

/** Save a FormulaStore to disk. Receives a fully-formed object; writes as-is. */
export function saveFormulaStore(store: FormulaStore): void {
  writeJSON(PATHS.formulaStore, store);
}

// ─── Merge ────────────────────────────────────────────────────────────────────

/**
 * Merge formulas for one account into the store under each given identityMode.
 * Overwrites existing entries for this accountKey under each affected mode.
 * Returns a new FormulaStore (immutable — does not mutate the input).
 *
 * For single-mode accounts pass a one-element array.
 * For AI虚拟偶像 (cross-mode) accounts pass ALL_IDENTITY_MODES.
 */
export function mergeAccountFormulas(
  store: FormulaStore,
  identityModes: IdentityMode[],
  accountKey: string,
  formulas: HookFormula[],
): FormulaStore {
  // Deep-clone the formulas map to ensure immutability at every nesting level
  const newFormulas: Record<string, Record<string, HookFormula[]>> = {};

  // Copy all existing mode buckets
  for (const [mode, accountMap] of Object.entries(store.formulas)) {
    newFormulas[mode] = {};
    for (const [key, list] of Object.entries(accountMap)) {
      newFormulas[mode][key] = list.map(f => ({ ...f, examples: [...f.examples] }));
    }
  }

  // Write the new formulas under each requested identity mode
  for (const mode of identityModes) {
    if (!newFormulas[mode]) {
      newFormulas[mode] = {};
    }
    newFormulas[mode][accountKey] = formulas.map(f => ({ ...f, examples: [...f.examples] }));
  }

  return {
    version: 1,
    formulas: newFormulas as FormulaStore['formulas'],
    last_updated: new Date().toISOString(),
  };
}

// ─── Query ────────────────────────────────────────────────────────────────────

const FREQ_ORDER: Record<string, number> = { '高': 0, '中': 1, '低': 2 };

/**
 * Query all formulas for a given identityMode, aggregated across all accounts.
 * Deduplicates by formula string (keeps highest-frequency version).
 * Sorts: '高' first, then '中', then '低'.
 */
export function queryFormulasByMode(
  store: FormulaStore,
  identityMode: IdentityMode,
): HookFormula[] {
  const accountMap = store.formulas[identityMode];
  if (!accountMap) return [];

  // Collect all formulas across accounts, deduplicating by formula string
  const best = new Map<string, HookFormula>();

  for (const list of Object.values(accountMap)) {
    for (const f of list) {
      const existing = best.get(f.formula);
      if (!existing) {
        best.set(f.formula, f);
      } else {
        // Keep the highest-frequency version
        const existingRank = FREQ_ORDER[existing.frequency] ?? 2;
        const newRank = FREQ_ORDER[f.frequency] ?? 2;
        if (newRank < existingRank) {
          best.set(f.formula, f);
        }
      }
    }
  }

  return Array.from(best.values()).sort((a, b) => {
    const rankA = FREQ_ORDER[a.frequency] ?? 2;
    const rankB = FREQ_ORDER[b.frequency] ?? 2;
    return rankA - rankB;
  });
}
