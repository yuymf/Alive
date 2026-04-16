/**
 * viral-search.ts
 * Three proactive viral-content discovery capabilities:
 *
 * 1. runViralSearch()           — Search XHS/Douyin by engagement thresholds
 * 2. runCrossPlatformRadar()    — Cross-platform viral detection via trend-history
 * 3. runAutoBreakdown()         — Auto-trigger viral-analyzer for high-engagement items
 *
 * All three inject results into discovery-pool and are designed to run as
 * heartbeat post-hooks after keyword-tracker, or be triggered manually
 * from the dashboard.
 */

import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now } from '../utils/time-utils';
import { loadDiscoveryPool, saveDiscoveryPool, scoreContent } from './discovery-engine';
import { collectKeywords } from './keyword-tracker';
import { calcKeywordTrackRelevance } from './keyword-tracker';
import { analyzePost, persistAnalysis } from './viral-analyzer';
import { loadPersona } from '../persona/persona-loader';
import { detectKeywordLanguage } from '../utils/text-utils';
import { getIdentityKeys } from '../utils/types';
import { searchXhsNotes } from '../../sub-skills/platform/xhs-bridge/scripts/xhs-client';
import { searchDouyinVideos, getDouyinRateLimitStatus } from '../../sub-skills/platform/douyin-bridge/scripts/douyin-client';
import type { XhsNote } from '../../sub-skills/platform/xhs-bridge/scripts/xhs-client';
import type { DouyinVideo } from '../../sub-skills/platform/douyin-bridge/scripts/douyin-client';
import type { DiscoveryItem } from './discovery-engine';
import type { TrendHistory, TrendItem, PostAnalysisLog, PersonaConfig, TagVocabulary } from '../utils/types';
import type { LLMClient } from '../utils/llm-client';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Minimum engagement (likes) for viral search results */
export const VIRAL_ENGAGEMENT_THRESHOLD = 5000;

/** Minimum engagement (likes) for cross-platform radar results (lower bar — early signal) */
export const RADAR_ENGAGEMENT_THRESHOLD = 1000;

/** Maximum items auto-breakdown will analyze per run (LLM cost control) */
export const MAX_AUTO_BREAKDOWNS = 2;

/** Minimum engagement to trigger auto-breakdown */
export const AUTO_BREAKDOWN_THRESHOLD = 5000;

/** Maximum keywords to search per viral-search run */
const MAX_VIRAL_KEYWORDS = 3;

/** Maximum trend keywords to search per radar run */
const MAX_RADAR_KEYWORDS = 5;

/** Discovery pool capacity (matches discovery-engine) */
const MAX_DISCOVERY_ITEMS = 30;

/** Cooldown: minimum hours between viral-search runs */
export const VIRAL_SEARCH_COOLDOWN_HOURS = 8;

/** State file for tracking last run times */
const VIRAL_SEARCH_STATE_KEY = 'viral-search-state';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ViralSearchState {
  last_viral_search: string | null;
  last_radar_run: string | null;
  last_auto_breakdown: string | null;
}

export interface ViralSearchResult {
  searched_keywords: string[];
  xhs_found: number;
  douyin_found: number;
  injected: number;
}

export interface RadarResult {
  trend_keywords_used: string[];
  xhs_found: number;
  douyin_found: number;
  injected: number;
}

export interface AutoBreakdownResult {
  candidates_found: number;
  analyzed: number;
  titles: string[];
}

// ─── State I/O ──────────────────────────────────────────────────────────────

function getStatePath(): string {
  return PATHS.keywordState.replace('keyword-state.json', 'viral-search-state.json');
}

function loadViralSearchState(): ViralSearchState {
  return readJSON<ViralSearchState>(getStatePath(), {
    last_viral_search: null,
    last_radar_run: null,
    last_auto_breakdown: null,
  });
}

function saveViralSearchState(state: ViralSearchState): void {
  writeJSON(getStatePath(), state);
}

function isCooldownActive(lastRun: string | null, cooldownHours: number): boolean {
  if (!lastRun) return false;
  const elapsed = (now().getTime() - new Date(lastRun).getTime()) / (1000 * 60 * 60);
  return elapsed < cooldownHours;
}

// ─── XHS Viral Search ───────────────────────────────────────────────────────

/**
 * Search XHS for viral content using platform-native sort/filter options.
 * Returns notes that exceed the engagement threshold.
 */
