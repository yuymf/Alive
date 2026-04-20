import { PATHS, readJSON } from '../utils/file-utils';
import { now, getLocalDate } from '../utils/time-utils';
import type { CompetitorLog, CompetitorUpdate } from '../utils/types';
import {
  TRENDS_CACHE_TTL_MS,
  TRENDS_EMPTY_CACHE_TTL_MS,
  TREND_SCORING_VERSION,
} from '../ops/trend-analyzer';
import { COMPETITOR_CACHE_TTL_MS } from '../ops/competitor-tracker';

interface TrendsCacheData {
  computed_at: string;
  persona_identities?: string;
  scoring_version?: number;
  results: unknown[];
}

export interface OpsTrendsCacheStatus {
  trendsFromCache: boolean;
  competitorsFromCache: boolean;
  trendsAgeMin: number;
  competitorsAgeMin: number;
}

function toAgeMin(ageMs: number | null): number {
  return ageMs === null ? Infinity : Math.round(ageMs / 60_000);
}

function getOldestFetchedAtMs(entries: CompetitorUpdate[]): number | null {
  const timestamps = entries
    .map(entry => Date.parse(entry.fetched_at))
    .filter(ts => Number.isFinite(ts));

  return timestamps.length > 0 ? Math.min(...timestamps) : null;
}

function getCompetitorEntriesForToday(log: CompetitorLog): CompetitorUpdate[] {
  const today = getLocalDate(now());
  return (log.entries ?? []).filter(entry => getLocalDate(new Date(entry.fetched_at)) === today);
}

export function getOpsTrendsCacheStatus(personaIdentities: string): OpsTrendsCacheStatus {
  const result: OpsTrendsCacheStatus = {
    trendsFromCache: false,
    competitorsFromCache: false,
    trendsAgeMin: Infinity,
    competitorsAgeMin: Infinity,
  };

  try {
    const cache = readJSON<TrendsCacheData>(PATHS.trendsCache, null as unknown as TrendsCacheData);
    if (cache?.computed_at) {
      const ageMs = now().getTime() - new Date(cache.computed_at).getTime();
      const ttlMs = (cache.results?.length ?? 0) === 0 ? TRENDS_EMPTY_CACHE_TTL_MS : TRENDS_CACHE_TTL_MS;
      result.trendsAgeMin = toAgeMin(ageMs);
      if (
        ageMs < ttlMs
        && cache.persona_identities === personaIdentities
        && cache.scoring_version === TREND_SCORING_VERSION
      ) {
        result.trendsFromCache = true;
      }
    }
  } catch {
    // missing or corrupt cache -> treat as stale
  }

  try {
    const competitorLog = readJSON<CompetitorLog>(PATHS.competitorLog, { entries: [], last_updated: '' });
    const todayEntries = getCompetitorEntriesForToday(competitorLog);
    if (todayEntries.length > 0) {
      const sourceAtMs = getOldestFetchedAtMs(todayEntries) ?? Date.parse(competitorLog.last_updated);
      const ageMs = Number.isFinite(sourceAtMs) ? now().getTime() - sourceAtMs : null;
      result.competitorsAgeMin = toAgeMin(ageMs);
      if (ageMs !== null && ageMs < COMPETITOR_CACHE_TTL_MS) {
        result.competitorsFromCache = true;
      }
    }
  } catch {
    // missing or corrupt cache -> treat as stale
  }

  return result;
}
