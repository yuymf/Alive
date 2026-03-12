#!/usr/bin/env node
/**
 * inspiration-collector.ts
 * "刷手机" — Gathers inspiration from 4 sources.
 * Minase's perspective: she's browsing Instagram, watching anime news, scrolling Pinterest.
 */

import { InspirationData, PostHistory } from './types';
import { PATHS, readJSON, writeJSON, readTemplate } from './file-utils';
import { callLLMJSON } from './llm-client';
import { callInstagramBridge } from './instagram-bridge-client';
import { isXhsMcpAvailable, listXhsFeed, searchXhsNotes, getXhsNoteDetail } from './xhs-mcp-client';

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
  visual_trends: 72 * 60 * 60 * 1000,           // 72h
  self_performance: 168 * 60 * 60 * 1000,        // 7 days
  xiaohongshu_trends: 6 * 60 * 60 * 1000,        // 6h — enables 2-4 refreshes/day
} as const;

function isExpired(updatedAt: number, ttl: number): boolean {
  return Date.now() - updatedAt > ttl;
}

/**
 * 2a: Instagram hot post analysis via instagrapi bridge.
 * Falls back to LLM general knowledge if bridge unavailable.
 */
async function collectInstagramTrends(): Promise<InspirationData['instagram_trends']> {
  const igUser = process.env.INSTAGRAM_USERNAME;

  let rawData = '';

  if (igUser) {
    const hashtags = ['cosplay', 'cosplaygirl', 'animecosplay', 'コスプレ', '辣妹', 'jfashion'];
    const results: string[] = [];

    for (const tag of hashtags.slice(0, 3)) { // Limit API calls
      try {
        const data = await callInstagramBridge('hashtag_top', {
          name: tag,
          amount: '5',
        }) as { hashtag: string; posts: Array<{ like_count: number; comment_count: number; caption_text: string }>; error?: string };

        if (data.error) {
          console.error(`Hashtag search failed for #${tag}: ${data.error}`);
          continue;
        }

        for (const post of data.posts ?? []) {
          results.push(`[${tag}] likes:${post.like_count ?? 0} comments:${post.comment_count ?? 0} "${(post.caption_text ?? '').slice(0, 100)}"`);
        }
      } catch (err) {
        console.error(`Hashtag search failed for #${tag}: ${(err as Error).message}`);
      }
    }

    rawData = results.length > 0
      ? results.join('\n')
      : 'Instagram API 没有返回有效数据，以下是通用cosplay趋势信息。';
  }

  // Fallback / supplement: ask LLM to summarize based on general knowledge
  if (!rawData || rawData.includes('没有返回有效数据')) {
    rawData += '\n请基于你对cosplay和Instagram的知识，总结当前热门趋势。';
  }

  const template = readTemplate('inspiration-summary-prompt.md');
  const prompt = template.replace('{raw_data}', rawData);

  try {
    const result = await callLLMJSON<{
      hot_styles: string[];
      high_engagement_patterns: string[];
      trending_hashtags: string[];
    }>(prompt, 512);

    return { ...result, updated_at: Date.now() };
  } catch {
    return { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: Date.now() };
  }
}

/**
 * 2b: ACG hotspot tracking.
 * Extends fetch-trends.ts pattern — uses LLM general knowledge.
 */
async function collectACGHotspots(): Promise<InspirationData['acg_hotspots']> {
  const prompt = `你是一个ACG趋势分析师。请列出：
1. 当前最热门的适合cosplay的动漫/游戏角色 Top 5
2. 近期即将举办的漫展或cos活动（中国和日本）
3. 本季度的热门动漫主题/审美趋势

以 JSON 格式返回：
\`\`\`json
{
  "trending_characters": ["角色1", "角色2", ...],
  "upcoming_events": ["事件1", "事件2", ...],
  "seasonal_themes": ["主题1", "主题2", ...]
}
\`\`\`
只返回 JSON。`;

  try {
    const result = await callLLMJSON<{
      trending_characters: string[];
      upcoming_events: string[];
      seasonal_themes: string[];
    }>(prompt, 512);

    return { ...result, updated_at: Date.now() };
  } catch {
    return { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: Date.now() };
  }
}

/**
 * 2c: Cross-platform visual inspiration.
 */
async function collectVisualTrends(): Promise<InspirationData['visual_trends']> {
  const prompt = `你是一个视觉趋势分析师，专注于cosplay和日系穿搭。请分析当前流行的：
1. 构图方式（如：镜面反射、低角度仰拍、对称构图...）
2. 色调趋势（如：莫兰迪色系、赛博霓虹、胶片复古...）
3. 拍照场景创意（如：便利店门口、天台夕阳、废弃工厂...）

以 JSON 格式返回：
\`\`\`json
{
  "composition_styles": ["构图方式1", ...],
  "color_palettes": ["色调1", ...],
  "scene_ideas": ["场景1", ...]
}
\`\`\`
只返回 JSON。`;

  try {
    const result = await callLLMJSON<{
      composition_styles: string[];
      color_palettes: string[];
      scene_ideas: string[];
    }>(prompt, 512);

    return { ...result, updated_at: Date.now() };
  } catch {
    return { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: Date.now() };
  }
}

/**
 * 2d: Self-performance review from post history.
 */
function collectSelfPerformance(): InspirationData['self_performance'] {
  const history = readJSON<PostHistory>(PATHS.postHistory, { posts: [] });
  const postsWithStats = history.posts.filter(p => p.stats);

  if (postsWithStats.length === 0) {
    return { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: Date.now() };
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
    updated_at: Date.now(),
  };
}

