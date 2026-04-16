/**
 * trend-analyzer.ts
 * Fetches trending topics from the remote DailyHot API (douyin, weibo, bilibili, toutiao, etc.),
 * computes velocity scores vs 7-day history, filters by threshold,
 * and runs LLM relevance filter based on persona's topic_filter_prompt.
 *
 * Data source: https://dailyhot-rho-nine.vercel.app/<platform>?limit=N
 * (Previously used ClawHub skills — migrated to direct API calls for reliability.)
 */

import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now, getLocalDate } from '../utils/time-utils';
import { TrendItem, TrendHistory, OpsConfig, PersonaConfig, TagVocabulary, TrendSourceType, TrendSourceBucket, TrendSignalKind, toSourceBucket, sourceWeight, classifySignalKind } from '../utils/types';
import { LLMClient } from '../utils/llm-client';
import { normalizeKeyword, extractTrendHookKeyword } from '../utils/text-utils';
import { loadDiscoveryPool } from './discovery-engine';
import type { DiscoveryItem } from './discovery-engine';
import { searchXhsNotes } from '../../sub-skills/platform/xhs-bridge/scripts/xhs-client';
import { searchDouyinVideos, getDouyinRateLimitStatus } from '../../sub-skills/platform/douyin-bridge/scripts/douyin-client';

const isDebug = () => process.env.ALIVE_DEBUG === '1' || process.env.ALIVE_DEBUG === 'true';

// ─── Pure functions (exported for testing) ───────────────────────────────────

/**
 * Build persona identities string for LLM relevance filtering.
 * Prefers ops.topic_filter_prompt → identities keys → core_traits fallback.
 */
export function buildPersonaIdentities(persona: PersonaConfig): string {
  // Best: ops.topic_filter_prompt has curated identity description
  if (persona.ops?.topic_filter_prompt) {
    return persona.ops.topic_filter_prompt.trim();
  }
  // Good: identities field lists role names
  const identities = (persona as unknown as Record<string, unknown>).identities as Record<string, unknown> | undefined;
  if (identities && typeof identities === 'object') {
    const keys = Object.keys(identities);
    if (keys.length > 0) {
      return keys.map(k => k.replace(/_/g, ' ')).join('、');
    }
  }
  // Fallback: core_traits
  return (persona.personality?.core_traits ?? []).join('、');
}

export function computeVelocityScore(currentVolume: number, avg7d: number): number {
  if (avg7d === 0) return 1.0;
  return currentVolume / avg7d;
}

// ─── Synthetic signal scoring (non-breakout sources) ─────────────────────────

/**
 * Compute a bounded signal score for non-breakout sources (search, tag, discovery).
 * Unlike hot_list velocity which is a true ratio (current / avg_7d), these
 * sources have no historical average — we use hit count + engagement to
 * produce a normalized score within [floor, ceiling].
 *
 * Exported for testing.
 */
export function computeSyntheticSignalScore(opts: {
  count: number;
  avgEngagement: number;
  floor: number;
  ceiling: number;
}): number {
  const base = opts.floor + Math.min(0.45, (Math.max(opts.count, 1) - 1) * 0.12);
  const engagementBoost = Math.min(0.35, Math.log10(Math.max(opts.avgEngagement, 10)) * 0.08);
  return Math.min(opts.ceiling, Math.max(opts.floor, base + engagementBoost));
}

// ─── Topic specificity penalty ───────────────────────────────────────────────

const GENERIC_TRACK_WORDS = new Set([
  '电竞', '赛车', '音乐', '美妆', '穿搭', '健身', '美食', '旅行', '摄影',
  '女性力量', '日常', '生活', '搞笑', '情感', '职场', '科技', '游戏',
]);

/**
 * Penalize overly generic keywords from non-breakout sources.
 * Breakout (hot_list) keywords are not penalized — they represent real events.
 * Exported for testing.
 */
