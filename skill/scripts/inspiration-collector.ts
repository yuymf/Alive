#!/usr/bin/env node
/**
 * inspiration-collector.ts
 * "刷手机" — Gathers inspiration from 4 sources.
 * Minase's perspective: she's browsing Instagram, watching anime news, scrolling Pinterest.
 */

import * as fs from 'fs';
import * as path from 'path';

import { InspirationData, PostHistory, SavedReference, PostImpulseState, DEFAULT_POST_IMPULSE, TravelState, TravelSpot, DEFAULT_TRAVEL_STATE } from './types';
import { PATHS, readJSON, writeJSON, readTemplate } from './file-utils';
import { callLLMJSON } from './llm-client';
import { exaWebSearch } from './exa-client';
import type { SearchResult } from './exa-client';
import { hashtagRecent } from './instagram-bridge-client';
import type { InstagramHashtagPost } from './instagram-bridge-client';
import { accumulateImpulse } from './post-impulse';
import { isXhsAvailable, listXhsFeed, searchXhsNotes, getXhsNoteDetail } from './xhs-bridge-client';
import type { XhsNote, XhsSearchOptions } from './xhs-bridge-client';
import { now, sleep } from './time-utils';

const DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_SAVED_REFS = 20;
const REF_EXPIRY_DAYS = 7;

const IMAGE_MAGIC_BYTES: Record<string, Buffer> = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  jpg: Buffer.from([0xff, 0xd8, 0xff]),
  webp: Buffer.from([0x52, 0x49, 0x46, 0x46]),
};

function isValidImage(buffer: Buffer): boolean {
  return Object.values(IMAGE_MAGIC_BYTES).some(magic =>
    buffer.length > magic.length && buffer.subarray(0, magic.length).equals(magic)
  );
}

async function downloadImage(url: string, destPath: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return false;

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_FILE_SIZE) return false;
    if (!isValidImage(buffer)) return false;

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buffer);
    return true;
  } catch {
    return false;
  }
}

function cleanupExpiredRefs(refs: SavedReference[]): SavedReference[] {
  const expiryMs = REF_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  const currentMs = now().getTime();
  return refs.filter(ref => {
    const expired = currentMs - ref.saved_at > expiryMs;
    if (expired && fs.existsSync(ref.local_path)) {
      try { fs.unlinkSync(ref.local_path); } catch { /* ignore */ }
    }
    return !expired;
  });
}

const DEFAULT_INSPIRATION: InspirationData = {
  instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: 0 },
  acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: 0 },
  visual_trends: { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: 0 },
  self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: 0 },
  xiaohongshu_trends: { feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [], saved_inspirations: [], updated_at: 0 },
};

// TTLs in milliseconds
const TTL = {
  instagram_trends: 24 * 60 * 60 * 1000,       // 24h
  acg_hotspots: 24 * 60 * 60 * 1000,            // 24h
  visual_trends: 24 * 60 * 60 * 1000,           // 24h
  self_performance: 168 * 60 * 60 * 1000,        // 7 days
  xiaohongshu_trends: 6 * 60 * 60 * 1000,        // 6h — enables 2-4 refreshes/day
} as const;

function isExpired(updatedAt: number, ttl: number): boolean {
  return now().getTime() - updatedAt > ttl;
}

const INSTAGRAM_TREND_HASHTAGS = ['cosplay', 'cosplaygirl', 'animecosplay'];
const XHS_RECENT_SEARCH_OPTIONS: XhsSearchOptions = {
  sortBy: '最新',
  publishTime: '一周内',
};
const XHS_SEARCH_KEYWORDS = ['cosplay', 'cos妆造', '漫展'];
const ACG_SEARCH_RESULT_LIMIT = 5;
const XHS_DETAIL_MAX_ATTEMPTS = 2;
const XHS_DETAIL_RETRY_BASE_DELAY_MS = 800;

