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
  CronSchedule, PostImpulseState, DEFAULT_POST_IMPULSE,
  DEFAULT_MOMENTUM, DEFAULT_UNDERTONE,
  FlowState, DEFAULT_FLOW_STATE,
  ChainAndCooldownState, DEFAULT_CHAIN_STATE,
  hydrateEmotionState, hydrateIntent,
} from './types';
import { PATHS, readJSON, writeJSON, appendText, readText, readTemplate, readAllJSON, writeSocialRelation } from './file-utils';
import {
  decayTowardBaseline, applyDelta, computeEmotionIntentCoupling,
  intentSatisfactionFeedback, decayThreeLayer, applyImpulse,
  rollRumination, checkThresholdBreak,
} from './emotion-engine';
import {
  decaySatisfied, accumulateIntents, applyEventBoosts,
  injectScheduleIntents, getTopIntents, getTopIntentsRaw, satisfyIntent, addIntent,
  applyResistanceToPool, checkImpulseBreakthrough, processProcrastination,
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
import { rollContextAwareEvent, processChainEvents, EventContext } from './random-events';
import { isActiveHeartbeatHour } from './heartbeat-gate';
import { accumulateImpulse, decayImpulse, shouldInjectPostDesire, checkDormancy } from './post-impulse';
import { now, getLocalDate, getLocalHour, getLocalWeekday, formatLocalTime, getLocalTimeHHMM } from './time-utils';
import { executeSearch } from './search-pipeline';
import {
  checkFlowEntry, checkDriftEntry, checkFlowExit, checkDriftExit,
  tickFlow, resetFlow, generateFlowDiary, generateDriftDiary,
  computeVoiceDirective, LastAction,
} from './flow-engine';

// Default initial states (Spec §16)
const DEFAULT_EMOTION: EmotionState = {
  mood: { valence: 0.3, arousal: 0.5, description: '刚醒来' },
  energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
  last_updated: null, recent_cause: '初始化',
  momentum: { ...DEFAULT_MOMENTUM },
  undertone: { ...DEFAULT_UNDERTONE },
  impulse_history: [],
  consecutive_high_stress: 0,
  threshold_break_cooldown: 0,
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
  impulse?: PostImpulseState,
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

  if (impulse && shouldInjectPostDesire(impulse)) {
    parts.push(`\n【发帖冲动】想发帖的冲动很强（冲动值：${Math.round(impulse.value)}/100）。如果决定发帖，请在 chosen_actions 中使用 type: "real", skill: "post-pipeline"。`);
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
  voiceDirective: string = '',
): Promise<ActionOutput> {
  const template = readTemplate('simulated-action.md');
  const prompt = template
    .replace('{action_description}', actionDesc)
    .replace('{emotion_summary}', `${emotion.mood.description} (valence: ${emotion.mood.valence.toFixed(1)})`)
    .replace('{current_time}', formatTime())
    .replace('{schedule_context}', scheduleContext)
    .replace('{voice_directive}', voiceDirective || '正常叙事语气。');

  return callLLMJSON<ActionOutput>(prompt, 800);
}

/**
 * Execute the post-pipeline action (extract to avoid duplication between exact and fuzzy match).
 */
async function executePostPipeline(
  action: { action: string; skill: string | null },
  vitalityState: VitalityState,
  actionResults: string[],
  canPost: boolean,
): Promise<VitalityState> {
  if (!canPost) {
    console.log(`[REAL ACTION] Skipped post-pipeline — vitality too low (${Math.round(vitalityState.vitality)})`);
    actionResults.push(`[skipped:low-vitality] ${action.action}`);
    return vitalityState;
  }
  const updatedVitality = applyActionCost(vitalityState, 'post-pipeline');
  if (process.env.E2E_INLINE_PIPELINE === '1') {
    try {
      const { runPipeline } = await import('./post-pipeline');
      console.log(`[REAL ACTION] Running post-pipeline inline for: ${action.action}`);
      await runPipeline();
    } catch (pipeErr) {
      console.error(`[REAL ACTION] Inline post-pipeline failed: ${(pipeErr as Error).message}`);
    }
  } else {
    const scriptPath = require.resolve('./post-pipeline');
    const child = spawn('node', [scriptPath], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    console.log(`[REAL ACTION] Spawned post-pipeline (pid: ${child.pid}) for: ${action.action}`);
  }
  actionResults.push(`[real] ${action.action}`);
  return updatedVitality;
}

/**
 * Regular heartbeat tick (Spec §10).
 */
export async function regularTick(): Promise<void> {
  const currentTime = now();
  const hour = getLocalHour(currentTime);
  const weekday = getLocalWeekday(currentTime);
  const todayStr = getLocalDate(currentTime);
  const timeStr = getLocalTimeHHMM(currentTime);

  // 1. Read state (+ hydration for backward compat)
  let emotion = hydrateEmotionState(readJSON(PATHS.emotionState, DEFAULT_EMOTION) as unknown as Record<string, unknown>);
  let intentPool: IntentPool = readJSON<IntentPool>(PATHS.intentPool, DEFAULT_INTENT_POOL);
  intentPool = {
    ...intentPool,
    intents: intentPool.intents.map(i => hydrateIntent(i as unknown as Record<string, unknown>)),
  };
  const schedule = readJSON<ScheduleToday>(PATHS.scheduleToday, DEFAULT_SCHEDULE);
  const events = readJSON<EventQueue>(PATHS.eventQueue, DEFAULT_EVENT_QUEUE);
  const heartbeatLog = readJSON<HeartbeatLog>(PATHS.heartbeatLog, DEFAULT_HEARTBEAT_LOG);
  const diary = readText(PATHS.diary);
  const recentDiary = diary.split('\n').slice(-20).join('\n');
  const worldContext = readText(PATHS.world).split('\n').slice(-10).join('\n');
  let vitality = readJSON<VitalityState>(PATHS.vitalityState, DEFAULT_VITALITY);
  let confidence = readJSON<ConfidenceState>(PATHS.confidenceState, DEFAULT_CONFIDENCE);
  let flowState = readJSON<FlowState>(PATHS.flowState, DEFAULT_FLOW_STATE);
  let chainState = readJSON<ChainAndCooldownState>(PATHS.pendingChains, DEFAULT_CHAIN_STATE);

  // 1b. Read and update impulse state
  let impulse: PostImpulseState = readJSON(PATHS.postImpulse, DEFAULT_POST_IMPULSE);
  impulse = decayImpulse(impulse);

  const dormancyBoost = checkDormancy(impulse);
  if (dormancyBoost > 0) {
    impulse = accumulateImpulse(impulse, dormancyBoost);
    console.log(`Dormancy boost applied: +${dormancyBoost}`);
  }

  if (emotion.mood.valence > 0.6 && emotion.mood.arousal > 0.5) {
    const emotionBoost = 5 + Math.random() * 5; // +5~10
    impulse = accumulateImpulse(impulse, emotionBoost);
  }

  // 2. Perception: three-layer emotion decay + rumination + threshold break
  emotion = decayThreeLayer(emotion);
  const flowDrainModifier = flowState.status === 'flow' ? 0.7 : 1.0;
  vitality = drainVitality(vitality, emotion, flowDrainModifier);
  confidence = decayConfidence(confidence);

  // Rumination check
  const ruminationResult = rollRumination(emotion);
  emotion = ruminationResult.state;
  if (ruminationResult.diaryEntry) {
    appendText(PATHS.diary, `\n## ${todayStr} ${timeStr}\n${ruminationResult.diaryEntry}\n情绪: ${emotion.mood.description} | 重要性: 3\n标签: 反刍\n`);
    console.log(`Rumination: ${ruminationResult.diaryEntry}`);
  }

  // Threshold break check
  const thresholdResult = checkThresholdBreak(emotion);
  emotion = thresholdResult.state;
  const thresholdBroke = thresholdResult.diaryEntry !== null;
  if (thresholdResult.diaryEntry) {
    appendText(PATHS.diary, `\n## ${todayStr} ${timeStr}\n${thresholdResult.diaryEntry}\n情绪: ${emotion.mood.description} | 重要性: 8\n标签: 情绪爆发\n`);
    console.log(`Threshold break: ${thresholdResult.diaryEntry}`);
  }

  // 2b. Process pending chain events
  const chainResult = processChainEvents(chainState);
  chainState = chainResult.remaining;
  for (const triggered of chainResult.triggered) {
    emotion = applyDelta(emotion, triggered.event.emotion_delta, triggered.event.description);
    for (const boost of triggered.event.intent_boosts) {
      intentPool = addIntent(intentPool, boost.category, triggered.event.description, boost.boost, 'event');
    }
    appendText(PATHS.diary, `\n## ${todayStr} ${timeStr}\n${triggered.event.diary_entry}\n情绪: ${emotion.mood.description} | 重要性: 3\n标签: 连锁事件\n`);
    console.log(`Chain event: ${triggered.event.description}`);
  }

  // 2c. Social graph: decay relations, process dormancy, generate social intents
  const socialMeta = readJSON<SocialMeta>(PATHS.socialMeta, { instagram_following: [], xiaohongshu_following: [], stats: { core: 0, familiar: 0, cognitive: 0, dormant: 0 } });
  let socialRelations = readAllJSON<SocialRelation>(PATHS.socialInstagramDir);
  socialRelations = decayAllRelations(socialRelations, currentTime);
  const dormancyResult = processDormancy(socialRelations, currentTime);
  socialRelations = dormancyResult.active;

  // 2d. Reactivate dormant relations with new interactions
  const unprocessedEvents = events.events.filter(e => !e.processed);
  const hasNewEvent = unprocessedEvents.length > 0;
  for (const event of unprocessedEvents) {
    const eventUserId = (event.data as { user_id?: string }).user_id;
    if (!eventUserId) continue;
    socialRelations = socialRelations.map(r =>
      r.id === eventUserId && classifyTier(r.relationship.closeness) === 'dormant'
        ? reactivateRelation(r, currentTime.toISOString())
        : r
    );
  }
  const socialIntents = generateSocialIntents(socialRelations, socialMeta, currentTime);

  // Write updated social relations back
  for (const r of socialRelations) {
    writeSocialRelation(PATHS.socialInstagramDir, r);
  }
  const updatedMeta = updateMetaStats(socialMeta, socialRelations);
  writeJSON(PATHS.socialMeta, updatedMeta);

  // 3. Narrative continuity: build recent tick summaries and last inner monologue
  const recentLogs = heartbeatLog.logs.filter(l => l.status === 'completed').slice(-3);
  const recentTickSummaries = recentLogs
    .map(l => l.tick_summary || (l.chosen_actions ? `做了: ${l.chosen_actions.join(', ')}` : '(无摘要)'))
    .map((s, i) => `- ${recentLogs.length - i}小时前: ${s}`)
    .join('\n') || '（还没有之前的记录）';

  const lastLog = heartbeatLog.logs.filter(l => l.status === 'completed').slice(-1)[0];
  const lastInnerMonologue = lastLog?.inner_monologue
    ? `> 你上一个小时的内心独白是：「${lastLog.inner_monologue}」\n> 现在请接着你的思绪继续。`
    : '';

  // 3b. Voice directive
  const voiceDirective = computeVoiceDirective(flowState.status, emotion, thresholdBroke);

  // 4. Flow state judgment
  const rigidNow = getActiveRigidSchedule(schedule, hour, weekday);
  const scheduleContext = rigidNow
    ? `${rigidNow.activity}中，可做: ${rigidNow.allowed_actions.join(', ')}`
    : '自由时段';

  // Path A: currently in flow
  if (flowState.status === 'flow') {
    const exitCheck = checkFlowExit(flowState, intentPool, vitality.vitality, rigidNow, hasNewEvent);
    if (!exitCheck.shouldExit) {
      // Continue flow — no LLM call
      flowState = tickFlow(flowState);
      const flowDiary = generateFlowDiary(flowState, emotion);
      appendText(PATHS.diary, `\n## ${todayStr} ${timeStr}\n${flowDiary}\n情绪: ${emotion.mood.description} | 重要性: 7\n标签: flow, ${flowState.category}\n`);

      // Write state and return early
      writeFlowTickState(currentTime, emotion, intentPool, events, vitality, confidence, impulse, flowState, chainState, heartbeatLog, {
        tickSummary: `flow中: ${flowState.activity}`,
        innerMonologue: null,
        actions: [`[flow] ${flowState.activity}`],
        importance: 7,
        voiceDirective,
      });
      console.log(`Flow tick #${flowState.duration_ticks}: ${flowState.activity}`);
      return;
    }
    // Exit flow
    console.log(`Flow exit: ${exitCheck.reason}`);
    appendText(PATHS.diary, `\n> 💭 ${exitCheck.reason}...从${flowState.activity}中回过神来\n`);
    flowState = resetFlow();
  }

  // Path B: currently in drift
  if (flowState.status === 'drift') {
    const exitCheck = checkDriftExit(flowState, intentPool, vitality.vitality, hasNewEvent);
    if (!exitCheck.shouldExit) {
      // Continue drift — no LLM call
      flowState = tickFlow(flowState);
      vitality = replenishVitality(vitality, 'browsing_light');
      const driftDiary = generateDriftDiary(flowState);
      appendText(PATHS.diary, `\n## ${todayStr} ${timeStr}\n${driftDiary}\n情绪: ${emotion.mood.description} | 重要性: 2\n标签: drift\n`);

      // Write state and return early
      writeFlowTickState(currentTime, emotion, intentPool, events, vitality, confidence, impulse, flowState, chainState, heartbeatLog, {
        tickSummary: 'drift中: 刷手机/发呆',
        innerMonologue: null,
        actions: ['[drift] 刷手机'],
        importance: 2,
        voiceDirective,
      });
      console.log(`Drift tick #${flowState.duration_ticks}`);
      return;
    }
    // Exit drift
    console.log(`Drift exit: ${exitCheck.reason}`);
    appendText(PATHS.diary, `\n> 💭 ${exitCheck.reason}...不再发呆了\n`);
    flowState = resetFlow();
  }

  // Path C: normal tick
  // Count consecutive active heartbeats for rest calculation
  const consecutiveActive = heartbeatLog.logs.filter(l => l.status === 'completed').slice(-10).length;

  // Hours since last post
  const lastPostMatch = diary.match(/发了新 Instagram 帖子/g);
  const lastPostHoursAgo = lastPostMatch ? 24 : 72;

  // 5. Intent phase: rule engine
  intentPool = decaySatisfied(intentPool);
  intentPool = accumulateIntents(intentPool, hour, lastPostHoursAgo, consecutiveActive, hasNewEvent);
  intentPool = applyEventBoosts(intentPool, events);
  intentPool = injectScheduleIntents(intentPool, schedule, hour);

  // 5b. Inject social graph intents
  for (const si of socialIntents) {
    intentPool = addIntent(intentPool, si.category, si.description, si.intensity, 'accumulation');
  }

  // 5c. Apply emotion→intent coupling
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

  // 5d. Apply dynamic resistance
  intentPool = applyResistanceToPool(
    intentPool, vitality.vitality, confidence.confidence,
    false, null, rigidNow,
  );

  // 5e. Check impulse breakthrough
  const breakthrough = checkImpulseBreakthrough(intentPool, vitality.vitality, false);
  if (breakthrough) {
    console.log(`Impulse breakthrough: ${breakthrough.description}`);
  }

  // 5f. Context-aware random event
  const eventCtx: EventContext = {
    emotion,
    vitality,
    flow: flowState,
    currentSchedule: rigidNow?.activity ?? null,
    recentActions: recentLogs.flatMap(l => l.chosen_actions ?? []),
    cooldowns: chainState.cooldowns,
  };
  const randomResult = rollContextAwareEvent(eventCtx);
  if (randomResult.event) {
    emotion = applyImpulse(emotion, randomResult.event.emotion_delta, randomResult.event.description, 3);
    for (const boost of randomResult.event.intent_boosts) {
      intentPool = addIntent(intentPool, boost.category, randomResult.event.description, boost.boost, 'event');
    }
    appendText(PATHS.diary, `\n## ${todayStr} ${timeStr}\n${randomResult.event.diary_entry}\n情绪: ${emotion.mood.description} | 重要性: 3\n标签: 随机事件\n`);
    console.log(`Random event: ${randomResult.event.description}`);

    // Record cooldown
    chainState = {
      ...chainState,
      cooldowns: {
        ...chainState.cooldowns,
        [randomResult.event.description]: currentTime.toISOString(),
      },
    };
  }
  // Add chain events from random event
  chainState = {
    ...chainState,
    pending: [...chainState.pending, ...randomResult.newChainEvents],
  };

  // 6. Build perception summary + LLM decision
  const perceptionSummary = buildPerceptionSummary(emotion, schedule, events, hour, weekday, worldContext, impulse);

  const template = readTemplate('heartbeat-prompt.md');
  // Use getTopIntentsRaw for LLM display (show all intents including below resistance)
  const intentSummary = getTopIntentsRaw(intentPool, 7)
    .map(i => {
      const net = i.intensity - i.resistance;
      const skippedInfo = i.skipped_count > 0 ? `, 拖延: ${i.skipped_count}次` : '';
      return `- [${i.category}] ${i.description} (强度: ${i.intensity.toFixed(1)}, 门槛: ${i.resistance.toFixed(1)}, 净值: ${net.toFixed(1)}${skippedInfo}) id=${i.id}`;
    })
    .join('\n');

  const personalityDrift = readJSON(PATHS.personalityDrift, { base: 'ESTP', modifiers: [] });
  const personalityContext = `ESTP基底。${personalityDrift.modifiers.map((m: { effect: string }) => m.effect).join('；')}`;

  const prompt = template
    .replace('{current_time}', formatTime())
    .replace('{emotion_summary}', `${emotion.mood.description} (v:${emotion.mood.valence.toFixed(1)} a:${emotion.mood.arousal.toFixed(1)} e:${emotion.energy.toFixed(1)})`)
    .replace('{schedule_context}', scheduleContext)
    .replace('{recent_tick_summaries}', recentTickSummaries)
    .replace('{last_inner_monologue}', lastInnerMonologue)
    .replace('{perception_summary}', perceptionSummary)
    .replace('{intent_pool_summary}', intentSummary || '（空）')
    .replace('{personality_context}', personalityContext)
    .replace('{vitality_context}', `活力: ${Math.round(vitality.vitality)}/100${vitalityConstraints.moodModifier ? ` (${vitalityConstraints.moodModifier})` : ''}`)
    .replace('{confidence_context}', getConfidenceMoodHint(confidence.confidence))
    .replace('{voice_directive}', voiceDirective);

  let decision: HeartbeatDecision;
  try {
    decision = await callLLMJSON<HeartbeatDecision>(prompt, 1024);
  } catch (err) {
    const logEntry: HeartbeatLogEntry = {
      timestamp: currentTime.toISOString(),
      type: 'regular',
      status: 'skipped',
      error: (err as Error).message,
    };
    const updatedLog = { ...heartbeatLog, logs: [...heartbeatLog.logs, logEntry] };
    writeJSON(PATHS.heartbeatLog, updatedLog);
    writeJSON(PATHS.flowState, flowState);
    writeJSON(PATHS.pendingChains, chainState);
    console.error(`Heartbeat skipped: ${(err as Error).message}`);
    return;
  }

  // 7. Apply LLM decisions to intent pool
  for (const newImpulse of decision.new_impulses) {
    intentPool = addIntent(intentPool, toIntentCategory(newImpulse.category), newImpulse.description, newImpulse.intensity, 'llm');
  }

  // 8. Execute actions
  let totalImportance = 0;
  const actionResults: string[] = [];
  const chosenIntentIds = new Set<string>();

  for (const action of decision.chosen_actions) {
    if (action.satisfies_intent) {
      chosenIntentIds.add(action.satisfies_intent);
      const satisfiedIntent = intentPool.intents.find(i => i.id === action.satisfies_intent);
      intentPool = satisfyIntent(intentPool, action.satisfies_intent);
      if (satisfiedIntent) {
        emotion = intentSatisfactionFeedback(emotion, satisfiedIntent.category);
      }
    }

    if (action.type === 'simulated' || action.type === 'inner') {
      try {
        const result = await executeSimulatedAction(action.action, emotion, scheduleContext, voiceDirective);
        emotion = applyDelta(emotion, result.emotion_delta, result.narrative.slice(0, 50));

        if (action.action.includes('休息') || action.action.includes('摸鱼') || action.action.includes('追番')) {
          vitality = replenishVitality(vitality, 'rest');
        } else if (action.action.includes('刷') || action.action.includes('看手机')) {
          vitality = replenishVitality(vitality, 'browsing_light');
        }

        appendText(PATHS.diary, `\n## ${todayStr} ${timeStr}\n${result.diary_entry}\n情绪: ${emotion.mood.description} | 重要性: 4\n标签: heartbeat, ${action.type}\n`);
        totalImportance += 4;
        actionResults.push(action.action);

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
      if (action.skill === 'post-pipeline' || action.skill === 'auto-photo') {
        vitality = await executePostPipeline(action, vitality, actionResults, vitalityConstraints.canPost);
        continue;
      }
      // Fuzzy match: if skill name contains posting-related keywords, treat as post-pipeline
      const lowerSkill = (action.skill || '').toLowerCase();
      const isPostIntent = /post|发帖|拍照|摄影|photo|selfie|cos.*拍|自拍/.test(lowerSkill);
      if (isPostIntent) {
        console.log(`[REAL ACTION] Fuzzy-matched skill "${action.skill}" → post-pipeline for: ${action.action}`);
        vitality = await executePostPipeline(action, vitality, actionResults, vitalityConstraints.canPost);
        continue;
      }
      // Search pipeline routing
      const isSearchIntent = /search|搜|查|学习|研究|了解/.test(lowerSkill);
      if (isSearchIntent) {
        if (vitalityConstraints.canSearch) {
          vitality = await executeSearch(action, vitality, actionResults, voiceDirective);
        } else {
          console.log(`[SEARCH] Skipped — vitality too low (${vitality.vitality})`);
          actionResults.push(`[skipped:low-vitality] ${action.action}`);
        }
        continue;
      }
      console.log(`[REAL ACTION] Unknown skill: ${action.skill} for: ${action.action}`);
      actionResults.push(`[real] ${action.action}`);
    }
  }

  // 8a. Safety net: if LLM produced no actions but has monologue, write a diary entry
  if (actionResults.length === 0 && decision.inner_monologue) {
    appendText(PATHS.diary, `\n## ${todayStr} ${timeStr}\n${decision.inner_monologue}\n情绪: ${emotion.mood.description} | 重要性: 3\n标签: heartbeat, inner\n`);
    totalImportance += 3;
    actionResults.push(decision.inner_monologue.slice(0, 50));
  }

  // 8b. Procrastination tracking
  const procResult = processProcrastination(intentPool, chosenIntentIds);
  intentPool = procResult.pool;
  if (procResult.stressDelta > 0) {
    emotion = applyDelta(emotion, { stress: procResult.stressDelta }, '拖延压力');
  }
  for (const entry of procResult.diaryEntries) {
    appendText(PATHS.diary, `\n> 💭 ${entry}\n`);
  }

  // 9. Write inner monologue to diary
  if (decision.inner_monologue) {
    appendText(PATHS.diary, `\n> 💭 ${decision.inner_monologue}\n`);
  }

  // 9b. Check post stats for 24h-old posts
  try {
    const { checkPostStats } = await import('./post-pipeline');
    await checkPostStats();
    const postHistory = readJSON<PostHistory>(PATHS.postHistory, { posts: [] });
    confidence = updateConfidence(confidence, postHistory);
  } catch (err) {
    console.error(`Stats check failed: ${(err as Error).message}`);
  }

  // 10. Check flow/drift entry after action execution
  const lastAction: LastAction | null = actionResults.length > 0
    ? { category: toIntentCategory(decision.chosen_actions[0]?.action?.split(' ')[0] ?? ''), activity: actionResults[0] }
    : null;

  // Try to infer last action category from the satisfied intent
  const lastSatisfiedIntent = decision.chosen_actions.find(a => a.satisfies_intent);
  const lastActionForFlow: LastAction | null = lastSatisfiedIntent
    ? (() => {
        const intent = intentPool.intents.find(i => i.id === lastSatisfiedIntent.satisfies_intent);
        return intent ? { category: intent.category, activity: lastSatisfiedIntent.action } : lastAction;
      })()
    : lastAction;

  flowState = checkFlowEntry(flowState, lastActionForFlow, intentPool);
  if (flowState.status === 'none') {
    flowState = checkDriftEntry(flowState, vitality.vitality, intentPool, emotion.stress);
  }

  // 11. Mark events as processed
  const processedEvents = events.events.map(e => ({ ...e, processed: true }));
  const trimmedEvents = processedEvents.length > events.max_size
    ? processedEvents.slice(-events.max_size)
    : processedEvents;
  const updatedEvents: EventQueue = { ...events, events: trimmedEvents };

  // 12. Update reflection counter
  const wisdom = readJSON<WisdomStore>(PATHS.coreWisdom, { version: 1, wisdom: [], total_importance_since_reflection: 0 });
  const updatedWisdom: WisdomStore = {
    ...wisdom,
    total_importance_since_reflection: wisdom.total_importance_since_reflection + totalImportance,
  };
  writeJSON(PATHS.coreWisdom, updatedWisdom);

  // 13. Write all state
  const tickSummary = actionResults.length > 0
    ? actionResults.join(', ')
    : decision.inner_monologue?.slice(0, 50) || '(无动作)';

  writeFlowTickState(currentTime, emotion, intentPool, updatedEvents, vitality, confidence, impulse, flowState, chainState, heartbeatLog, {
    tickSummary,
    innerMonologue: decision.inner_monologue || null,
    actions: actionResults,
    importance: totalImportance,
    voiceDirective,
  });

  console.log(`Heartbeat completed at ${formatTime()}. Actions: ${actionResults.join(', ') || 'none'}`);
}

/**
 * Helper to write all state at end of a tick (normal, flow, or drift).
 */
function writeFlowTickState(
  tickTime: Date,
  emotion: EmotionState,
  intentPool: IntentPool,
  events: EventQueue,
  vitality: VitalityState,
  confidence: ConfidenceState,
  impulse: PostImpulseState,
  flowState: FlowState,
  chainState: ChainAndCooldownState,
  heartbeatLog: HeartbeatLog,
  tick: {
    tickSummary: string;
    innerMonologue: string | null;
    actions: string[];
    importance: number;
    voiceDirective: string;
  },
): void {
  emotion = { ...emotion, last_updated: tickTime.toISOString() };
  intentPool = { ...intentPool, last_updated: tickTime.toISOString() };
  vitality = { ...vitality, last_updated: tickTime.toISOString() };
  confidence = { ...confidence, last_updated: tickTime.toISOString() };

  writeJSON(PATHS.emotionState, emotion);
  writeJSON(PATHS.intentPool, intentPool);
  writeJSON(PATHS.eventQueue, events);
  writeJSON(PATHS.vitalityState, vitality);
  writeJSON(PATHS.confidenceState, confidence);
  writeJSON(PATHS.postImpulse, impulse);
  writeJSON(PATHS.flowState, flowState);
  writeJSON(PATHS.pendingChains, chainState);

  const logEntry: HeartbeatLogEntry = {
    timestamp: tickTime.toISOString(),
    type: 'regular',
    status: 'completed',
    perception_summary: '',
    chosen_actions: tick.actions,
    emotion_after: { mood: emotion.mood, energy: emotion.energy },
    importance_added: tick.importance,
    tick_summary: tick.tickSummary,
    inner_monologue: tick.innerMonologue ?? undefined,
    flow_state: flowState.status,
    voice_directive: tick.voiceDirective,
  };

  let updatedLog = { ...heartbeatLog, logs: [...heartbeatLog.logs, logEntry] };
  const logJson = JSON.stringify(updatedLog);
  if (logJson.length > 100_000) {
    updatedLog = { ...updatedLog, logs: updatedLog.logs.slice(-50) };
  }
  writeJSON(PATHS.heartbeatLog, updatedLog);
}

// Entry point: route to the right handler
async function main(): Promise<void> {
  const currentTime = now();
  const hour = getLocalHour(currentTime);
  const todayStr = getLocalDate(currentTime);

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
        timestamp: now().toISOString(),
        type: 'regular',
        status: 'skipped',
        error: err.message,
      }],
    };
    writeJSON(PATHS.heartbeatLog, errorLog);
  } catch { /* best effort */ }
  process.exit(1);
});