export async function searchXhsViral(
  keyword: string,
  threshold: number = VIRAL_ENGAGEMENT_THRESHOLD,
): Promise<XhsNote[]> {
  try {
    const notes = await searchXhsNotes(keyword, {
      sortBy: '最热',
      publishTime: '7天内',
    });
    return notes.filter(note => note.likes >= threshold);
  } catch (err) {
    console.warn(`[viral-search] XHS search failed for "${keyword}": ${(err as Error).message}`);
    return [];
  }
}

// ─── Douyin Viral Search ────────────────────────────────────────────────────

/**
 * Search Douyin for viral content (search-then-filter strategy,
 * since Douyin API has no server-side engagement filter).
 */
export function searchDouyinViral(
  keyword: string,
  threshold: number = VIRAL_ENGAGEMENT_THRESHOLD,
): DouyinVideo[] {
  try {
    const result = searchDouyinVideos(keyword, 20);
    if (!result.success || !result.videos) {
      if (result.rate_limited) {
        console.warn(`[viral-search] Douyin 风控限流 for "${keyword}": ${result.reason ?? 'cooldown'}`);
      } else {
        console.warn(`[viral-search] Douyin search failed for "${keyword}": ${result.error ?? 'unknown'}`);
      }
      return [];
    }
    return result.videos.filter(v => v.digg_count >= threshold);
  } catch (err) {
    console.warn(`[viral-search] Douyin search error for "${keyword}": ${(err as Error).message}`);
    return [];
  }
}

// ─── URL Builder ────────────────────────────────────────────────────────────

/**
 * Build a full XHS URL from a note ID and xsec_token.
 */
export function buildXhsUrl(noteId: string, xsecToken: string): string {
  return `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${encodeURIComponent(xsecToken)}`;
}

// ─── Pool Injection ─────────────────────────────────────────────────────────

/**
 * Inject XHS notes into discovery pool, deduplicating by title.
 */
function injectXhsNotesToPool(
  notes: XhsNote[],
  source: string,
  keyword: string,
  pool: { items: DiscoveryItem[]; existingTitles: Set<string> },
): number {
  const timestamp = now().toISOString();
  let added = 0;

  for (const note of notes) {
    if (pool.existingTitles.has(note.title)) continue;

    const score = scoreContent({
      title: note.title,
      likes: note.likes,
      topic: keyword,
      takeaway: note.description?.slice(0, 100),
    });

    pool.items.push({
      title: note.title,
      author: note.user ?? '',
      source,
      engagement: note.likes,
      topic: keyword,
      score,
      discovered_at: timestamp,
    });
    pool.existingTitles.add(note.title);
    added++;
  }

  return added;
}

/**
 * Inject Douyin videos into discovery pool, deduplicating by desc (title).
 */
function injectDouyinVideosToPool(
  videos: DouyinVideo[],
  source: string,
  keyword: string,
  pool: { items: DiscoveryItem[]; existingTitles: Set<string> },
): number {
  const timestamp = now().toISOString();
  let added = 0;

  for (const video of videos) {
    const title = video.desc || `douyin-${video.aweme_id}`;
    if (pool.existingTitles.has(title)) continue;

    const score = scoreContent({
      title,
      likes: video.digg_count,
      topic: keyword,
    });

    pool.items.push({
      title,
      author: video.author ?? '',
      source,
      engagement: video.digg_count,
      topic: keyword,
      score,
      discovered_at: timestamp,
    });
    pool.existingTitles.add(title);
    added++;
  }

  return added;
}

// ─── Feature 1: Viral Search ────────────────────────────────────────────────

/**
 * Run viral search: collect keywords → search XHS/Douyin by engagement → inject to pool.
 *
 * Respects cooldown to avoid hammering platform APIs.
 * Can be called from heartbeat post-hook or dashboard.
 */
