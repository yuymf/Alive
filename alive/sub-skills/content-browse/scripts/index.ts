// alive/sub-skills/content-browse/scripts/index.ts
// Content browsing & inspiration collection sub-skill
//
// Generalized from skill/scripts/inspiration-collector.ts + fetch-trends.ts
// Removes Instagram/XiaoHongShu/cosplay hardcoding; uses abstract platform
// operations injected via ctx.config.

import * as fs from 'fs';
import * as path from 'path';
import type { SubSkillContext, SubSkillResult } from '../../../scripts/router/sub-skill-sdk';
import { createResult, createFeedback } from '../../../scripts/router/sub-skill-sdk';

// ── Types ────────────────────────────────────────────────────────

export interface FeedItem {
  id: string;
  title: string;
  likes: number;
  user?: string;
  tags?: string[];
  caption?: string;
  thumbnail_url?: string;
  source?: string;
}

export interface TrendPost {
  title: string;
  score: number;
  selftext: string;
  source: string;
  topComments: string[];
}

export interface InspirationSummary {
  feed_highlights: Array<{ title: string; likes: number; topic: string; takeaway?: string }>;
  trending_topics: string[];
  domain_insights: string[];
  saved_inspirations: Array<{
    source_id: string;
    source_title: string;
    visual_description: string;
    style_tags: string[];
  }>;
}

export interface InspirationState {
  last_refreshed_at: string | null;
  feed_highlights: InspirationSummary['feed_highlights'];
  trending_topics: string[];
  domain_insights: string[];
  saved_inspirations: InspirationSummary['saved_inspirations'];
}

const DEFAULT_INSPIRATION_STATE: InspirationState = {
  last_refreshed_at: null,
  feed_highlights: [],
  trending_topics: [],
  domain_insights: [],
  saved_inspirations: [],
};

// ── Template Loader ──────────────────────────────────────────────

function loadTemplate(templateName: string): string {
  const templateDir = path.join(__dirname, '..', 'templates');
  const templatePath = path.join(templateDir, templateName);
  if (fs.existsSync(templatePath)) return fs.readFileSync(templatePath, 'utf8');
  throw new Error(`Template not found: ${templateName}`);
}

// ── Helpers ──────────────────────────────────────────────────────

function formatFeedItem(item: FeedItem): string {
  const user = item.user ? ` by ${item.user}` : '';
  const tags = item.tags?.length ? ` [${item.tags.join(', ')}]` : '';
  const source = item.source ? ` (${item.source})` : '';
  return `- ${item.title} (❤️${item.likes})${user}${tags}${source}`;
}

function getCurrentSeasonLabel(): string {
  const month = new Date().getMonth() + 1;
  if (month >= 3 && month <= 5) return '春季';
  if (month >= 6 && month <= 8) return '夏季';
  if (month >= 9 && month <= 11) return '秋季';
  return '冬季';
}

// ── Actions ──────────────────────────────────────────────────────

