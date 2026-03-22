#!/usr/bin/env npx tsx

/**
 * simulate-production-days.ts
 *
 * Runs a multi-day mock simulation directly against the production memory
 * directory (~/.openclaw/workspace/memory/minase/) so that minase-world
 * dashboard can display and replay the data.
 *
 * Usage:
 *   npx tsx e2e/simulate-production-days.ts
 *
 * Environment variables:
 *   SIM_START_DATE  — start date YYYY-MM-DD (default: 2026-03-17)
 *   SIM_END_DATE    — end date YYYY-MM-DD inclusive (default: today)
 *   SIM_HOURS       — comma-separated hours to simulate (default: 7,8,10,12,14,16,18,20,22,23)
 */

import * as fs from 'fs';
import * as path from 'path';
import { setTimeOverride, clearTimeOverride } from '../skill/scripts/time-utils';
import { setBasePaths, resetBasePaths, PATHS, readJSON, writeJSON, appendText } from '../skill/scripts/file-utils';
import { runMorningPlan } from '../skill/scripts/morning-plan';
import { regularTick } from '../skill/scripts/heartbeat-tick';
import { runNightReflect } from '../skill/scripts/night-reflect';
import {
  DEFAULT_MOMENTUM, DEFAULT_UNDERTONE,
  DEFAULT_FLOW_STATE, DEFAULT_CHAIN_STATE,
  DEFAULT_POST_IMPULSE, DEFAULT_PHOTO_GALLERY,
  DEFAULT_TRAVEL_STATE,
} from '../skill/scripts/types';
import { loadApiKeys, applyApiKeys, setupMockEnv } from './shared/setup';

// ─── Configuration ───────────────────────────────────────────────

const PRODUCTION_MEMORY = path.join(process.env.HOME!, '.openclaw', 'workspace', 'memory', 'minase');
const SKILL_DIR = path.join(process.env.HOME!, '.openclaw', 'skills', 'minase');
// Also use the local skill dir for templates, since the installed skill may not exist
const LOCAL_SKILL_DIR = path.join(__dirname, '..', 'skill');

const DEFAULT_START_DATE = '2026-03-17';

// Simulate fewer hours per day to speed things up (still gives good coverage)
const DEFAULT_HOURS = [7, 8, 10, 12, 14, 16, 18, 20, 22, 23];

