/**
 * tag-engine.ts
 * Builds and maintains a dynamic tag vocabulary from high-engagement platform content.
 */
import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { searchXhsNotes } from '../../sub-skills/platform/xhs-bridge/scripts/xhs-client';
import { searchDouyinVideos } from '../../sub-skills/platform/douyin-bridge/scripts/douyin-client';
import { detectKeywordLanguage } from '../utils/text-utils';
import type { TagEntry, TagVocabulary, TagSource } from '../utils/types';
import type { OpsConfig, ViralEntry } from '../utils/types';
import { now } from '../utils/time-utils';

const XHS_HIT_THRESHOLD = 1000;
const DOUYIN_HIT_THRESHOLD = 5000;
const XHS_HIT_SCORE = 10;
const DOUYIN_HIT_SCORE = 15;
const MULTI_COMPETITOR_BONUS = 20;
const DORMANT_INITIAL_SCORE = 5;
const HASHTAG_REGEX = /#[\w\u4e00-\u9fa5]+/g;

const DECAY_FACTOR = 0.85;
const DORMANT_SCORE_THRESHOLD = 5;
const ACTIVE_TO_DORMANT_DAYS = 7;
const DORMANT_DELETE_DAYS = 30;
const TOP_ACTIVE_REFRESH = 10;
const REFRESH_LIMIT = 5;
const REVIVAL_SAMPLE_SIZE = 10;
const REVIVAL_SCORE = 15;

export function extractHashtags(text: string, text2?: string): string[] {
  const combined = text2 !== undefined ? `${text} ${text2}` : text;
  const matches = combined.match(HASHTAG_REGEX) ?? [];
  // Filter out non-Chinese tags (Japanese, pure English) that don't work well as search keywords
  return [...new Set(matches)].filter(tag => {
    const content = tag.slice(1); // Remove leading #
    const lang = detectKeywordLanguage(content);
    // Accept Chinese, mixed (like "AI绘画"), and short English tags (≤8 chars)
    if (lang === 'zh' || lang === 'mixed') return true;
    if (lang === 'en' && content.length <= 8) return true; // Short English tags are OK (e.g. #OOTD)
    return false;
  });
}

export function scoreForPlatform(platform: 'xhs' | 'douyin'): number {
  return platform === 'xhs' ? XHS_HIT_SCORE : DOUYIN_HIT_SCORE;
}

export function buildInitialEntry(
  tag: string,
  platform: 'xhs' | 'douyin' | 'both',
  score: number,
  source: TagSource,
  timestamp: string,
): TagEntry {
  return {
    tag,
    platform,
    score,
    sources: [source],
    first_seen: timestamp,
    last_hit: timestamp,
    hit_count: 1,
    peak_score: score,
  };
}

export function mergeTags(
  maps: Array<Map<string, { score: number; sources: TagSource[] }>>,
  timestamp: string,
): { active: TagEntry[]; dormant: TagEntry[] } {
  const combined = new Map<string, { score: number; sources: TagSource[]; freq: number }>();

  for (const m of maps) {
    for (const [tag, data] of m) {
      const existing = combined.get(tag);
      if (existing) {
        existing.score += data.score;
        existing.sources.push(...data.sources);
        existing.freq += 1;
      } else {
        combined.set(tag, { score: data.score, sources: [...data.sources], freq: 1 });
      }
    }
  }

  const active: TagEntry[] = [];
  const dormant: TagEntry[] = [];

  for (const [tag, data] of combined) {
    const competitorAccounts = new Set(
      data.sources
        .filter(s => s.type === 'competitor')
        .map(s => (s as { type: 'competitor'; account: string; platform: string }).account),
    );
    const multiBonus = competitorAccounts.size >= 2 ? MULTI_COMPETITOR_BONUS : 0;

    const platforms = new Set(data.sources.map(s => s.platform));
    const platform: 'xhs' | 'douyin' | 'both' =
      platforms.has('xhs') && platforms.has('douyin')
        ? 'both'
        : platforms.has('douyin')
          ? 'douyin'
          : 'xhs';

    const finalScore = data.score + multiBonus;
    const entry: TagEntry = {
      tag,
      platform,
      score: finalScore,
      sources: data.sources,
      first_seen: timestamp,
      last_hit: timestamp,
      hit_count: data.freq,
      peak_score: finalScore,
    };

    if (data.freq >= 2) {
      active.push(entry);
    } else {
      dormant.push({ ...entry, score: DORMANT_INITIAL_SCORE });
    }
  }

  return { active, dormant };
}