async function getXhsNoteDetailWithRetry(note: XhsNote): Promise<Awaited<ReturnType<typeof getXhsNoteDetail>> | null> {
  for (let attempt = 1; attempt <= XHS_DETAIL_MAX_ATTEMPTS; attempt++) {
    try {
      return await getXhsNoteDetail(note.id, note.xsec_token);
    } catch (err) {
      if (attempt === XHS_DETAIL_MAX_ATTEMPTS) {
        console.warn(`XHS detail fetch failed for ${note.id} after ${XHS_DETAIL_MAX_ATTEMPTS} attempts: ${(err as Error).message}`);
        return null;
      }
      console.warn(`XHS detail transient failure for ${note.id}, retrying (${attempt}/${XHS_DETAIL_MAX_ATTEMPTS}): ${(err as Error).message}`);
      await sleep(XHS_DETAIL_RETRY_BASE_DELAY_MS * attempt);
    }
  }
  return null;
}

function createEmptyInstagramTrends(): InspirationData['instagram_trends'] {
  return {
    hot_styles: [],
    high_engagement_patterns: [],
    trending_hashtags: [],
    updated_at: now().getTime(),
  };
}

function createEmptyAcgHotspots(): InspirationData['acg_hotspots'] {
  return {
    trending_characters: [],
    upcoming_events: [],
    seasonal_themes: [],
    updated_at: now().getTime(),
  };
}

function createEmptyVisualTrends(): InspirationData['visual_trends'] {
  return {
    composition_styles: [],
    color_palettes: [],
    scene_ideas: [],
    updated_at: now().getTime(),
  };
}

function dedupeByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function timestampValue(value: string | null | undefined): number {
  return value ? new Date(value).getTime() : 0;
}

function formatInstagramPost(entry: { hashtag: string; post: InstagramHashtagPost }): string {
  const takenAt = entry.post.taken_at ?? 'unknown';
  return `- [recent][#${entry.hashtag}] ${takenAt} likes:${entry.post.like_count ?? 0} comments:${entry.post.comment_count ?? 0} "${(entry.post.caption_text ?? '').slice(0, 120)}"`;
}

function formatXhsNote(note: XhsNote): string {
  return `- ${note.title} (❤️${note.likes}) by ${note.user || 'unknown'} [${note.tags.join(', ')}]`;
}

function getCurrentSeasonLabel(date: Date = now()): string {
  const month = date.getMonth() + 1;
  if (month >= 3 && month <= 5) return '春季';
  if (month >= 6 && month <= 8) return '夏季';
  if (month >= 9 && month <= 11) return '秋季';
  return '冬季';
}

function formatAcgSearchResult(result: SearchResult): string {
  return `- ${result.title}\n  URL: ${result.url}\n  摘要: ${result.snippet || '无摘要'}`;
}

async function searchAcgLive(query: string): Promise<SearchResult[]> {
  try {
    return await exaWebSearch(query, ACG_SEARCH_RESULT_LIMIT, 'auto');
  } catch (err) {
    console.warn(`ACG live search failed for "${query}": ${(err as Error).message}`);
    return [];
  }
}

/**
 * 2a: Instagram latest hashtag analysis via instagrapi bridge.
 * Requires live recent data; does not fall back to LLM general knowledge.
 * Also downloads "心动" images as saved_references for future photo generation.
 */
