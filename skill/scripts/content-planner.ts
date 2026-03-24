#!/usr/bin/env node
/**
 * content-planner.ts
 * Minase's content decision engine.
 * She decides what to photograph and what to share, based on mood and inspiration.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ContentStyle, PhotoIntent, PostIntent, PostHistory, PostRecord, ShotDescription,
  InspirationData, EmotionState, ScheduleToday,
  DEFAULT_MOMENTUM, DEFAULT_UNDERTONE,
  TravelState, TravelSpot, DEFAULT_TRAVEL_STATE,
} from './types';
import { PATHS, readJSON, readTemplate, appendText, writeJSON } from './file-utils';
import { consultAdvisor } from './advisor-client';
import { callInstagramBridge } from './instagram-bridge-client';
import { callLLMJSON } from './llm-client';
import { getLocalDate, getLocalHour, getLocalWeekday, formatLocalTime } from './time-utils';

const DEFAULT_POST_HISTORY: PostHistory = { posts: [] };
const DEFAULT_INSPIRATION: InspirationData = {
  instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: 0 },
  acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: 0 },
  visual_trends: { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: 0 },
  self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: 0 },
  xiaohongshu_trends: { feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [], saved_inspirations: [], updated_at: 0 },
};

/**
 * List inspiration reference images in the inspiration-refs directory.
 */
function formatInspirationRefs(): string {
  const dir = PATHS.inspirationRefs;
  if (!fs.existsSync(dir)) return '没有灵感参考图';
  const files = fs.readdirSync(dir).filter(f =>
    f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.webp'),
  );
  if (files.length === 0) return '没有灵感参考图';
  return files.map(f => `- ${f}`).join('\n');
}
const DEFAULT_EMOTION: EmotionState = {
  mood: { valence: 0.3, arousal: 0.5, description: '普通' },
  energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
  last_updated: null, recent_cause: '',
  momentum: { ...DEFAULT_MOMENTUM },
  undertone: { ...DEFAULT_UNDERTONE },
  impulse_history: [],
  consecutive_high_stress: 0,
  threshold_break_cooldown: 0,
};

// Phase ratios from instagram.md (authority source)
// travel sub-styles share the same bucket as 'travel' for ratio accounting
// Uses Partial<Record<ContentStyle, number>> so travel sub-styles don't need explicit 0 entries
const PHASE_RATIOS: Record<number, Partial<Record<ContentStyle, number>>> = {
  1: { cos: 0.4, daily: 0.1, behind_scenes: 0.1, travel: 0.4 },
  2: { cos: 0.3, daily: 0.1, behind_scenes: 0.1, travel: 0.5 },
  3: { cos: 0.25, daily: 0.1, behind_scenes: 0.15, travel: 0.5 },
};

const MAX_POSTS_PER_DAY = 3;

/**
 * Read follower count from socialMeta cache.
 * If missing or zero, attempt a live sync from Instagram (non-blocking, non-fatal).
 * Returns the follower count (may still be 0 if sync fails).
 */
async function syncFollowerCount(): Promise<number> {
  const meta = readJSON<{ follower_count?: number; follower_synced_at?: string }>(PATHS.socialMeta, {});
  if (meta.follower_count && meta.follower_count > 0) {
    return meta.follower_count;
  }

  // Cache is missing or zero — try a live sync
  try {
    const igUser = process.env.INSTAGRAM_USERNAME;
    if (!igUser) {
      console.warn('[content-planner] No INSTAGRAM_USERNAME set, cannot sync follower count');
      return 0;
    }
    console.log('[content-planner] follower_count missing from cache, syncing from Instagram...');
    const userInfo = await callInstagramBridge('get_user_info', {}) as {
      follower_count?: number;
      following_count?: number;
      media_count?: number;
    };
    if (userInfo.follower_count !== undefined) {
      const currentMeta = readJSON<Record<string, unknown>>(PATHS.socialMeta, {});
      writeJSON(PATHS.socialMeta, {
        ...currentMeta,
        follower_count: userInfo.follower_count,
        following_count: userInfo.following_count,
        media_count: userInfo.media_count,
        follower_synced_at: new Date().toISOString(),
      });
      console.log(`[content-planner] Follower sync success: ${userInfo.follower_count} followers`);
      return userInfo.follower_count;
    }
  } catch (err) {
    console.warn(`[content-planner] Live follower sync failed (non-fatal): ${(err as Error).message}`);
  }
  return 0;
}

