/**
 * trend-analyzer.ts
 * Fetches trending topics from the remote DailyHot API (douyin, weibo, bilibili, toutiao, etc.),
 * computes velocity scores vs 7-day history, filters by threshold,
 * and runs LLM relevance filter based on persona's topic_filter_prompt.
 *
 * Data source: https://dailyhot-rho-nine.vercel.app/<platform>?limit=N
 * (Previously used ClawHub skills — migrated to direct API calls for reliability.)
 */

import { execFileSync } from 'child_process';
import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now, getLocalDate } from '../utils/time-utils';
import { TrendItem, TrendHistory, OpsConfig, PersonaConfig } from '../utils/types';
import { LLMClient } from '../utils/llm-client';

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
  // Cap input to top 10 to control prompt length (avoid finish_reason=length).
  // Assumes input is already sorted by velocity_score desc (or by volume for cold-start).
  const capped = trends.slice(0, 10);
  const trendList = capped
    .map(t => `- ${t.keyword} (${t.platform}, velocity=${t.velocity_score.toFixed(1)}x, rank=${t.rank})`)
    .join('\n');

  // Cold-start detection: if all velocities are 1.0x (no history yet), relax the velocity requirement
  const isColStart = capped.every(t => t.velocity_score === 1.0);
  const velocityRequirement = isColStart
    ? '无历史数据，按热度排名选择'
    : '平台正在助推（velocity > 1.5）';

  return `你是一个内容运营分析师。以下是今日平台热榜话题：

${trendList}

虚拟人设身份：${personaIdentities}

请从以上热点中筛选出最多 ${topicCount} 个可蹭的话题，要求：
1. 与虚拟人的某个身份相关，或可借势切入
2. ${velocityRequirement}
3. 避免政治敏感、负面争议话题
4. 尽量让选中话题覆盖不同身份（identity_mode），避免全部集中在同一身份
5. 如果没有合适的话题，返回空数组 {"topics":[]}

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
}

interface DailyHotApiResponse {
  code: number;
  name: string;
  data: DailyHotApiItem[];
}

/**
 * Fetch hot topics from remote DailyHot API.
 * Supports: douyin, bilibili, weibo, toutiao, sina-news, etc.
 */
function callDailyHotNews(platform: string, limit = 30): TrendItem[] {
  const targetPlatform = DAILYHOT_AVAILABLE_PLATFORMS.has(platform) ? platform : null;
  if (!targetPlatform) return [];
  try {
    const raw = execFileSync('curl', [
      '-s', '--max-time', '15',
      `${DAILYHOT_API_BASE}/${targetPlatform}?limit=${limit}`,
    ], { timeout: 20_000, encoding: 'utf8' });
    const parsed = JSON.parse(raw.trim()) as DailyHotApiResponse;
    if (parsed.code !== 200) return [];
    return parsed.data.map((item, idx) => ({
      platform,
      keyword: item.title ?? '',
      current_volume: item.hot ?? 0,
      avg_7d: 0,
      velocity_score: 0,
      rank: idx + 1,
    })).filter(i => i.keyword !== '');
  } catch {
    return [];
  }
}

/**
 * Fetch Douyin hot topics from remote DailyHot API.
 */
function callDouyinHotTrend(limit = 30): TrendItem[] {
  return callDailyHotNews('douyin', limit);
}

// ─── Fallback: Direct Weibo Hot Search API ───────────────────────────────────

interface WeiboHotSearchItem {
  word?: string;
  raw_hot?: number;
  num?: number;
  rank?: number;
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
function callWeiboDirectApi(limit = 30): TrendItem[] {
  try {
    const raw = execFileSync('curl', [
      '-s', '--max-time', '10',
      'https://weibo.com/ajax/side/hotSearch',
      '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      '-H', 'Accept: application/json',
      '-H', 'Referer: https://weibo.com/',
    ], { timeout: 15_000, encoding: 'utf8' });
    const parsed = JSON.parse(raw.trim()) as WeiboHotSearchResponse;
    if (parsed.ok !== 1 || !parsed.data?.realtime) return [];
    return parsed.data.realtime.slice(0, limit).map((item, idx) => ({
      platform: 'weibo',
      keyword: item.word ?? '',
      current_volume: item.raw_hot ?? item.num ?? 0,
      avg_7d: 0,
      velocity_score: 0,
      rank: idx + 1,
    })).filter(i => i.keyword !== '');
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
function callBilibiliDirectApi(limit = 20): TrendItem[] {
  try {
    const raw = execFileSync('curl', [
      '-s', '--max-time', '10',
      'https://api.bilibili.com/x/web-interface/ranking/v2',
      '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      '-H', 'Referer: https://www.bilibili.com/',
    ], { timeout: 15_000, encoding: 'utf8' });
    const parsed = JSON.parse(raw.trim()) as BilibiliRankResponse;
    if (parsed.code !== 0 || !parsed.data?.list) return [];
    return parsed.data.list.slice(0, limit).map((item, idx) => ({
      platform: 'bilibili',
      keyword: item.title ?? '',
      current_volume: item.stat?.view ?? 0,
      avg_7d: 0,
      velocity_score: 0,
      rank: idx + 1,
    })).filter(i => i.keyword !== '');
  } catch (err) {
    console.warn('[trend-analyzer] bilibili direct API fallback failed:', (err as Error).message);
    return [];
  }
}

/**
 * Fetch platform data with fallback: try DailyHot first, then direct API.
 */
function fetchWithFallback(platform: string, limit = 30): TrendItem[] {
  const items = callDailyHotNews(platform, limit);
  if (items.length > 0) return items;

  // Fallback to direct APIs for critical platforms
  if (platform === 'weibo') {
    console.log(`[trend-analyzer] DailyHot weibo returned 0 items, trying direct API fallback...`);
    return callWeiboDirectApi(limit);
  }
  if (platform === 'bilibili') {
    console.log(`[trend-analyzer] DailyHot bilibili returned 0 items, trying direct API fallback...`);
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

export async function analyzeTrends(
  ops: OpsConfig,
  personaIdentities: string,
  llm: LLMClient,
): Promise<FilteredTrend[]> {
  // 1. Collect raw trends from remote DailyHot API (with direct-API fallback)
  const douyinItems = callDouyinHotTrend(30);
  const weiboItems = fetchWithFallback('weibo', 20);
  const bilibiliItems = fetchWithFallback('bilibili', 20);
  const toutiaoItems = callDailyHotNews('toutiao', 20);
  const baiduItems = callDailyHotNews('baidu', 15);
  const rawAll = [...douyinItems, ...weiboItems, ...bilibiliItems, ...toutiaoItems, ...baiduItems];
  console.log(`[trend-analyzer] DEBUG: rawAll items: ${rawAll.length} (douyin=${douyinItems.length}, weibo=${weiboItems.length}, bilibili=${bilibiliItems.length}, toutiao=${toutiaoItems.length}, baidu=${baiduItems.length})`);


  // Deduplicate by keyword+platform
  const seen = new Set<string>();
  const deduped = rawAll.filter(item => {
    const key = `${item.platform}:${item.keyword}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`[trend-analyzer] DEBUG: deduped items: ${deduped.length}`);

  // 2. Load history once, then compute velocity scores
  const history = readJSON<TrendHistory[]>(PATHS.trendHistory, []);
  const withVelocity: TrendItem[] = deduped.map(item => {
    const avg7d = computeAvgFromHistory(history, item.keyword, item.platform);
    const velocity_score = computeVelocityScore(item.current_volume, avg7d);
    return { ...item, avg_7d: avg7d, velocity_score };
  });
  console.log(`[trend-analyzer] DEBUG: withVelocity items: ${withVelocity.length}`);

  // 3. Persist today's data for future velocity calculations
  persistTodayTrends(withVelocity);

  // 4. Filter by threshold — cold-start bypass: if all have no history, skip threshold
  const hasHistory = withVelocity.some(i => i.avg_7d > 0);
  console.log(`[trend-analyzer] DEBUG: hasHistory=${hasHistory}, threshold=${ops.trend_score_threshold}`);
  const aboveThreshold = hasHistory
    ? filterByThreshold(withVelocity, ops.trend_score_threshold)
        .sort((a, b) => b.velocity_score - a.velocity_score)  // Sort by velocity desc before capping
    : withVelocity.sort((a, b) => b.current_volume - a.current_volume).slice(0, 30);
  console.log(`[trend-analyzer] DEBUG: aboveThreshold items: ${aboveThreshold.length}`);
  if (aboveThreshold.length === 0) {
    console.log(`[trend-analyzer] DEBUG: No trends above threshold, returning empty`);
    return [];
  }

  // 5. LLM relevance filter
  const prompt = buildRelevancePrompt(aboveThreshold, personaIdentities, ops.topic_count);
  console.log(`[trend-analyzer] DEBUG: About to call LLM with prompt (first 200 chars): ${prompt.slice(0, 200)}`);
  try {
    const envelope = await llm.callJSON<LLMTrendEnvelope>(prompt, 4000);
    console.log(`[trend-analyzer] DEBUG: LLM response received:`, envelope);
    const results = Array.isArray(envelope) ? envelope : (envelope.topics ?? []);
    console.log(`[trend-analyzer] DEBUG: LLM results count: ${results.length}`);

    // Track used original trends to prevent multiple LLM results from mapping to the same one
    const usedOriginalKeys = new Set<string>();

    return results
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
          console.log(`[trend-analyzer] DEBUG: Fuzzy match failed for "${r.keyword}" (norm: "${rNorm}"), bestScore=${bestScore.toFixed(3)}`);
          return null;
        }

        // Claim this original so subsequent LLM results won't map to it
        const matchKey = `${bestMatch.platform}:${bestMatch.keyword}`;
        usedOriginalKeys.add(matchKey);
        console.log(`[trend-analyzer] DEBUG: Matched "${r.keyword}" → "${bestMatch.keyword}" (score=${bestScore.toFixed(3)})`);

        return {
          ...bestMatch,
          velocity_score: r.velocity_score || bestMatch.velocity_score,
          hook_angle: r.hook_angle,
          identity_mode: normalizeIdentityMode(r.identity_mode),
        };
      })
      .filter((r): r is FilteredTrend => r !== null);
  } catch (err) {
    console.error(`[trend-analyzer] DEBUG: LLM call failed:`, err);
    return [];
  }
}