export async function runViralSearch(
  options?: {
    /** Override keywords (skip collectKeywords) */
    keywords?: string[];
    /** Override engagement threshold */
    threshold?: number;
    /** Skip cooldown check (for manual dashboard trigger) */
    forceFresh?: boolean;
  },
): Promise<ViralSearchResult> {
  const state = loadViralSearchState();
  const result: ViralSearchResult = {
    searched_keywords: [],
    xhs_found: 0,
    douyin_found: 0,
    injected: 0,
  };

  // Cooldown check
  if (!options?.forceFresh && isCooldownActive(state.last_viral_search, VIRAL_SEARCH_COOLDOWN_HOURS)) {
    console.log('[viral-search] Skipped — still within cooldown period');
    return result;
  }

  // Collect keywords
  const threshold = options?.threshold ?? VIRAL_ENGAGEMENT_THRESHOLD;
  let keywords: string[];

  if (options?.keywords?.length) {
    keywords = options.keywords.slice(0, MAX_VIRAL_KEYWORDS);
  } else {
    const collected = collectKeywords();
    keywords = collected
      .slice(0, MAX_VIRAL_KEYWORDS)
      .map(k => k.keyword);
  }

  // Inject active tags from tag vocabulary (tag-engine.ts) as additional search keywords
  // Filter out non-Chinese tags that don't work well for XHS/Douyin search
  const tagVocab = readJSON<TagVocabulary | null>(PATHS.tagVocabulary, null);
  if (tagVocab?.active?.length) {
    const tagKeywords = [...tagVocab.active]
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(t => t.tag.replace(/^#/, '')) // Strip # prefix for search
      .filter(tag => {
        const lang = detectKeywordLanguage(tag);
        return lang === 'zh' || lang === 'mixed' || (lang === 'en' && tag.length <= 8);
      });
    keywords.push(...tagKeywords);
  }

  // Dedup keywords (case-insensitive)
  const seen = new Set<string>();
  keywords = keywords.filter(k => {
    const lower = k.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });

  if (keywords.length === 0) {
    console.log('[viral-search] No keywords available — skipped');
    return result;
  }

  result.searched_keywords = keywords;
  console.log(`[viral-search] Searching ${keywords.length} keywords with threshold=${threshold}`);

  // Load pool once for batch injection
  const pool = loadDiscoveryPool();
  const poolHelper = {
    items: pool.items,
    existingTitles: new Set(pool.items.map(i => i.title)),
  };

  // Run all XHS searches in parallel, then process results index-aligned
  const xhsResults = await Promise.all(keywords.map(kw => searchXhsViral(kw, threshold)));

  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i];
    const xhsNotes = xhsResults[i];
    result.xhs_found += xhsNotes.length;
    result.injected += injectXhsNotesToPool(xhsNotes, `viral-search:xhs`, kw, poolHelper);

    // Douyin (sync, best-effort) — 风控冷却期内跳过
    const rlStatus = getDouyinRateLimitStatus();
    if (rlStatus.in_cooldown) {
      if (i === 0 || rlStatus.cooldown_remaining_s > 0) {
        console.warn(`[viral-search] Douyin 风控冷却中 (剩余 ${rlStatus.cooldown_remaining_s}s)，跳过剩余关键词`);
      }
      continue;
    }
    const dyVideos = searchDouyinViral(kw, threshold);
    result.douyin_found += dyVideos.length;
    result.injected += injectDouyinVideosToPool(dyVideos, `viral-search:douyin`, kw, poolHelper);
  }

  // Save pool (sort + trim)
  poolHelper.items.sort((a, b) => b.score - a.score);
  pool.items = poolHelper.items.slice(0, MAX_DISCOVERY_ITEMS);
  if (result.injected > 0) {
    saveDiscoveryPool(pool);
  }

  // Update state
  state.last_viral_search = now().toISOString();
  saveViralSearchState(state);

  console.log(
    `[viral-search] Done: ${result.xhs_found} XHS + ${result.douyin_found} Douyin found, ${result.injected} injected`,
  );

  return result;
}

// ─── Feature 2: Cross-Platform Radar ────────────────────────────────────────

/**
 * Extract top velocity trend keywords from trend-history.json.
 * Filters by persona track relevance: off-track keywords are deprioritized.
 * Allows up to 1 "wildcard" slot for cross-track trending content.
 */