async function collectInstagramTrends(): Promise<{
  trends: InspirationData['instagram_trends'];
  newRefs: SavedReference[];
}> {
  const igUser = process.env.INSTAGRAM_USERNAME;
  if (!igUser) {
    console.warn('INSTAGRAM_USERNAME not set, skipping Instagram live trend collection.');
    return { trends: createEmptyInstagramTrends(), newRefs: [] };
  }

  const failures: string[] = [];
  const recentEntries: Array<{ post: InstagramHashtagPost; hashtag: string }> = [];

  for (const tag of INSTAGRAM_TREND_HASHTAGS) {
    try {
      const data = await hashtagRecent(tag, 5);
      for (const post of data.posts ?? []) {
        recentEntries.push({ post, hashtag: tag });
      }
    } catch (err) {
      const message = `#${tag}: ${(err as Error).message}`;
      failures.push(message);
      console.error(`Recent hashtag search failed for ${message}`);
    }
  }

  const dedupedEntries = dedupeByKey(recentEntries, entry => entry.post.pk)
    .sort((a, b) => timestampValue(b.post.taken_at) - timestampValue(a.post.taken_at));

  if (dedupedEntries.length === 0) {
    if (failures.length > 0) {
      console.warn(`Instagram recent trend collection returned no live posts. Failures: ${failures.join(' | ')}`);
    }
    return { trends: createEmptyInstagramTrends(), newRefs: [] };
  }

  const rawData = [
    `抓取时间: ${now().toISOString()}`,
    `数据范围: Instagram hashtag recent（仅分析本次实时抓取到的帖子，不要用通用知识补全）`,
    `标签: ${INSTAGRAM_TREND_HASHTAGS.map(tag => `#${tag}`).join('、')}`,
    ...(failures.length > 0 ? [`部分抓取失败: ${failures.join(' | ')}`] : []),
    ...dedupedEntries.slice(0, 15).map(formatInstagramPost),
  ].join('\n');

  const template = readTemplate('inspiration-summary-prompt.md');
  const prompt = template.replace('{raw_data}', rawData);

  let trends: InspirationData['instagram_trends'];
  try {
    const result = await callLLMJSON<{
      hot_styles: string[];
      high_engagement_patterns: string[];
      trending_hashtags: string[];
    }>(prompt, undefined, 'inspiration-collector');
    trends = { ...result, updated_at: now().getTime() };
  } catch {
    trends = createEmptyInstagramTrends();
  }

  const allPostsWithImages = dedupedEntries.filter(entry => Boolean(entry.post.thumbnail_url));
  const newRefs: SavedReference[] = [];

  if (allPostsWithImages.length > 0) {
    const selectionPrompt = `你是水瀬（Minase），18岁辣妹系coser。从以下最近抓到的Instagram帖子中选出最多5张让你"心动"的图片（符合你的审美：辣妹风、cos、街拍、潮流）。

帖子列表：
${allPostsWithImages.map(({ post }, i) => `${i + 1}. [${(post.caption_text ?? '').slice(0, 50)}] 点赞:${post.like_count} 发布时间:${post.taken_at ?? 'unknown'}`).join('\n')}

返回JSON：{"selected": [序号], "reasons": {"序号": "原因"}}`;

    try {
      const filterResult = await callLLMJSON<{ selected: number[]; reasons: Record<string, string> }>(selectionPrompt, undefined, 'inspiration-collector');
      const selected = filterResult.selected ?? [];

      const refsDir = PATHS.inspirationRefs;

      for (const idx of selected) {
        const entry = allPostsWithImages[idx - 1];
        const thumbnailUrl = entry?.post?.thumbnail_url;
        if (!entry || !thumbnailUrl) continue;

        const { post, hashtag: currentHashtag } = entry;
        const filename = `ig_${post.pk ?? idx}_${now().getTime()}.jpg`;
        const destPath = path.join(refsDir, filename);

        const ok = await downloadImage(thumbnailUrl, destPath);
        if (ok) {
          newRefs.push({
            url: thumbnailUrl,
            local_path: destPath,
            source_hashtag: currentHashtag,
            style_tags: [],
            scene_description: (post.caption_text ?? '').slice(0, 100),
            saved_at: now().getTime(),
          });
        }
      }
    } catch (err) {
      console.error(`Image selection LLM failed: ${(err as Error).message}`);
    }
  }

  return { trends, newRefs };
}

/**
 * 2b: ACG hotspot tracking.
 * Uses live web search snippets instead of asking an offline LLM to guess “current” trends.
 */