export function computeTopicSpecificityPenalty(
  keyword: string,
  signalKind: TrendSignalKind,
): number {
  if (signalKind === 'breakout') return 1.0;

  const bare = keyword.replace(/^#/, '').trim();
  const len = bare.length;
  let penalty = 1.0;

  if (len <= 2) penalty = 0.55;
  else if (len === 3) penalty = 0.75;
  else penalty = 1.0;

  if (GENERIC_TRACK_WORDS.has(bare)) {
    penalty *= 0.85;
  }

  return penalty;
}

// ─── Signal quota allocation ─────────────────────────────────────────────────

/**
 * Apply signal-kind-based quota to prevent any single kind from dominating.
 * Rules:
 *   - If breakout items exist, at least 1 must be included
 *   - If search_demand items exist, at least 1 must be included
 *   - recommended_track capped at 40% of quota (2 of top-5, 4 of top-10)
 *   - Final list re-sorted by priority_score
 *
 * Exported for testing.
 */
export function applySignalQuota(items: TrendItem[], quotaSize: number): TrendItem[] {
  if (items.length <= quotaSize) return items;

  const sorted = [...items].sort((a, b) => b.priority_score - a.priority_score);
  const picked: TrendItem[] = [];
  const pickedKeys = new Set<string>();

  const addItem = (item: TrendItem) => {
    const key = `${item.platform}:${item.keyword}`;
    if (pickedKeys.has(key)) return;
    pickedKeys.add(key);
    picked.push(item);
  };

  // Reserve slots for breakout and search_demand
  const firstBreakout = sorted.find(i => i.signal_kind === 'breakout');
  const firstSearch = sorted.find(i => i.signal_kind === 'search_demand');
  if (firstBreakout) addItem(firstBreakout);
  if (firstSearch) addItem(firstSearch);

  // Fill remaining by priority, but cap recommended_track
  const maxRecommended = Math.max(1, Math.ceil(quotaSize * 0.4));
  let recommendedCount = picked.filter(i => i.signal_kind === 'recommended_track').length;

  for (const item of sorted) {
    if (picked.length >= quotaSize) break;
    const key = `${item.platform}:${item.keyword}`;
    if (pickedKeys.has(key)) continue;
    if (item.signal_kind === 'recommended_track') {
      if (recommendedCount >= maxRecommended) continue;
      recommendedCount++;
    }
    addItem(item);
  }

  return picked.sort((a, b) => b.priority_score - a.priority_score);
}

// ─── Trend Fatigue Detection (3.3) ──────────────────────────────────────────
//
// Detects when a trend keyword has been previously selected and generated into
// content, applying a fatigue penalty to prevent repeated selection of the same
// topic across consecutive runs.
//
// Uses review-queue items' trend_hook field as the source of truth for
// "previously selected keywords". Fatigue decays exponentially with time
// (recent selections penalise more heavily).
//
// Pure functions — no side effects, no LLM calls.

/**
 * A single usage record for a previously-selected trend keyword.
 */
export interface TrendUsageRecord {
  keyword: string;
  identity_mode: string;
  used_at: string;        // ISO timestamp
}

/**
 * Build a usage history map from review-queue items.
 * Returns a Map<normalised_keyword, TrendUsageRecord[]> for all items
 * that were generated from trends (have a trend_hook) within the lookback window.
 *
 * @param items - QueueItem[] from review-queue
 * @param lookbackDays - How many days of history to consider (default: 7)
 * @param refTime - Reference "now" timestamp (for testability)
 */
export function buildTrendUsageMap(
  items: Array<{ trend_hook: string; identity_mode: string; created_at: string; status: string }>,
  lookbackDays = 7,
  refTime?: Date,
): Map<string, TrendUsageRecord[]> {
  const ref = refTime ?? now();
  const cutoff = new Date(ref.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const usageMap = new Map<string, TrendUsageRecord[]>();

  for (const item of items) {
    if (!item.trend_hook) continue;
    const createdAt = new Date(item.created_at);
    if (createdAt < cutoff) continue;

    // Only count items that actually went through the pipeline (not expired junk)
    // Include: pending, approved, published, editing, discarded (discarded still means "was selected")
    if (item.status === 'expired') continue;

    const keyword = extractTrendHookKeyword(item.trend_hook).toLowerCase();
    if (!keyword) continue;

    const record: TrendUsageRecord = {
      keyword,
      identity_mode: item.identity_mode,
      used_at: item.created_at,
    };

    const existing = usageMap.get(keyword);
    if (existing) {
      existing.push(record);
    } else {
      usageMap.set(keyword, [record]);
    }
  }

  return usageMap;
}

/**
 * Compute fatigue score for a single keyword based on usage history.
 *
 * Score formula: Σ (0.5 × e^(-0.3 × days_since_use)) for each usage record.
 * - A keyword used today: 0.5
 * - Used 1 day ago: ~0.37
 * - Used 3 days ago: ~0.20
 * - Used 7 days ago: ~0.06
 * - Two uses today: 1.0 (maximum practical fatigue)
 *
 * Capped at 0.9 — even heavily-fatigued keywords still have 10% chance.
 *
 * @param usageRecords - Past usage records for this keyword
 * @param refTime - Reference "now" (for testability)
 * @returns Fatigue score 0.0 (fresh) to 0.9 (heavily fatigued)
 */
export function computeFatigueScore(
  usageRecords: TrendUsageRecord[],
  refTime?: Date,
): number {
  if (usageRecords.length === 0) return 0;

  const ref = refTime ?? now();
  let fatigue = 0;

  for (const record of usageRecords) {
    const daysAgo = (ref.getTime() - new Date(record.used_at).getTime()) / (1000 * 60 * 60 * 24);
    // Exponential time decay: recent usages penalise more
    fatigue += 0.5 * Math.exp(-0.3 * Math.max(daysAgo, 0));
  }

  return Math.min(0.9, fatigue);
}

/**
 * Apply fatigue penalties to a list of trend items.
 * Mutates priority_score by multiplying with (1.0 - fatigue_score).
 *
 * Cross-references each trend's keyword against the usage map built from
 * review-queue history. Matching is case-insensitive and uses substring
 * matching to handle keyword variations (e.g. "王者荣耀" matches
 * "王者荣耀新赛季").
 *
 * Returns a new array (does not mutate input).
 */
export function applyFatiguePenalty(
  items: TrendItem[],
  usageMap: Map<string, TrendUsageRecord[]>,
  refTime?: Date,
): TrendItem[] {
  if (usageMap.size === 0) return items;

  return items.map(item => {
    const kwLower = item.keyword.toLowerCase();

    // Exact match first
    let records = usageMap.get(kwLower);

    // Substring match: check if any used keyword is contained in this keyword or vice versa
    if (!records) {
      for (const [usedKw, usedRecords] of usageMap) {
        if (kwLower.includes(usedKw) || usedKw.includes(kwLower)) {
          records = usedRecords;
          break;
        }
      }
    }

    if (!records || records.length === 0) return item;

    const fatigue = computeFatigueScore(records, refTime);
    if (fatigue === 0) return item;

    const multiplier = 1.0 - fatigue;
    const newPriority = Math.round(item.priority_score * multiplier * 100) / 100;

    if (isDebug()) {
      console.log(`[trend-analyzer] Fatigue: "${item.keyword}" × ${multiplier.toFixed(2)} (fatigue=${fatigue.toFixed(2)}, uses=${records.length}) → priority ${item.priority_score} → ${newPriority}`);
    }

    return { ...item, priority_score: newPriority };
  });
}

export function filterByThreshold(items: TrendItem[], threshold: number): TrendItem[] {
  return items.filter(i => i.velocity_score >= threshold);
}

/** Valid identity modes — LLM must return one of these */
export const VALID_IDENTITY_MODES = ['esports', 'singer', 'racer', 'daily'] as const;
export type ValidIdentityMode = typeof VALID_IDENTITY_MODES[number];

/** Validate and normalize identity_mode from LLM response */
export function normalizeIdentityMode(raw: string): ValidIdentityMode {
  const lower = raw.toLowerCase().trim();
  if ((VALID_IDENTITY_MODES as readonly string[]).includes(lower)) return lower as ValidIdentityMode;
  // Common LLM hallucinations → fallback mapping
  const aliasMap: Record<string, ValidIdentityMode> = {
    'women_power': 'daily',
    'lifestyle': 'daily',
    'life': 'daily',
    'gaming': 'esports',
    'game': 'esports',
    'music': 'singer',
    'racing': 'racer',
    'sports': 'racer',
    'sport': 'racer',
    'driver': 'racer',
    'commentator': 'esports',
  };
  if (aliasMap[lower]) {
    console.warn(`[trend-analyzer] identity_mode "${raw}" → mapped to "${aliasMap[lower]}"`);
    return aliasMap[lower];
  }
  console.warn(`[trend-analyzer] identity_mode "${raw}" is unknown, defaulting to "daily"`);
  return 'daily';
}

export function buildRelevancePrompt(
  trends: TrendItem[],
  personaIdentities: string,
  topicCount: number,
): string {
  // Cap input to top 25 to give LLM enough coverage for niche identity topics
  // (Miss V's esports/music/racing topics may not rank in top 10 by velocity).
  // Assumes input is already sorted by priority_score desc.
  const capped = trends.slice(0, 25);
  const trendList = capped
    .map(t => {
      const srcLabel = t.source_bucket ?? '热榜';
      const parts = [`- ${t.keyword} (${t.platform}, 来源=${srcLabel}, velocity=${t.velocity_score.toFixed(1)}x, priority=${t.priority_score.toFixed(1)}, rank=${t.rank})`];
      // Append description if available (key for clickbait detection)
      if (t.description) parts.push(`  描述：${t.description}`);
      // Mark clickbait suspicion
      if (t.clickbait_labels && t.clickbait_labels.length >= 2) parts.push('  ⚠️疑似标题党');
      // Mark ads
      if (t.is_ad) parts.push('  📢广告');
      // Mark topics without description (can't verify facts)
      if (!t.description && !t.is_ad) parts.push('  [无描述，无法核实事实]');
      return parts.join('\n');
    })
    .join('\n');

  // Cold-start detection: if all velocities are 1.0x (no history yet), relax the velocity requirement
  const isColStart = capped.every(t => t.velocity_score === 1.0);
  // Also relax when max velocity is below 1.5 (data is early or flat — no clear breakout trends yet)
  const maxVelocity = Math.max(...capped.map(t => t.velocity_score));
  const velocityRequirement = isColStart
    ? '无历史数据，按热度排名选择'
    : maxVelocity < 1.5
      ? `当前最高速度分为 ${maxVelocity.toFixed(1)}x，按相关性和热度排名选择，不要求速度分门槛`
      : '平台正在助推（velocity > 1.5）';

  return `你是一个内容运营分析师。以下是今日平台趋势信号（包含三种来源）：

来源说明：
- 搜索：用户主动搜索命中的高互动内容关联 tag —— 代表真实用户需求
- 赛道 Tag：搜索与竞品分析中验证的高互动内容 tag —— 代表算法认可的赛道
- 热榜：平台编辑型热搜/热榜 —— 公共议题曝光，不一定适合做赛道内容

${trendList}

虚拟人设身份：${personaIdentities}

请从以上趋势信号中筛选出最多 ${topicCount} 个可蹭的话题，要求：
1. 与虚拟人的某个身份相关，或可借势切入
2. ${velocityRequirement}
3. 避免政治敏感、负面争议话题
4. 尽量让选中话题覆盖不同身份（identity_mode），避免全部集中在同一身份
5. 如果没有合适的话题，返回空数组 {"topics":[]}
6. 避免标题党/误导性话题：对比标题与描述，如果标题字面意思与描述事实不符（如标题暗示"已变"，描述说"无此政策"），不要选择该话题。如果话题标记了⚠️疑似标题党，需要格外谨慎。对于标记了[无描述，无法核实事实]的话题，也要审慎评估，优先选择有描述佐证的话题。如果某个话题可能存在争议但无法确认，在 hook_angle 中注明"⚠️ 需核实事实"。
7. 跳过标记为📢广告的话题，不要选择广告内容。
8. 【重要】当相关性接近时，优先选择"搜索"和"赛道 Tag"来源的信号，它们代表真实用户互动和算法验证。"热榜"只作为补充，不要让热榜压过赛道 tag。tag 型关键词（如 #电竞女孩）优先保留原貌。
9. 按 priority 分数从高到低优先选择。
10. 【多样性】如果选择了 3 个以上话题，确保至少包含 1 个"热榜"来源的话题（作为公共议题补充），以及至少 2 个"搜索"或"赛道 Tag"来源的话题。

对每个筛选出的话题，给出：
- keyword: 必须与上方列表中的某个话题关键词完全一致（不要缩写或改写）
- platform: 来源平台（必须与上方列表一致）
- velocity_score: 速度分
- hook_angle: 用什么角度切入（结合人设）
- identity_mode: 使用哪个身份，只能是以下四选一：esports（电竞解说）/ singer（歌手）/ racer（赛车手）/ daily（日常生活）

以 JSON 对象返回，格式：
\`\`\`json
{"topics":[{"keyword":"...","platform":"...","velocity_score":0,"hook_angle":"...","identity_mode":"esports|singer|racer|daily"}]}
\`\`\``;
}

/**
 * Read the tag vocabulary and convert active tags into TrendItem signals.
 * Exported for unit testing.
 * Returns empty array when vocabulary file does not exist.
 */
export function injectTagVocabularyItems(): TrendItem[] {
  const vocab = readJSON<TagVocabulary>(PATHS.tagVocabulary, null as unknown as TagVocabulary);
  if (!vocab?.active?.length) return [];

  return [...vocab.active]
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(t => {
      const st: TrendSourceType = 'tag_engine';
      const hitCount = Math.max(t.hit_count ?? 1, 1);
      const velocity = computeSyntheticSignalScore({
        count: hitCount,
        avgEngagement: Math.max(t.score, 1),
        floor: 0.9,
        ceiling: 1.5,
      });
      return {
        platform: (t.platform === 'douyin' ? 'douyin' : t.platform === 'both' ? 'xhs' : 'xhs') as 'xhs' | 'douyin',
        keyword: t.tag,
        current_volume: t.score,
        avg_7d: 0,
        velocity_score: velocity,
        rank: 999,
        _source: 'tag_engine' as const,
        source_type: st,
        source_bucket: toSourceBucket(st),
        signal_kind: classifySignalKind(st),
        display_metric: `命中 ${hitCount} 次`,
        priority_score: 0,
      };
    });
}

/**
 * Convert high-engagement discovery-pool items into TrendItem signals.
 * These represent real engagement data (from search results / recommendation feed),
 * NOT hot-list rankings that may contain fake traffic.
 *
 * Scoring: discovery items get a 1.5x velocity boost to prioritize verified engagement.
 */
export function injectDiscoveryPoolTrends(): TrendItem[] {
  const pool = loadDiscoveryPool();
  if (!pool.items || pool.items.length === 0) return [];

  // Only inject items with meaningful engagement
  const qualified = pool.items
    .filter((item: DiscoveryItem) => item.engagement > 0 && item.score > 0)
    .sort((a: DiscoveryItem, b: DiscoveryItem) => b.score - a.score)
    .slice(0, 15);

  return qualified.map((item: DiscoveryItem) => {
    const st: TrendSourceType = 'discovery_pool';
    // Normalize source: "search:xhs" → "xhs", "content-browse" → "xhs"
    const rawPlatform = item.source.split(':').pop() ?? item.source;
    const normalizedPlatform = (rawPlatform === 'content-browse' || rawPlatform === 'instagram' || rawPlatform === 'reddit')
      ? 'xhs' : rawPlatform;
    const velocity = computeSyntheticSignalScore({
      count: 1,
      avgEngagement: item.engagement,
      floor: 0.9,
      ceiling: 1.5,
    });
    return {
      platform: normalizedPlatform as TrendItem['platform'],
      keyword: item.topic || item.title,
      current_volume: item.engagement,
      avg_7d: 0,
      velocity_score: velocity,
      rank: 998,
      _source: 'discovery_pool' as const,
      source_type: st,
      source_bucket: toSourceBucket(st),
      signal_kind: classifySignalKind(st),
      display_metric: '赛道信号',
      priority_score: 0,
    };
  });
}

// ─── Search Keyword Trend Engine (Phase 2) ──────────────────────────────────
//
// Instead of relying solely on hot-list rankings (which may contain fake traffic),
// this engine proactively searches platforms for keywords that are already known
// to be relevant (from tag-engine active tags + keyword-tracker), then extracts
// high-engagement content's associated tags as TrendItem signals.
//
// Authentic engagement thresholds (matching tag-engine.ts):
//   - XHS: likes >= 1000
//   - Douyin: digg_count >= 5000
//   - Bilibili: like >= 5000
//
// Results are cached to avoid redundant API calls across heartbeat ticks.

const SEARCH_KEYWORD_HIT_THRESHOLD_XHS = 1000;
const SEARCH_KEYWORD_HIT_THRESHOLD_DOUYIN = 5000;
const SEARCH_KEYWORD_HIT_THRESHOLD_BILIBILI = 5000;
const SEARCH_KEYWORD_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface SearchKeywordCacheData {
  computed_at: string;
  items: TrendItem[];
}

const HASHTAG_REGEX = /#[\w\u4e00-\u9fa5]+/g;

function extractTagsFromText(text: string): string[] {
  const matches = text.match(HASHTAG_REGEX) ?? [];
  return [...new Set(matches.map(t => t.slice(1)))]; // Remove leading #
}

/**
 * Fetch search-keyword-based trends: search XHS/Douyin for known relevant keywords,
 * filter by engagement thresholds, extract associated tags as TrendItem signals.
 *
 * Results are cached for SEARCH_KEYWORD_CACHE_TTL_MS to avoid redundant API calls.
 * This is designed to be called as a heartbeat post-hook, writing results to cache
 * that analyzeTrends() reads synchronously on the next invocation.
 */
export async function fetchSearchKeywordTrends(): Promise<TrendItem[]> {
  // 0) Check cache
  const cached = readJSON<SearchKeywordCacheData>(PATHS.searchKeywordCache, null as unknown as SearchKeywordCacheData);
  if (cached?.computed_at) {
    const age = now().getTime() - new Date(cached.computed_at).getTime();
    if (age < SEARCH_KEYWORD_CACHE_TTL_MS && cached.items.length > 0) {
      if (isDebug()) console.log(`[trend-analyzer] Using cached search-keyword trends (age: ${Math.round(age / 60_000)}min, ${cached.items.length} items)`);
      return cached.items;
    }
  }

  // 1) Collect search keywords from tag-engine active tags + keyword-tracker
  const searchKeywords: string[] = [];

  // Source A: tag-engine active tags (top 15 by score)
  const vocab = readJSON<TagVocabulary>(PATHS.tagVocabulary, null as unknown as TagVocabulary);
  if (vocab?.active?.length) {
    const topTags = [...vocab.active]
      .sort((a, b) => b.score - a.score)
      .slice(0, 15)
      .map(t => t.tag);
    searchKeywords.push(...topTags);
  }

  // Source B: keyword-tracker
  try {
    const { collectKeywords } = await import('./keyword-tracker');
    const trackerKeywords = collectKeywords().slice(0, 10).map(k => k.keyword);
    searchKeywords.push(...trackerKeywords);
  } catch {
    // keyword-tracker not available — skip
  }

  // Deduplicate
  const uniqueKeywords = [...new Set(searchKeywords)].slice(0, 20);
  if (uniqueKeywords.length === 0) {
    return [];
  }

  if (isDebug()) console.log(`[trend-analyzer] Search-keyword engine: searching ${uniqueKeywords.length} keywords`);

  // 2) Search each keyword on XHS and Douyin, collect tags from high-engagement results
  const tagFrequency = new Map<string, { count: number; totalEngagement: number; platforms: Set<string> }>();

  // XHS searches (parallel)
  const xhsResults = await Promise.allSettled(
    uniqueKeywords.map(async (kw) => {
      try {
        const notes = await searchXhsNotes(kw, { sortBy: '最热', noteType: '全部' });
        return notes
          .filter(n => (n.likes ?? 0) >= SEARCH_KEYWORD_HIT_THRESHOLD_XHS)
          .map(n => ({ tags: extractTagsFromText(`${n.title} ${n.description}`), engagement: n.likes ?? 0 }));
      } catch {
        return [];
      }
    }),
  );

  for (const result of xhsResults) {
    if (result.status !== 'fulfilled') continue;
    for (const hit of result.value) {
      for (const tag of hit.tags) {
        const existing = tagFrequency.get(tag);
        if (existing) {
          existing.count++;
          existing.totalEngagement += hit.engagement;
          existing.platforms.add('xhs');
        } else {
          tagFrequency.set(tag, { count: 1, totalEngagement: hit.engagement, platforms: new Set(['xhs']) });
        }
      }
    }
  }

  // Douyin searches (sync, best-effort) — 风控冷却期内跳过
  for (const kw of uniqueKeywords) {
    const rlStatus = getDouyinRateLimitStatus();
    if (rlStatus.in_cooldown) {
      console.warn(`[trend-analyzer] Douyin 风控冷却中 (剩余 ${rlStatus.cooldown_remaining_s}s)，跳过剩余关键词`);
      break;
    }
    try {
      const result = searchDouyinVideos(kw, 10);
      if (!result.success || !result.videos) {
        if (result.rate_limited) {
          console.warn(`[trend-analyzer] Douyin 风控限流 for "${kw}": ${result.reason ?? 'cooldown'}`);
          break; // 风控后不再继续搜索
        }
        continue;
      }
      const hits = result.videos
        .filter((v: { digg_count: number }) => v.digg_count >= SEARCH_KEYWORD_HIT_THRESHOLD_DOUYIN);
      for (const v of hits) {
        const tags = extractTagsFromText(v.desc as string);
        for (const tag of tags) {
          const existing = tagFrequency.get(tag);
          if (existing) {
            existing.count++;
            existing.totalEngagement += (v as { digg_count: number }).digg_count;
            existing.platforms.add('douyin');
          } else {
            tagFrequency.set(tag, { count: 1, totalEngagement: (v as { digg_count: number }).digg_count, platforms: new Set(['douyin']) });
          }
        }
      }
    } catch {
      // Douyin search failed — skip
    }
  }

  // 3) Convert high-frequency tags into TrendItem signals
  //    Only keep tags that appeared in >=2 high-engagement results (signal reliability)
  const items: TrendItem[] = [];
  for (const [tag, data] of tagFrequency) {
    if (data.count < 2) continue; // Not enough signal

    const platform = data.platforms.has('xhs') && data.platforms.has('douyin') ? 'xhs' : // Prefer xhs as primary
      data.platforms.has('xhs') ? 'xhs' : 'douyin';
    const avgEngagement = data.totalEngagement / data.count;

    items.push({
      platform,
      keyword: tag,
      current_volume: data.totalEngagement,
      avg_7d: 0,
      velocity_score: computeSyntheticSignalScore({
        count: data.count,
        avgEngagement,
        floor: 0.9,
        ceiling: 1.8,
      }),
      rank: 997,
      _source: 'search_keyword' as const,
      source_type: 'search_keyword' as TrendSourceType,
      source_bucket: toSourceBucket('search_keyword'),
      signal_kind: classifySignalKind('search_keyword'),
      display_metric: `命中 ${data.count} 篇`,
      priority_score: 0,
    });
  }

  // Sort by velocity desc, cap at 30
  items.sort((a, b) => b.velocity_score - a.velocity_score);
  const capped = items.slice(0, 30);

  if (isDebug()) console.log(`[trend-analyzer] Search-keyword engine: ${capped.length} trend items from ${uniqueKeywords.length} keywords`);

  // 4) Write cache
  writeJSON(PATHS.searchKeywordCache, {
    computed_at: new Date().toISOString(),
    items: capped,
  } satisfies SearchKeywordCacheData);

  return capped;
}

/**
 * Read cached search-keyword trends (synchronous, for use in analyzeTrends).
 * Returns empty array if cache doesn't exist or is stale.
 */
export function loadCachedSearchKeywordTrends(): TrendItem[] {
  const cached = readJSON<SearchKeywordCacheData>(PATHS.searchKeywordCache, null as unknown as SearchKeywordCacheData);
  if (!cached?.computed_at || !cached.items?.length) return [];

  const age = now().getTime() - new Date(cached.computed_at).getTime();
  if (age > SEARCH_KEYWORD_CACHE_TTL_MS) return [];

  return cached.items;
}

/**
 * Compute priority_score for each item based on velocity_score × source_weight × penalties.
 * Unlike the old applyAuthenticEngagementWeight(), this does NOT mutate velocity_score.
 * velocity_score stays as the raw "trend speed" — priority_score is used for ranking.
 *
 * Also back-fills source_type/source_bucket/signal_kind for legacy items that only have _source.
 */
export function computePriorityScores(items: TrendItem[]): TrendItem[] {
  return items.map(item => {
    // Back-fill source_type from legacy _source if not set
    let st: TrendSourceType = item.source_type;
    if (!st) {
      const legacy = (item as TrendItem & { _source?: string })._source;
      st = legacy === 'tag_engine' ? 'tag_engine'
        : legacy === 'discovery_pool' ? 'discovery_pool'
        : legacy === 'search_keyword' ? 'search_keyword'
        : 'hot_list';
    }

    const sk: TrendSignalKind = item.signal_kind ?? classifySignalKind(st);
    const w = sourceWeight(st);
    // Clickbait penalty: reduce priority for suspected clickbait
    const qualityPenalty = (item.clickbait_labels && item.clickbait_labels.length >= 2) ? 0.5
      : item.is_ad ? 0.1
      : 1.0;
    const specificityPenalty = computeTopicSpecificityPenalty(item.keyword, sk);
    const ps = item.velocity_score * w * qualityPenalty * specificityPenalty;

    return {
      ...item,
      source_type: st,
      source_bucket: toSourceBucket(st),
      signal_kind: sk,
      priority_score: Math.round(ps * 100) / 100,
    };
  });
}

/**
 * @deprecated Use computePriorityScores() instead. Kept for backward compatibility.
 */
export function applyAuthenticEngagementWeight(items: TrendItem[]): TrendItem[] {
  return computePriorityScores(items);
}

// ─── Remote DailyHot API (https://dailyhot-rho-nine.vercel.app) ──────────────

const DAILYHOT_API_BASE = 'https://dailyhot-rho-nine.vercel.app';

/** Available platforms on the remote API */
const DAILYHOT_AVAILABLE_PLATFORMS = new Set([
  'douyin', 'bilibili', 'weibo', 'toutiao', 'sina-news', 'sina',
  'netease-news', 'qq-news', 'baidu', 'thepaper', '36kr', 'ithome',
]);

interface DailyHotApiItem {
  id?: string;
  title?: string;
  hot?: number;
  url?: string;
  timestamp?: number;
  desc?: string;
  cover?: string;
  label?: string;
  isAd?: boolean;
}

interface DailyHotApiResponse {
  code: number;
  name: string;
  data: DailyHotApiItem[];
}

/**
 * Clean a raw trending title for use as a keyword.
 * Strips noise, truncates long titles, removes non-Chinese content.
 */
function cleanTrendTitle(raw: string): string {
  if (!raw) return '';
  let cleaned = raw
    // Remove common title suffix noise
    .replace(/[！？?!…]+$/.source ? /[！？?!…]+$/ : /$/, '')
    // Remove trailing punctuation
    .replace(/[，。、：；\s]+$/, '')
    // Remove common noise words at the end of hot search titles
    .replace(/(引发热议|引热议|引关注|上热搜|登热搜|成热议|火爆|疯传|刷屏)$/, '')
    .trim();

  // Use normalizeKeyword for language/length filtering, but keep longer titles
  // since they'll be further filtered by LLM relevance check
  const normalized = normalizeKeyword(cleaned, { allowNonChinese: true, maxLength: 20 });
  return normalized ?? '';
}

// ─── Clickbait / misleading title detection ─────────────────────────────────

/** Clickbait/misleading pattern definitions */
const CLICKBAIT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // "X变Y" contradiction (e.g. "绿色变白色")
  { pattern: /[变改换].*?(变|为|成|到)/, label: 'contradiction' },
  // Suspense misdirection (e.g. "竟然", "居然")
  { pattern: /(竟然|居然|没想到|谁料|谁知|出人意料)/, label: 'suspense' },
  // Emotional manipulation (e.g. "震惊", "崩溃")
  { pattern: /(震惊|吓哭|崩溃|炸了|疯掉|不敢相信)/, label: 'emotion' },
  // Absolute claims (e.g. "99%的人", "所有人都")
  { pattern: /(99%|所有人都|没人能|绝对|从不)/, label: 'absolute' },
  // Reversal deception (e.g. "真相是", "被骗了")
  { pattern: /(真相是|原来如此|被骗了|都是假的)/, label: 'reversal' },
  // Exaggerated numbers without context (e.g. "10亿人", "9999万")
  { pattern: /(\d+亿人|\d{4,}万)/, label: 'exaggeration' },
];

/**
 * Detect clickbait/misleading patterns in a trending title.
 * Returns labels array — 2+ labels means likely clickbait.
 * Single-label matches may be false positives (e.g. "变革" matches contradiction).
 */
export function detectClickbait(title: string): { isClickbait: boolean; labels: string[] } {
  const labels: string[] = [];
  for (const { pattern, label } of CLICKBAIT_PATTERNS) {
    if (pattern.test(title)) labels.push(label);
  }
  return { isClickbait: labels.length >= 2, labels };
}

/**
 * Fetch hot topics from remote DailyHot API (async).
 * Supports: douyin, bilibili, weibo, toutiao, sina-news, etc.
 */
async function callDailyHotNews(platform: string, limit = 30): Promise<TrendItem[]> {
  const targetPlatform = DAILYHOT_AVAILABLE_PLATFORMS.has(platform) ? platform : null;
  if (!targetPlatform) return [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const res = await fetch(`${DAILYHOT_API_BASE}/${targetPlatform}?limit=${limit}`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    const parsed = await res.json() as DailyHotApiResponse;
    if (parsed.code !== 200) return [];
    return parsed.data.map((item, idx) => {
      const cleanTitle = cleanTrendTitle(item.title ?? '');
      const clickbait = detectClickbait(cleanTitle);
      const st: TrendSourceType = 'hot_list';
      return {
        platform,
        keyword: cleanTitle,
        current_volume: item.hot ?? 0,
        avg_7d: 0,
        velocity_score: 0,
        rank: idx + 1,
        description: item.desc || '',
        is_ad: item.isAd ?? false,
        clickbait_labels: clickbait.labels.length > 0 ? clickbait.labels : undefined,
        source_type: st,
        source_bucket: toSourceBucket(st),
        signal_kind: classifySignalKind(st),
        priority_score: 0,
      };
    }).filter(i => i.keyword !== '');
  } catch {
    return [];
  }
}

// ─── Fallback: Direct Weibo Hot Search API ───────────────────────────────────

interface WeiboHotSearchItem {
  word?: string;
  raw_hot?: number;
  num?: number;
  rank?: number;
  note?: string;
  note_desc?: string;
  category?: string;
  word_type?: number;
  is_ad?: number;
}

interface WeiboHotSearchResponse {
  ok: number;
  data?: {
    realtime?: WeiboHotSearchItem[];
  };
}

/**
 * Fallback for weibo when DailyHot API fails: directly call weibo.com/ajax/side/hotSearch.
 * This is a public API that doesn't require authentication.
 */
async function callWeiboDirectApi(limit = 30): Promise<TrendItem[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch('https://weibo.com/ajax/side/hotSearch', {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://weibo.com/',
      },
    });
    clearTimeout(timer);
    const parsed = await res.json() as WeiboHotSearchResponse;
    if (parsed.ok !== 1 || !parsed.data?.realtime) return [];
    return parsed.data.realtime.slice(0, limit).map((item, idx) => {
      const cleanTitle = cleanTrendTitle(item.word ?? '');
      const clickbait = detectClickbait(cleanTitle);
      const st: TrendSourceType = 'hot_list';
      return {
        platform: 'weibo',
        keyword: cleanTitle,
        current_volume: item.raw_hot ?? item.num ?? 0,
        avg_7d: 0,
        velocity_score: 0,
        rank: idx + 1,
        description: item.note || item.note_desc || '',
        category: item.category || '',
        is_ad: item.is_ad === 1,
        clickbait_labels: clickbait.labels.length > 0 ? clickbait.labels : undefined,
        source_type: st,
        source_bucket: toSourceBucket(st),
        signal_kind: classifySignalKind(st),
        priority_score: 0,
      };
    }).filter(i => i.keyword !== '');
  } catch (err) {
    console.warn('[trend-analyzer] weibo direct API fallback failed:', (err as Error).message);
    return [];
  }
}

