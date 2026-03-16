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
import { callInstagramBridge } from './instagram-bridge-client';
import { accumulateImpulse } from './post-impulse';
import { isXhsAvailable, listXhsFeed, searchXhsNotes, getXhsNoteDetail } from './xhs-bridge-client';
import { now } from './time-utils';

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
  visual_trends: 72 * 60 * 60 * 1000,           // 72h
  self_performance: 168 * 60 * 60 * 1000,        // 7 days
  xiaohongshu_trends: 6 * 60 * 60 * 1000,        // 6h — enables 2-4 refreshes/day
} as const;

function isExpired(updatedAt: number, ttl: number): boolean {
  return now().getTime() - updatedAt > ttl;
}

/**
 * 2a: Instagram hot post analysis via instagrapi bridge.
 * Falls back to LLM general knowledge if bridge unavailable.
 * Also downloads "心动" images as saved_references for future photo generation.
 */
async function collectInstagramTrends(): Promise<{
  trends: InspirationData['instagram_trends'];
  newRefs: SavedReference[];
}> {
  const igUser = process.env.INSTAGRAM_USERNAME;

  let rawData = '';
  // Collect all posts-with-images across hashtags for later image selection
  const allPostsWithImages: Array<{ post: any; hashtag: string }> = [];

  if (igUser) {
    const hashtags = ['cosplay', 'cosplaygirl', 'animecosplay', 'コスプレ', '辣妹', 'jfashion'];
    const results: string[] = [];

    for (const tag of hashtags.slice(0, 3)) { // Limit API calls
      try {
        const data = await callInstagramBridge('hashtag_top', {
          name: tag,
          amount: '5',
        }) as { hashtag: string; posts: Array<{ pk?: string; like_count: number; comment_count: number; caption_text: string; thumbnail_url?: string }>; error?: string };

        if (data.error) {
          console.error(`Hashtag search failed for #${tag}: ${data.error}`);
          continue;
        }

        for (const post of data.posts ?? []) {
          results.push(`[${tag}] likes:${post.like_count ?? 0} comments:${post.comment_count ?? 0} "${(post.caption_text ?? '').slice(0, 100)}"`);
          if (post.thumbnail_url) {
            allPostsWithImages.push({ post, hashtag: tag });
          }
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

  let trends: InspirationData['instagram_trends'];
  try {
    const result = await callLLMJSON<{
      hot_styles: string[];
      high_engagement_patterns: string[];
      trending_hashtags: string[];
    }>(prompt, undefined, 'inspiration-collector');
    trends = { ...result, updated_at: now().getTime() };
  } catch {
    trends = { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: now().getTime() };
  }

  // Image selection: ask LLM to pick "心动" images (max 5 per refresh)
  const newRefs: SavedReference[] = [];

  if (allPostsWithImages.length > 0) {
    const selectionPrompt = `你是水瀬（Minase），18岁辣妹系coser。从以下Instagram热门帖子中选出最多5张让你"心动"的图片（符合你的审美：辣妹风、cos、街拍、潮流）。

帖子列表：
${allPostsWithImages.map(({ post }, i) => `${i + 1}. [${(post.caption_text ?? '').slice(0, 50)}] 点赞:${post.like_count}`).join('\n')}

返回JSON：{"selected": [序号], "reasons": {"序号": "原因"}}`;

    try {
      const filterResult = await callLLMJSON<{ selected: number[]; reasons: Record<string, string> }>(selectionPrompt, undefined, 'inspiration-collector');
      const selected = filterResult.selected ?? [];

      const refsDir = PATHS.inspirationRefs;

      for (const idx of selected) {
        const entry = allPostsWithImages[idx - 1];
        if (!entry?.post?.thumbnail_url) continue;

        const { post, hashtag: currentHashtag } = entry;
        const filename = `ig_${post.pk ?? idx}_${now().getTime()}.jpg`;
        const destPath = path.join(refsDir, filename);

        const ok = await downloadImage(post.thumbnail_url, destPath);
        if (ok) {
          newRefs.push({
            url: post.thumbnail_url,
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
    }>(prompt, undefined, 'inspiration-collector');
    return { ...result, updated_at: now().getTime() };
  } catch {
    return { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: now().getTime() };
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
    }>(prompt, undefined, 'inspiration-collector');
    return { ...result, updated_at: now().getTime() };
  } catch {
    return { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: now().getTime() };
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
    }>(prompt, undefined, 'inspiration-collector');

    // Merge saved_inspirations with existing (persists across refreshes)
    const current = readJSON<InspirationData>(PATHS.inspiration, DEFAULT_INSPIRATION);
    const existingInspos = current.xiaohongshu_trends?.saved_inspirations ?? [];
    const newInspos = (result.saved_inspirations ?? []).map(s => ({
      ...s,
      saved_at: now().getTime(),
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
      prompt, 512, 'travel-inspo'
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

  if (forceAll || isExpired(current.instagram_trends.updated_at, TTL.instagram_trends)) {
    console.log('Refreshing Instagram trends...');
    const { trends, newRefs } = await collectInstagramTrends();
    updated = { ...updated, instagram_trends: trends };
    if (newRefs.length > 0) {
      const existing = updated.saved_references ?? [];
      const cleaned = cleanupExpiredRefs(existing);
      const merged = [...cleaned, ...newRefs].slice(-MAX_SAVED_REFS);
      updated = { ...updated, saved_references: merged };
      const impulseBoost = 10 + Math.random() * 5;
      let impulse: PostImpulseState = readJSON(PATHS.postImpulse, DEFAULT_POST_IMPULSE);
      impulse = accumulateImpulse(impulse, impulseBoost);
      writeJSON(PATHS.postImpulse, impulse);
      console.log(`Inspiration saved ${newRefs.length} refs, impulse +${impulseBoost.toFixed(1)}`);
    }
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