export const actions = {
  /**
   * Browse feed content and extract inspiration.
   *
   * Expects ctx.config to optionally contain:
   *   - getFeedItems(): Promise<FeedItem[]>     — fetch recommended feed
   *   - searchContent(keyword): Promise<FeedItem[]>  — search by keyword
   *   - searchKeywords?: string[]               — fallback keywords to search
   *   - actionContext?: string                   — heartbeat action description (for LLM keyword generation)
   *   - webSearch?(query): Promise<Array<{title, url, snippet}>> — web search fallback
   */
  async 'feed-browse'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const { persona, emotion, llm, config, memory } = ctx;

    const getFeedItems = config.getFeedItems as (() => Promise<FeedItem[]>) | undefined;
    const searchContent = config.searchContent as ((kw: string) => Promise<FeedItem[]>) | undefined;
    const fallbackKeywords = (config.searchKeywords as string[]) ?? persona.personality.core_traits.slice(0, 3);
    const actionContext = (config.actionContext as string) ?? '';

    // 0. Generate intent-driven search keywords via LLM
    let searchKeywords: string[];
    try {
      const recentInspirations = memory.readJSON<InspirationState>('inspiration-state', DEFAULT_INSPIRATION_STATE);
      const recentTitles = (recentInspirations.saved_inspirations ?? [])
        .slice(-5)
        .map(s => s.source_title)
        .join('、') || '（暂无）';

      const intentTemplate = loadTemplate('search-intent-prompt.md');
      const moodValence = emotion.mood?.valence ?? 0;
      const moodEnergy = emotion.energy ?? 0.5;
      const moodCreativity = emotion.creativity ?? 0.4;
      const intentPrompt = intentTemplate
        .replace('{persona_name}', persona.meta.name)
        .replace('{persona_traits}', (persona.personality.core_traits ?? []).join('、'))
        .replace('{emotion_summary}', `${emotion.mood?.description ?? '平静'} (valence=${moodValence.toFixed(1)}, energy=${moodEnergy.toFixed(1)}, creativity=${moodCreativity.toFixed(1)})`)
        .replace('{action_context}', actionContext || '（没有特别想做的事，随便刷刷）')
        .replace('{recent_inspirations}', recentTitles)
        .replace('{default_keywords}', fallbackKeywords.join('、'));

      const result = await llm.callJSON<{ keywords: string[] }>(intentPrompt, 300);
      searchKeywords = (result.keywords ?? []).slice(0, 5);

      if (searchKeywords.length === 0) {
        searchKeywords = fallbackKeywords;
      } else {
        console.log(`[content-browse] LLM generated keywords: ${searchKeywords.join(', ')}`);
      }
    } catch (err) {
      console.warn(`[content-browse] LLM keyword generation failed, using fallback: ${(err as Error).message}`);
      searchKeywords = fallbackKeywords;
    }

    const feedItems: FeedItem[] = [];
    const searchItems: FeedItem[] = [];

    // 1. Fetch feed
    if (getFeedItems) {
      try {
        const items = await getFeedItems();
        feedItems.push(...items.slice(0, 10));
      } catch (err) {
        console.warn(`[content-browse] Feed fetch failed: ${(err as Error).message}`);
      }
    }

    // 2. Search by LLM-generated keywords
    if (searchContent) {
      for (const keyword of searchKeywords.slice(0, 3)) {
        try {
          const items = await searchContent(keyword);
          searchItems.push(...items);
        } catch (err) {
          console.warn(`[content-browse] Search "${keyword}" failed: ${(err as Error).message}`);
        }
      }
    }

    // Dedup
    const seenIds = new Set<string>();
    const allItems = [...feedItems, ...searchItems].filter(item => {
      if (seenIds.has(item.id)) return false;
      seenIds.add(item.id);
      return true;
    });

    if (allItems.length === 0) {
      return createResult(
        '刷了一会儿但没什么新鲜的',
        { vitality_cost: 5, emotion_deltas: [{ valence: -0.02 }] },
      );
    }

    // 3. LLM analysis
    const feedText = feedItems.length > 0
      ? feedItems.map(formatFeedItem).join('\n')
      : '无数据';
    const searchText = searchItems.length > 0
      ? searchItems.map(formatFeedItem).join('\n')
      : '无数据';

    const template = loadTemplate('feed-analysis-prompt.md');
    // Build source platforms list from feed items
    const sourcePlatforms = new Set<string>();
    for (const item of allItems) {
      if (item.source) sourcePlatforms.add(item.source);
    }
    const platformsStr = sourcePlatforms.size > 0
      ? Array.from(sourcePlatforms).join(', ')
      : '未标注';
    // Also check config.sourcePlatforms (from adapter)
    const configPlatforms = config.sourcePlatforms as string[] | undefined;
    const finalPlatformsStr = configPlatforms?.length
      ? configPlatforms.join(', ')
      : platformsStr;

    const prompt = template
      .replace('{source_platforms}', finalPlatformsStr)
      .replace('{feed_data}', feedText)
      .replace('{search_data}', searchText)
      .replace('{detail_data}', '（暂无详情）')
      .replace(/\{persona\.meta\.name\}/g, persona.meta.name);

    let summary: InspirationSummary;
    try {
      summary = await llm.callJSON<InspirationSummary>(prompt, 1500);
    } catch (err) {
      console.error(`[content-browse] LLM analysis failed: ${(err as Error).message}`);
      return createResult(
        `刷了 ${allItems.length} 条内容，但没来得及细想`,
        { vitality_cost: 10, emotion_deltas: [{ creativity: 0.03 }] },
      );
    }

    // 4. Save state
    const currentState = memory.readJSON<InspirationState>('inspiration-state', DEFAULT_INSPIRATION_STATE);
    const existingInspos = currentState.saved_inspirations ?? [];
    const newInspos = summary.saved_inspirations ?? [];
    const newIds = new Set(newInspos.map(s => s.source_id));
    const mergedInspos = [
      ...existingInspos.filter(s => !newIds.has(s.source_id)),
      ...newInspos,
    ].slice(-20);

    memory.writeJSON<InspirationState>('inspiration-state', {
      last_refreshed_at: new Date().toISOString(),
      feed_highlights: summary.feed_highlights ?? [],
      trending_topics: summary.trending_topics ?? [],
      domain_insights: summary.domain_insights ?? [],
      saved_inspirations: mergedInspos,
    });

    // 5. Diary entry
    const dateStr = new Date().toISOString().slice(0, 10);
    const timeStr = new Date().toTimeString().slice(0, 5);
    const highlights = (summary.feed_highlights ?? []).slice(0, 3).map(h => h.title).join('、');
    const topics = (summary.trending_topics ?? []).slice(0, 3).join('、');

    memory.appendDiary(
      `\n### ${dateStr} ${timeStr} 刷手机\n📱 刷了一会儿，看到${highlights ? `「${highlights}」` : '一些内容'}${topics ? `，热点话题有：${topics}` : ''}。收藏了 ${mergedInspos.length - existingInspos.length + newInspos.length} 条灵感。\n`,
    );

    const insightCount = (summary.domain_insights ?? []).length;
    return createResult(
      `刷了 ${allItems.length} 条内容，发现 ${insightCount} 个洞察`,
      {
        vitality_cost: 10,
        emotion_deltas: [
          { creativity: 0.08, valence: 0.03 },
          ...(insightCount > 2 ? [{ creativity: 0.05 }] : []),
        ],
      },
    );
  },

  /**
   * Collect domain-specific inspiration via web search (e.g. ACG trends, visual references).
   *
   * Expects ctx.config to optionally contain:
   *   - webSearch(query, limit): Promise<Array<{title, url, snippet}>> — web search API
   *   - trendQueries?: string[]  — custom search queries for trend tracking
   */
  async 'inspiration-collect'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const { persona, llm, config, memory } = ctx;

    type WebSearchResult = { title: string; url: string; snippet: string };
    const webSearch = config.webSearch as ((query: string, limit?: number) => Promise<WebSearchResult[]>) | undefined;

    if (!webSearch) {
      return createResult(
        '想找灵感但搜索功能未配置',
        { vitality_cost: 0 },
      );
    }

    const season = getCurrentSeasonLabel();
    const year = new Date().getFullYear();
    const interests = persona.personality.core_traits?.slice(0, 3) ?? [];
    const defaultQueries = interests.map(trait => `${year} ${season} ${trait} 趋势`);
    const trendQueries = (config.trendQueries as string[]) ?? defaultQueries;

    // Run parallel searches
    const searchPromises = trendQueries.slice(0, 4).map(async (query) => {
      try {
        return { query, results: await webSearch(query, 5) };
      } catch (err) {
        console.warn(`[content-browse] Web search failed for "${query}": ${(err as Error).message}`);
        return { query, results: [] as WebSearchResult[] };
      }
    });

    const searchResults = await Promise.all(searchPromises);
    const totalResults = searchResults.reduce((sum, s) => sum + s.results.length, 0);

    if (totalResults === 0) {
      return createResult('搜了一圈没找到什么新鲜的', { vitality_cost: 10 });
    }

    // Format for LLM
    const rawData = searchResults.map(({ query, results }) => {
      if (results.length === 0) return `【${query}】\n无数据`;
      const formatted = results.map(r => `- ${r.title}\n  URL: ${r.url}\n  摘要: ${r.snippet || '无摘要'}`).join('\n');
      return `【${query}】\n${formatted}`;
    }).join('\n\n');

    const template = loadTemplate('inspiration-summary-prompt.md');
    const prompt = template
      .replace('{raw_data}', rawData)
      .replace(/\{persona\.meta\.name\}/g, persona.meta.name);

    let trendSummary: {
      hot_styles: string[];
      high_engagement_patterns: string[];
      trending_hashtags: string[];
    };

    try {
      trendSummary = await llm.callJSON<typeof trendSummary>(prompt, 1000);
    } catch (err) {
      console.error(`[content-browse] LLM trend analysis failed: ${(err as Error).message}`);
      return createResult(
        `找了 ${totalResults} 条灵感但没来得及整理`,
        { vitality_cost: 10, emotion_deltas: [{ creativity: 0.03 }] },
      );
    }

    // Save trend data
    memory.writeJSON('trend-insights', {
      ...trendSummary,
      updated_at: new Date().toISOString(),
    });

    const dateStr = new Date().toISOString().slice(0, 10);
    const timeStr = new Date().toTimeString().slice(0, 5);
    const topStyles = (trendSummary.hot_styles ?? []).slice(0, 2).join('、');

    memory.appendDiary(
      `\n### ${dateStr} ${timeStr} 灵感采集\n🔍 搜了一圈灵感，${topStyles ? `发现「${topStyles}」等趋势` : '整理了一下最近的趋势'}。\n`,
    );

    return createResult(
      `采集了 ${totalResults} 条灵感素材，整理出 ${(trendSummary.hot_styles ?? []).length} 个风格趋势`,
      {
        vitality_cost: 10,
        emotion_deltas: [{ creativity: 0.1, valence: 0.05 }],
      },
    );
  },
};
