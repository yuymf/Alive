#!/usr/bin/env node
/**
 * heartbeat-tick.ts
 * Main heartbeat entry point — called every hour by OpenClaw cron.
 * Routes to morning-plan, night-reflect, or regular tick. (Spec §10)
 *
 * Usage: node heartbeat-tick.js
 */

import {
  EmotionState, IntentPool, IntentCategory, ScheduleToday, EventQueue,
  HeartbeatLog, HeartbeatLogEntry, ActionOutput, RigidSchedule, WisdomStore,
  SocialRelation, SocialMeta, VitalityState, ConfidenceState, PostHistory,
  CronSchedule,
} from './types';
import { PATHS, readJSON, writeJSON, appendText, readText, readTemplate, readAllJSON, writeSocialRelation } from './file-utils';
import { decayTowardBaseline, applyDelta, computeEmotionIntentCoupling, intentSatisfactionFeedback } from './emotion-engine';
import {
  decaySatisfied, accumulateIntents, applyEventBoosts,
  injectScheduleIntents, getTopIntents, satisfyIntent, addIntent,
} from './intent-engine';
import { callLLMJSON } from './llm-client';
import { runMorningPlan } from './morning-plan';
import { runNightReflect } from './night-reflect';
import {
  decayAllRelations, processDormancy, generateSocialIntents,
  updateMetaStats, reactivateRelation, classifyTier,
} from './social-graph-engine';
import { spawn } from 'child_process';
import { drainVitality, applyActionCost, replenishVitality, getVitalityConstraints, DEFAULT_VITALITY } from './vitality-engine';
import { updateConfidence, decayConfidence, getCreationRateMultiplier, getConfidenceMoodHint, DEFAULT_CONFIDENCE } from './confidence-engine';
import { rollRandomEvent } from './random-events';
import { isActiveHeartbeatHour } from './heartbeat-gate';
import { getLocalDate, getLocalHour, getLocalWeekday, formatLocalTime, getLocalTimeHHMM } from './time-utils';

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

const VALID_CATEGORIES: ReadonlySet<string> = new Set<IntentCategory>(['创作', '社交', '窥屏', '表达', '学习', '休息', '梦想']);

function toIntentCategory(s: string): IntentCategory {
  return VALID_CATEGORIES.has(s) ? s as IntentCategory : '表达';
}

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