/**
 * Determine current phase based on follower count.
 * Reads the real follower count from socialMeta.
 */
function getCurrentPhase(): number {
  const meta = readJSON<{ follower_count?: number }>(PATHS.socialMeta, {});
  const followers = meta.follower_count ?? 0;
  if (followers >= 5000) return 3;
  if (followers >= 500) return 2;
  return 1;
}

/**
 * Rule-based filter: should we even consider posting?
 * Caps at MAX_POSTS_PER_DAY posts per calendar day.
 */
export function shouldConsiderPosting(history: PostHistory): { allowed: boolean; reason: string } {
  const today = getLocalDate();
  const [y, m, d] = today.split('-').map(Number);
  const todayStart = new Date(y, m - 1, d).getTime();   // Local midnight
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;
  const postsToday = history.posts.filter(p => p.timestamp >= todayStart && p.timestamp < todayEnd).length;
  if (postsToday >= MAX_POSTS_PER_DAY) {
    return { allowed: false, reason: `今天已经发了${postsToday}条，达到每日上限${MAX_POSTS_PER_DAY}条` };
  }
  return { allowed: true, reason: `今天已发${postsToday}条，还可以发${MAX_POSTS_PER_DAY - postsToday}条` };
}

/**
 * Get recent style distribution for ratio-aware planning.
 */
function getRecentStyleDistribution(history: PostHistory, n = 10): string {
  const recent = history.posts.slice(-n);
  if (recent.length === 0) return '还没发过帖子';

  const counts: Record<string, number> = {};
  for (const post of recent) {
    counts[post.style] = (counts[post.style] ?? 0) + 1;
  }

  const phase = getCurrentPhase();
  const target = PHASE_RATIOS[phase] ?? PHASE_RATIOS[1];

  const lines: string[] = [];
  for (const [style, targetRatio] of Object.entries(target)) {
    const actual = (counts[style] ?? 0) / recent.length;
    const status = actual > targetRatio + 0.15 ? '偏多' : actual < targetRatio - 0.15 ? '偏少' : '正常';
    lines.push(`${style}: ${Math.round(actual * 100)}% (目标${Math.round(targetRatio * 100)}%) ${status}`);
  }

  return lines.join('\n');
}

/**
 * Format recent post performance data for LLM context.
 */
function formatRecentPerformance(history: PostHistory): string {
  const withStats = history.posts.filter(p => p.stats).slice(-5);
  if (withStats.length === 0) return '暂无历史表现数据';

  return withStats.map(p => {
    const engagement = p.stats!.likes + p.stats!.comments * 3;
    return `${p.style} (${new Date(p.timestamp).toLocaleDateString('zh-CN')}): ${p.stats!.likes}赞 ${p.stats!.comments}评 互动率≈${(engagement / Math.max(p.stats!.reach, 1) * 100).toFixed(1)}%`;
  }).join('\n');
}

/**
 * Refine travel style to a sub-style based on scene description.
 */
function refineStyle(style: ContentStyle, sceneDescription: string): ContentStyle {
  if (style !== 'travel') return style;
  const desc = sceneDescription.toLowerCase();
  if (desc.includes('餐厅') || desc.includes('咖啡') || desc.includes('探店') || desc.includes('food')) {
    return 'travel_food';
  }
  if (desc.includes('街') || desc.includes('street') || desc.includes('市场') || desc.includes('alley')) {
    return 'travel_street';
  }
  return 'travel_portrait'; // default travel sub-style
}