// ─── Fallback: Direct Bilibili Ranking API ───────────────────────────────────

interface BilibiliRankItem {
  title?: string;
  stat?: { view?: number };
  bvid?: string;
}

interface BilibiliRankResponse {
  code: number;
  data?: { list?: BilibiliRankItem[] };
}

/**
 * Fallback for bilibili: directly call api.bilibili.com ranking API.
 */
async function callBilibiliDirectApi(limit = 20): Promise<TrendItem[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch('https://api.bilibili.com/x/web-interface/ranking/v2', {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://www.bilibili.com/',
      },
    });
    clearTimeout(timer);
    const parsed = await res.json() as BilibiliRankResponse;
    if (parsed.code !== 0 || !parsed.data?.list) return [];
    const st: TrendSourceType = 'hot_list';
    return parsed.data.list.slice(0, limit).map((item, idx) => ({
      platform: 'bilibili',
      keyword: cleanTrendTitle(item.title ?? ''),
      current_volume: item.stat?.view ?? 0,
      avg_7d: 0,
      velocity_score: 0,
      rank: idx + 1,
      source_type: st,
      source_bucket: toSourceBucket(st),
      signal_kind: classifySignalKind(st),
      priority_score: 0,
    })).filter(i => i.keyword !== '');
  } catch (err) {
    console.warn('[trend-analyzer] bilibili direct API fallback failed:', (err as Error).message);
    return [];
  }
}