export async function collectACGHotspots(): Promise<InspirationData['acg_hotspots']> {
  const currentDate = now();
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth() + 1;
  const season = getCurrentSeasonLabel(currentDate);

  const [characterResults, chinaEventResults, japanEventResults, themeResults] = await Promise.all([
    searchAcgLive(`${year} 最热门 cosplay 动漫 游戏 角色 ${season}`),
    searchAcgLive(`${year} ${month}月 中国 漫展 cosplay 活动`),
    searchAcgLive(`${year} ${month}月 日本 コスプレ イベント anime convention`),
    searchAcgLive(`${year} ${season} 动漫 审美 趋势 cosplay`),
  ]);

  const liveCounts = [characterResults, chinaEventResults, japanEventResults, themeResults]
    .reduce((sum, results) => sum + results.length, 0);

  if (liveCounts === 0) {
    return createEmptyAcgHotspots();
  }

  const prompt = `你是一个 ACG 趋势分析师。以下是通过实时网页搜索拿到的最新结果摘要，抓取时间 ${currentDate.toISOString()}。

你只能根据这些搜索结果提取信息，禁止使用常识、训练记忆或过期知识补全“当前”“近期”内容。
如果某一类证据不足，请直接返回空数组。

【适合 cosplay 的热门角色】
${characterResults.length > 0 ? characterResults.map(formatAcgSearchResult).join('\n') : '无数据'}

【中国近期漫展 / cos 活动】
${chinaEventResults.length > 0 ? chinaEventResults.map(formatAcgSearchResult).join('\n') : '无数据'}

【日本近期漫展 / cos 活动】
${japanEventResults.length > 0 ? japanEventResults.map(formatAcgSearchResult).join('\n') : '无数据'}

【本季度动漫主题 / 审美趋势】
${themeResults.length > 0 ? themeResults.map(formatAcgSearchResult).join('\n') : '无数据'}

请输出 JSON：
\`\`\`json
{
  "trending_characters": ["角色1", "角色2"],
  "upcoming_events": ["活动1", "活动2"],
  "seasonal_themes": ["主题1", "主题2"]
}
\`\`\`

要求：
- trending_characters：仅保留搜索结果中反复出现、且明显适合 cosplay 的角色名，最多 5 个
- upcoming_events：仅保留从当前时间起近期将举办、且能从搜索结果看出地点或活动名的活动，最多 6 个
- seasonal_themes：仅总结搜索结果中出现过的视觉主题、题材或审美关键词，最多 5 个
- 不要输出说明文字，只返回 JSON`; 

  try {
    const result = await callLLMJSON<{
      trending_characters: string[];
      upcoming_events: string[];
      seasonal_themes: string[];
    }>(prompt, undefined, 'inspiration-collector');
    return { ...result, updated_at: now().getTime() };
  } catch {
    return createEmptyAcgHotspots();
  }
}

/**
 * 2c: Cross-platform visual inspiration.
 * Uses live web search snippets instead of asking an offline LLM to guess “current” trends.
 */
async function collectVisualTrends(): Promise<InspirationData['visual_trends']> {
  const currentDate = now();
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth() + 1;
  const season = getCurrentSeasonLabel(currentDate);

  const [compositionResults, paletteResults, sceneResults] = await Promise.all([
    searchAcgLive(`${year} ${month}月 cosplay 写真 构图 趋势 ${season}`),
    searchAcgLive(`${year} ${month}月 日系穿搭 cosplay 摄影 色调 趋势 ${season}`),
    searchAcgLive(`${year} ${month}月 cosplay 日系写真 拍照场景 创意 ${season}`),
  ]);

  const liveCounts = [compositionResults, paletteResults, sceneResults]
    .reduce((sum, results) => sum + results.length, 0);

  if (liveCounts === 0) {
    return createEmptyVisualTrends();
  }

  const prompt = `你是一个视觉趋势分析师。以下是通过实时网页搜索拿到的最新结果摘要，抓取时间 ${currentDate.toISOString()}。

你只能根据这些搜索结果提取信息，禁止使用常识、训练记忆或过期知识补全“当前”“近期”内容。
如果某一类证据不足，请直接返回空数组。

【构图方式趋势】
${compositionResults.length > 0 ? compositionResults.map(formatAcgSearchResult).join('\n') : '无数据'}

【色调 / 调色趋势】
${paletteResults.length > 0 ? paletteResults.map(formatAcgSearchResult).join('\n') : '无数据'}

【拍照场景创意】
${sceneResults.length > 0 ? sceneResults.map(formatAcgSearchResult).join('\n') : '无数据'}

请输出 JSON：
\`\`\`json
{
  "composition_styles": ["构图方式1", "构图方式2"],
  "color_palettes": ["色调1", "色调2"],
  "scene_ideas": ["场景1", "场景2"]
}
\`\`\`

要求：
- composition_styles：仅总结搜索结果中反复出现、可直接指导拍摄的构图方式，最多 5 个
- color_palettes：仅总结搜索结果中出现过的配色、调色、光影关键词，最多 5 个
- scene_ideas：仅保留从搜索结果中能看出的场景创意或取景地点类型，最多 5 个
- 不要输出说明文字，只返回 JSON`;

  try {
    const result = await callLLMJSON<{
      composition_styles: string[];
      color_palettes: string[];
      scene_ideas: string[];
    }>(prompt, undefined, 'inspiration-collector');
    return { ...result, updated_at: now().getTime() };
  } catch {
    return createEmptyVisualTrends();
  }
}

