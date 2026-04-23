/**
 * cache-warmup.ts
 *
 * Non-blocking cold-start warmup for ops caches.
 *
 * Consumers (/brief, /trends, /idea, topic-generator, ops-desk) only ever
 * READ caches — they never block on platform IO. On the very first run,
 * or after long periods where the cron hasn't executed, the caches may
 * not yet exist. This module provides a single fire-and-forget entry
 * point that consumers call at the top of their handler: it detects a
 * cold cache and kicks off a background refresh without awaiting.
 *
 * Guarantees:
 *   - Callers never await this function's internal work.
 *   - At most one warmup runs per process (deduplicated by flag).
 *   - A warmup in progress is treated as "already warming" and skipped.
 *   - Errors are swallowed and logged — this is best-effort only.
 */

import { wallNow } from '../utils/time-utils';
import { PATHS } from '../utils/file-utils';
import type { OpsConfig, PersonaConfig } from '../utils/types';

let _warmupInFlight = false;
let _lastWarmupAtMs = 0;

/** Minimum gap between two in-process warmup triggers (prevents spam). */
const WARMUP_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/** Age threshold for considering a cache "cold" — anything older or missing triggers a warmup. */
const COLD_CACHE_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

import * as fs from 'fs';

function cacheFileAgeMs(filePath: string): number | null {
  try {
    const stat = fs.statSync(filePath);
    return wallNow().getTime() - stat.mtimeMs;
  } catch {
    return null; // missing or unreadable
  }
}

/** Returns true if trends-cache or competitor-log is missing / older than threshold. */
function needsWarmup(): boolean {
  const trendsAge = cacheFileAgeMs(PATHS.trendsCache);
  const competitorsAge = cacheFileAgeMs(PATHS.competitorLog);
  const searchAge = cacheFileAgeMs(PATHS.searchKeywordCache);

  if (trendsAge === null || trendsAge > COLD_CACHE_AGE_MS) return true;
  if (competitorsAge === null || competitorsAge > COLD_CACHE_AGE_MS) return true;
  if (searchAge === null || searchAge > COLD_CACHE_AGE_MS) return true;
  return false;
}

/**
 * Ensure the ops caches are warm. Non-blocking.
 *
 * Called by /brief, /trends, /idea, and other consumer entry points at
 * the top of their handler. Returns immediately; any actual refresh runs
 * detached on the next tick and writes directly to the cache files,
 * which the CURRENT invocation will not see — but the NEXT invocation
 * will. This is the correct semantics: a user whose first /trends call
 * lands on an empty cache receives the "data not ready" banner, while
 * their second call (a few minutes later) finds a freshly warmed cache.
 */
export function ensureOpsCachesWarm(persona: PersonaConfig, ops: OpsConfig): void {
  // Opt-out switch for CLI/one-shot processes. Warmup is a fire-and-forget
  // operation that keeps the event loop alive for several minutes while it
  // fetches platform data + calls LLMs. That's fine for long-lived hosts
  // (dashboard, cron daemon) but fatal for the CLI, where it prevents the
  // process from exiting after the command result is written — the parent
  // harness then kills it with SIGALRM (exit 142) after the hard timeout.
  // The CLI entrypoint sets ALIVE_DISABLE_WARMUP=1 to short-circuit here.
  if (process.env.ALIVE_DISABLE_WARMUP === '1') return;
  if (_warmupInFlight) return;
  if (wallNow().getTime() - _lastWarmupAtMs < WARMUP_COOLDOWN_MS) return;
  if (!needsWarmup()) return;

  _warmupInFlight = true;
  _lastWarmupAtMs = wallNow().getTime();

  // Kick off the refresh detached from the current call stack. Using
  // setImmediate rather than a bare Promise.resolve() ensures the caller's
  // response is sent before any refresh work starts on the event loop.
  setImmediate(() => {
    void runWarmup(persona, ops).finally(() => {
      _warmupInFlight = false;
    });
  });
}

async function runWarmup(persona: PersonaConfig, ops: OpsConfig): Promise<void> {
  console.error('[cache-warmup] Cold cache detected — starting background refresh');
  try {
    // Imports are lazy so this module stays import-cheap for callers
    // that never trigger a warmup.
    const { refreshTrends, refreshSearchKeywordTrends, buildPersonaIdentities } = await import('./trend-analyzer');
    const { refreshCompetitors } = await import('./competitor-tracker');
    const { createRealLLMClient } = await import('../utils/llm-client');

    const identities = buildPersonaIdentities(persona);
    const llm = createRealLLMClient('cache-warmup');

    // Sequential, not parallel — minimise platform load during warmup,
    // and treat each failure independently.
    try {
      await refreshSearchKeywordTrends(ops);
    } catch (err) {
      console.error('[cache-warmup] refreshSearchKeywordTrends failed:', err);
    }
    try {
      await refreshTrends(ops, identities, llm);
    } catch (err) {
      console.error('[cache-warmup] refreshTrends failed:', err);
    }
    try {
      await refreshCompetitors(ops);
    } catch (err) {
      console.error('[cache-warmup] refreshCompetitors failed:', err);
    }

    console.error('[cache-warmup] Background refresh completed');
  } catch (err) {
    console.error('[cache-warmup] Fatal error during warmup:', err);
  }
}

/**
 * Reset warmup state — test-only helper.
 */
export function resetCacheWarmupState(): void {
  _warmupInFlight = false;
  _lastWarmupAtMs = 0;
}
