/**
 * keyword-tracker.ts
 * P4-1: Active keyword/track search engine.
 *
 * Upgrades discovery-engine from "passive discovery" to "active search":
 * - Maintains keyword-state.json with keyword lists, velocity tracking, and search timestamps
 * - Sources keywords from: persona.content_sources.keywords, trending_topics, competitor topics
 * - Triggered as heartbeat post-hook after content-browse
 * - Search results injected into discovery pool (reuses existing scoring)
 */

import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now } from '../utils/time-utils';
import { loadPersona, getContentSourcesConfig } from '../persona/persona-loader';
import { loadDiscoveryPool, saveDiscoveryPool, scoreContent } from './discovery-engine';
import type { ContentProviderRegistry, ContentItem } from '../adapters/content-provider';
import type { DiscoveryItem } from './discovery-engine';
import type { CompetitorProfile } from '../utils/types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface KeywordEntry {
  /** The keyword text */
  keyword: string;
  /** Source of this keyword: persona config, trending, competitor */
  source: 'persona' | 'trending' | 'competitor';
  /** How many times this keyword has been searched */
  search_count: number;
  /** How many content items were found in total across all searches */
  total_found: number;
  /** Last time this keyword was searched (ISO 8601) */
  last_searched: string | null;
  /** Velocity: average items found per search (rolling) */
  velocity: number;
  /** When this keyword was first added */
  added_at: string;
}

export interface KeywordState {
  keywords: KeywordEntry[];
  last_updated: string;
  /** Total number of active searches performed */
  total_searches: number;
}

export const DEFAULT_KEYWORD_STATE: KeywordState = {
  keywords: [],
  last_updated: '',
  total_searches: 0,
};

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum keywords to track */
const MAX_KEYWORDS = 30;
/** Minimum hours between re-searching the same keyword */
const SEARCH_COOLDOWN_HOURS = 6;
/** Maximum keywords to search per heartbeat tick */
const MAX_SEARCHES_PER_TICK = 3;
/** Per-keyword search result limit */
const SEARCH_RESULT_LIMIT = 10;
/** Maximum discovery pool items */
const MAX_DISCOVERY_ITEMS = 30;
/** Minimum engagement to be considered discovery-worthy (lowered for search results) */
const SEARCH_ENGAGEMENT_THRESHOLD = 100;

// ─── I/O ────────────────────────────────────────────────────────────────────

export function loadKeywordState(): KeywordState {
  return readJSON<KeywordState>(PATHS.keywordState, DEFAULT_KEYWORD_STATE);
}

export function saveKeywordState(state: KeywordState): void {
  writeJSON(PATHS.keywordState, { ...state, last_updated: now().toISOString() });
}

// ─── Keyword Collection ─────────────────────────────────────────────────────

/**
 * Collect keywords from all sources:
 * 1. persona.content_sources.keywords (static)
 * 2. trending_topics from inspiration-state.json (dynamic)
 * 3. competitor topics from competitor-analysis.json (derived)
 */
export function collectKeywords(): KeywordEntry[] {
  const timestamp = now().toISOString();
  const entries: KeywordEntry[] = [];
  const seen = new Set<string>();

  const addKeyword = (keyword: string, source: KeywordEntry['source']) => {
    const normalized = keyword.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    entries.push({
      keyword: normalized,
      source,
      search_count: 0,
      total_found: 0,
      last_searched: null,
      velocity: 0,
      added_at: timestamp,
    });
  };

  // Source 1: persona.content_sources.keywords
  try {
    const persona = loadPersona();
    const contentSources = getContentSourcesConfig(persona);
    for (const kw of contentSources.keywords) {
      addKeyword(kw, 'persona');
    }
  } catch {
    // Persona not available — skip
  }

  // Source 2: trending_topics from inspiration-state.json
  try {
    const inspirationState = readJSON<{
      trending_topics: string[];
    }>(PATHS.inspirationState, { trending_topics: [] });
    for (const topic of inspirationState.trending_topics) {
      addKeyword(topic, 'trending');
    }
  } catch {
    // Skip
  }

  // Source 3: competitor topics from competitor-analysis.json
  try {
    const persona = loadPersona();
    const competitors: CompetitorProfile[] = persona.ops?.competitors ?? [];
    for (const comp of competitors) {
      for (const takeaway of comp.takeaways ?? []) {
        // Extract meaningful keywords from takeaways (first 2-3 words or the whole phrase if short)
        const cleaned = takeaway.replace(/^关联话题[：:]\s*/, '');
        if (cleaned.length <= 20) {
          addKeyword(cleaned, 'competitor');
        }
      }
    }
  } catch {
    // Skip
  }

  return entries;
}