async function searchXhsHighEngagement(
  keyword: string,
  limit: number,
): Promise<Array<{ tags: string[] }>> {
  try {
    const notes = await searchXhsNotes(keyword, { sortBy: '最新', noteType: '全部' });
    return notes
      .slice(0, limit)
      .filter(n => (n.likes ?? 0) >= XHS_HIT_THRESHOLD)
      .map(n => ({ tags: extractHashtags(n.title, n.description) }));
  } catch {
    return [];
  }
}

function searchDouyinHighEngagement(
  keyword: string,
  count: number,
): Array<{ tags: string[] }> {
  try {
    const result = searchDouyinVideos(keyword, count);
    if (!result.success || !result.videos) return [];
    return result.videos
      .filter((v: { digg_count: number }) => v.digg_count >= DOUYIN_HIT_THRESHOLD)
      .map((v: { desc: string }) => ({ tags: extractHashtags(v.desc) }));
  } catch {
    return [];
  }
}

/** Resolve the search keyword for a competitor entry.
 * Supports both `CompetitorProfile` (has `name`) and ad-hoc test objects (has `account`).
 */
function resolveCompetitorKeyword(comp: { name?: string; account?: string; [key: string]: unknown }): string {
  if (typeof comp['name'] === 'string') return comp['name'] as string;
  if (typeof comp['account'] === 'string') return comp['account'] as string;
  return String(comp['name'] ?? comp['account'] ?? '');
}

export async function runColdStart(ops: OpsConfig, timestamp: string): Promise<TagVocabulary> {
  const tagMaps: Array<Map<string, { score: number; sources: TagSource[] }>> = [];
  type CompetitorEntry = { name?: string; account?: string; platform?: string; [key: string]: unknown };
  const competitors = (ops.competitors ?? []) as unknown as ReadonlyArray<CompetitorEntry>;

  for (const comp of competitors) {
    const platform = (comp['platform'] as string | undefined) ?? 'xhs';
    const accountKey = resolveCompetitorKeyword(comp);
    const tagMap = new Map<string, { score: number; sources: TagSource[] }>();

    if (platform === 'xhs' || platform === 'xhs_and_douyin') {
      const hits = await searchXhsHighEngagement(accountKey, 20);
      for (const h of hits) {
        for (const tag of h.tags) {
          const source: TagSource = { type: 'competitor', account: accountKey, platform: 'xhs' };
          const existing = tagMap.get(tag);
          if (existing) {
            existing.score += XHS_HIT_SCORE;
            existing.sources.push(source);
          } else {
            tagMap.set(tag, { score: XHS_HIT_SCORE, sources: [source] });
          }
        }
      }
    }

    if (platform === 'douyin' || platform === 'xhs_and_douyin') {
      const hits = searchDouyinHighEngagement(accountKey, 20);
      for (const h of hits) {
        for (const tag of h.tags) {
          const source: TagSource = { type: 'competitor', account: accountKey, platform: 'douyin' };
          const existing = tagMap.get(tag);
          if (existing) {
            existing.score += DOUYIN_HIT_SCORE;
            existing.sources.push(source);
          } else {
            tagMap.set(tag, { score: DOUYIN_HIT_SCORE, sources: [source] });
          }
        }
      }
    }

    if (tagMap.size > 0) {
      tagMaps.push(tagMap);
    }
  }

  // Seed keywords → tag extraction
  try {
    const { collectKeywords } = await import('./keyword-tracker');
    const keywords = collectKeywords().slice(0, 10);
    for (const kw of keywords) {
      const tagMap = new Map<string, { score: number; sources: TagSource[] }>();
      const hits = await searchXhsHighEngagement(kw.keyword, 20);
      for (const h of hits) {
        for (const tag of h.tags) {
          const source: TagSource = { type: 'keyword_search', keyword: kw.keyword, platform: 'xhs' };
          const existing = tagMap.get(tag);
          if (existing) {
            existing.score += XHS_HIT_SCORE;
            existing.sources.push(source);
          } else {
            tagMap.set(tag, { score: XHS_HIT_SCORE, sources: [source] });
          }
        }
      }
      if (tagMap.size > 0) tagMaps.push(tagMap);
    }
  } catch (err) {
    const msg = (err as Error)?.message ?? '';
    if (!msg.includes('Cannot find module') && !msg.includes('MODULE_NOT_FOUND')) {
      throw err;
    }
    // keyword-tracker not available — skip
  }

  const { active, dormant } = mergeTags(tagMaps, timestamp);
  const vocab: TagVocabulary = {
    version: 1,
    last_updated: timestamp,
    active,
    dormant,
  };

  writeJSON(PATHS.tagVocabulary, vocab);
  return vocab;
}