function normalizeOutfitLabel(outfit?: string): string | undefined {
  const normalized = (outfit ?? '').trim().replace(/\s+/g, ' ');
  return normalized || undefined;
}

/**
 * 同一批次（同场景）默认保持一套服装；只有显式 outfitChange=true 才允许换装。
 */
export function normalizeBatchOutfits(shots: ShotDescription[]): ShotDescription[] {
  if (shots.length === 0) return shots;

  let anchorOutfit = normalizeOutfitLabel(shots[0]?.outfit)
    ?? normalizeOutfitLabel(shots.find(s => normalizeOutfitLabel(s.outfit))?.outfit)
    ?? '同一套服装';

  return shots.map((shot, idx) => {
    const explicitChange = shot.outfitChange === true;
    const shotOutfit = normalizeOutfitLabel(shot.outfit);

    if (idx === 0) {
      anchorOutfit = shotOutfit ?? anchorOutfit;
      return {
        ...shot,
        outfit: anchorOutfit,
        outfitChange: false,
      };
    }

    if (explicitChange) {
      const changedOutfit = shotOutfit ?? anchorOutfit;
      return {
        ...shot,
        outfit: changedOutfit,
        outfitChange: true,
      };
    }

    return {
      ...shot,
      outfit: anchorOutfit,
      outfitChange: false,
    };
  });
}

/**
 * Plan a photo: ask Minase if she wants to take a picture.
 */
export async function planPhoto(): Promise<PhotoIntent> {
  const emotion = readJSON<EmotionState>(PATHS.emotionState, DEFAULT_EMOTION);
  const inspiration = readJSON<InspirationData>(PATHS.inspiration, DEFAULT_INSPIRATION);
  const history = readJSON<PostHistory>(PATHS.postHistory, DEFAULT_POST_HISTORY);

  const xhsTrends = inspiration.xiaohongshu_trends?.trending_topics?.join('、') || '没有最新数据';
  const xhsCosInsights = inspiration.xiaohongshu_trends?.cosplay_insights?.join('、') || '没有最新数据';
  const savedInspo = inspiration.xiaohongshu_trends?.saved_inspirations?.slice(-5) ?? [];
  const inspoText = savedInspo.length > 0
    ? savedInspo.map(s => `- ${s.visual_description} (${s.style_tags.join(', ')})`).join('\n')
    : '没有收藏的灵感图';

  const template = readTemplate('photo-intent-prompt.md');
  // Load travel spots for current city
  const travelStatePlan = readJSON<TravelState>(PATHS.travelState, DEFAULT_TRAVEL_STATE);
  let travelSpotsStr = '';
  try {
    const spotsCache = JSON.parse(
      fs.readFileSync(path.join(PATHS.inspirationRefs, 'travel-spots.json'), 'utf-8')
    ) as Record<string, { spots: TravelSpot[] }>;
    const cityKey = `${travelStatePlan.current_city}_${travelStatePlan.country}`;
    const citySpots: TravelSpot[] = spotsCache[cityKey]?.spots ?? [];
    const visitedSet = new Set(travelStatePlan.visited_spots);
    travelSpotsStr = citySpots
      .map(s => `- ${s.name}${visitedSet.has(s.name) ? '（已去）' : '（推荐）'}：${s.description}`)
      .join('\n') || '（暂无攻略数据）';
  } catch {
    travelSpotsStr = '（暂无攻略数据）';
  }
  const prompt = template
    .replace('{current_time}', formatLocalTime())
    .replace('{mood}', `${emotion.mood.description} (energy: ${emotion.energy.toFixed(1)}, creativity: ${emotion.creativity.toFixed(1)})`)
    .replace('{activity}', getActivityFromSchedule())
    .replace('{instagram_trends}', inspiration.instagram_trends.hot_styles.join('、') || '没有最新数据')
    .replace('{trending_characters}', inspiration.acg_hotspots.trending_characters.join('、') || '没有最新数据')
    .replace('{visual_trends}', [
      ...inspiration.visual_trends.scene_ideas.slice(0, 3),
      ...inspiration.visual_trends.composition_styles.slice(0, 2),
    ].join('、') || '没有最新数据')
    .replace('{best_style}', inspiration.self_performance.best_style)
    .replace('{recent_performance}', formatRecentPerformance(history))
    .replace('{recent_styles}', getRecentStyleDistribution(history))
    .replace('{target_ratios}', formatTargetRatios())
    .replace('{xhs_trends}', xhsTrends)
    .replace('{xhs_cosplay_insights}', xhsCosInsights)
    .replace('{saved_inspirations}', inspoText)
    .replace('{inspiration_refs}', formatInspirationRefs())
    .replace('{travel_spots}', travelSpotsStr);

  const parsed = await callLLMJSON<PhotoIntent>(prompt, undefined, 'content-planner');

  const style = parsed.style ?? 'daily';
  const refinedShots = (parsed.shots ?? (parsed.wantToShoot ? [{
    description: parsed.sceneDescription,
    angle: '正面',
    variation: '主图',
    outfit: '同一套服装',
    outfitChange: false,
  }] : [])).map(shot => ({
    ...shot,
    style: refineStyle(shot.style ?? style, shot.description ?? ''),
    outfit: normalizeOutfitLabel(shot.outfit),
    outfitChange: shot.outfitChange === true,
  }));

  const normalizedShots = normalizeBatchOutfits(refinedShots);

  const intent: PhotoIntent = {
    ...parsed,
    imageCount: Math.max(1, parsed.imageCount ?? normalizedShots.length),
    shots: normalizedShots,
  };

  return intent;
}