/**
 * 2d: Self-performance review from post history.
 */
function collectSelfPerformance(): InspirationData['self_performance'] {
  const history = readJSON<PostHistory>(PATHS.postHistory, { posts: [] });
  const postsWithStats = history.posts.filter(p => p.stats);

  if (postsWithStats.length === 0) {
    return { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: now().getTime() };
  }

  // Calculate engagement by style
  const styleStats: Record<string, { total: number; count: number }> = {};
  for (const post of postsWithStats) {
    const engagement = (post.stats!.likes + post.stats!.comments * 3) / Math.max(post.stats!.reach, 1);
    if (!styleStats[post.style]) styleStats[post.style] = { total: 0, count: 0 };
    styleStats[post.style].total += engagement;
    styleStats[post.style].count += 1;
  }

  const engagementByStyle: Record<string, number> = {};
  let bestStyle = 'cos';
  let bestRate = 0;
  for (const [style, stats] of Object.entries(styleStats)) {
    const rate = stats.total / stats.count;
    engagementByStyle[style] = Math.round(rate * 1000) / 1000;
    if (rate > bestRate) {
      bestRate = rate;
      bestStyle = style;
    }
  }

  // Best time slots
  const hourStats: Record<number, number> = {};
  for (const post of postsWithStats) {
    const hour = new Date(post.timestamp).getHours();
    const engagement = (post.stats!.likes + post.stats!.comments * 3);
    hourStats[hour] = (hourStats[hour] ?? 0) + engagement;
  }
  const bestTimeSlots = Object.entries(hourStats)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([h]) => `${h}:00`);

  // Best hashtag combos
  const hashtagPerformance: Map<string, number> = new Map();
  for (const post of postsWithStats) {
    const key = [...post.hashtags].sort().join(',');
    const engagement = (post.stats!.likes + post.stats!.comments * 3);
    hashtagPerformance.set(key, (hashtagPerformance.get(key) ?? 0) + engagement);
  }
  const bestHashtagCombos = [...hashtagPerformance.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([combo]) => combo.split(','));

  return {
    best_style: bestStyle,
    best_time_slots: bestTimeSlots,
    best_hashtag_combos: bestHashtagCombos,
    engagement_by_style: engagementByStyle,
    updated_at: now().getTime(),
  };
}

/**
 * 2e: XiaoHongShu feed + search trends via xiaohongshu-skills CLI.
 * Browses recommendation feed and searches cos-specific content.
 * Also extracts visual inspiration descriptions for future photo shoots.
 */