// ─── Daily decay ─────────────────────────────────────────────────────────────

/**
 * Apply daily decay to all active entries.
 * Entries with score < DORMANT_SCORE_THRESHOLD AND last_hit > ACTIVE_TO_DORMANT_DAYS
 * are split off into newDormant[].
 *
 * @param opts.returnSplit  When true, returns { stillActive, newDormant }.
 *                         When false (default), returns the still-active list directly.
 */
export function applyDailyDecay(
  entries: TagEntry[],
  opts: { returnSplit: true },
): { stillActive: TagEntry[]; newDormant: TagEntry[] };
export function applyDailyDecay(
  entries: TagEntry[],
  opts?: { returnSplit?: false },
): TagEntry[];
export function applyDailyDecay(
  entries: TagEntry[],
  opts?: { returnSplit?: boolean },
): TagEntry[] | { stillActive: TagEntry[]; newDormant: TagEntry[] } {
  const cutoff = Date.now() - ACTIVE_TO_DORMANT_DAYS * 24 * 60 * 60 * 1000;
  const stillActive: TagEntry[] = [];
  const newDormant: TagEntry[] = [];

  for (const entry of entries) {
    const decayed = Math.floor(entry.score * DECAY_FACTOR);
    const lastHitTs = new Date(entry.last_hit).getTime();
    const isDead = decayed < DORMANT_SCORE_THRESHOLD && lastHitTs < cutoff;
    const updated: TagEntry = { ...entry, score: decayed, peak_score: Math.max(entry.peak_score, decayed) };
    if (isDead) {
      newDormant.push(updated);
    } else {
      stillActive.push(updated);
    }
  }

  if (opts?.returnSplit) {
    return { stillActive, newDormant };
  }
  return stillActive;
}

// ─── Active tag refresh ──────────────────────────────────────────────────────

/**
 * Inject any tags from `hits` that are not already in `updated` as new entries.
 */
function discoverNewTagsFromHits(
  hits: Array<{ tags: string[] }>,
  platform: 'xhs' | 'douyin',
  score: number,
  keyword: string,
  updated: Map<string, TagEntry>,
  timestamp: string,
): void {
  for (const hit of hits) {
    for (const newTag of hit.tags) {
      if (!updated.has(newTag)) {
        const source: TagSource = { type: 'keyword_search', keyword, platform };
        updated.set(newTag, buildInitialEntry(newTag, platform, score, source, timestamp));
      }
    }
  }
}

/**
 * Refresh the top active tags by searching XHS (and Douyin when available).
 * High-engagement hits → score += platform delta, last_hit updated.
 * Returns the updated entries (immutable — new array).
 */