/**
 * 2e: XiaoHongShu feed + search trends via xiaohongshu-mcp.
 * Browses recommendation feed and searches cos-specific content.
 * Also extracts visual inspiration descriptions for future photo shoots.
 */
export async function collectXiaohongshuTrends(): Promise<NonNullable<InspirationData['xiaohongshu_trends']>> {
  const empty: NonNullable<InspirationData['xiaohongshu_trends']> = {
    feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [],
    saved_inspirations: [], updated_at: 0,
  };

  const available = await isXhsMcpAvailable();
  if (!available) {
    console.warn('XHS MCP server not available, skipping XiaoHongShu trends.');
    return empty;
  }

  // Collect feed and search results
  let feedNotes: Awaited<ReturnType<typeof listXhsFeed>> = [];
  let searchNotes: Awaited<ReturnType<typeof searchXhsNotes>> = [];

  try {
    feedNotes = await listXhsFeed();
  } catch (err) {
    console.warn(`XHS feed fetch failed: ${(err as Error).message}`);
  }

  try {
    searchNotes = await searchXhsNotes('cosplay');
  } catch (err) {
    console.warn(`XHS search failed: ${(err as Error).message}`);
  }

  // Fetch details for top 3 high-engagement notes
  const allNotes = [...feedNotes, ...searchNotes]
    .filter((note, idx, arr) => arr.findIndex(n => n.id === note.id) === idx)
    .sort((a, b) => b.likes - a.likes);
  const topNotes = allNotes.filter(n => n.likes > 500).slice(0, 3);

  const details: string[] = [];
  for (const note of topNotes) {
    try {
      const detail = await getXhsNoteDetail(note.id, note.xsec_token);
      const commentSummary = detail.comments.slice(0, 3).map(c => `  - ${c.user}: ${c.content}`).join('\n');
      details.push(`标题: ${detail.title}\n描述: ${detail.description}\n点赞: ${detail.likes}\n评论:\n${commentSummary}`);
    } catch (err) {
      console.warn(`XHS detail fetch failed for ${note.id}: ${(err as Error).message}`);
    }
  }

  // Format raw data for LLM
  const feedText = feedNotes.slice(0, 10).map(n => `- ${n.title} (❤️${n.likes}) [${n.tags.join(', ')}]`).join('\n') || '无数据';
  const searchText = searchNotes.slice(0, 10).map(n => `- ${n.title} (❤️${n.likes}) [${n.tags.join(', ')}]`).join('\n') || '无数据';
  const detailText = details.join('\n---\n') || '无高互动笔记';

  const template = readTemplate('xhs-inspiration-prompt.md');
  const prompt = template
    .replace('{feed_data}', feedText)
    .replace('{search_data}', searchText)
    .replace('{detail_data}', detailText);

  try {
    const result = await callLLMJSON<{
      feed_highlights: Array<{ title: string; likes: number; topic: string }>;
      cosplay_notes: Array<{ title: string; likes: number; topic: string }>;
      trending_topics: string[];
      cosplay_insights: string[];
      saved_inspirations: Array<{
        source_note_id: string;
        source_title: string;
        visual_description: string;
        style_tags: string[];
      }>;
    }>(prompt, 1024);

    // Merge saved_inspirations with existing (persists across refreshes)
    const current = readJSON<InspirationData>(PATHS.inspiration, DEFAULT_INSPIRATION);
    const existingInspos = current.xiaohongshu_trends?.saved_inspirations ?? [];
    const newInspos = (result.saved_inspirations ?? []).map(s => ({
      ...s,
      saved_at: Date.now(),
    }));
    // Prefer new entries over old when source_note_id collides
    const newIds = new Set(newInspos.map(s => s.source_note_id));
    const filteredExisting = existingInspos.filter(s => !newIds.has(s.source_note_id));
    const merged = [...filteredExisting, ...newInspos].slice(-20);

    return {
      feed_highlights: result.feed_highlights ?? [],
      cosplay_notes: result.cosplay_notes ?? [],
      trending_topics: result.trending_topics ?? [],
      cosplay_insights: result.cosplay_insights ?? [],
      saved_inspirations: merged,
      updated_at: Date.now(),
    };
  } catch (err) {
    console.error(`XHS LLM summarization failed: ${(err as Error).message}`);
    return { ...empty, updated_at: Date.now() };
  }
}

/**
 * Main entry: refresh expired inspiration sections.
 */
export async function refreshInspiration(forceAll = false): Promise<InspirationData> {
  const current = readJSON<InspirationData>(PATHS.inspiration, DEFAULT_INSPIRATION);
  let updated = { ...current };

  if (forceAll || isExpired(current.instagram_trends.updated_at, TTL.instagram_trends)) {
    console.log('Refreshing Instagram trends...');
    updated = { ...updated, instagram_trends: await collectInstagramTrends() };
  }

  if (forceAll || isExpired(current.acg_hotspots.updated_at, TTL.acg_hotspots)) {
    console.log('Refreshing ACG hotspots...');
    updated = { ...updated, acg_hotspots: await collectACGHotspots() };
  }

  if (forceAll || isExpired(current.visual_trends.updated_at, TTL.visual_trends)) {
    console.log('Refreshing visual trends...');
    updated = { ...updated, visual_trends: await collectVisualTrends() };
  }

  if (forceAll || isExpired(current.self_performance.updated_at, TTL.self_performance)) {
    console.log('Refreshing self performance...');
    updated = { ...updated, self_performance: collectSelfPerformance() };
  }

  if (forceAll || isExpired(current.xiaohongshu_trends?.updated_at ?? 0, TTL.xiaohongshu_trends)) {
    console.log('Refreshing XiaoHongShu trends...');
    updated = { ...updated, xiaohongshu_trends: await collectXiaohongshuTrends() };
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