function formatTime(): string {
  return formatLocalTime();
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
  worldContext: string,
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

  if (worldContext) {
    parts.push(`世界动态: ${worldContext}`);
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
  const hour = getLocalHour(now);
  const weekday = getLocalWeekday(now);
  const todayStr = getLocalDate(now);
  const timeStr = getLocalTimeHHMM(now);

  // 1. Read state
  let emotion = readJSON<EmotionState>(PATHS.emotionState, DEFAULT_EMOTION);
  let intentPool = readJSON<IntentPool>(PATHS.intentPool, DEFAULT_INTENT_POOL);
  const schedule = readJSON<ScheduleToday>(PATHS.scheduleToday, DEFAULT_SCHEDULE);
  const events = readJSON<EventQueue>(PATHS.eventQueue, DEFAULT_EVENT_QUEUE);
  const heartbeatLog = readJSON<HeartbeatLog>(PATHS.heartbeatLog, DEFAULT_HEARTBEAT_LOG);
  const diary = readText(PATHS.diary);
  const recentDiary = diary.split('\n').slice(-20).join('\n');
  const worldContext = readText(PATHS.world).split('\n').slice(-10).join('\n');
  let vitality = readJSON<VitalityState>(PATHS.vitalityState, DEFAULT_VITALITY);
  let confidence = readJSON<ConfidenceState>(PATHS.confidenceState, DEFAULT_CONFIDENCE);

  // 2. Perception: decay emotion + drain vitality
  emotion = decayTowardBaseline(emotion);
  vitality = drainVitality(vitality, emotion);
  confidence = decayConfidence(confidence);

  // 2b. Social graph: decay relations, process dormancy, generate social intents
  const socialMeta = readJSON<SocialMeta>(PATHS.socialMeta, { instagram_following: [], xiaohongshu_following: [], stats: { core: 0, familiar: 0, cognitive: 0, dormant: 0 } });
  let socialRelations = readAllJSON<SocialRelation>(PATHS.socialInstagramDir);
  socialRelations = decayAllRelations(socialRelations, now);
  const dormancyResult = processDormancy(socialRelations, now);
  socialRelations = dormancyResult.active;

  // 2c. Reactivate dormant relations with new interactions
  const unprocessedEvents = events.events.filter(e => !e.processed);
  for (const event of unprocessedEvents) {
    const eventUserId = (event.data as { user_id?: string }).user_id;
    if (!eventUserId) continue;
    socialRelations = socialRelations.map(r =>
      r.id === eventUserId && classifyTier(r.relationship.closeness) === 'dormant'
        ? reactivateRelation(r, now.toISOString())
        : r
    );
  }
  const socialIntents = generateSocialIntents(socialRelations, socialMeta, now);

  // Write updated social relations back
  for (const r of socialRelations) {
    writeSocialRelation(PATHS.socialInstagramDir, r);
  }
  const updatedMeta = updateMetaStats(socialMeta, socialRelations);
  writeJSON(PATHS.socialMeta, updatedMeta);

  // Count consecutive active heartbeats for rest calculation
  const recentLogs = heartbeatLog.logs.filter(l => l.status === 'completed').slice(-10);
  const consecutiveActive = recentLogs.length;

  // Hours since last post (scan diary for post entries)
  const lastPostMatch = diary.match(/发了新 Instagram 帖子/g);
  const lastPostHoursAgo = lastPostMatch ? 24 : 72; // Simplified: check diary more thoroughly in production

  // 3. Intent phase: rule engine
  intentPool = decaySatisfied(intentPool);
  intentPool = accumulateIntents(intentPool, hour, lastPostHoursAgo, consecutiveActive, events.events.some(e => !e.processed));
  intentPool = applyEventBoosts(intentPool, events);
  intentPool = injectScheduleIntents(intentPool, schedule, hour);

  // 3b. Inject social graph intents
  for (const si of socialIntents) {
    intentPool = addIntent(intentPool, si.category, si.description, si.intensity, 'accumulation');
  }

  // 3c. Apply emotion→intent coupling (non-linear dimension interaction)
  const couplingMultipliers = computeEmotionIntentCoupling(emotion);
  const vitalityConstraints = getVitalityConstraints(vitality.vitality);
  const creationMultiplier = getCreationRateMultiplier(confidence.confidence);
  intentPool = {
    ...intentPool,
    intents: intentPool.intents.map(i => {
      if (i.satisfied_at !== null) return i;
      const coupling = couplingMultipliers[i.category] ?? 1.0;
      const vitalityMod = vitalityConstraints.intentMultiplier;
      const confidenceMod = i.category === '创作' ? creationMultiplier : 1.0;
      const adjustedIntensity = Math.min(10, i.intensity * coupling * vitalityMod * confidenceMod);
      return adjustedIntensity !== i.intensity ? { ...i, intensity: adjustedIntensity } : i;
    }),
  };

  // 3d. Random perturbation: "life happens"
  const randomEvent = rollRandomEvent();
  if (randomEvent) {
    emotion = applyDelta(emotion, randomEvent.emotion_delta, randomEvent.description);
    for (const boost of randomEvent.intent_boosts) {
      intentPool = addIntent(intentPool, boost.category, randomEvent.description, boost.boost, 'event');
    }
    appendText(PATHS.diary, `\n## ${todayStr} ${timeStr}\n${randomEvent.diary_entry}\n情绪: ${emotion.mood.description} | 重要性: 3\n标签: 随机事件\n`);
    console.log(`Random event: ${randomEvent.description}`);
  }

  // 4. Build perception summary
  const rigidNow = getActiveRigidSchedule(schedule, hour, weekday);
  const perceptionSummary = buildPerceptionSummary(emotion, schedule, events, hour, weekday, worldContext);

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
    .replace('{personality_context}', personalityContext)
    .replace('{vitality_context}', `活力: ${Math.round(vitality.vitality)}/100${vitalityConstraints.moodModifier ? ` (${vitalityConstraints.moodModifier})` : ''}`)
    .replace('{confidence_context}', getConfidenceMoodHint(confidence.confidence));

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
    intentPool = addIntent(intentPool, toIntentCategory(impulse.category), impulse.description, impulse.intensity, 'llm');
  }

  // 7. Execute actions
  let totalImportance = 0;
  const actionResults: string[] = [];

  for (const action of decision.chosen_actions) {
    if (action.satisfies_intent) {
      const satisfiedIntent = intentPool.intents.find(i => i.id === action.satisfies_intent);
      intentPool = satisfyIntent(intentPool, action.satisfies_intent);
      // Intent satisfaction → emotion feedback (dimension coupling)
      if (satisfiedIntent) {
        emotion = intentSatisfactionFeedback(emotion, satisfiedIntent.category);
      }
    }

    if (action.type === 'simulated' || action.type === 'inner') {
      try {
        const result = await executeSimulatedAction(action.action, emotion, scheduleContext);
        emotion = applyDelta(emotion, result.emotion_delta, result.narrative.slice(0, 50));

        // Vitality: replenish from rest actions, drain from intense actions
        if (action.action.includes('休息') || action.action.includes('摸鱼') || action.action.includes('追番')) {
          vitality = replenishVitality(vitality, 'rest');
        } else if (action.action.includes('刷') || action.action.includes('看手机')) {
          vitality = replenishVitality(vitality, 'browsing_light');
        }

        appendText(PATHS.diary, `\n## ${todayStr} ${timeStr}\n${result.diary_entry}\n情绪: ${emotion.mood.description} | 重要性: 4\n标签: heartbeat, ${action.type}\n`);
        totalImportance += 4;
        actionResults.push(action.action);

        // Trigger inspiration refresh on browsing actions
        if (action.action.includes('刷') || action.action.includes('看手机') || action.action.includes('窥屏')) {
          try {
            const { refreshInspiration } = await import('./inspiration-collector');
            await refreshInspiration();
          } catch (inspErr) {
            console.error(`Inspiration refresh failed: ${(inspErr as Error).message}`);
          }
        }
      } catch (err) {
        console.error(`Action failed: ${action.action}: ${(err as Error).message}`);
      }
    } else if (action.type === 'real' && action.skill) {
      // Real actions — spawn detached child process
      if (action.skill === 'post-pipeline' || action.skill === 'auto-photo') {
        // Vitality gate: cannot post when vitality is low
        if (!vitalityConstraints.canPost) {
          console.log(`[REAL ACTION] Skipped post-pipeline — vitality too low (${Math.round(vitality.vitality)})`);
          actionResults.push(`[skipped:low-vitality] ${action.action}`);
          continue;
        }
        vitality = applyActionCost(vitality, 'post-pipeline');
        const scriptPath = require.resolve('./post-pipeline');
        const child = spawn('node', [scriptPath], {
          detached: true,
          stdio: 'ignore',
          env: process.env,
        });
        child.unref();
        console.log(`[REAL ACTION] Spawned post-pipeline (pid: ${child.pid}) for: ${action.action}`);
      } else {
        console.log(`[REAL ACTION] Unknown skill: ${action.skill} for: ${action.action}`);
      }
      actionResults.push(`[real] ${action.action}`);
    }
  }

  // 8. Write inner monologue to diary
  if (decision.inner_monologue) {
    appendText(PATHS.diary, `\n> 💭 ${decision.inner_monologue}\n`);
  }

  // 8b. Check post stats for 24h-old posts (lightweight, runs each heartbeat)
  try {
    const { checkPostStats } = await import('./post-pipeline');
    await checkPostStats();
    // Update confidence based on latest stats
    const postHistory = readJSON<PostHistory>(PATHS.postHistory, { posts: [] });
    confidence = updateConfidence(confidence, postHistory);
  } catch (err) {
    console.error(`Stats check failed: ${(err as Error).message}`);
  }

  // 9. Mark events as processed and enforce max_size (Spec §13)
  const processedEvents = events.events.map(e => ({ ...e, processed: true }));
  const trimmedEvents = processedEvents.length > events.max_size
    ? processedEvents.slice(-events.max_size)
    : processedEvents;
  const updatedEvents: EventQueue = {
    ...events,
    events: trimmedEvents,
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
  vitality = { ...vitality, last_updated: now.toISOString() };
  confidence = { ...confidence, last_updated: now.toISOString() };
  writeJSON(PATHS.emotionState, emotion);
  writeJSON(PATHS.intentPool, intentPool);
  writeJSON(PATHS.eventQueue, updatedEvents);
  writeJSON(PATHS.vitalityState, vitality);
  writeJSON(PATHS.confidenceState, confidence);

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
  const now = new Date();
  const hour = getLocalHour(now);
  const todayStr = getLocalDate(now);

  // Read today's cron schedule (written by morning plan)
  const cronSchedule = readJSON<CronSchedule>(PATHS.cronSchedule, { date: '', heartbeats: [] });

  // First-wake detection: if schedule date doesn't match today,
  // this is the first tick of the day — run morning plan regardless of hour.
  if (cronSchedule.date !== todayStr) {
    console.log(`First wake of ${todayStr} (schedule date: ${cronSchedule.date || 'none'}) — running morning plan`);
    await runMorningPlan();
    return;
  }

  const activeHeartbeat = isActiveHeartbeatHour(hour, cronSchedule);

  if (!activeHeartbeat) {
    console.log(`Hour ${hour} is not in today's heartbeat schedule — skipping.`);
    return;
  }

  switch (activeHeartbeat.type) {
    case 'morning':
      console.log('Morning heartbeat — running morning plan');
      await runMorningPlan();
      break;
    case 'night':
      console.log('Night heartbeat — running night reflection');
      await runNightReflect();
      break;
    case 'regular':
      await regularTick();
      break;
  }
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
