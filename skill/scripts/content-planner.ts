#!/usr/bin/env node
/**
 * content-planner.ts
 * Minase's content decision engine.
 * She decides what to photograph and what to share, based on mood and inspiration.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ContentStyle, PhotoIntent, PostIntent, PostHistory, PostRecord,
  InspirationData, EmotionState, ScheduleToday,
  DEFAULT_MOMENTUM, DEFAULT_UNDERTONE,
  TravelState, DEFAULT_TRAVEL_STATE,
} from './types';
import { PATHS, readJSON, readTemplate, appendText } from './file-utils';
import { consultAdvisor } from './advisor-client';
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

// Phase 1 ratios from instagram.md (authority source)
const PHASE_RATIOS: Record<number, Record<ContentStyle, number>> = {
  1: { cos: 0.8, daily: 0.1, behind_scenes: 0, travel: 0.1 },
  2: { cos: 0.5, daily: 0.2, behind_scenes: 0.1, travel: 0.2 },
  3: { cos: 0.4, daily: 0.2, behind_scenes: 0.15, travel: 0.25 },
};

const MAX_POSTS_PER_DAY = 3;

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
  const todayStart = new Date(today).getTime();
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
    .replace('{inspiration_refs}', formatInspirationRefs());

  const parsed = await callLLMJSON<PhotoIntent>(prompt, undefined, 'content-planner');

  const intent: PhotoIntent = {
    ...parsed,
    imageCount: parsed.imageCount ?? 1,
    shots: parsed.shots ?? (parsed.wantToShoot ? [{
      description: parsed.sceneDescription,
      angle: '正面',
      variation: '主图',
    }] : []),
  };

  return intent;
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
      caption: '',
      hashtags: [],
      reason: '相册里没有照片可以发',
    };
  }

  // Step A: Read social meta (for follower count)
  const socialMeta = readJSON<{ follower_count?: number }>(PATHS.socialMeta, {});

  // Step B: Read post history and build summary
  const postHistory = readJSON<PostHistory>(PATHS.postHistory, DEFAULT_POST_HISTORY);
  const recentPostsSummary = (postHistory.posts ?? [])
    .slice(-7)
    .map((p: PostRecord) => `${p.timestamp ? new Date(p.timestamp).toISOString().slice(0, 10) : '?'}: ${p.style ?? '?'} — ${p.caption?.slice(0, 30) ?? '?'}…`)
    .join('\n');

  // Step C: Consult 小慧 for today's advice (non-blocking, graceful degradation)
  const travelStateRaw = readJSON<TravelState>(PATHS.travelState, DEFAULT_TRAVEL_STATE);
  const advisorAdvice = (options?.skipAdvisor)
    ? ''
    : await consultAdvisor({
        currentCity: travelStateRaw.current_city,
        country: travelStateRaw.country,
        followerCount: socialMeta?.follower_count ?? 0,
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
    .replace('{photo_list}', photoList.map((p, i) => `${i + 1}. ${path.basename(p)} (${path.basename(path.dirname(p))})`).join('\n'))
    .replace('{current_time}', formatLocalTime())
    .replace('{mood}', emotion.mood.description)
    .replace('{best_time_slots}', inspiration.self_performance.best_time_slots.join('、') || '暂无数据')
    .replace('{best_hashtag_combos}', inspiration.self_performance.best_hashtag_combos.map(c => c.join(', ')).join(' | ') || '暂无数据')
    .replace('{trending_hashtags}', inspiration.instagram_trends.trending_hashtags.join(', ') || '暂无数据')
    .replace('{advisor_suggestion}', advisorSuggestion);

  const parsed = await callLLMJSON<PostIntent>(prompt, undefined, 'content-planner');

  // Resolve selectedPhotos to full paths (immutable — create new object)
  const selectedPhotos = (parsed.selectedPhotos ?? ((parsed as any).selectedPhoto ? [(parsed as any).selectedPhoto] : []))
    .map((name: string) => photoList.find(p => path.basename(p) === name) ?? name);

  const intent: PostIntent = {
    ...parsed,
    selectedPhotos,
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