/**
 * Merge newly collected keywords into existing keyword state.
 * Preserves search history for existing keywords, adds new ones, trims to MAX_KEYWORDS.
 */
export function mergeKeywords(state: KeywordState, collected: KeywordEntry[]): KeywordState {
  const existingMap = new Map(
    state.keywords.map(k => [k.keyword, k]),
  );

  for (const entry of collected) {
    if (!existingMap.has(entry.keyword)) {
      existingMap.set(entry.keyword, entry);
    } else {
      // Update source if it changed (persona > competitor > trending priority)
      const existing = existingMap.get(entry.keyword)!;
      const sourcePriority: Record<string, number> = { persona: 3, competitor: 2, trending: 1 };
      if ((sourcePriority[entry.source] ?? 0) > (sourcePriority[existing.source] ?? 0)) {
        existingMap.set(entry.keyword, { ...existing, source: entry.source });
      }
    }
  }

  // Sort: persona first, then by velocity desc, then by recency
  let keywords = [...existingMap.values()];
  const sourcePriority: Record<string, number> = { persona: 3, competitor: 2, trending: 1 };
  keywords.sort((a, b) => {
    const sp = (sourcePriority[b.source] ?? 0) - (sourcePriority[a.source] ?? 0);
    if (sp !== 0) return sp;
    return b.velocity - a.velocity;
  });

  keywords = keywords.slice(0, MAX_KEYWORDS);

  return { ...state, keywords };
}

// ─── Search Selection ───────────────────────────────────────────────────────

/**
 * Select keywords that are due for a search (cooldown expired, prioritized).
 */
export function selectKeywordsForSearch(state: KeywordState): string[] {
  const currentTime = now();
  const cooldownMs = SEARCH_COOLDOWN_HOURS * 60 * 60 * 1000;

  const eligible = state.keywords.filter(k => {
    if (!k.last_searched) return true; // Never searched → eligible
    const elapsed = currentTime.getTime() - new Date(k.last_searched).getTime();
    return elapsed >= cooldownMs;
  });

  // Prioritize: never-searched first, then highest velocity, then persona source
  const sourcePriority: Record<string, number> = { persona: 3, competitor: 2, trending: 1 };
  eligible.sort((a, b) => {
    // Never searched first
    if (!a.last_searched && b.last_searched) return -1;
    if (a.last_searched && !b.last_searched) return 1;
    // Persona keywords first
    const sp = (sourcePriority[b.source] ?? 0) - (sourcePriority[a.source] ?? 0);
    if (sp !== 0) return sp;
    // Higher velocity first
    return b.velocity - a.velocity;
  });

  return eligible.slice(0, MAX_SEARCHES_PER_TICK).map(k => k.keyword);
}

// ─── Active Search ──────────────────────────────────────────────────────────

/**
 * Run active search for a keyword using ContentProviderRegistry.
 * Returns ContentItem[] from across all available providers.
 */
export async function searchKeyword(
  registry: ContentProviderRegistry,
  keyword: string,
): Promise<ContentItem[]> {
  try {
    return await registry.search(keyword, { limit: SEARCH_RESULT_LIMIT });
  } catch (err) {
    console.warn(`[keyword-tracker] Search failed for "${keyword}": ${(err as Error).message}`);
    return [];
  }
}

/**
 * Convert search results to discovery items and inject into the discovery pool.
 * Uses the same scoring mechanism as processInspirationForDiscovery.
 */