export function filterAlreadyPostedPhotos(photoList: string[], postHistory: PostHistory): string[] {
  const postedPathSet = new Set(
    (postHistory.posts ?? [])
      .flatMap((p: PostRecord) => {
        const paths = p.image_local_paths ?? ((p as any).image_local_path ? [(p as any).image_local_path] : []);
        return paths.map((imgPath: string) => path.resolve(imgPath));
      })
  );
  return photoList.filter(photoPath => !postedPathSet.has(path.resolve(photoPath)));
}

export function resolvePostSelection(
  availablePhotos: string[],
  parsed: Partial<PostIntent> & { selectedPhoto?: string; coverPhoto?: string },
): { selectedPhotos: string[]; coverPhoto?: string } {
  const normalizeCandidate = (candidate?: string): string | null => {
    const normalized = (candidate ?? '').trim();
    if (!normalized) return null;

    const byBasename = availablePhotos.find(p => path.basename(p) === normalized);
    if (byBasename) return byBasename;

    const absolute = path.resolve(normalized);
    const byAbsolute = availablePhotos.find(p => path.resolve(p) === absolute);
    return byAbsolute ?? null;
  };

  const selectedCandidates = (parsed.selectedPhotos ?? (parsed.selectedPhoto ? [parsed.selectedPhoto] : []))
    .map(candidate => normalizeCandidate(candidate))
    .filter((candidate): candidate is string => Boolean(candidate));

  const selectedPhotos: string[] = [];
  const seen = new Set<string>();
  for (const selected of selectedCandidates) {
    const key = path.resolve(selected);
    if (seen.has(key)) continue;
    seen.add(key);
    selectedPhotos.push(selected);
  }

  let coverPhoto = normalizeCandidate(parsed.coverPhoto);
  if (!coverPhoto && selectedPhotos.length > 0) {
    coverPhoto = selectedPhotos[0];
  }

  if (coverPhoto) {
    const coverKey = path.resolve(coverPhoto);
    const rest = selectedPhotos.filter(p => path.resolve(p) !== coverKey);
    if (!seen.has(coverKey)) {
      selectedPhotos.unshift(coverPhoto);
      seen.add(coverKey);
    }
    if (selectedPhotos[0] !== coverPhoto) {
      selectedPhotos.splice(0, selectedPhotos.length, coverPhoto, ...rest);
    }
  }

  return {
    selectedPhotos,
    coverPhoto: coverPhoto ?? selectedPhotos[0],
  };
}

