/**
 * trend-analyzer.ts
 * Calls daily-hot-news and douyin-hot-trend ClawHub skills,
 * computes velocity scores vs 7-day history, filters by threshold,
 * and runs LLM relevance filter based on persona's topic_filter_prompt.
 *
 * ClawHub skill invocation pattern (mirrors xhs-client.ts execFile approach):
 *   openclaw skill run daily-hot-news --args '{"platform":"douyin"}'
 */

import { execFileSync } from 'child_process';
import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now, getLocalDate } from '../utils/time-utils';
import { TrendItem, TrendHistory, OpsConfig } from '../utils/types';
import { LLMClient } from '../utils/llm-client';

// ─── Pure functions (exported for testing) ───────────────────────────────────

export function computeVelocityScore(currentVolume: number, avg7d: number): number {
  if (avg7d === 0) return 1.0;
  return currentVolume / avg7d;
}

export function filterByThreshold(items: TrendItem[], threshold: number): TrendItem[] {
  return items.filter(i => i.velocity_score >= threshold);
}

export function buildRelevancePrompt(
  trends: TrendItem[],
  personaIdentities: string,
  topicCount: number,
): string {
  const trendList = trends
    .map(t => `- ${t.keyword} (${t.platform}, velocity=${t.velocity_score.toFixed(1)}x, rank=${t.rank})`)
    .join('\n');
  return `你是一个内容运营分析师。以下是今日平台热榜话题：

${trendList}

虚拟人设身份：${personaIdentities}

请从以上热点中筛选出最多 ${topicCount} 个可蹭的话题，要求：
1. 与虚拟人的某个身份相关，或可借势切入
2. 平台正在助推（velocity > 1.5）
3. 避免政治敏感、负面争议话题

对每个筛选出的话题，给出：
- keyword: 话题关键词
- platform: 来源平台
- velocity_score: 速度分
- hook_angle: 用什么角度切入（结合人设）
- identity_mode: 使用哪个身份（esports/singer/racer/daily）

以 JSON 数组返回，格式：
\`\`\`json
[{"keyword":"...","platform":"...","velocity_score":0,"hook_angle":"...","identity_mode":"..."}]
\`\`\``;
}

// ─── ClawHub skill invocations ────────────────────────────────────────────────

interface HotNewsItem {
  title?: string;
  name?: string;
  hot?: number;
  index?: number;
  rank?: number;
}

function callDailyHotNews(platform: string, limit = 30): TrendItem[] {
  try {
    const raw = execFileSync('openclaw', [
      'skill', 'run', 'daily-hot-news',
      '--args', JSON.stringify({ platform, limit }),
    ], { timeout: 30_000, encoding: 'utf8' });
    const parsed = JSON.parse(raw) as HotNewsItem[];
    return parsed.map((item, idx) => ({
      platform,
      keyword: item.title ?? item.name ?? '',
      current_volume: item.hot ?? 0,
      avg_7d: 0, // filled in by computeWithHistory
      velocity_score: 0,
      rank: item.index ?? item.rank ?? idx + 1,
    }));
  } catch {
    return [];
  }
}

interface DouyinHotItem {
  title?: string;
  popularity?: number;
  rank?: number;
  type?: string;
  cover?: string;
}

function callDouyinHotTrend(limit = 30): TrendItem[] {
  try {
    const raw = execFileSync('openclaw', [
      'skill', 'run', 'douyin-hot-trend',
      '--args', JSON.stringify({ limit }),
    ], { timeout: 30_000, encoding: 'utf8' });
    const parsed = JSON.parse(raw) as DouyinHotItem[];
    return parsed.map(item => ({
      platform: 'douyin',
      keyword: item.title ?? '',
      current_volume: item.popularity ?? 0,
      avg_7d: 0,
      velocity_score: 0,
      rank: item.rank ?? 0,
      type: item.type,
      cover: item.cover,
    }));
  } catch {
    return [];
  }
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

export interface FilteredTrend extends TrendItem {
  hook_angle: string;
  identity_mode: 'esports' | 'singer' | 'racer' | 'daily';
}

export async function analyzeTrends(
  ops: OpsConfig,
  personaIdentities: string,
  llm: LLMClient,
): Promise<FilteredTrend[]> {
  // 1. Collect raw trends
  const douyinItems = callDouyinHotTrend(30);
  const weiboItems = callDailyHotNews('weibo', 20);
  const zhihuItems = callDailyHotNews('zhihu', 20);
  const bilibiliItems = callDailyHotNews('bilibili', 20);
  const rawAll = [...douyinItems, ...weiboItems, ...zhihuItems, ...bilibiliItems];

  // Deduplicate by keyword+platform
  const seen = new Set<string>();
  const deduped = rawAll.filter(item => {
    const key = `${item.platform}:${item.keyword}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 2. Load history once, then compute velocity scores
  const history = readJSON<TrendHistory[]>(PATHS.trendHistory, []);
  const withVelocity: TrendItem[] = deduped.map(item => {
    const avg7d = computeAvgFromHistory(history, item.keyword, item.platform);
    const velocity_score = computeVelocityScore(item.current_volume, avg7d);
    return { ...item, avg_7d: avg7d, velocity_score };
  });

  // 3. Persist today's data for future velocity calculations
  persistTodayTrends(withVelocity);

  // 4. Filter by threshold
  const aboveThreshold = filterByThreshold(withVelocity, ops.trend_score_threshold);
  if (aboveThreshold.length === 0) return [];

  // 5. LLM relevance filter
  const prompt = buildRelevancePrompt(aboveThreshold, personaIdentities, ops.topic_count);
  try {
    const results = await llm.callJSON<LLMTrendResult[]>(prompt, 1000);
    return results
      .map(r => {
        const match = aboveThreshold.find(t => t.keyword === r.keyword && t.platform === r.platform);
        if (!match) return null;
        return {
          ...match,
          velocity_score: r.velocity_score || match.velocity_score,
          hook_angle: r.hook_angle,
          identity_mode: r.identity_mode,
        };
      })
      .filter((r): r is FilteredTrend => r !== null);
  } catch {
    return [];
  }
}