// ─── Fallback: Direct Douyin Hot Search API ──────────────────────────────────

/**
 * Fallback for douyin: directly call douyin.com trending API via the
 * tophub aggregator endpoint (public, no auth required).
 */
async function callDouyinDirectApi(limit = 30): Promise<TrendItem[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch('https://tophub.today/api/nodes/1', {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    });
    clearTimeout(timer);
    const parsed = await res.json() as { data?: { items?: Array<{ title?: string; extra?: { hot?: number } }> } };
    const items = parsed.data?.items ?? [];
    if (items.length === 0) return [];
    const st: TrendSourceType = 'hot_list';
    return items.slice(0, limit).map((item, idx) => ({
      platform: 'douyin',
      keyword: cleanTrendTitle(item.title ?? ''),
      current_volume: item.extra?.hot ?? 0,
      avg_7d: 0,
      velocity_score: 0,
      rank: idx + 1,
      source_type: st,
      source_bucket: toSourceBucket(st),
      signal_kind: classifySignalKind(st),
      priority_score: 0,
    })).filter(i => i.keyword !== '');
  } catch (err) {
    console.warn('[trend-analyzer] douyin direct API fallback failed:', (err as Error).message);
    return [];
  }
}

/**
 * Fetch platform data with fallback: try DailyHot first, then direct API.
 */