export function injectSearchResultsToPool(
  results: ContentItem[],
  keyword: string,
): number {
  if (results.length === 0) return 0;

  const pool = loadDiscoveryPool();
  const existingTitles = new Set(pool.items.map(i => i.title));
  const timestamp = now().toISOString();
  let addedCount = 0;

  for (const item of results) {
    if (existingTitles.has(item.title)) continue;
    const likes = item.likes ?? 0;
    if (likes < SEARCH_ENGAGEMENT_THRESHOLD) continue;

    const score = scoreContent({
      title: item.title,
      likes,
      topic: keyword,
      takeaway: item.snippet,
    });

    const discoveryItem: DiscoveryItem = {
      title: item.title,
      author: item.user ?? '',
      source: `search:${item.source}`,
      engagement: likes,
      topic: keyword,
      score,
      discovered_at: timestamp,
    };

    pool.items.push(discoveryItem);
    existingTitles.add(item.title);
    addedCount++;
  }

  // Sort and trim
  pool.items.sort((a, b) => b.score - a.score);
  pool.items = pool.items.slice(0, MAX_DISCOVERY_ITEMS);

  if (addedCount > 0) {
    saveDiscoveryPool(pool);
  }

  return addedCount;
}

/**
 * Update keyword entry after a search is performed.
 */
export function updateKeywordAfterSearch(
  state: KeywordState,
  keyword: string,
  foundCount: number,
): KeywordState {
  const timestamp = now().toISOString();
  const keywords = state.keywords.map(k => {
    if (k.keyword !== keyword) return k;
    const newSearchCount = k.search_count + 1;
    const newTotalFound = k.total_found + foundCount;
    // Rolling average velocity
    const newVelocity = newSearchCount > 0 ? newTotalFound / newSearchCount : 0;
    return {
      ...k,
      search_count: newSearchCount,
      total_found: newTotalFound,
      last_searched: timestamp,
      velocity: Math.round(newVelocity * 100) / 100,
    };
  });

  return {
    ...state,
    keywords,
    total_searches: state.total_searches + 1,
  };
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Run keyword-based active search.
 * Called as heartbeat post-hook after content-browse.
 *
 * Flow:
 * 1. Collect keywords from persona + trending + competitors
 * 2. Merge into keyword state
 * 3. Select keywords due for search
 * 4. Execute searches via ContentProviderRegistry
 * 5. Inject results into discovery pool
 * 6. Update keyword state with search metrics
 *
 * @returns Summary of search activity
 */
export async function runKeywordSearch(registry: ContentProviderRegistry): Promise<{
  searched: number;
  totalDiscovered: number;
  keywords: string[];
}> {
  // 1. Collect & merge keywords
  let state = loadKeywordState();
  const collected = collectKeywords();
  state = mergeKeywords(state, collected);

  // 2. Select keywords for this tick
  const keywordsToSearch = selectKeywordsForSearch(state);
  if (keywordsToSearch.length === 0) {
    saveKeywordState(state);
    return { searched: 0, totalDiscovered: 0, keywords: [] };
  }

  // 3. Execute searches
  let totalDiscovered = 0;
  for (const keyword of keywordsToSearch) {
    const results = await searchKeyword(registry, keyword);
    const added = injectSearchResultsToPool(results, keyword);
    state = updateKeywordAfterSearch(state, keyword, results.length);
    totalDiscovered += added;
  }

  // 4. Save state
  saveKeywordState(state);

  return {
    searched: keywordsToSearch.length,
    totalDiscovered,
    keywords: keywordsToSearch,
  };
}

// ─── Context for Brief/Logging ──────────────────────────────────────────────

/**
 * Build a keyword tracking summary for the daily brief.
 */
export function buildKeywordContext(): string {
  const state = loadKeywordState();
  if (state.keywords.length === 0) return '';

  const active = state.keywords.filter(k => k.search_count > 0);
  if (active.length === 0) return '';

  const lines = ['━━ 🔍 关键词追踪 ━━'];
  const topByVelocity = [...active].sort((a, b) => b.velocity - a.velocity).slice(0, 5);

  for (const k of topByVelocity) {
    const sourceTag = k.source === 'persona' ? '📌' : k.source === 'competitor' ? '🎯' : '📈';
    lines.push(`  ${sourceTag} "${k.keyword}" — 搜索${k.search_count}次, 均产出${k.velocity}条`);
  }

  lines.push(`  累计搜索: ${state.total_searches}次`);
  return lines.join('\n');
}