export function extractTopTrendKeywords(limit: number = MAX_RADAR_KEYWORDS): string[] {
  try {
    const historyArr = readJSON<TrendHistory[]>(PATHS.trendHistory, []);
    if (historyArr.length === 0) return [];

    // Get the most recent day's trends
    const latest = historyArr[historyArr.length - 1];
    if (!latest.trends || latest.trends.length === 0) return [];

    // Load identity keys for track filtering
    let identityKeys: string[] = [];
    try {
      const persona = loadPersona();
      identityKeys = getIdentityKeys(persona);
    } catch {
      // No persona — skip track filtering
    }

    // Sort by velocity_score descending and take top N unique keywords
    const sorted = [...latest.trends]
      .filter(t => t.velocity_score > 0)
      .sort((a, b) => b.velocity_score - a.velocity_score);

    const seen = new Set<string>();
    const onTrackKeywords: string[] = [];
    const offTrackKeywords: string[] = [];

    for (const trend of sorted) {
      const kw = trend.keyword.trim().toLowerCase();
      if (!kw || seen.has(kw)) continue;
      // Filter out non-Chinese trend keywords
      const lang = detectKeywordLanguage(kw);
      if (lang === 'ja') continue; // Skip Japanese
      if (lang === 'en' && kw.length > 8) continue; // Skip long English keywords
      seen.add(kw);

      const originalKw = trend.keyword.trim(); // Keep original casing for search

      // Track relevance check
      if (identityKeys.length > 0) {
        const relevance = calcKeywordTrackRelevance(originalKw, identityKeys);
        if (relevance > 0) {
          onTrackKeywords.push(originalKw);
        } else {
          offTrackKeywords.push(originalKw);
        }
      } else {
        // No identity info — treat all as on-track
        onTrackKeywords.push(originalKw);
      }

      if (onTrackKeywords.length + Math.min(offTrackKeywords.length, 1) >= limit) break;
    }

    // Compose result: all on-track keywords + up to 1 wildcard off-track keyword
    const result = [...onTrackKeywords];
    if (result.length < limit && offTrackKeywords.length > 0) {
      result.push(offTrackKeywords[0]); // 1 wildcard slot for cross-track discovery
    }

    return result.slice(0, limit);
  } catch (err) {
    console.warn(`[radar] Failed to read trend-history: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Run cross-platform radar: read trend-history → search XHS/Douyin → inject to pool.
 *
 * Discovers content that has gone viral on one platform but may also be trending
 * on another platform (cross-platform viral detection).
 */
export async function runCrossPlatformRadar(
  options?: {
    /** Override trend keywords */
    keywords?: string[];
    /** Override engagement threshold */
    threshold?: number;
    /** Skip cooldown check */
    forceFresh?: boolean;
  },
): Promise<RadarResult> {
  const state = loadViralSearchState();
  const result: RadarResult = {
    trend_keywords_used: [],
    xhs_found: 0,
    douyin_found: 0,
    injected: 0,
  };

  // Cooldown check (shares the same cooldown window)
  if (!options?.forceFresh && isCooldownActive(state.last_radar_run, VIRAL_SEARCH_COOLDOWN_HOURS)) {
    console.log('[radar] Skipped — still within cooldown period');
    return result;
  }

  const threshold = options?.threshold ?? RADAR_ENGAGEMENT_THRESHOLD;

  // Extract trend keywords
  let keywords: string[];
  if (options?.keywords?.length) {
    keywords = options.keywords.slice(0, MAX_RADAR_KEYWORDS);
  } else {
    keywords = extractTopTrendKeywords(MAX_RADAR_KEYWORDS);
  }

  if (keywords.length === 0) {
    console.log('[radar] No trend keywords available — skipped');
    return result;
  }

  result.trend_keywords_used = keywords;
  console.log(`[radar] Scanning ${keywords.length} trend keywords with threshold=${threshold}`);

  // Load pool once
  const pool = loadDiscoveryPool();
  const poolHelper = {
    items: pool.items,
    existingTitles: new Set(pool.items.map(i => i.title)),
  };

  // Search each trend keyword on target platforms
  for (const kw of keywords) {
    // XHS
    try {
      const xhsNotes = await searchXhsNotes(kw, {
        sortBy: '最热',
        publishTime: '7天内',
      });
      const filtered = xhsNotes.filter(n => n.likes >= threshold);
      result.xhs_found += filtered.length;
      result.injected += injectXhsNotesToPool(filtered, `radar:trending→xhs`, kw, poolHelper);
    } catch (err) {
      console.warn(`[radar] XHS search failed for "${kw}": ${(err as Error).message}`);
    }

    // Douyin — 风控冷却期内跳过
    const dyRlStatus = getDouyinRateLimitStatus();
    if (!dyRlStatus.in_cooldown) {
      try {
        const dyResult = searchDouyinVideos(kw, 20);
        if (dyResult.success && dyResult.videos) {
          const filtered = dyResult.videos.filter(v => v.digg_count >= threshold);
          result.douyin_found += filtered.length;
          result.injected += injectDouyinVideosToPool(filtered, `radar:trending→douyin`, kw, poolHelper);
        } else if (dyResult.rate_limited) {
          console.warn(`[radar] Douyin 风控限流 for "${kw}": ${dyResult.reason ?? 'cooldown'}`);
        }
      } catch (err) {
        console.warn(`[radar] Douyin search failed for "${kw}": ${(err as Error).message}`);
      }
    }
  }

  // Save pool
  poolHelper.items.sort((a, b) => b.score - a.score);
  pool.items = poolHelper.items.slice(0, MAX_DISCOVERY_ITEMS);
  if (result.injected > 0) {
    saveDiscoveryPool(pool);
  }

  // Update state
  state.last_radar_run = now().toISOString();
  saveViralSearchState(state);

  console.log(
    `[radar] Done: ${result.xhs_found} XHS + ${result.douyin_found} Douyin found, ${result.injected} injected`,
  );

  return result;
}

// ─── Feature 3: Auto-Breakdown Pipeline ─────────────────────────────────────

/**
 * Attempt to build a fetchable XHS URL for a discovery item by searching for its title.
 * Returns null if no match is found.
 */
export async function buildXhsUrlForTitle(title: string): Promise<string | null> {
  try {
    const notes = await searchXhsNotes(title);
    if (notes.length === 0) return null;

    // Find the best match (exact or closest title)
    const match = notes.find(n => n.title === title) ?? notes[0];
    if (!match.id || !match.xsec_token) return null;

    return buildXhsUrl(match.id, match.xsec_token);
  } catch (err) {
    console.warn(`[auto-breakdown] URL lookup failed for "${title}": ${(err as Error).message}`);
    return null;
  }
}

/**
 * Run auto-breakdown: scan discovery-pool for high-engagement items,
 * auto-trigger viral-analyzer for unanalyzed entries.
 *
 * - Threshold: AUTO_BREAKDOWN_THRESHOLD (default 5000)
 * - Max per run: MAX_AUTO_BREAKDOWNS (default 2) for LLM cost control
 * - Dedup: skips items already in post-analysis-log.json
 */
export async function runAutoBreakdown(
  llm: LLMClient,
  options?: {
    /** Override engagement threshold */
    threshold?: number;
    /** Override max breakdowns per run */
    maxBreakdowns?: number;
    /** Skip cooldown check */
    forceFresh?: boolean;
  },
): Promise<AutoBreakdownResult> {
  const result: AutoBreakdownResult = {
    candidates_found: 0,
    analyzed: 0,
    titles: [],
  };

  const threshold = options?.threshold ?? AUTO_BREAKDOWN_THRESHOLD;
  const maxBreakdowns = options?.maxBreakdowns ?? MAX_AUTO_BREAKDOWNS;

  // Load discovery pool
  const pool = loadDiscoveryPool();

  // Load existing analysis log for dedup
  const analysisLog = readJSON<PostAnalysisLog>(PATHS.postAnalysisLog, { entries: [] });
  const analyzedTitles = new Set(analysisLog.entries.map(e => e.title));

  // Filter: high engagement + not yet analyzed
  const candidates = pool.items.filter(
    item => item.engagement >= threshold && !analyzedTitles.has(item.title),
  );

  result.candidates_found = candidates.length;

  if (candidates.length === 0) {
    console.log('[auto-breakdown] No new candidates above threshold — skipped');
    return result;
  }

  console.log(
    `[auto-breakdown] Found ${candidates.length} candidates, will analyze up to ${maxBreakdowns}`,
  );

  // Load persona for analysis prompt
  let persona: PersonaConfig;
  try {
    persona = loadPersona();
  } catch (err) {
    console.warn(`[auto-breakdown] Failed to load persona — skipped: ${(err as Error).message}`);
    return result;
  }

  // Process top candidates (sorted by engagement desc)
  const sortedCandidates = [...candidates].sort((a, b) => b.engagement - a.engagement);
  const toAnalyze = sortedCandidates.slice(0, maxBreakdowns);

  for (const candidate of toAnalyze) {
    try {
      // Build URL: search XHS by title to get noteId + xsec_token
      const url = await buildXhsUrlForTitle(candidate.title);
      if (!url) {
        console.warn(`[auto-breakdown] Could not find URL for "${candidate.title}" — skipped`);
        continue;
      }

      console.log(`[auto-breakdown] Analyzing: "${candidate.title}"`);
      const analysis = await analyzePost(url, persona, llm);
      persistAnalysis(analysis);

      result.analyzed++;
      result.titles.push(candidate.title);
      console.log(`[auto-breakdown] ✓ Analyzed: "${candidate.title}"`);
    } catch (err) {
      console.warn(
        `[auto-breakdown] Failed to analyze "${candidate.title}": ${(err as Error).message}`,
      );
      // Continue to next candidate — don't let one failure block others
    }
  }

  // Update state
  const state = loadViralSearchState();
  state.last_auto_breakdown = now().toISOString();
  saveViralSearchState(state);

  console.log(
    `[auto-breakdown] Done: ${result.analyzed}/${result.candidates_found} analyzed`,
  );

  return result;
}