async function fetchWithFallback(platform: string, limit = 30): Promise<TrendItem[]> {
  const items = await callDailyHotNews(platform, limit);
  if (items.length > 0) return items;

  // Fallback to direct APIs for critical platforms
  if (platform === 'douyin') {
    if (isDebug()) console.log(`[trend-analyzer] DailyHot douyin returned 0 items, trying direct API fallback...`);
    return callDouyinDirectApi(limit);
  }
  if (platform === 'weibo') {
    if (isDebug()) console.log(`[trend-analyzer] DailyHot weibo returned 0 items, trying direct API fallback...`);
    return callWeiboDirectApi(limit);
  }
  if (platform === 'bilibili') {
    if (isDebug()) console.log(`[trend-analyzer] DailyHot bilibili returned 0 items, trying direct API fallback...`);
    return callBilibiliDirectApi(limit);
  }

  return items;
}

// ─── History & velocity computation ──────────────────────────────────────────

function computeAvgFromHistory(history: TrendHistory[], keyword: string, platform: string): number {
  const sevenDaysAgo = new Date(now().getTime() - 7 * 24 * 60 * 60 * 1000);
  const relevant = history.filter(h => new Date(h.date) >= sevenDaysAgo);
  const volumes: number[] = [];
  for (const day of relevant) {
    const match = day.trends.find(t => t.keyword === keyword && t.platform === platform);
    if (match) volumes.push(match.current_volume);
  }
  if (volumes.length === 0) return 0;
  return volumes.reduce((a, b) => a + b, 0) / volumes.length;
}

function persistTodayTrends(trends: TrendItem[]): void {
  const history = readJSON<TrendHistory[]>(PATHS.trendHistory, []);
  const today = getLocalDate(now());
  const withoutToday = history.filter(h => h.date !== today);
  // Keep only last 14 days
  const trimmed = withoutToday.slice(-13);
  writeJSON(PATHS.trendHistory, [...trimmed, { date: today, trends }]);
}

// ─── Main export ─────────────────────────────────────────────────────────────

