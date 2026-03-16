#!/usr/bin/env node
/**
 * morning-plan.ts
 * Morning heartbeat — generates today's schedule, intent seeds, and cron config.
 * Called at 07:00 by heartbeat-tick.ts. (Spec §10)
 *
 * Usage: node morning-plan.js
 */

import {
  EmotionState, IntentPool, IntentCategory, ScheduleToday, EventQueue,
  HeartbeatLog, HeartbeatLogEntry, CronSchedule, Aspirations, RigidSchedule, EMOTION_BASELINE,
  DEFAULT_MOMENTUM, DEFAULT_UNDERTONE, BASE_RESISTANCE,
  FlowState, DEFAULT_FLOW_STATE,
  ChainAndCooldownState, DEFAULT_CHAIN_STATE,
  TravelState, DEFAULT_TRAVEL_STATE,
} from './types';
import { advanceTravelState } from './travel-state';
import { PATHS, readJSON, writeJSON, appendText, readText, readTemplate } from './file-utils';
import { callLLMJSON } from './llm-client';
import { callInstagramBridge } from './instagram-bridge-client';
import { VitalityState } from './types';
import { morningRecovery, DEFAULT_VITALITY } from './vitality-engine';
import { syncCronSchedule } from './cron-sync';
import { now, getLocalDate, getLocalWeekday, formatLocalTime, getLocalTimeHHMM } from './time-utils';

const VALID_CATEGORIES: ReadonlySet<string> = new Set<IntentCategory>(['创作', '社交', '窥屏', '表达', '学习', '休息', '梦想']);

function toIntentCategory(s: string): IntentCategory {
  return VALID_CATEGORIES.has(s) ? s as IntentCategory : '表达';
}

/**
 * Generate today's rigid schedule based on the current travel phase.
 * Replaces the old weekday-based WEEKDAY_RIGID constant.
 */
function buildRigidFromTravelPhase(phase: TravelState['phase']): RigidSchedule[] {
  switch (phase) {
    case 'arriving':
      return [
        { type: 'rigid', activity: '到达探索', start: '09:00', end: '12:00', weekdays: [1,2,3,4,5,6,7], allowed_actions: ['内心活动', '拍摄环境', '找外景', '搜攻略'] },
        { type: 'rigid', activity: '踩点拍摄', start: '14:00', end: '18:00', weekdays: [1,2,3,4,5,6,7], allowed_actions: ['拍摄', '生成图片', '找参考', '搜攻略'] },
        { type: 'rigid', activity: '整理发帖', start: '20:00', end: '21:00', weekdays: [1,2,3,4,5,6,7], allowed_actions: ['发帖', '写文案', '回评论'] },
      ];
    case 'exploring':
    case 'shooting':
      return [
        { type: 'rigid', activity: '外景拍摄', start: '09:00', end: '12:00', weekdays: [1,2,3,4,5,6,7], allowed_actions: ['拍摄', '生成图片', '找外景', '搜攻略'] },
        { type: 'rigid', activity: '探店游览', start: '14:00', end: '17:00', weekdays: [1,2,3,4,5,6,7], allowed_actions: ['拍摄', '内心活动', '搜攻略'] },
        { type: 'rigid', activity: '发帖时间', start: '19:30', end: '21:00', weekdays: [1,2,3,4,5,6,7], allowed_actions: ['发帖', '写文案', '回评论'] },
      ];
    case 'departing':
      return [
        { type: 'rigid', activity: '打包出发', start: '10:00', end: '12:00', weekdays: [1,2,3,4,5,6,7], allowed_actions: ['内心活动', '搜索下一目的地'] },
        { type: 'rigid', activity: '发帖总结', start: '20:00', end: '21:00', weekdays: [1,2,3,4,5,6,7], allowed_actions: ['发帖', '写文案', '回评论'] },
      ];
  }
}

interface MorningPlanDecision {
  mood_description: string;
  wake_time: string;
  sleep_time: string;
  flexible_schedule: Array<{ activity: string; preferred_time: string; intent_boost: number; intent_category: string }>;
  intent_seeds: Array<{ category: string; description: string; intensity: number }>;
  diary_entry: string;
}

