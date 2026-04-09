/**
 * tag-engine.ts
 * Builds and maintains a dynamic tag vocabulary from high-engagement platform content.
 */
import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { searchXhsNotes } from '../../sub-skills/platform/xhs-bridge/scripts/xhs-client';
import { searchDouyinVideos } from '../../sub-skills/platform/douyin-bridge/scripts/douyin-client';
import type { TagEntry, TagVocabulary, TagSource } from '../utils/types';
import type { OpsConfig } from '../utils/types';

const XHS_HIT_THRESHOLD = 1000;
const DOUYIN_HIT_THRESHOLD = 5000;
const XHS_HIT_SCORE = 10;
const DOUYIN_HIT_SCORE = 15;
const MULTI_COMPETITOR_BONUS = 20;
const DORMANT_INITIAL_SCORE = 5;
const HASHTAG_REGEX = /#[\w\u4e00-\u9fa5]+/g;

export function extractHashtags(text: string, text2?: string): string[] {
  const combined = text2 !== undefined ? `${text} ${text2}` : text;
  const matches = combined.match(HASHTAG_REGEX) ?? [];
  return [...new Set(matches)];
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
function resolveCompetitorKeyword(comp: Record<string, unknown>): string {
  if (typeof comp['name'] === 'string') return comp['name'] as string;
  if (typeof comp['account'] === 'string') return comp['account'] as string;
  return String(comp['name'] ?? comp['account'] ?? '');
}

export async function runColdStart(ops: OpsConfig, timestamp: string): Promise<TagVocabulary> {
  const tagMaps: Array<Map<string, { score: number; sources: TagSource[] }>> = [];
  const competitors = (ops.competitors ?? []) as unknown as ReadonlyArray<Record<string, unknown>>;

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
  } catch {
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