interface LLMTrendResult {
  keyword: string;
  platform: string;
  velocity_score: number;
  hook_angle: string;
  identity_mode: 'esports' | 'singer' | 'racer' | 'daily';
}

interface LLMTrendEnvelope {
  topics: LLMTrendResult[];
}

export interface FilteredTrend extends TrendItem {
  hook_angle: string;
  identity_mode: 'esports' | 'singer' | 'racer' | 'daily';
}

// ─── TTL cache for analyzeTrends results ───────────────────────────────────
// Hot lists change slowly — most hourly cron invocations get the same results.
// Caching the LLM-filtered output for 4 hours saves ~73% of LLM calls.

interface TrendsCacheData {
  computed_at: string;       // ISO timestamp of when this cache was written
  persona_identities: string; // identities string used for this computation (invalidates on persona change)
  scoring_version: number;   // Invalidate cache when scoring model changes
  results: FilteredTrend[];
  /** Signal pool summary for /trends display */
  signal_pool?: { bucket: string; top: { keyword: string; platform: string; v: string; p: string }[] }[];
}

const TRENDS_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const SCORING_VERSION = 3; // Bump when scoring model / prompt changes

/** Build signal pool summary for /trends display — groups items by source_bucket, shows top 3 per group */
function buildSignalPoolSummary(items: TrendItem[]): TrendsCacheData['signal_pool'] {
  const byBucket = new Map<string, TrendItem[]>();
  for (const t of items) {
    const b = t.source_bucket ?? '热榜';
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b)!.push(t);
  }
  return [...byBucket.entries()].map(([bucket, items]) => ({
    bucket,
    top: items.slice(0, 3).map(t => ({
      keyword: t.keyword,
      platform: t.platform,
      v: t.velocity_score.toFixed(1),
      p: t.priority_score.toFixed(1),
    })),
  }));
}