export async function collectXiaohongshuTrends(): Promise<NonNullable<InspirationData['xiaohongshu_trends']>> {
  const empty: NonNullable<InspirationData['xiaohongshu_trends']> = {
    feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [],
    saved_inspirations: [], updated_at: 0,
  };

  const available = await isXhsAvailable();
  if (!available) {
    console.warn('XHS CLI not available, skipping XiaoHongShu trends.');
    return empty;
  }

  let feedNotes: XhsNote[] = [];
  const searchNotes: XhsNote[] = [];
  const searchFailures: string[] = [];

  try {
    feedNotes = await listXhsFeed();
  } catch (err) {
    console.warn(`XHS feed fetch failed: ${(err as Error).message}`);
  }

  for (const keyword of XHS_SEARCH_KEYWORDS) {
    try {
      const results = await searchXhsNotes(keyword, XHS_RECENT_SEARCH_OPTIONS);
      searchNotes.push(...results);
    } catch (err) {
      const message = `${keyword}: ${(err as Error).message}`;
      searchFailures.push(message);
      console.warn(`XHS search failed for ${message}`);
    }
  }

  const dedupedFeedNotes = dedupeByKey(feedNotes, note => note.id).slice(0, 10);
  const dedupedSearchNotes = dedupeByKey(searchNotes, note => note.id).slice(0, 12);
  const allNotes = dedupeByKey([...dedupedFeedNotes, ...dedupedSearchNotes], note => note.id)
    .sort((a, b) => b.likes - a.likes);

  if (allNotes.length === 0) {
    if (searchFailures.length > 0) {
      console.warn(`XHS live trend collection returned no notes. Failures: ${searchFailures.join(' | ')}`);
    }
    return { ...empty, updated_at: now().getTime() };
  }

  const topNotes = allNotes
    .filter(n => n.likes > 500 && n.xsec_token)
    .slice(0, 3);

  const details: string[] = [];
  for (const note of topNotes) {
    const detail = await getXhsNoteDetailWithRetry(note);
    if (!detail) continue;

    const commentSummary = detail.comments.slice(0, 3).map(c => `  - ${c.user}: ${c.content}`).join('\n');
    details.push(`标题: ${detail.title}\n描述: ${detail.description}\n点赞: ${detail.likes}\n评论:\n${commentSummary}`);
  }

  const feedText = [
    `抓取时间: ${now().toISOString()}`,
    '数据范围: 小红书首页推荐流实时抓取（本次刷新）',
    ...(dedupedFeedNotes.length > 0 ? dedupedFeedNotes.map(formatXhsNote) : ['无数据']),
  ].join('\n');
  const searchText = [
    `搜索策略: 关键词=${XHS_SEARCH_KEYWORDS.join(' / ')}；排序=${XHS_RECENT_SEARCH_OPTIONS.sortBy}；时间范围=${XHS_RECENT_SEARCH_OPTIONS.publishTime}`,
    ...(searchFailures.length > 0 ? [`部分搜索失败: ${searchFailures.join(' | ')}`] : []),
    ...(dedupedSearchNotes.length > 0 ? dedupedSearchNotes.map(formatXhsNote) : ['无数据']),
  ].join('\n');
  const detailText = details.join('\n---\n') || '无高互动笔记';

  const template = readTemplate('xhs-inspiration-prompt.md');
  const prompt = template
    .replace('{feed_data}', feedText)
    .replace('{search_data}', searchText)
    .replace('{detail_data}', detailText);

  try {
    const result = await callLLMJSON<{
      feed_highlights: Array<{ title: string; likes: number; topic: string; takeaway?: string }>;
      cosplay_notes: Array<{ title: string; likes: number; topic: string; takeaway?: string }>;
      trending_topics: string[];
      cosplay_insights: string[];
      saved_inspirations: Array<{
        source_note_id: string;
        source_title: string;
        visual_description: string;
        style_tags: string[];
      }>;
    }>(prompt, undefined, 'inspiration-collector');

    const current = readJSON<InspirationData>(PATHS.inspiration, DEFAULT_INSPIRATION);
    const existingInspos = current.xiaohongshu_trends?.saved_inspirations ?? [];
    const newInspos = (result.saved_inspirations ?? []).map(s => ({
      ...s,
      saved_at: now().getTime(),
    }));
    const newIds = new Set(newInspos.map(s => s.source_note_id));
    const filteredExisting = existingInspos.filter(s => !newIds.has(s.source_note_id));
    const merged = [...filteredExisting, ...newInspos].slice(-20);

    return {
      feed_highlights: result.feed_highlights ?? [],
      cosplay_notes: result.cosplay_notes ?? [],
      trending_topics: result.trending_topics ?? [],
      cosplay_insights: result.cosplay_insights ?? [],
      saved_inspirations: merged,
      updated_at: now().getTime(),
    };
  } catch (err) {
    console.error(`XHS LLM summarization failed: ${(err as Error).message}`);
    return { ...empty, updated_at: now().getTime() };
  }
}

/**
 * Collect photography spots for the current city using LLM knowledge.
 * Results cached for 7 days per city key in inspiration-refs/travel-spots.json.
 */