export async function runMorningPlan(): Promise<void> {
  const currentTime = now();
  const weekday = getLocalWeekday(currentTime);
  const todayStr = getLocalDate(currentTime);

  // Refresh expired inspiration data at the start of each day
  try {
    const { refreshInspiration } = await import('./inspiration-collector');
    await refreshInspiration();
  } catch (err) {
    console.error(`Inspiration refresh failed: ${(err as Error).message}`);
  }

  // Read yesterday's log
  const heartbeatLog = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
  const yesterday = getLocalDate(new Date(currentTime.getTime() - 86400000));
  const yesterdayLogs = heartbeatLog.logs.filter(l => l.timestamp.startsWith(yesterday));
  const yesterdaySummary = yesterdayLogs.length > 0
    ? yesterdayLogs.map(l => `${l.timestamp.split('T')[1].slice(0, 5)}: ${l.chosen_actions?.join(', ') || l.status}`).join('\n')
    : '昨天好像断片了……不太记得发生了什么。';

  // Rotate old logs (Spec §13: 7 day retention)
  const cutoff = new Date(currentTime.getTime() - 7 * 86400000).toISOString();
  const trimmedLog: HeartbeatLog = {
    ...heartbeatLog,
    logs: heartbeatLog.logs.filter(l => l.timestamp >= cutoff),
  };

  // Read other context
  const aspirations = readJSON<Aspirations>(PATHS.aspirations, { aspirations: [] });
  const worldMd = readText(PATHS.world).split('\n').slice(-20).join('\n');
  const events = readJSON<EventQueue>(PATHS.eventQueue, { events: [], max_size: 50 });
  const overnightEvents = events.events.filter(e => !e.processed);

  // 1. Read and advance travel state
  const today = new Date().toISOString().slice(0, 10);
  let travelState: TravelState = readJSON<TravelState>(PATHS.travelState, DEFAULT_TRAVEL_STATE);
  travelState = advanceTravelState(travelState, today);
  writeJSON(PATHS.travelState, travelState);

  // 2. Generate rigid schedule from phase
  const rigidSchedule = buildRigidFromTravelPhase(travelState.phase);

  // Sync follower count from Instagram (non-fatal if it fails)
  try {
    const igUser = process.env.INSTAGRAM_USERNAME;
    if (igUser) {
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
          follower_synced_at: now().toISOString(),
        });
        console.log(`Follower sync: ${userInfo.follower_count} followers`);
      }
    }
  } catch (err) {
    console.error(`Follower sync failed (non-fatal): ${(err as Error).message}`);
  }

  // Morning vitality recovery: simulate overnight sleep
  const prevVitality = readJSON<VitalityState>(PATHS.vitalityState, DEFAULT_VITALITY);
  const recoveredVitality = morningRecovery(prevVitality);
  writeJSON(PATHS.vitalityState, recoveredVitality);
  console.log(`Vitality: ${Math.round(prevVitality.vitality)} → ${Math.round(recoveredVitality.vitality)} (morning recovery)`);

  // Build prompt
  const template = readTemplate('morning-plan-prompt.md');
  const weekdayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  const prompt = template
    .replace('{current_time}', formatLocalTime(currentTime))
    .replace('{weekday_name}', weekdayNames[weekday])
    .replace('{yesterday_summary}', yesterdaySummary)
    .replace('{aspirations_summary}', aspirations.aspirations.length > 0
      ? aspirations.aspirations.map(a => `- [${a.status}] ${a.content}`).join('\n')
      : '还没有明确的梦想，一切随缘。')
    .replace('{world_summary}', worldMd || '没有特别的世界动态。')
    .replace('{overnight_events}', overnightEvents.length > 0
      ? overnightEvents.map(e => `- [${e.type}] ${JSON.stringify(e.data).slice(0, 100)}`).join('\n')
      : '平静的夜晚，没有新消息。')
    .replace('{rigid_schedule_template}', rigidSchedule.length > 0
      ? rigidSchedule.map(r => `- ${r.start}-${r.end} ${r.activity}`).join('\n')
      : '今天没有固定日程（周末）');

  const decision = await callLLMJSON<MorningPlanDecision>(prompt, undefined, 'morning-plan');

  // Build schedule-today.json
  const scheduleToday: ScheduleToday = {
    date: todayStr,
    rigid: rigidSchedule,
    flexible: decision.flexible_schedule.map(f => ({
      type: 'flexible' as const,
      activity: f.activity,
      preferred_time: f.preferred_time,
      intent_boost: f.intent_boost,
      intent_category: toIntentCategory(f.intent_category || '创作'),
    })),
    generated_by: 'morning-plan',
  };

  // Build intent pool with seeds
  const intentPool: IntentPool = {
    intents: decision.intent_seeds.map((seed, i) => {
      const category = toIntentCategory(seed.category);
      return {
        id: `seed_${currentTime.getTime()}_${i}`,
        category,
        description: seed.description,
        intensity: Math.min(10, Math.max(0, seed.intensity)),
        source: 'accumulation' as const,
        born_at: currentTime.toISOString(),
        decay_rate: 0.3,
        satisfied_at: null,
        resistance: BASE_RESISTANCE[category] ?? 0,
        skipped_count: 0,
        last_attempted: null,
      };
    }),
    last_updated: currentTime.toISOString(),
  };

  // Build emotion state for morning (using ESTP baseline from spec)
  // Set undertone from today's starting mood to guide emotional drift for the day
  const morningUndertone = {
    valence: EMOTION_BASELINE.valence!,
    arousal: EMOTION_BASELINE.arousal!,
    energy: EMOTION_BASELINE.energy! + 0.1,
    stress: EMOTION_BASELINE.stress!,
    creativity: EMOTION_BASELINE.creativity!,
    sociability: EMOTION_BASELINE.sociability!,
  };
  const emotion: EmotionState = {
    mood: { valence: EMOTION_BASELINE.valence!, arousal: EMOTION_BASELINE.arousal!, description: decision.mood_description },
    energy: EMOTION_BASELINE.energy! + 0.1, // Slightly above baseline: morning freshness
    stress: EMOTION_BASELINE.stress!,
    creativity: EMOTION_BASELINE.creativity!,
    sociability: EMOTION_BASELINE.sociability!,
    last_updated: currentTime.toISOString(),
    recent_cause: '晨规划',
    momentum: { ...DEFAULT_MOMENTUM },
    undertone: morningUndertone,
    impulse_history: [],
    consecutive_high_stress: 0,
    threshold_break_cooldown: 0,
  };

  // Build cron schedule (Spec §14)
  const wakeHour = parseInt(decision.wake_time.split(':')[0], 10) || 7;
  const sleepHour = parseInt(decision.sleep_time.split(':')[0], 10) || 23;
  const heartbeats: CronSchedule['heartbeats'] = [];
  heartbeats.push({ time: decision.wake_time, type: 'morning' });
  for (let h = wakeHour + 1; h < sleepHour; h++) {
    heartbeats.push({ time: `${h.toString().padStart(2, '0')}:00`, type: 'regular' });
  }
  heartbeats.push({ time: decision.sleep_time, type: 'night' });

  const cronSchedule: CronSchedule = {
    date: todayStr,
    heartbeats,
  };

  // Write diary entry
  appendText(PATHS.diary, `\n## ${todayStr} ${decision.wake_time}\n${decision.diary_entry}\n情绪: ${decision.mood_description} | 重要性: 3\n标签: morning, plan\n`);

  // Write all state
  writeJSON(PATHS.scheduleToday, scheduleToday);
  writeJSON(PATHS.intentPool, intentPool);
  writeJSON(PATHS.emotionState, emotion);
  writeJSON(PATHS.cronSchedule, cronSchedule);

  // Reset flow state and chain events for new day
  writeJSON(PATHS.flowState, { ...DEFAULT_FLOW_STATE });
  writeJSON(PATHS.pendingChains, { ...DEFAULT_CHAIN_STATE });

  // Sync dynamic cron schedule to OpenClaw (non-fatal)
  const syncResult = syncCronSchedule(cronSchedule);
  if (syncResult.synced) {
    console.log(`Cron sync: OK (morning=${syncResult.details.morning}, tick=${syncResult.details.tick}, night=${syncResult.details.night})`);
  } else {
    console.error(`Cron sync: partial/failed — ${JSON.stringify(syncResult.details)}. Fallback: heartbeat-tick will gate by cron-schedule.json.`);
  }

  // Add morning heartbeat log entry
  const morningLogEntry: HeartbeatLogEntry = {
    timestamp: currentTime.toISOString(),
    type: 'morning',
    status: 'completed',
    chosen_actions: [`schedule: ${decision.flexible_schedule.length} flexible items`],
    emotion_after: { mood: emotion.mood, energy: emotion.energy },
    importance_added: 3,
  };
  const finalLog: HeartbeatLog = {
    ...trimmedLog,
    logs: [...trimmedLog.logs, morningLogEntry],
  };
  writeJSON(PATHS.heartbeatLog, finalLog);

  // Mark overnight events as processed
  const updatedEvents: EventQueue = {
    ...events,
    events: events.events.map(e => ({ ...e, processed: true })),
  };
  writeJSON(PATHS.eventQueue, updatedEvents);

  console.log(`Morning plan complete. Schedule: ${heartbeats.length} heartbeats, ${decision.flexible_schedule.length} flexible items.`);
}

if (require.main === module) {
  runMorningPlan().catch(err => {
    console.error('Morning plan error:', err.message);
    process.exit(1);
  });
}