/**
 * Plan a post: ask Minase if she wants to share a photo on Instagram.
 */
export async function planPost(options?: { skipAdvisor?: boolean }): Promise<PostIntent> {
  const emotion = readJSON<EmotionState>(PATHS.emotionState, DEFAULT_EMOTION);
  const inspiration = readJSON<InspirationData>(PATHS.inspiration, DEFAULT_INSPIRATION);

  // List photos in photo-roll
  const photoList = listPhotoRoll();
  if (photoList.length === 0) {
    return {
      wantToPost: false,
      selectedPhotos: [],
      coverPhoto: undefined,
      caption: '',
      hashtags: [],
      reason: '相册里没有照片可以发',
    };
  }

  // Step A: Read post history and filter out already-posted photos (hard dedupe rule)
  const postHistory = readJSON<PostHistory>(PATHS.postHistory, DEFAULT_POST_HISTORY);
  const availablePhotos = filterAlreadyPostedPhotos(photoList, postHistory);

  if (availablePhotos.length === 0) {
    return {
      wantToPost: false,
      selectedPhotos: [],
      coverPhoto: undefined,
      caption: '',
      hashtags: [],
      reason: '可发照片都已经成功发过了，避免重复发送',
    };
  }

  // Step B: Sync follower count (live fetch if cache is stale/missing)
  const followerCount = await syncFollowerCount();

  // Step C: Build summary from recent post history
  const recentPostsSummary = (postHistory.posts ?? [])
    .slice(-7)
    .map((p: PostRecord) => `${p.timestamp ? new Date(p.timestamp).toISOString().slice(0, 10) : '?'}: ${p.style ?? '?'} — ${p.caption?.slice(0, 30) ?? '?'}…`)
    .join('\n');

  // Step D: Consult 小慧 for today's advice (non-blocking, graceful degradation)
  const travelStateRaw = readJSON<TravelState>(PATHS.travelState, DEFAULT_TRAVEL_STATE);
  const advisorAdvice = (options?.skipAdvisor)
    ? ''
    : await consultAdvisor({
        currentCity: travelStateRaw.current_city,
        country: travelStateRaw.country,
        followerCount,
        recentPostsSummary,
        trendingTopics: inspiration?.visual_trends?.scene_ideas?.join(', ') ?? '',
      });
  const advisorSuggestion = advisorAdvice || '（今天没联系到小慧）';

  // Write advisor result to diary (non-critical)
  if (advisorAdvice) {
    const todayStr = new Date().toLocaleDateString('zh-CN');
    const timeStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    try {
      appendText(
        PATHS.diary,
        `\n## ${todayStr} ${timeStr}\n小慧说：${advisorAdvice.slice(0, 100)}…\n情绪: 参考建议 | 重要性: 2\n标签: 运营建议\n`
      );
    } catch { /* diary write is non-critical */ }
  }

  const template = readTemplate('post-intent-prompt.md');
  const prompt = template
    .replace('{photo_list}', availablePhotos.map((p, i) => `${i + 1}. ${path.basename(p)} (${path.basename(path.dirname(p))})`).join('\n'))
    .replace('{current_time}', formatLocalTime())
    .replace('{mood}', emotion.mood.description)
    .replace('{best_time_slots}', inspiration.self_performance.best_time_slots.join('、') || '暂无数据')
    .replace('{best_hashtag_combos}', inspiration.self_performance.best_hashtag_combos.map(c => c.join(', ')).join(' | ') || '暂无数据')
    .replace('{trending_hashtags}', inspiration.instagram_trends.trending_hashtags.join(', ') || '暂无数据')
    .replace('{advisor_suggestion}', advisorSuggestion);

  let parsed: PostIntent;
  try {
    parsed = await callLLMJSON<PostIntent>(prompt, undefined, 'content-planner');
  } catch (err) {
    const fallbackHashtags = inspiration.instagram_trends.trending_hashtags
      .map(tag => tag.replace(/^#/, '').trim())
      .filter(Boolean)
      .slice(0, 5);

    parsed = {
      wantToPost: true,
      selectedPhotos: photoList.slice(0, Math.min(3, photoList.length)),
      caption: `今天的${emotion.mood.description}小记录～`,
      hashtags: fallbackHashtags.length > 0 ? fallbackHashtags : ['daily', 'life'],
      reason: `LLM 解析失败，使用降级文案继续发帖: ${(err as Error).message.slice(0, 80)}`,
    };
    console.warn(`[content-planner] planPost fallback: ${(err as Error).message}`);
  }

  if (!parsed.wantToPost) {
    return {
      ...parsed,
      wantToPost: false,
      selectedPhotos: [],
      coverPhoto: undefined,
      caption: parsed.caption ?? '',
      hashtags: parsed.hashtags ?? [],
      reason: parsed.reason || '今天不发',
    };
  }

  const { selectedPhotos, coverPhoto } = resolvePostSelection(availablePhotos, {
    ...parsed,
    coverPhoto: (parsed as any).coverPhoto,
    selectedPhoto: (parsed as any).selectedPhoto,
  });

  if (selectedPhotos.length === 0) {
    return {
      wantToPost: false,
      selectedPhotos: [],
      coverPhoto: undefined,
      caption: parsed.caption ?? '',
      hashtags: parsed.hashtags ?? [],
      reason: '候选图在去重后为空，跳过本次发帖以避免重复发送',
    };
  }

  const intent: PostIntent = {
    ...parsed,
    selectedPhotos,
    coverPhoto: coverPhoto ?? selectedPhotos[0],
    caption: parsed.caption ?? '',
    hashtags: parsed.hashtags ?? [],
    reason: parsed.reason || '照片状态不错，想发一组',
  };

  return intent;
}

/**
 * List all photos in photo-roll (most recent first).
 */
function listPhotoRoll(): string[] {
  const rollDir = PATHS.photoRoll;
  if (!fs.existsSync(rollDir)) return [];

  const photos: string[] = [];
  const dateDirs = fs.readdirSync(rollDir).sort().reverse();

  for (const dateDir of dateDirs.slice(0, 7)) { // Last 7 days
    const dirPath = path.join(rollDir, dateDir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    for (const file of fs.readdirSync(dirPath)) {
      if (file.endsWith('.png') || file.endsWith('.jpg')) {
        photos.push(path.join(dirPath, file));
      }
    }
  }

  return photos;
}

/**
 * Get current activity from schedule.
 */
function getActivityFromSchedule(): string {
  const schedule = readJSON<ScheduleToday>(PATHS.scheduleToday, { date: null, rigid: [], flexible: [], generated_by: null });
  const hour = getLocalHour();
  const weekday = getLocalWeekday();

  for (const rigid of schedule.rigid) {
    if (!rigid.weekdays.includes(weekday)) continue;
    const startH = parseInt(rigid.start.split(':')[0], 10);
    const endH = parseInt(rigid.end.split(':')[0], 10);
    if (hour >= startH && hour < endH) return rigid.activity;
  }

  return '自由时段';
}

function formatTargetRatios(): string {
  const phase = getCurrentPhase();
  const ratios = PHASE_RATIOS[phase] ?? PHASE_RATIOS[1];
  return Object.entries(ratios)
    .map(([style, ratio]) => `${style}: ${Math.round(ratio * 100)}%`)
    .join(', ');
}