export async function refreshActiveTags(
  active: TagEntry[],
  timestamp: string,
): Promise<TagEntry[]> {
  const top = [...active].sort((a, b) => b.score - a.score).slice(0, TOP_ACTIVE_REFRESH);
  const updated = new Map(active.map(e => [e.tag, e]));

  // Run all XHS searches in parallel (sortBy: 最新 for recency)
  const xhsResults = await Promise.all(
    top.map(entry => searchXhsHighEngagement(entry.tag, REFRESH_LIMIT)),
  );

  for (let i = 0; i < top.length; i++) {
    const entry = top[i];
    const xhsHits = xhsResults[i];

    if (xhsHits.length > 0) {
      const existing = updated.get(entry.tag)!;
      const newScore = existing.score + xhsHits.length * XHS_HIT_SCORE;
      updated.set(entry.tag, {
        ...existing,
        score: newScore,
        peak_score: Math.max(existing.peak_score, newScore),
        last_hit: timestamp,
        hit_count: existing.hit_count + xhsHits.length,
      });
    }

    // Douyin search (sync, best-effort)
    const douyinHits = searchDouyinHighEngagement(entry.tag, REFRESH_LIMIT);
    if (douyinHits.length > 0) {
      const existing = updated.get(entry.tag)!;
      const newScore = existing.score + douyinHits.length * DOUYIN_HIT_SCORE;
      updated.set(entry.tag, {
        ...existing,
        score: newScore,
        peak_score: Math.max(existing.peak_score, newScore),
        last_hit: timestamp,
        hit_count: existing.hit_count + douyinHits.length,
        platform: existing.platform === 'xhs' ? 'both' : existing.platform,
      });
    }

    discoverNewTagsFromHits(xhsHits, 'xhs', XHS_HIT_SCORE, entry.tag, updated, timestamp);
    discoverNewTagsFromHits(douyinHits, 'douyin', DOUYIN_HIT_SCORE, entry.tag, updated, timestamp);
  }

  return [...updated.values()];
}

// ─── Dormant revival ─────────────────────────────────────────────────────────

/**
 * Sample up to REVIVAL_SAMPLE_SIZE dormant entries, check for new XHS hits.
 *   - last_hit > 30 days → delete (not returned in kept[])
 *   - has fresh high-engagement hit → move to revived[] with score = REVIVAL_SCORE
 *   - otherwise → stay in kept[]
 */
export async function reviveDormantSample(
  dormant: TagEntry[],
  _active: TagEntry[],
): Promise<{ kept: TagEntry[]; revived: TagEntry[] }> {
  const deleteCutoff = Date.now() - DORMANT_DELETE_DAYS * 24 * 60 * 60 * 1000;

  // First pass: remove expired entries
  const notExpired = dormant.filter(e => new Date(e.last_hit).getTime() >= deleteCutoff);

  // Sample up to REVIVAL_SAMPLE_SIZE for XHS check
  const sample = notExpired.slice(0, REVIVAL_SAMPLE_SIZE);

  const kept: TagEntry[] = [];
  const revived: TagEntry[] = [];
  const checkedTags = new Set<string>();

  for (const entry of sample) {
    checkedTags.add(entry.tag);
    const hits = await searchXhsHighEngagement(entry.tag, 5);
    if (hits.length > 0) {
      revived.push({ ...entry, score: REVIVAL_SCORE, last_hit: now().toISOString() });
    } else {
      kept.push(entry);
    }
  }

  // Entries not in sample stay in kept
  for (const entry of notExpired) {
    if (!checkedTags.has(entry.tag)) {
      kept.push(entry);
    }
  }

  return { kept, revived };
}

// ─── Viral KB → Tag Engine feedback ───────────────────────────────────────────

/**
 * Boost tag scores from a newly inserted viral KB entry.
 * Extracts hashtags from the entry's title/description + implicit tag from content_type,
 * then updates the tag vocabulary accordingly.
 *
 * - Active tags: score += 25, hit_count++, source appended
 * - Dormant tags: moved to active with score = 25, hit_count++
 * - New tags: created with score = 25 via buildInitialEntry()
 *
 * No-op if vocabulary file does not exist (cold-start safe).
 * Wrapped in try/catch at the call site — failures do not affect main flow.
 */
