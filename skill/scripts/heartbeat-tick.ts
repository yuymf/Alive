#!/usr/bin/env node
/**
 * heartbeat-tick.ts
 * Main heartbeat entry point — called every hour by OpenClaw cron.
 * Routes to morning-plan, night-reflect, or regular tick. (Spec §10)
 *
 * Usage: node heartbeat-tick.js
 */

import {
  EmotionState, IntentPool, ScheduleToday, EventQueue,
  HeartbeatLog, HeartbeatLogEntry, ActionOutput, RigidSchedule, WisdomStore,
} from './types';
import { PATHS, readJSON, writeJSON, appendText, readText, readTemplate } from './file-utils';
import { decayTowardBaseline, applyDelta } from './emotion-engine';
import {
  decaySatisfied, accumulateIntents, applyEventBoosts,
  injectScheduleIntents, getTopIntents, satisfyIntent, addIntent,
} from './intent-engine';
import { callLLMJSON } from './llm-client';

// Default initial states (Spec §16)
const DEFAULT_EMOTION: EmotionState = {
  mood: { valence: 0.3, arousal: 0.5, description: '刚醒来' },
  energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
  last_updated: null, recent_cause: '初始化',
};
const DEFAULT_INTENT_POOL: IntentPool = { intents: [], last_updated: null };
const DEFAULT_SCHEDULE: ScheduleToday = { date: null, rigid: [], flexible: [], generated_by: null };
const DEFAULT_EVENT_QUEUE: EventQueue = { events: [], max_size: 50 };
const DEFAULT_HEARTBEAT_LOG: HeartbeatLog = { logs: [], retention_days: 7 };

interface HeartbeatDecision {
  inner_monologue: string;
  new_impulses: Array<{ category: string; description: string; intensity: number }>;
  suppressed_intents: string[];
  chosen_actions: Array<{
    action: string;
    type: 'real' | 'simulated' | 'inner';
    skill: string | null;
    satisfies_intent: string | null;
  }>;
}

function getCurrentHour(): number {
  return new Date().getHours();
}

