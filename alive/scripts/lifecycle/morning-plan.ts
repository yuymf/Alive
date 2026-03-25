#!/usr/bin/env node
/**
 * morning-plan.ts
 * Morning heartbeat — generates today's schedule, intent seeds, and cron config.
 * Generalized: no travel state, no Instagram sync, no inspiration collector.
 * Sub-skills handle domain-specific morning tasks via onMorning() hooks.
 */

import {
  EmotionState, IntentPool, IntentCategory, ScheduleToday, EventQueue,
  HeartbeatLog, HeartbeatLogEntry, CronSchedule, Aspirations, RigidSchedule,
  DEFAULT_MOMENTUM, BASE_RESISTANCE,
  FlowState, DEFAULT_FLOW_STATE,
  ChainAndCooldownState, DEFAULT_CHAIN_STATE,
  VitalityState,
} from '../utils/types';
import { PATHS, readJSON, writeJSON, appendText, readText, readTemplate } from '../utils/file-utils';
import { now, getLocalDate, getLocalWeekday, formatLocalTime, setTimezone } from '../utils/time-utils';
import { getEmotionBaseline, getDefaultUndertone, getScheduleConfig, loadPersona, injectPersona, buildVoiceSignature } from '../persona/persona-loader';
import { morningRecovery, DEFAULT_VITALITY } from '../engines/vitality';

const VALID_CATEGORIES: ReadonlySet<string> = new Set<IntentCategory>(['创作', '社交', '窥屏', '表达', '学习', '休息', '梦想']);

function toIntentCategory(s: string): IntentCategory {
  return VALID_CATEGORIES.has(s) ? s as IntentCategory : '表达';
}

interface MorningPlanDecision {
  mood_description: string;
  wake_time: string;
  sleep_time: string;
  flexible_schedule: Array<{ activity: string; preferred_time: string; intent_boost: number; intent_category: string }>;
  intent_seeds: Array<{ category: string; description: string; intensity: number }>;
  diary_entry: string;
}

export async function runMorningPlan(
  llm: { callJSON<T>(prompt: string, maxTokens?: number): Promise<T> },
): Promise<void> {
  const persona = loadPersona();
  // Set timezone from persona config before any time operations
  setTimezone(persona.schedule?.timezone ?? null);

  const currentTime = now();
  const weekday = getLocalWeekday(currentTime);
  const todayStr = getLocalDate(currentTime);
  const scheduleConfig = getScheduleConfig(persona);
  const baseline = getEmotionBaseline(persona);
  const defaultUndertone = getDefaultUndertone(persona);

  // Read yesterday's log
  const heartbeatLog = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
  const yesterday = getLocalDate(new Date(currentTime.getTime() - 86400000));
  const yesterdayLogs = heartbeatLog.logs.filter(l => l.timestamp.startsWith(yesterday));
  const yesterdaySummary = yesterdayLogs.length > 0
    ? yesterdayLogs.map(l => `${l.timestamp.split('T')[1].slice(0, 5)}: ${l.chosen_actions?.join(', ') || l.status}`).join('\n')
    : '昨天好像断片了……不太记得发生了什么。';

  // Rotate old logs (7 day retention)
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

  // Morning vitality recovery: simulate overnight sleep
  const prevVitality = readJSON<VitalityState>(PATHS.vitalityState, DEFAULT_VITALITY);
  const recoveredVitality = morningRecovery(prevVitality);
  writeJSON(PATHS.vitalityState, recoveredVitality);
  console.log(`Vitality: ${Math.round(prevVitality.vitality)} → ${Math.round(recoveredVitality.vitality)} (morning recovery)`);

  // Build prompt (inject persona placeholders)
  let template = readTemplate('morning-plan-prompt.md');
  template = injectPersona(template, persona);

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
    .replace('{rigid_schedule_template}', '今天没有预设的固定日程');

  const decision = await llm.callJSON<MorningPlanDecision>(prompt);

  // Build schedule-today.json (no rigid schedule by default; sub-skills can inject)
  const scheduleToday: ScheduleToday = {
    date: todayStr,
    rigid: [],
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

  // Build emotion state for morning (using persona MBTI baseline)
  const morningUndertone = {
    valence: baseline.valence ?? defaultUndertone.valence,
    arousal: baseline.arousal ?? defaultUndertone.arousal,
    energy: (baseline.energy ?? defaultUndertone.energy) + 0.1,
    stress: baseline.stress ?? defaultUndertone.stress,
    creativity: baseline.creativity ?? defaultUndertone.creativity,
    sociability: baseline.sociability ?? defaultUndertone.sociability,
  };
  const emotion: EmotionState = {
    mood: { valence: baseline.valence ?? 0.2, arousal: baseline.arousal ?? 0.4, description: decision.mood_description },
    energy: (baseline.energy ?? 0.5) + 0.1,
    stress: baseline.stress ?? 0.2,
    creativity: baseline.creativity ?? 0.4,
    sociability: baseline.sociability ?? 0.4,
    last_updated: currentTime.toISOString(),
    recent_cause: '晨规划',
    momentum: { ...DEFAULT_MOMENTUM },
    undertone: morningUndertone,
    impulse_history: [],
    consecutive_high_stress: 0,
    threshold_break_cooldown: 0,
  };

  // Build cron schedule
  const wakeHour = parseInt(decision.wake_time.split(':')[0], 10) || scheduleConfig.wake_hour;
  const sleepHour = parseInt(decision.sleep_time.split(':')[0], 10) || scheduleConfig.sleep_hour;
  const heartbeats: CronSchedule['heartbeats'] = [];
  heartbeats.push({ time: decision.wake_time, type: 'morning' });
  for (let h = wakeHour + 1; h < sleepHour; h++) {
    heartbeats.push({ time: `${h.toString().padStart(2, '0')}:00`, type: 'regular' });
  }
  heartbeats.push({ time: decision.sleep_time, type: 'night' });

  const cronSchedule: CronSchedule = { date: todayStr, heartbeats };

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