export async function collectTravelInspo(city: string, country: string): Promise<TravelSpot[]> {
  const travelSpotsPath = path.join(PATHS.inspirationRefs, 'travel-spots.json');

  // Load cache
  let cache: Record<string, { spots: TravelSpot[]; fetched_at: string }> = {};
  try {
    cache = JSON.parse(fs.readFileSync(travelSpotsPath, 'utf-8'));
  } catch { /* first run */ }

  const cacheKey = `${city}_${country}`;
  const cached = cache[cacheKey];
  if (cached) {
    const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
    if (ageMs < 7 * 24 * 60 * 60 * 1000) {
      return cached.spots;
    }
  }

  // Use LLM to get local photography knowledge
  const prompt = `你是一个了解${country}各城市的旅行摄影专家。
请列出${city}最适合 Instagram 拍摄的 5 个地点，每个地点给出：名称、一句话描述、最佳拍摄时间。

以 JSON 数组格式返回，每项包含字段：name, description, best_time, style_tags（数组，从 ["travel_portrait","travel_food","travel_street"] 中选）。

\`\`\`json
[{"name":"...","description":"...","best_time":"...","style_tags":["travel_portrait"]}]
\`\`\``;

  let spots: TravelSpot[] = [];
  try {
    const raw = await callLLMJSON<Array<{ name: string; description: string; best_time: string; style_tags: string[] }>>(
      prompt, undefined, 'travel-inspo'
    );
    spots = (raw ?? []).map(r => ({
      name: r.name ?? '',
      description: r.description ?? '',
      best_time: r.best_time ?? '傍晚',
      style_tags: r.style_tags ?? ['travel_portrait'],
      visited: false,
    }));
  } catch { /* LLM call failed — return empty */ }

  // Save cache
  cache[cacheKey] = { spots, fetched_at: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(travelSpotsPath), { recursive: true });
    fs.writeFileSync(travelSpotsPath, JSON.stringify(cache, null, 2));
  } catch { /* non-critical */ }

  return spots;
}

/**
 * Main entry: refresh expired inspiration sections.
 */
export async function refreshInspiration(forceAll = false): Promise<InspirationData> {
  const current = readJSON<InspirationData>(PATHS.inspiration, DEFAULT_INSPIRATION);
  let updated = { ...current };
  const refreshTasks: Array<Promise<Partial<InspirationData>>> = [];

  if (forceAll || isExpired(current.instagram_trends.updated_at, TTL.instagram_trends)) {
    console.log('Refreshing Instagram trends...');
    refreshTasks.push((async () => {
      const { trends, newRefs } = await collectInstagramTrends();
      const patch: Partial<InspirationData> = { instagram_trends: trends };

      if (newRefs.length > 0) {
        const existing = current.saved_references ?? [];
        const cleaned = cleanupExpiredRefs(existing);
        const merged = [...cleaned, ...newRefs].slice(-MAX_SAVED_REFS);
        patch.saved_references = merged;

        const impulseBoost = 10 + Math.random() * 5;
        let impulse: PostImpulseState = readJSON(PATHS.postImpulse, DEFAULT_POST_IMPULSE);
        impulse = accumulateImpulse(impulse, impulseBoost);
        writeJSON(PATHS.postImpulse, impulse);
        console.log(`Inspiration saved ${newRefs.length} refs, impulse +${impulseBoost.toFixed(1)}`);
      }

      return patch;
    })());
  }

  if (forceAll || isExpired(current.acg_hotspots.updated_at, TTL.acg_hotspots)) {
    console.log('Refreshing ACG hotspots...');
    refreshTasks.push((async () => ({ acg_hotspots: await collectACGHotspots() }))());
  }

  if (forceAll || isExpired(current.visual_trends.updated_at, TTL.visual_trends)) {
    console.log('Refreshing visual trends...');
    refreshTasks.push((async () => ({ visual_trends: await collectVisualTrends() }))());
  }

  if (forceAll || isExpired(current.self_performance.updated_at, TTL.self_performance)) {
    console.log('Refreshing self performance...');
    refreshTasks.push(Promise.resolve({ self_performance: collectSelfPerformance() }));
  }

  if (forceAll || isExpired(current.xiaohongshu_trends?.updated_at ?? 0, TTL.xiaohongshu_trends)) {
    console.log('Refreshing XiaoHongShu trends...');
    refreshTasks.push((async () => ({ xiaohongshu_trends: await collectXiaohongshuTrends() }))());
  }

  const settled = await Promise.allSettled(refreshTasks);
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      updated = { ...updated, ...result.value };
    }
  }

  // Collect travel spots for current city
  const travelStateData = readJSON<TravelState>(PATHS.travelState, DEFAULT_TRAVEL_STATE);
  if (travelStateData.current_city) {
    await collectTravelInspo(travelStateData.current_city, travelStateData.country).catch(() => {});
  }

  writeJSON(PATHS.inspiration, updated);
  return updated;
}

// CLI entry
if (require.main === module) {
  const force = process.argv.includes('--force');
  refreshInspiration(force)
    .then(() => console.log('Inspiration refreshed.'))
    .catch(err => {
      console.error('Failed to refresh inspiration:', err.message);
      process.exit(1);
    });
}