export function boostTagsFromViralEntry(entry: ViralEntry): void {
  const existing = readJSON<TagVocabulary | null>(PATHS.tagVocabulary, null);
  if (!existing) return; // cold start — no vocabulary yet

  const tags = extractHashtags(entry.title, entry.description);

  // Add implicit tag from content_type if available
  if (entry.dissection?.content_type) {
    const implicitTag = `#${entry.dissection.content_type}`;
    if (!tags.includes(implicitTag)) {
      tags.push(implicitTag);
    }
  }

  if (tags.length === 0) return;

  const timestamp = now().toISOString();
  const source: TagSource = {
    type: 'viral_kb',
    entry_id: entry.id,
    platform: entry.platform,
  };
  const entryPlatform: 'xhs' | 'douyin' =
    entry.platform === 'douyin' ? 'douyin' : 'xhs';

  const activeMap = new Map(existing.active.map(e => [e.tag, e]));
  const dormantMap = new Map(existing.dormant.map(e => [e.tag, e]));
  const BOOST_SCORE = 25;

  for (const tag of tags) {
    const activeEntry = activeMap.get(tag);
    if (activeEntry) {
      // Boost existing active tag
      const newScore = activeEntry.score + BOOST_SCORE;
      activeMap.set(tag, {
        ...activeEntry,
        score: newScore,
        peak_score: Math.max(activeEntry.peak_score, newScore),
        hit_count: activeEntry.hit_count + 1,
        last_hit: timestamp,
        sources: [...activeEntry.sources, source],
      });
      continue;
    }

    const dormantEntry = dormantMap.get(tag);
    if (dormantEntry) {
      // Revive dormant tag → move to active
      dormantMap.delete(tag);
      activeMap.set(tag, {
        ...dormantEntry,
        score: BOOST_SCORE,
        peak_score: Math.max(dormantEntry.peak_score, BOOST_SCORE),
        hit_count: dormantEntry.hit_count + 1,
        last_hit: timestamp,
        sources: [...dormantEntry.sources, source],
      });
      continue;
    }

    // Brand new tag
    activeMap.set(tag, buildInitialEntry(tag, entryPlatform, BOOST_SCORE, source, timestamp));
  }

  const updatedVocab: TagVocabulary = {
    ...existing,
    last_updated: timestamp,
    active: [...activeMap.values()],
    dormant: [...dormantMap.values()],
  };

  writeJSON(PATHS.tagVocabulary, updatedVocab);
}

// ─── Daily maintenance entry point ───────────────────────────────────────────

/**
 * Run the full daily maintenance cycle on the tag vocabulary.
 *
 * Steps:
 *   1. Refresh top active tags (search XHS + Douyin for hits)
 *   2. Apply daily decay to all active entries
 *   3. Revive/prune dormant entries
 *   4. Persist updated vocabulary
 */
export async function runDailyMaintenance(timestamp: string): Promise<TagVocabulary> {
  const existing = readJSON<TagVocabulary>(PATHS.tagVocabulary, {
    version: 1,
    last_updated: timestamp,
    active: [],
    dormant: [],
  });

  // Step 1: Refresh active tags (find hits, discover new tags)
  const refreshed = await refreshActiveTags(existing.active, timestamp);

  // Step 2: Apply daily decay, split out newly dormant entries
  const { stillActive, newDormant } = applyDailyDecay(refreshed, { returnSplit: true });

  // Step 3: Revival check on dormant
  const allDormant = [...existing.dormant, ...newDormant];
  const { kept, revived } = await reviveDormantSample(allDormant, stillActive);

  const finalActive = [...stillActive, ...revived];
  const finalDormant = kept;

  const vocab: TagVocabulary = {
    version: 1,
    last_updated: timestamp,
    active: finalActive,
    dormant: finalDormant,
  };

  writeJSON(PATHS.tagVocabulary, vocab);
  return vocab;
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Main entry: cold-start if vocabulary missing, else daily maintenance.
 * Returns run stats for logging.
 */
export async function runTagEngine(ops: OpsConfig): Promise<{
  mode: 'cold_start' | 'maintenance';
  activeCount: number;
  dormantCount: number;
  timestamp: string;
}> {
  const timestamp = now().toISOString();
  const existing = readJSON<TagVocabulary | null>(PATHS.tagVocabulary, null);

  let vocab: TagVocabulary;
  let mode: 'cold_start' | 'maintenance';

  if (!existing) {
    console.log('[tag-engine] No vocabulary found — running cold start');
    vocab = await runColdStart(ops, timestamp);
    mode = 'cold_start';
  } else {
    console.log(`[tag-engine] Running daily maintenance (${existing.active.length} active, ${existing.dormant.length} dormant)`);
    vocab = await runDailyMaintenance(timestamp);
    mode = 'maintenance';
  }

  return {
    mode,
    activeCount: vocab.active.length,
    dormantCount: vocab.dormant.length,
    timestamp,
  };
}