function formatTime(): string {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

/**
 * Get the active rigid schedule for the current time (Spec §3).
 */
function getActiveRigidSchedule(schedule: ScheduleToday, hour: number, weekday: number): RigidSchedule | null {
  for (const rigid of schedule.rigid) {
    if (!rigid.weekdays.includes(weekday)) continue;
    const startH = parseInt(rigid.start.split(':')[0], 10);
    const endH = parseInt(rigid.end.split(':')[0], 10);
    if (hour >= startH && hour < endH) return rigid;
  }
  return null;
}

/**
 * Build the perception summary (Spec §4).
 */
function buildPerceptionSummary(
  emotion: EmotionState,
  schedule: ScheduleToday,
  events: EventQueue,
  hour: number,
  weekday: number,
): string {
  const rigidNow = getActiveRigidSchedule(schedule, hour, weekday);
  const unprocessedEvents = events.events.filter(e => !e.processed);

  const parts: string[] = [];
  parts.push(`时间: ${formatTime()}`);
  parts.push(`情绪: valence=${emotion.mood.valence.toFixed(1)}, arousal=${emotion.mood.arousal.toFixed(1)}, energy=${emotion.energy.toFixed(1)}, stress=${emotion.stress.toFixed(1)}, creativity=${emotion.creativity.toFixed(1)}, sociability=${emotion.sociability.toFixed(1)}`);
  parts.push(`情绪描述: ${emotion.mood.description}`);

  if (rigidNow) {
    parts.push(`当前日程: ${rigidNow.activity}（可做: ${rigidNow.allowed_actions.join(', ')}）`);
  } else {
    parts.push('当前日程: 自由时段');
  }

  if (unprocessedEvents.length > 0) {
    parts.push(`未处理事件: ${unprocessedEvents.length}个`);
    for (const e of unprocessedEvents.slice(0, 5)) {
      parts.push(`  - [${e.type}] ${JSON.stringify(e.data).slice(0, 100)}`);
    }
  } else {
    parts.push('未处理事件: 无');
  }

  return parts.join('\n');
}

/**
 * Execute a simulated action via LLM (Spec §5).
 */
async function executeSimulatedAction(
  actionDesc: string,
  emotion: EmotionState,
  scheduleContext: string,
): Promise<ActionOutput> {
  const template = readTemplate('simulated-action.md');
  const prompt = template
    .replace('{action_description}', actionDesc)
    .replace('{emotion_summary}', `${emotion.mood.description} (valence: ${emotion.mood.valence.toFixed(1)})`)
    .replace('{current_time}', formatTime())
    .replace('{schedule_context}', scheduleContext);

  return callLLMJSON<ActionOutput>(prompt, 800);
}

/**
 * Regular heartbeat tick (Spec §10).
 */
async function regularTick(): Promise<void> {
  const now = new Date();
  const hour = now.getHours();
  const weekday = now.getDay() === 0 ? 7 : now.getDay(); // 1=Mon..7=Sun

  // 1. Read state
  let emotion = readJSON<EmotionState>(PATHS.emotionState, DEFAULT_EMOTION);
  let intentPool = readJSON<IntentPool>(PATHS.intentPool, DEFAULT_INTENT_POOL);
  const schedule = readJSON<ScheduleToday>(PATHS.scheduleToday, DEFAULT_SCHEDULE);
  const events = readJSON<EventQueue>(PATHS.eventQueue, DEFAULT_EVENT_QUEUE);
  const heartbeatLog = readJSON<HeartbeatLog>(PATHS.heartbeatLog, DEFAULT_HEARTBEAT_LOG);
  const recentDiary = readText(PATHS.diary).split('\n').slice(-20).join('\n');
  const worldContext = readText(PATHS.world).split('\n').slice(-10).join('\n');

  // 2. Perception: decay emotion + process events
  emotion = decayTowardBaseline(emotion);

  // Count consecutive active heartbeats for rest calculation
  const recentLogs = heartbeatLog.logs.filter(l => l.status === 'completed').slice(-10);
  const consecutiveActive = recentLogs.length;

  // Hours since last post (scan diary for post entries)
  const diary = readText(PATHS.diary);
  const lastPostMatch = diary.match(/发了新 Instagram 帖子/g);
  const lastPostHoursAgo = lastPostMatch ? 24 : 72; // Simplified: check diary more thoroughly in production

  // 3. Intent phase: rule engine
  intentPool = decaySatisfied(intentPool);
  intentPool = accumulateIntents(intentPool, hour, lastPostHoursAgo, consecutiveActive, events.events.some(e => !e.processed));
  intentPool = applyEventBoosts(intentPool, events);
  intentPool = injectScheduleIntents(intentPool, schedule, hour);

  // 4. Build perception summary
  const rigidNow = getActiveRigidSchedule(schedule, hour, weekday);
  const perceptionSummary = buildPerceptionSummary(emotion, schedule, events, hour, weekday);

  // 5. Intent phase: LLM decision
  const template = readTemplate('heartbeat-prompt.md');
  const intentSummary = getTopIntents(intentPool, 7)
    .map(i => `- [${i.category}] ${i.description} (强度: ${i.intensity.toFixed(1)}) id=${i.id}`)
    .join('\n');

  const personalityDrift = readJSON(PATHS.personalityDrift, { base: 'ESTP', modifiers: [] });
  const personalityContext = `ESTP基底。${personalityDrift.modifiers.map((m: { effect: string }) => m.effect).join('；')}`;

  const scheduleContext = rigidNow
    ? `${rigidNow.activity}中，可做: ${rigidNow.allowed_actions.join(', ')}`
    : '自由时段';

  const prompt = template
    .replace('{current_time}', formatTime())
    .replace('{emotion_summary}', `${emotion.mood.description} (v:${emotion.mood.valence.toFixed(1)} a:${emotion.mood.arousal.toFixed(1)} e:${emotion.energy.toFixed(1)})`)
    .replace('{schedule_context}', scheduleContext)
    .replace('{recent_diary}', recentDiary)
    .replace('{perception_summary}', perceptionSummary)
    .replace('{intent_pool_summary}', intentSummary || '（空）')
    .replace('{personality_context}', personalityContext);

  let decision: HeartbeatDecision;
  try {
    decision = await callLLMJSON<HeartbeatDecision>(prompt, 1024);
  } catch (err) {
    // LLM failed — log and skip (Spec §13)
    const logEntry: HeartbeatLogEntry = {
      timestamp: now.toISOString(),
      type: 'regular',
      status: 'skipped',
      error: (err as Error).message,
    };
    const updatedLog = { ...heartbeatLog, logs: [...heartbeatLog.logs, logEntry] };
    writeJSON(PATHS.heartbeatLog, updatedLog);
    console.error(`Heartbeat skipped: ${(err as Error).message}`);
    return;
  }

  // 6. Apply LLM decisions to intent pool
  for (const impulse of decision.new_impulses) {
    intentPool = addIntent(intentPool, impulse.category as any, impulse.description, impulse.intensity, 'llm');
  }

  // 7. Execute actions
  let totalImportance = 0;
  const actionResults: string[] = [];

  for (const action of decision.chosen_actions) {
    if (action.satisfies_intent) {
      intentPool = satisfyIntent(intentPool, action.satisfies_intent);
    }

    if (action.type === 'simulated' || action.type === 'inner') {
      try {
        const result = await executeSimulatedAction(action.action, emotion, scheduleContext);
        emotion = applyDelta(emotion, result.emotion_delta, result.narrative.slice(0, 50));
        appendText(PATHS.diary, `\n## ${now.toISOString().split('T')[0]} ${now.toISOString().split('T')[1].slice(0, 5)}\n${result.diary_entry}\n情绪: ${emotion.mood.description} | 重要性: 4\n标签: heartbeat, ${action.type}\n`);
        totalImportance += 4;
        actionResults.push(action.action);
      } catch (err) {
        console.error(`Action failed: ${action.action}: ${(err as Error).message}`);
      }
    } else if (action.type === 'real' && action.skill) {
      // Real actions — log placeholder, actual skill execution is future work
      console.log(`[REAL ACTION] Would call skill: ${action.skill} for: ${action.action}`);
      actionResults.push(`[real] ${action.action}`);
    }
  }

  // 8. Write inner monologue to diary
  if (decision.inner_monologue) {
    appendText(PATHS.diary, `\n> 💭 ${decision.inner_monologue}\n`);
  }

  // 9. Mark events as processed
  const updatedEvents: EventQueue = {
    ...events,
    events: events.events.map(e => ({ ...e, processed: true })),
  };

  // 10. Update reflection counter (immutable)
  const wisdom = readJSON<WisdomStore>(PATHS.coreWisdom, { version: 1, wisdom: [], total_importance_since_reflection: 0 });
  const updatedWisdom: WisdomStore = {
    ...wisdom,
    total_importance_since_reflection: wisdom.total_importance_since_reflection + totalImportance,
  };
  writeJSON(PATHS.coreWisdom, updatedWisdom);

  // 11. Write all state
  emotion = { ...emotion, last_updated: now.toISOString() };
  intentPool = { ...intentPool, last_updated: now.toISOString() };
  writeJSON(PATHS.emotionState, emotion);
  writeJSON(PATHS.intentPool, intentPool);
  writeJSON(PATHS.eventQueue, updatedEvents);

  const logEntry: HeartbeatLogEntry = {
    timestamp: now.toISOString(),
    type: 'regular',
    status: 'completed',
    perception_summary: perceptionSummary.slice(0, 200),
    chosen_actions: actionResults,
    emotion_after: { mood: emotion.mood, energy: emotion.energy },
    importance_added: totalImportance,
  };
  let updatedLog = { ...heartbeatLog, logs: [...heartbeatLog.logs, logEntry] };
  // Enforce 100KB size limit (Spec §13)
  const logJson = JSON.stringify(updatedLog);
  if (logJson.length > 100_000) {
    updatedLog = { ...updatedLog, logs: updatedLog.logs.slice(-50) };
  }
  writeJSON(PATHS.heartbeatLog, updatedLog);

  console.log(`Heartbeat completed at ${formatTime()}. Actions: ${actionResults.join(', ') || 'none'}`);
}

// Entry point: route to the right handler
async function main(): Promise<void> {
  const hour = getCurrentHour();

  if (hour === 7) {
    // Morning plan — delegate to morning-plan.ts
    console.log('Morning heartbeat — running morning plan');
    const { runMorningPlan } = require('./morning-plan');
    await runMorningPlan();
    return;
  }

  if (hour === 23) {
    // Night reflection — delegate to night-reflect.ts
    console.log('Night heartbeat — running night reflection');
    const { runNightReflect } = require('./night-reflect');
    await runNightReflect();
    return;
  }

  if (hour >= 0 && hour < 7) {
    // Sleep hours — do nothing (Spec §1)
    console.log('Sleep hours — no heartbeat.');
    return;
  }

  await regularTick();
}

main().catch(err => {
  console.error('Heartbeat error:', err.message);
  // Write error to log even on crash
  try {
    const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, DEFAULT_HEARTBEAT_LOG);
    const errorLog: HeartbeatLog = {
      ...log,
      logs: [...log.logs, {
        timestamp: new Date().toISOString(),
        type: 'regular',
        status: 'skipped',
        error: err.message,
      }],
    };
    writeJSON(PATHS.heartbeatLog, errorLog);
  } catch { /* best effort */ }
  process.exit(1);
});
