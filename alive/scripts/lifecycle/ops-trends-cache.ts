import { PATHS, readJSON } from '../utils/file-utils';
import { now } from '../utils/time-utils';
import {
  TRENDS_CACHE_TTL_MS,
  TRENDS_EMPTY_CACHE_TTL_MS,
  TREND_SCORING_VERSION,
} from '../ops/trend-analyzer';
import { COMPETITOR_CACHE_TTL_MS, readCachedCompetitorsWithMeta } from '../ops/competitor-tracker';

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
    const competitorMeta = readCachedCompetitorsWithMeta();
    if (competitorMeta.computed_at && competitorMeta.updates.length > 0) {
      const sourceAtMs = Date.parse(competitorMeta.computed_at);
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
