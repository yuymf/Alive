/**
 * active-directions.ts
 *
 * Persona-local log of direction keywords the user has explicitly
 * queried via `/idea <direction>`.
 *
 * Role in the async-decoupling architecture
 * -----------------------------------------
 * The main producer/consumer split (PR-1) treats every ops data source
 * as "cron produces, /command reads". Directions break that pattern by
 * their nature — a user types a fresh keyword that no cron could have
 * pre-fetched. PR-3 handles this in two layers:
 *
 *   1. `cmdIdea(direction)` first tries `direction-idea-cache.json` and
 *      `trends-cache.json` (keyword filter) before falling back to an
 *      inline platform search.
 *   2. Regardless of which layer served the current request, the
 *      direction is recorded here. The ops-browse cron folds this log
 *      into its keyword-tracker inputs so the next cron round pre-fetches
 *      content tagged with the direction, warming the caches for the
 *      user's likely follow-up queries.
 *
 * This file is intentionally small: a ring buffer of recent queries plus
 * a deduplication map keyed on the normalised direction string.
 */

import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now } from '../utils/time-utils';

/** Directions older than this are treated as stale and pruned. */
const ACTIVE_DIRECTION_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days

/** Hard cap on how many directions we retain; oldest drop first. */
const MAX_DIRECTIONS = 50;

export interface ActiveDirectionEntry {
  direction: string;
  /** ISO 8601 of the most recent `/idea <direction>` invocation. */
  last_queried_at: string;
  /** Lifetime count of `/idea <direction>` calls with this exact string. */
  query_count: number;
}

export interface ActiveDirectionsLog {
  entries: ActiveDirectionEntry[];
}

export function loadActiveDirections(): ActiveDirectionsLog {
  // Always hand back a fresh object + entries array. `readJSON` returns the
  // `defaultValue` reference verbatim when the file is missing, so sharing a
  // module-level sentinel would let callers mutate the default and poison
  // subsequent reads (caught the hard way by unit tests).
  return readJSON<ActiveDirectionsLog>(PATHS.activeDirections, { entries: [] });
}

function normalizeDirection(raw: string): string {
  return raw.trim();
}

/**
 * Record a user-queried direction. Call this from `cmdIdea(direction)`
 * before any early returns so even direction queries that hit the cache
 * are counted — recency matters for cron pre-fetch scheduling.
 */
export function recordActiveDirection(raw: string): void {
  const direction = normalizeDirection(raw);
  if (!direction) return;

  const log = loadActiveDirections();
  const timestamp = now().toISOString();

  const existingIdx = log.entries.findIndex(e => e.direction === direction);
  if (existingIdx >= 0) {
    const existing = log.entries[existingIdx];
    log.entries[existingIdx] = {
      direction,
      last_queried_at: timestamp,
      query_count: existing.query_count + 1,
    };
  } else {
    log.entries.push({ direction, last_queried_at: timestamp, query_count: 1 });
  }

  // Prune stale + cap size (keep most-recent-first ordering for the cap).
  const cutoff = now().getTime() - ACTIVE_DIRECTION_TTL_MS;
  const fresh = log.entries
    .filter(e => Date.parse(e.last_queried_at) >= cutoff)
    .sort((a, b) => Date.parse(b.last_queried_at) - Date.parse(a.last_queried_at))
    .slice(0, MAX_DIRECTIONS);

  writeJSON(PATHS.activeDirections, { entries: fresh });
}

/**
 * Returns fresh direction strings for consumers like keyword-tracker that
 * want to fold user queries into their keyword pool. Entries beyond the
 * TTL are omitted. Sorted most-recent-first.
 */
export function listFreshDirections(): string[] {
  const log = loadActiveDirections();
  const cutoff = now().getTime() - ACTIVE_DIRECTION_TTL_MS;
  return log.entries
    .filter(e => Date.parse(e.last_queried_at) >= cutoff)
    .sort((a, b) => Date.parse(b.last_queried_at) - Date.parse(a.last_queried_at))
    .map(e => e.direction);
}
