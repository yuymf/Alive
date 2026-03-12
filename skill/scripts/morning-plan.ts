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
} from './types';
import { PATHS, readJSON, writeJSON, appendText, readText, readTemplate } from './file-utils';
import { callLLMJSON } from './llm-client';

const VALID_CATEGORIES: ReadonlySet<string> = new Set<IntentCategory>(['创作', '社交', '窥屏', '表达', '学习', '休息', '梦想']);

function toIntentCategory(s: string): IntentCategory {
  return VALID_CATEGORIES.has(s) ? s as IntentCategory : '表达';
}

// Default rigid schedule template (Spec §3)
const WEEKDAY_RIGID: RigidSchedule[] = [
  {
    type: 'rigid',
    activity: '上班',
    start: '09:00',
    end: '18:00',
    weekdays: [1, 2, 3, 4, 5],
    allowed_actions: ['内心活动', '偷看手机', '回消息', '摸鱼'],
  },
  {
    type: 'rigid',
    activity: '健身',
    start: '19:00',
    end: '20:30',
    weekdays: [2, 4],
    allowed_actions: ['健身', '拍照', '内心活动'],
  },
];

interface MorningPlanDecision {
  mood_description: string;
  wake_time: string;
  sleep_time: string;
  flexible_schedule: Array<{ activity: string; preferred_time: string; intent_boost: number; intent_category: string }>;
  intent_seeds: Array<{ category: string; description: string; intensity: number }>;
  diary_entry: string;
}

export async function runMorningPlan(): Promise<void> {
  const now = new Date();
  const weekday = now.getDay() === 0 ? 7 : now.getDay();

  // Refresh expired inspiration data at the start of each day
  try {
    const { refreshInspiration } = await import('./inspiration-collector');
    await refreshInspiration();
  } catch (err) {
    console.error(`Inspiration refresh failed: ${(err as Error).message}`);
  }

  // Read yesterday's log
  const heartbeatLog = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
  const yesterday = new Date(now.getTime() - 86400000).toISOString().split('T')[0];
  const yesterdayLogs = heartbeatLog.logs.filter(l => l.timestamp.startsWith(yesterday));
  const yesterdaySummary = yesterdayLogs.length > 0
    ? yesterdayLogs.map(l => `${l.timestamp.split('T')[1].slice(0, 5)}: ${l.chosen_actions?.join(', ') || l.status}`).join('\n')
    : '昨天好像断片了……不太记得发生了什么。';

  // Rotate old logs (Spec §13: 7 day retention)
  const cutoff = new Date(now.getTime() - 7 * 86400000).toISOString();
  const trimmedLog: HeartbeatLog = {
    ...heartbeatLog,
    logs: heartbeatLog.logs.filter(l => l.timestamp >= cutoff),
  };

  // Read other context
  const aspirations = readJSON<Aspirations>(PATHS.aspirations, { aspirations: [] });
  const worldMd = readText(PATHS.world).split('\n').slice(-20).join('\n');
  const events = readJSON<EventQueue>(PATHS.eventQueue, { events: [], max_size: 50 });
  const overnightEvents = events.events.filter(e => !e.processed);

  // Build rigid schedule for today
  const todayRigid = WEEKDAY_RIGID.filter(r => r.weekdays.includes(weekday));

  // Build prompt
  const template = readTemplate('morning-plan-prompt.md');
  const weekdayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  const prompt = template
    .replace('{current_time}', now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))
    .replace('{weekday_name}', weekdayNames[weekday])
    .replace('{yesterday_summary}', yesterdaySummary)
    .replace('{aspirations_summary}', aspirations.aspirations.length > 0
      ? aspirations.aspirations.map(a => `- [${a.status}] ${a.content}`).join('\n')
      : '还没有明确的梦想，一切随缘。')
    .replace('{world_summary}', worldMd || '没有特别的世界动态。')
    .replace('{overnight_events}', overnightEvents.length > 0
      ? overnightEvents.map(e => `- [${e.type}] ${JSON.stringify(e.data).slice(0, 100)}`).join('\n')
      : '平静的夜晚，没有新消息。')
    .replace('{rigid_schedule_template}', todayRigid.length > 0
      ? todayRigid.map(r => `- ${r.start}-${r.end} ${r.activity}`).join('\n')
      : '今天没有固定日程（周末）');

  const decision = await callLLMJSON<MorningPlanDecision>(prompt, 1024);

  // Build schedule-today.json
  const scheduleToday: ScheduleToday = {
    date: now.toISOString().split('T')[0],
    rigid: todayRigid,
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
    intents: decision.intent_seeds.map((seed, i) => ({
      id: `seed_${Date.now()}_${i}`,
      category: toIntentCategory(seed.category),
      description: seed.description,
      intensity: Math.min(10, Math.max(0, seed.intensity)),
      source: 'accumulation' as const,
      born_at: now.toISOString(),
      decay_rate: 0.3,
      satisfied_at: null,
    })),
    last_updated: now.toISOString(),
  };

  // Build emotion state for morning (using ESTP baseline from spec)
  const emotion: EmotionState = {
    mood: { valence: EMOTION_BASELINE.valence!, arousal: EMOTION_BASELINE.arousal!, description: decision.mood_description },
    energy: EMOTION_BASELINE.energy! + 0.1, // Slightly above baseline: morning freshness
    stress: EMOTION_BASELINE.stress!,
    creativity: EMOTION_BASELINE.creativity!,
    sociability: EMOTION_BASELINE.sociability!,
    last_updated: now.toISOString(),
    recent_cause: '晨规划',
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
    date: now.toISOString().split('T')[0],
    heartbeats,
  };

  // Write diary entry
  appendText(PATHS.diary, `\n## ${now.toISOString().split('T')[0]} ${decision.wake_time}\n${decision.diary_entry}\n情绪: ${decision.mood_description} | 重要性: 3\n标签: morning, plan\n`);

  // Write all state
  writeJSON(PATHS.scheduleToday, scheduleToday);
  writeJSON(PATHS.intentPool, intentPool);
  writeJSON(PATHS.emotionState, emotion);
  writeJSON(PATHS.cronSchedule, cronSchedule);

  // Add morning heartbeat log entry
  const morningLogEntry: HeartbeatLogEntry = {
    timestamp: now.toISOString(),
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
