#!/usr/bin/env node
/**
 * content-planner.ts
 * Minase's content decision engine.
 * She decides what to photograph and what to share, based on mood and inspiration.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ContentStyle, PhotoIntent, PostIntent, PostHistory,
  InspirationData, EmotionState, ScheduleToday,
} from './types';
import { PATHS, readJSON, readTemplate } from './file-utils';
import { callLLMJSON } from './llm-client';

const DEFAULT_POST_HISTORY: PostHistory = { posts: [] };
const DEFAULT_INSPIRATION: InspirationData = {
  instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: 0 },
  acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: 0 },
  visual_trends: { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: 0 },
  self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: 0 },
};
const DEFAULT_EMOTION: EmotionState = {
  mood: { valence: 0.3, arousal: 0.5, description: '普通' },
  energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
  last_updated: null, recent_cause: '',
};

// Phase 1 ratios from instagram.md (authority source)
const PHASE_RATIOS: Record<number, Record<ContentStyle, number>> = {
  1: { cos: 0.8, daily: 0.1, behind_scenes: 0, travel: 0.1 },
  2: { cos: 0.5, daily: 0.2, behind_scenes: 0.1, travel: 0.2 },
  3: { cos: 0.4, daily: 0.2, behind_scenes: 0.15, travel: 0.25 },
};

const MIN_POST_INTERVAL_MS = 16 * 60 * 60 * 1000; // 16 hours

/**
 * Determine current phase based on follower count.
 * For now, default to Phase 1 (we don't have follower data in the system yet).
 */
function getCurrentPhase(): number {
  // TODO: Read from instagram_meta.json when available
  return 1;
}

/**
 * Rule-based filter: should we even consider posting?
 */
export function shouldConsiderPosting(history: PostHistory): { allowed: boolean; reason: string } {
  const now = Date.now();

  if (history.posts.length === 0) {
    return { allowed: true, reason: '还没发过帖子' };
  }

  const lastPost = history.posts[history.posts.length - 1];
  const timeSince = now - lastPost.timestamp;

  if (timeSince < MIN_POST_INTERVAL_MS) {
    const hoursAgo = Math.round(timeSince / (60 * 60 * 1000));
    return { allowed: false, reason: `上次发帖才${hoursAgo}小时前` };
  }

  // Check if already posted today
  const todayStr = new Date().toISOString().split('T')[0];
  const postedToday = history.posts.some(p =>
    new Date(p.timestamp).toISOString().split('T')[0] === todayStr
  );
  if (postedToday) {
    return { allowed: false, reason: '今天已经发过了' };
  }

  return { allowed: true, reason: '可以发' };
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
 * Plan a photo: ask Minase if she wants to take a picture.
 */
export async function planPhoto(): Promise<PhotoIntent> {
  const emotion = readJSON<EmotionState>(PATHS.emotionState, DEFAULT_EMOTION);
  const inspiration = readJSON<InspirationData>(PATHS.inspiration, DEFAULT_INSPIRATION);
  const history = readJSON<PostHistory>(PATHS.postHistory, DEFAULT_POST_HISTORY);

  const template = readTemplate('photo-intent-prompt.md');
  const prompt = template
    .replace('{current_time}', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))
    .replace('{mood}', `${emotion.mood.description} (energy: ${emotion.energy.toFixed(1)}, creativity: ${emotion.creativity.toFixed(1)})`)
    .replace('{activity}', getActivityFromSchedule())
    .replace('{instagram_trends}', inspiration.instagram_trends.hot_styles.join('、') || '没有最新数据')
    .replace('{trending_characters}', inspiration.acg_hotspots.trending_characters.join('、') || '没有最新数据')
    .replace('{visual_trends}', [
      ...inspiration.visual_trends.scene_ideas.slice(0, 3),
      ...inspiration.visual_trends.composition_styles.slice(0, 2),
    ].join('、') || '没有最新数据')
    .replace('{best_style}', inspiration.self_performance.best_style)
    .replace('{recent_styles}', getRecentStyleDistribution(history))
    .replace('{target_ratios}', formatTargetRatios());

  return callLLMJSON<PhotoIntent>(prompt, 512);
}

/**
 * Plan a post: ask Minase if she wants to share a photo on Instagram.
 */
export async function planPost(): Promise<PostIntent> {
  const emotion = readJSON<EmotionState>(PATHS.emotionState, DEFAULT_EMOTION);
  const inspiration = readJSON<InspirationData>(PATHS.inspiration, DEFAULT_INSPIRATION);

  // List photos in photo-roll
  const photoList = listPhotoRoll();
  if (photoList.length === 0) {
    return {
      wantToPost: false,
      caption: '',
      hashtags: [],
      reason: '相册里没有照片可以发',
    };
  }

  const template = readTemplate('post-intent-prompt.md');
  const prompt = template
    .replace('{photo_list}', photoList.map((p, i) => `${i + 1}. ${path.basename(p)} (${path.basename(path.dirname(p))})`).join('\n'))
    .replace('{current_time}', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))
    .replace('{mood}', emotion.mood.description)
    .replace('{best_time_slots}', inspiration.self_performance.best_time_slots.join('、') || '暂无数据')
    .replace('{best_hashtag_combos}', inspiration.self_performance.best_hashtag_combos.map(c => c.join(', ')).join(' | ') || '暂无数据')
    .replace('{trending_hashtags}', inspiration.instagram_trends.trending_hashtags.join(', ') || '暂无数据');

  const intent = await callLLMJSON<PostIntent>(prompt, 512);

  // Resolve selectedPhoto to full path (immutable — create new object)
  if (intent.selectedPhoto && !path.isAbsolute(intent.selectedPhoto)) {
    const match = photoList.find(p => path.basename(p) === intent.selectedPhoto || p.includes(intent.selectedPhoto!));
    if (match) {
      return { ...intent, selectedPhoto: match };
    }
  }

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
  const hour = new Date().getHours();
  const weekday = new Date().getDay() === 0 ? 7 : new Date().getDay();

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