// ─── Helpers ─────────────────────────────────────────────────────

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function parseDate(input: string): Date {
  const d = new Date(`${input}T00:00:00`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${input}. Expected YYYY-MM-DD.`);
  }
  return d;
}

function daysBetween(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
}

// ─── Production Memory Init ─────────────────────────────────────

function resetProductionMemory(): void {
  console.log(`\n🗑️  Clearing production memory: ${PRODUCTION_MEMORY}`);

  // Remove everything except the directory itself
  if (fs.existsSync(PRODUCTION_MEMORY)) {
    fs.rmSync(PRODUCTION_MEMORY, { recursive: true, force: true });
  }

  // Re-create directory structure
  const dirs = [
    PRODUCTION_MEMORY,
    path.join(PRODUCTION_MEMORY, 'photo-roll'),
    path.join(PRODUCTION_MEMORY, 'relations', 'social', 'instagram'),
    path.join(PRODUCTION_MEMORY, 'relations', 'social', 'xiaohongshu'),
    path.join(PRODUCTION_MEMORY, 'inspiration-refs'),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write default state files
  const defaults: Record<string, unknown> = {
    'emotion-state.json': {
      mood: { valence: 0.3, arousal: 0.5, description: '刚醒来' },
      energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
      last_updated: null, recent_cause: '初始化',
      momentum: { ...DEFAULT_MOMENTUM },
      undertone: { ...DEFAULT_UNDERTONE },
      impulse_history: [],
      consecutive_high_stress: 0,
      threshold_break_cooldown: 0,
    },
    'intent-pool.json': { intents: [], last_updated: null },
    'schedule-today.json': { date: null, rigid: [], flexible: [], generated_by: null },
    'event-queue.json': { events: [], max_size: 50 },
    'heartbeat-log.json': { logs: [], retention_days: 7 },
    'core-wisdom.json': { version: 1, wisdom: [], total_importance_since_reflection: 0 },
    'preferences.json': {
      cos_characters: [
        { name: '初音ミク', affinity: 9, times_created: 2, source: 'seed' },
        { name: '明日香', affinity: 7, times_created: 1, source: 'seed' },
      ],
      content_style: [
        { style: '日系清新', affinity: 8 },
        { style: '暖色调', affinity: 7 },
      ],
      active_hours: [
        { period: '14:00-16:00', productivity: 9, learned_from: 'seed' },
        { period: '20:00-22:00', productivity: 7, learned_from: 'seed' },
      ],
      social_platforms: [
        { platform: 'instagram', engagement: 9, note: '主阵地' },
        { platform: 'xiaohongshu', engagement: 6, note: '只读灵感' },
      ],
    },
    'aspirations.json': { aspirations: [] },
    'personality-drift.json': { base: 'ESTP', modifiers: [] },
    'post-history.json': { posts: [] },
    'vitality-state.json': { vitality: 80, consecutive_low_days: 0, last_updated: null, last_recovery_date: null },
    'confidence-state.json': { confidence: 1.0, last_updated: null, streak: 0 },
    'post-impulse.json': { ...DEFAULT_POST_IMPULSE, value: 75 },
    'inspiration.json': {
      instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: 0 },
      acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: 0 },
      visual_trends: { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: 0 },
      self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: 0 },
      xiaohongshu_trends: { feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [], saved_inspirations: [], updated_at: 0 },
    },
    'flow-state.json': { ...DEFAULT_FLOW_STATE },
    'pending-chains.json': { ...DEFAULT_CHAIN_STATE },
    'photo-gallery.json': { ...DEFAULT_PHOTO_GALLERY },
    'travel-state.json': { ...DEFAULT_TRAVEL_STATE, arrived_at: new Date().toISOString().slice(0, 10) },
    'outbound-history.json': { commented: [] },
    'pending-engagement.json': { pending_replies: [] },
    'search-state.json': { queries: [], last_search: null },
  };

  for (const [file, data] of Object.entries(defaults)) {
    fs.writeFileSync(path.join(PRODUCTION_MEMORY, file), JSON.stringify(data, null, 2));
  }

  // Text files
  fs.writeFileSync(path.join(PRODUCTION_MEMORY, 'diary.md'), '# 水瀬の日記\n');
  fs.writeFileSync(path.join(PRODUCTION_MEMORY, 'world.md'), '# 世界観察\n\n_水瀬在浏览网络时学到的事情。_\n');

  // Social meta
  fs.writeFileSync(
    path.join(PRODUCTION_MEMORY, 'relations', 'social', 'meta.json'),
    JSON.stringify({
      instagram_following: ['38291234', '48392011'],
      xiaohongshu_following: [],
      stats: { core: 1, familiar: 1, cognitive: 0, dormant: 0 },
      follower_count: 860,
      following_count: 248,
      media_count: 42,
      follower_synced_at: new Date().toISOString(),
    }, null, 2),
  );

  // Seed social relations
  const seededAt = new Date().toISOString();
  const relations = [
    {
      id: '38291234',
      name: 'sora_cos',
      platform: 'instagram',
      type: '同行',
      relationship: { closeness: 8.2, sentiment: 'positive', tags: ['cos', '常互动'] },
      known_info: ['常发角色扮演和棚拍'],
      interaction_history: [{ date: seededAt, type: 'seed', content: '社交关系初始化' }],
      last_interaction: seededAt,
      created_at: seededAt,
    },
    {
      id: '48392011',
      name: 'mika_daily',
      platform: 'instagram',
      type: '用户',
      relationship: { closeness: 6.3, sentiment: 'positive', tags: ['穿搭', '街拍'] },
      known_info: ['偏日常日系穿搭'],
      interaction_history: [{ date: seededAt, type: 'seed', content: '社交关系初始化' }],
      last_interaction: seededAt,
      created_at: seededAt,
    },
  ];
  for (const r of relations) {
    fs.writeFileSync(
      path.join(PRODUCTION_MEMORY, 'relations', 'social', 'instagram', `${r.id}.json`),
      JSON.stringify(r, null, 2),
    );
  }

  // Clear LLM call log
  const llmLogPath = path.join(PRODUCTION_MEMORY, 'llm-call-log.jsonl');
  if (fs.existsSync(llmLogPath)) {
    fs.unlinkSync(llmLogPath);
  }

  console.log('✅ Production memory reset complete.\n');
}

// ─── Single Hour Simulation ─────────────────────────────────────

async function simulateHour(
  dateStr: string,
  hour: number,
  dayIndex: number,
  totalDays: number,
): Promise<{ success: boolean; durationMs: number; error?: string }> {
  const simDate = new Date(`${dateStr}T${String(hour).padStart(2, '0')}:00:00`);
  setTimeOverride(simDate);

  const start = Date.now();
  let error: string | undefined;

  try {
    if (hour === 7) {
      await runMorningPlan();
    } else if (hour === 23) {
      await runNightReflect();
    } else {
      await regularTick();
    }
  } catch (err) {
    error = (err as Error).message;
    console.error(`    ❌ Hour ${hour} failed: ${error}`);
  }

  return {
    success: !error,
    durationMs: Date.now() - start,
    error,
  };
}

// ─── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   Minase 5-Day Production Mock Simulation       ║');
  console.log('╚══════════════════════════════════════════════════╝');

  // Parse config
  const startDate = parseDate(process.env.SIM_START_DATE ?? DEFAULT_START_DATE);
  const endDate = parseDate(process.env.SIM_END_DATE ?? formatDate(new Date()));
  const hours = (process.env.SIM_HOURS ?? DEFAULT_HOURS.join(','))
    .split(',').map(h => parseInt(h.trim(), 10));
  const totalDays = daysBetween(startDate, endDate);

  console.log(`\n📅 Simulation range: ${formatDate(startDate)} → ${formatDate(endDate)} (${totalDays} days)`);
  console.log(`⏰ Hours per day: ${hours.join(', ')}`);
  console.log(`📂 Target memory: ${PRODUCTION_MEMORY}`);
  console.log(`📂 Skill dir: ${fs.existsSync(SKILL_DIR) ? SKILL_DIR : LOCAL_SKILL_DIR}`);

  // Load API keys from openclaw config
  const keys = loadApiKeys();
  applyApiKeys(keys, ['IMGURL_TOKEN']);

  // Set up mock environment (mock IG/XHS but use real LLM)
  const restoreEnv = setupMockEnv({
    instagram: true,
    xhs: true,
    cron: true,
    inlinePipeline: true,
    imgurl: true,
  });

  // Step 1: Reset production memory
  resetProductionMemory();

  // Step 2: Point file-utils to production memory
  const effectiveSkillDir = fs.existsSync(SKILL_DIR) ? SKILL_DIR : LOCAL_SKILL_DIR;
  setBasePaths(PRODUCTION_MEMORY, effectiveSkillDir);

  const dayResults: Array<{
    date: string;
    successHours: number;
    failedHours: number;
    totalDurationMs: number;
  }> = [];

  try {
    // Step 3: Run simulation for each day
    for (let i = 0; i < totalDays; i++) {
      const currentDate = addDays(startDate, i);
      const dateStr = formatDate(currentDate);

      console.log(`\n${'═'.repeat(50)}`);
      console.log(`📆 Day ${i + 1}/${totalDays}: ${dateStr}`);
      console.log('═'.repeat(50));

      let successHours = 0;
      let failedHours = 0;
      let totalDurationMs = 0;

      for (const hour of hours) {
        const label = hour === 7 ? '🌅 morning-plan'
          : hour === 23 ? '🌙 night-reflect'
          : `🕐 regular-tick`;

        process.stdout.write(`  ${label} (${String(hour).padStart(2, '0')}:00) ... `);

        const result = await simulateHour(dateStr, hour, i + 1, totalDays);
        totalDurationMs += result.durationMs;

        if (result.success) {
          successHours++;
          console.log(`✅ ${(result.durationMs / 1000).toFixed(1)}s`);
        } else {
          failedHours++;
          console.log(`❌ ${(result.durationMs / 1000).toFixed(1)}s — ${result.error?.slice(0, 80)}`);
        }
      }

      dayResults.push({ date: dateStr, successHours, failedHours, totalDurationMs });

      console.log(`\n  📊 Day summary: ${successHours}/${hours.length} succeeded, ${(totalDurationMs / 1000).toFixed(1)}s total`);
    }
  } finally {
    resetBasePaths();
    clearTimeOverride();
    restoreEnv();
  }

  // Step 4: Print final summary
  console.log('\n\n╔══════════════════════════════════════════════════╗');
  console.log('║   Simulation Complete                            ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  let totalSuccess = 0;
  let totalFailed = 0;
  let totalMs = 0;

  for (const day of dayResults) {
    totalSuccess += day.successHours;
    totalFailed += day.failedHours;
    totalMs += day.totalDurationMs;
    console.log(`  ${day.date}: ${day.successHours}/${day.successHours + day.failedHours} hours ✅  (${(day.totalDurationMs / 1000).toFixed(1)}s)`);
  }

  console.log(`\n  Total: ${totalSuccess} succeeded, ${totalFailed} failed, ${(totalMs / 1000).toFixed(0)}s`);
  console.log(`\n  Memory written to: ${PRODUCTION_MEMORY}`);
  console.log(`  Dashboard: cd /Users/halyu/Documents/Code/minase-world && node server.js`);
  console.log(`  URL: http://localhost:3900`);

  // Write simulation report
  const report = {
    startDate: formatDate(startDate),
    endDate: formatDate(endDate),
    totalDays,
    hoursPerDay: hours,
    results: dayResults,
    totals: { success: totalSuccess, failed: totalFailed, durationMs: totalMs },
    finishedAt: new Date().toISOString(),
  };
  const reportPath = path.join(PRODUCTION_MEMORY, 'simulation-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`  Report: ${reportPath}`);
}

main().catch(err => {
  console.error('\n💀 Fatal error:', err.message);
  resetBasePaths();
  clearTimeOverride();
  process.exit(1);
});