export async function analyzeTrends(
  ops: OpsConfig,
  personaIdentities: string,
  llm: LLMClient,
): Promise<FilteredTrend[]> {
  // 0) Check file-level TTL cache — skip all API+LLM work if cache is fresh
  const cached = readJSON<TrendsCacheData>(PATHS.trendsCache, null as unknown as TrendsCacheData);
  if (cached?.computed_at && cached.persona_identities === personaIdentities && cached.scoring_version === SCORING_VERSION) {
    const age = now().getTime() - new Date(cached.computed_at).getTime();
    if (age < TRENDS_CACHE_TTL_MS) {
      console.error(`[trend-analyzer] Using cached trends (age: ${Math.round(age / 60_000)}min, ${cached.results.length} topics)`);
      return cached.results;
    }
  }

  // 1. Collect raw trends from remote DailyHot API (with direct-API fallback)
  // Parallel fetch: all 5 platforms at once (was serial, could take 5×20s=100s; now max ~12s)
  const [douyinItems, weiboItems, bilibiliItems, toutiaoItems, baiduItems] =
    await Promise.all([
      fetchWithFallback('douyin', 10),
      fetchWithFallback('weibo', 10),
      fetchWithFallback('bilibili', 10),
      fetchWithFallback('toutiao', 10),
      fetchWithFallback('baidu', 10),
    ]);
  const rawAll = [...douyinItems, ...weiboItems, ...bilibiliItems, ...toutiaoItems, ...baiduItems];
  if (isDebug()) console.log(`[trend-analyzer] DEBUG: rawAll items: ${rawAll.length} (douyin=${douyinItems.length}, weibo=${weiboItems.length}, bilibili=${bilibiliItems.length}, toutiao=${toutiaoItems.length}, baidu=${baiduItems.length})`);


  // Deduplicate by keyword+platform
  const seen = new Set<string>();
  const deduped = rawAll.filter(item => {
    const key = `${item.platform}:${item.keyword}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (isDebug()) console.log(`[trend-analyzer] DEBUG: deduped items: ${deduped.length}`);

  // 2. Load history once, then compute velocity scores
  const history = readJSON<TrendHistory[]>(PATHS.trendHistory, []);
  let withVelocity: TrendItem[] = deduped.map(item => {
    const avg7d = computeAvgFromHistory(history, item.keyword, item.platform);
    const velocity_score = computeVelocityScore(item.current_volume, avg7d);
    return { ...item, avg_7d: avg7d, velocity_score };
  });
  if (isDebug()) console.log(`[trend-analyzer] DEBUG: withVelocity items: ${withVelocity.length}`);

  // 3. Persist today's data for future velocity calculations
  persistTodayTrends(withVelocity);

  // Inject AUTHENTIC engagement signals BEFORE hot-list data (tag-engine + discovery-pool + search-keyword)
  // These represent real user engagement, not potentially-inflated hot-list rankings
  const tagItems = injectTagVocabularyItems();
  const discoveryItems = injectDiscoveryPoolTrends();
  const searchKeywordItems = loadCachedSearchKeywordTrends();
  if (isDebug()) {
    console.log(`[trend-analyzer] DEBUG: Injecting ${tagItems.length} tag-engine signals, ${discoveryItems.length} discovery-pool signals, ${searchKeywordItems.length} search-keyword signals`);
  }

  // Combine: authentic signals first, then hot-list data
  // Then compute priority_score (velocity × source_weight × quality_penalty)
  const combined = [...tagItems, ...discoveryItems, ...searchKeywordItems, ...withVelocity];
  withVelocity = computePriorityScores(combined);

  // 3b. Apply trend fatigue penalty — reduce priority for keywords already
  //     selected in recent runs (cross-reference with review-queue history)
  try {
    const { loadQueue } = await import('./review-queue');
    const queue = await loadQueue();
    if (queue.items.length > 0) {
      const usageMap = buildTrendUsageMap(queue.items, 7);
      if (usageMap.size > 0) {
        withVelocity = applyFatiguePenalty(withVelocity, usageMap);
        if (isDebug()) console.log(`[trend-analyzer] Fatigue gate: ${usageMap.size} previously-used keywords tracked`);
      }
    }
  } catch {
    // review-queue not available — skip fatigue detection
  }

  // 4. Filter by threshold — cold-start bypass: if all have no history, skip threshold
  const hasHistory = withVelocity.some(i => i.avg_7d > 0);
  if (isDebug()) console.log(`[trend-analyzer] DEBUG: hasHistory=${hasHistory}, threshold=${ops.trend_score_threshold}`);

  // Sort by priority_score desc (was velocity_score desc)
  let aboveThreshold: TrendItem[];
  if (hasHistory) {
    aboveThreshold = filterByThreshold(withVelocity, ops.trend_score_threshold)
      .sort((a, b) => b.priority_score - a.priority_score);
  } else {
    aboveThreshold = withVelocity.sort((a, b) => b.current_volume - a.current_volume).slice(0, 30);
  }

  // ── Signal quota: balanced representation of all signal kinds ──
  const quotaSize = Math.min(25, aboveThreshold.length);
  aboveThreshold = applySignalQuota(aboveThreshold, quotaSize);

  if (isDebug()) {
    const kindCounts = new Map<string, number>();
    for (const i of aboveThreshold) kindCounts.set(i.signal_kind ?? 'unknown', (kindCounts.get(i.signal_kind ?? 'unknown') ?? 0) + 1);
    console.log(`[trend-analyzer] DEBUG: aboveThreshold items: ${aboveThreshold.length} (${[...kindCounts.entries()].map(([k,v]) => `${k}=${v}`).join(', ')})`);
  }
  if (aboveThreshold.length === 0) {
    if (isDebug()) console.log(`[trend-analyzer] DEBUG: No trends above threshold, returning empty`);
    // Cache empty result to avoid re-fetching
    writeJSON(PATHS.trendsCache, {
      computed_at: new Date().toISOString(),
      persona_identities: personaIdentities,
      scoring_version: SCORING_VERSION,
      results: [],
      signal_pool: buildSignalPoolSummary(aboveThreshold),
    } satisfies TrendsCacheData);
    return [];
  }

  // 5. LLM relevance filter
  const prompt = buildRelevancePrompt(aboveThreshold, personaIdentities, ops.topic_count);
  if (isDebug()) {
    const trendListDebug = aboveThreshold
      .map(t => `- ${t.keyword} (${t.platform}, v=${t.velocity_score.toFixed(1)}x, p=${t.priority_score.toFixed(1)}, src=${t.source_bucket})`)
      .join('\n');
    console.log(`[trend-analyzer] DEBUG: input trends (${aboveThreshold.length}):\n${trendListDebug}`);
  }
  try {
    const envelope = await llm.callJSON<LLMTrendEnvelope>(prompt, 4000);
    if (isDebug()) console.log(`[trend-analyzer] DEBUG: LLM response received:`, envelope);
    const results = Array.isArray(envelope) ? envelope : (envelope.topics ?? []);
    if (isDebug()) console.log(`[trend-analyzer] DEBUG: LLM results count: ${results.length}`);

    // Track used original trends to prevent multiple LLM results from mapping to the same one
    const usedOriginalKeys = new Set<string>();

    const filtered = results
      .map(r => {
        // Fuzzy match: LLM often returns shortened/cleaned keywords.
        // Strategy: strip punctuation → substring check → keyword-overlap check.
        const normalize = (s: string) => s.replace(/[【】《》「」『』\[\]()（）⚡·、，。！？!?,.\-—\s#IGN]/g, '').toLowerCase();
        const rNorm = normalize(r.keyword);

        // Score-based matching: count how many chars of rNorm appear in tNorm
        const overlapScore = (tNorm: string, rN: string): number => {
          if (tNorm === rN) return 1.0;
          if (tNorm.includes(rN) || rN.includes(tNorm)) return 0.9;
          // Check if significant portion of one appears in the other (substring of ≥6 chars)
          for (let len = Math.min(rN.length, 8); len >= 6; len--) {
            for (let i = 0; i <= rN.length - len; i++) {
              if (tNorm.includes(rN.slice(i, i + len))) return 0.7;
            }
          }
          // Split LLM keyword into 2-char segments and check overlap
          const segments: string[] = [];
          for (let i = 0; i < rN.length - 1; i++) segments.push(rN.slice(i, i + 2));
          if (segments.length === 0) return 0;
          const hits = segments.filter(seg => tNorm.includes(seg)).length;
          return hits / segments.length;
        };

        // IMPORTANT: Only match candidates from the SAME platform first.
        // Fall back to cross-platform only if no same-platform match found.
        const samePlatformCandidates = aboveThreshold.filter(t => t.platform === r.platform);
        const candidatePools = samePlatformCandidates.length > 0
          ? [samePlatformCandidates, aboveThreshold]
          : [aboveThreshold];

        let bestMatch: TrendItem | null = null;
        let bestScore = 0;

        for (const pool of candidatePools) {
          if (bestMatch && bestScore >= 0.45) break; // already found good match in same-platform pool

          for (const t of pool) {
            const tKey = `${t.platform}:${t.keyword}`;
            if (usedOriginalKeys.has(tKey)) continue; // skip already-claimed originals

            const tNorm = normalize(t.keyword);
            const platformBonus = t.platform === r.platform ? 0.15 : 0;
            const score = overlapScore(tNorm, rNorm) + platformBonus;
            if (score > bestScore) {
              bestScore = score;
              bestMatch = t;
            }
          }
        }

        // Raised threshold from 0.35 → 0.45 to reduce false positives
        if (!bestMatch || bestScore < 0.45) {
          if (isDebug()) console.log(`[trend-analyzer] DEBUG: Fuzzy match failed for "${r.keyword}" (norm: "${rNorm}"), bestScore=${bestScore.toFixed(3)}`);
          return null;
        }

        // Claim this original so subsequent LLM results won't map to it
        const matchKey = `${bestMatch.platform}:${bestMatch.keyword}`;
        usedOriginalKeys.add(matchKey);
        if (isDebug()) console.log(`[trend-analyzer] DEBUG: Matched "${r.keyword}" → "${bestMatch.keyword}" (score=${bestScore.toFixed(3)}`);

        return {
          ...bestMatch,
          velocity_score: r.velocity_score || bestMatch.velocity_score,
          hook_angle: r.hook_angle,
          identity_mode: normalizeIdentityMode(r.identity_mode),
        };
      })
      .filter((r): r is FilteredTrend => r !== null);

    // Write to TTL cache so subsequent cron runs skip API+LLM work
    writeJSON(PATHS.trendsCache, {
      computed_at: new Date().toISOString(),
      persona_identities: personaIdentities,
      scoring_version: SCORING_VERSION,
      results: filtered,
      signal_pool: buildSignalPoolSummary(aboveThreshold),
    } satisfies TrendsCacheData);

    return filtered;
  } catch (err) {
    console.error(`[trend-analyzer] LLM call failed:`, err);
    return [];
  }
}

// ─── Directional Idea Material Pipeline ─────────────────────────────────────
//
// When user runs `/idea 电竞`, this pipeline:
// 1) Checks direction-specific cache (2h TTL)
// 2) Scans discovery-pool for matching materials
// 3) Searches XHS (最新+7天内) + Douyin if not in cooldown
// 4) Optionally supplements with related hot-list items
// 5) Sends all materials to LLM for FilteredTrend selection
//
// Engagement thresholds: XHS likes >= 1000, Douyin digg_count >= 5000

const DIRECTION_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const DIRECTION_MIN_MATERIALS = 3; // need at least this many materials before LLM

interface DirectionalMaterial {
  direction: string;
  platform: string;
  title: string;
  excerpt: string;
  engagement: number;
  published_at?: string;
  source: 'cache' | 'discovery' | 'xhs_search' | 'douyin_search' | 'hot_list';
}

interface DirectionCacheData {
  computed_at: string;
  direction: string;
  persona_identities: string;
  results: FilteredTrend[];
}

function loadDirectionCache(direction: string, personaIdentities: string): FilteredTrend[] | null {
  const cached = readJSON<DirectionCacheData>(PATHS.directionIdeaCache, null as unknown as DirectionCacheData);
  if (!cached?.computed_at) return null;
  if (cached.direction !== direction || cached.persona_identities !== personaIdentities) return null;
  const age = now().getTime() - new Date(cached.computed_at).getTime();
  if (age >= DIRECTION_CACHE_TTL_MS) return null;
  console.error(`[direction-idea] Using cached results for "${direction}" (age: ${Math.round(age / 60_000)}min, ${cached.results.length} topics)`);
  return cached.results;
}

function saveDirectionCache(direction: string, personaIdentities: string, results: FilteredTrend[]): void {
  writeJSON(PATHS.directionIdeaCache, {
    computed_at: new Date().toISOString(),
    direction,
    persona_identities: personaIdentities,
    results,
  } satisfies DirectionCacheData);
}

/** Scan discovery-pool for items matching the direction keyword */
function loadDirectionalDiscoveryMaterials(direction: string): DirectionalMaterial[] {
  const pool = loadDiscoveryPool();
  if (!pool.items || pool.items.length === 0) return [];

  const dirLower = direction.toLowerCase();
  return pool.items
    .filter((item: DiscoveryItem) =>
      item.topic.toLowerCase().includes(dirLower) ||
      item.title.toLowerCase().includes(dirLower),
    )
    .sort((a: DiscoveryItem, b: DiscoveryItem) => b.engagement - a.engagement)
    .slice(0, 10)
    .map((item: DiscoveryItem) => ({
      direction,
      platform: item.source.includes('douyin') ? 'douyin' : 'xhs',
      title: item.title,
      excerpt: `${item.topic} | ${item.author}`,
      engagement: item.engagement,
      source: 'discovery' as const,
    }));
}

/** Search XHS + Douyin for the direction keyword, return raw materials */
async function fetchDirectionalSearchMaterials(direction: string): Promise<DirectionalMaterial[]> {
  const materials: DirectionalMaterial[] = [];

  // XHS: search by 最新 + 7天内 to get fresh high-engagement content
  // searchXhsNotes has built-in 4h cache per (keyword, sortBy, publishTime)
  try {
    const notes = await searchXhsNotes(direction, {
      sortBy: '最新',
      publishTime: '一周内',
    });
    const filtered = notes.filter(n => (n.likes ?? 0) >= SEARCH_KEYWORD_HIT_THRESHOLD_XHS);
    console.error(`[direction-idea] XHS search "${direction}": ${notes.length} results, ${filtered.length} above threshold`);
    for (const n of filtered.slice(0, 15)) {
      materials.push({
        direction,
        platform: 'xhs',
        title: n.title,
        excerpt: (n.description ?? '').slice(0, 120),
        engagement: n.likes ?? 0,
        source: 'xhs_search',
      });
    }
  } catch (err) {
    console.warn(`[direction-idea] XHS search failed for "${direction}": ${(err as Error).message}`);
  }

  // Douyin: respect rate limit cooldown
  const rlStatus = getDouyinRateLimitStatus();
  if (!rlStatus.in_cooldown) {
    try {
      const result = searchDouyinVideos(direction, 20);
      if (result.success && result.videos) {
        const filtered = result.videos.filter(v => v.digg_count >= SEARCH_KEYWORD_HIT_THRESHOLD_DOUYIN);
        console.error(`[direction-idea] Douyin search "${direction}": ${result.videos.length} results, ${filtered.length} above threshold`);
        // Sort by create_time descending (newest first)
        const sorted = filtered.sort((a, b) => (b.create_time ?? 0) - (a.create_time ?? 0));
        for (const v of sorted.slice(0, 10)) {
          materials.push({
            direction,
            platform: 'douyin',
            title: v.desc || `douyin-${v.aweme_id}`,
            excerpt: (v.desc ?? '').slice(0, 120),
            engagement: v.digg_count,
            published_at: v.create_time ? new Date(v.create_time * 1000).toISOString() : undefined,
            source: 'douyin_search',
          });
        }
      } else if (result.rate_limited) {
        console.warn(`[direction-idea] Douyin rate limited for "${direction}": ${result.reason ?? 'cooldown'}`);
      }
    } catch (err) {
      console.warn(`[direction-idea] Douyin search failed for "${direction}": ${(err as Error).message}`);
    }
  } else {
    console.warn(`[direction-idea] Douyin in cooldown (${rlStatus.cooldown_remaining_s}s remaining), skipping`);
  }

  return materials;
}

/** Scan hot-list trends cache for items related to the direction */
function loadDirectionalHotListItems(direction: string): TrendItem[] {
  const cached = readJSON<TrendsCacheData>(PATHS.trendsCache, null as unknown as TrendsCacheData);
  if (!cached?.results?.length) return [];

  const dirLower = direction.toLowerCase();
  return cached.results
    .filter(t => t.keyword.toLowerCase().includes(dirLower) || t.hook_angle?.toLowerCase().includes(dirLower))
    .slice(0, 3); // only a few supplementary items
}

/** Convert DirectionalMaterial[] → TrendItem[] for LLM processing */
function materialsToTrendItems(materials: DirectionalMaterial[]): TrendItem[] {
  return materials.map((m, idx) => ({
    platform: m.platform,
    keyword: m.title.slice(0, 40),
    current_volume: m.engagement,
    avg_7d: 0,
    velocity_score: computeSyntheticSignalScore({
      count: 1,
      avgEngagement: m.engagement,
      floor: 0.9,
      ceiling: 1.8,
    }),
    rank: 900 + idx,
    description: m.excerpt,
    source_type: 'search_keyword' as TrendSourceType,
    source_bucket: '搜索' as TrendSourceBucket,
    signal_kind: 'search_demand' as TrendSignalKind,
    priority_score: m.engagement * 0.001,
  }));
}

/**
 * Main entry: directional idea analysis.
 * Called by cmdIdea() when user specifies a direction (e.g. `/idea 电竞`).
 */
export async function analyzeDirectionalTrends(
  ops: OpsConfig,
  personaIdentities: string,
  llm: LLMClient,
  direction: string,
): Promise<FilteredTrend[]> {
  // 1) Check direction cache
  const cached = loadDirectionCache(direction, personaIdentities);
  if (cached) return cached;

  // 2) Gather materials: discovery-pool first, then real-time search
  let materials: DirectionalMaterial[] = [];

  // 2a) Discovery pool (already-searched content, free)
  const discoveryMaterials = loadDirectionalDiscoveryMaterials(direction);
  materials.push(...discoveryMaterials);
  console.error(`[direction-idea] Discovery pool: ${discoveryMaterials.length} matching materials for "${direction}"`);

  // 2b) Platform search (only if insufficient materials from discovery)
  if (materials.length < DIRECTION_MIN_MATERIALS) {
    const searchMaterials = await fetchDirectionalSearchMaterials(direction);
    materials.push(...searchMaterials);
    console.error(`[direction-idea] Platform search added: ${searchMaterials.length} materials`);
  } else {
    console.error(`[direction-idea] Sufficient discovery materials (${materials.length}), skipping platform search`);
  }

  // Deduplicate by title
  const seenTitles = new Set<string>();
  materials = materials.filter(m => {
    const key = m.title.toLowerCase().trim();
    if (seenTitles.has(key)) return false;
    seenTitles.add(key);
    return true;
  });

  console.error(`[direction-idea] Total unique materials: ${materials.length}`);

  // 3) Convert materials to TrendItem format
  const materialTrends = materialsToTrendItems(materials);

  // 4) Supplement with direction-related hot-list items (max 3)
  const hotListItems = loadDirectionalHotListItems(direction);
  if (hotListItems.length > 0) {
    console.error(`[direction-idea] Hot-list supplement: ${hotListItems.length} related items`);
  }

  // 5) Combine all, sort by engagement
  let allTrends = [...materialTrends, ...hotListItems]
    .sort((a, b) => b.current_volume - a.current_volume)
    .slice(0, 25);

  // 5b) Apply trend fatigue penalty (same as analyzeTrends)
  try {
    const { loadQueue } = await import('./review-queue');
    const queue = await loadQueue();
    if (queue.items.length > 0) {
      const usageMap = buildTrendUsageMap(queue.items, 7);
      if (usageMap.size > 0) {
        allTrends = applyFatiguePenalty(allTrends, usageMap);
        allTrends.sort((a, b) => b.priority_score - a.priority_score);
      }
    }
  } catch {
    // review-queue not available — skip fatigue detection
  }

  if (allTrends.length === 0) {
    console.error(`[direction-idea] No materials found for "${direction}"`);
    saveDirectionCache(direction, personaIdentities, []);
    return [];
  }

  // 6) LLM relevance filter with direction-aware prompt
  const directionPrompt = `${personaIdentities}\n\n【用户指定方向】：${direction}\n请特别优先选择与「${direction}」直接相关的话题。`;
  const prompt = buildRelevancePrompt(allTrends, directionPrompt, ops.topic_count);

  try {
    const envelope = await llm.callJSON<LLMTrendEnvelope>(prompt, 4000);
    const results = Array.isArray(envelope) ? envelope : (envelope.topics ?? []);
    console.error(`[direction-idea] LLM returned ${results.length} topics for "${direction}"`);

    // Fuzzy match back to allTrends (reuse same logic as analyzeTrends)
    const usedOriginalKeys = new Set<string>();
    const normalize = (s: string) => s.replace(/[【】《》「」『』\[\]()（）⚡·、，。！？!?,.\-—\s#IGN]/g, '').toLowerCase();

    const filtered = results
      .map(r => {
        const rNorm = normalize(r.keyword);
        let bestMatch: TrendItem | null = null;
        let bestScore = 0;

        for (const t of allTrends) {
          const tKey = `${t.platform}:${t.keyword}`;
          if (usedOriginalKeys.has(tKey)) continue;
          const tNorm = normalize(t.keyword);

          let score = 0;
          if (tNorm === rNorm) score = 1.0;
          else if (tNorm.includes(rNorm) || rNorm.includes(tNorm)) score = 0.9;
          else {
            const segments: string[] = [];
            for (let i = 0; i < rNorm.length - 1; i++) segments.push(rNorm.slice(i, i + 2));
            if (segments.length > 0) {
              const hits = segments.filter(seg => tNorm.includes(seg)).length;
              score = hits / segments.length;
            }
          }
          if (t.platform === r.platform) score += 0.15;
          if (score > bestScore) {
            bestScore = score;
            bestMatch = t;
          }
        }

        if (!bestMatch || bestScore < 0.35) return null;
        usedOriginalKeys.add(`${bestMatch.platform}:${bestMatch.keyword}`);

        return {
          ...bestMatch,
          velocity_score: r.velocity_score || bestMatch.velocity_score,
          hook_angle: r.hook_angle,
          identity_mode: normalizeIdentityMode(r.identity_mode),
        };
      })
      .filter((r): r is FilteredTrend => r !== null);

    console.error(`[direction-idea] Final filtered: ${filtered.length} topics for "${direction}"`);

    // Cache results
    saveDirectionCache(direction, personaIdentities, filtered);

    return filtered;
  } catch (err) {
    console.error(`[direction-idea] LLM call failed:`, err);
    return [];
  }
}
