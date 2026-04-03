#!/usr/bin/env node
/**
 * heartbeat-tick.ts
 * Main heartbeat entry point — called every hour by cron.
 * Routes to morning-plan, night-reflect, or regular tick.
 *
 * Generalized: no platform-specific pipelines (post-pipeline, search-pipeline, comment-engine).
 * All "real" actions are dispatched through the skill-router to sub-skills.
 */

import {
  EmotionState, IntentPool, IntentCategory, ScheduleToday, EventQueue,
  HeartbeatLog, HeartbeatLogEntry, ActionOutput, RigidSchedule, WisdomStore,
  SocialRelation, SocialMeta, VitalityState, ConfidenceState, FeedbackEvent,
  CronSchedule,
  DEFAULT_MOMENTUM, DEFAULT_UNDERTONE,
  FlowState, DEFAULT_FLOW_STATE,
  ChainAndCooldownState, DEFAULT_CHAIN_STATE,
  hydrateEmotionState, hydrateIntent,
  isFeatureEnabled,
} from '../utils/types';
import { PATHS, readJSON, writeJSON, appendText, readText, readTemplate, readAllJSON, writeSocialRelation } from '../utils/file-utils';
import {
  applyDelta, computeEmotionIntentCoupling,
  intentSatisfactionFeedback, decayThreeLayer, applyImpulse,
  rollRumination, checkThresholdBreak,
} from '../engines/emotion';
import {
  decaySatisfied, accumulateIntents, applyEventBoosts,
  injectScheduleIntents, getTopIntentsRaw, satisfyIntent, addIntent,
  applyResistanceToPool, checkImpulseBreakthrough, processProcrastination,
} from '../engines/intent';
import { drainVitality, applyActionCost, replenishVitality, getVitalityConstraints, DEFAULT_VITALITY, afternoonRestRecovery } from '../engines/vitality';
import { updateConfidenceFromBatch, decayConfidence, getProduceRateMultiplier, getConfidenceMoodHint, DEFAULT_CONFIDENCE } from '../engines/confidence';
import {
  checkFlowEntry, checkDriftEntry, checkFlowExit, checkDriftExit,
  tickFlow, resetFlow, generateFlowDiary, generateDriftDiary,
  computeVoiceDirective, LastAction, shouldEvolveFlow, FlowEvolution,
} from '../engines/flow';
import { rollContextAwareEvent, processChainEvents, EventContext } from '../world/random-events';
import {
  decayAllRelations, processDormancy, generateSocialIntents,
  updateMetaStats, reactivateRelation, classifyTier,
} from '../world/social-graph-engine';
import { isActiveHeartbeatHour } from '../world/heartbeat-gate';
import { loadPersona, injectPersona, buildVoiceSignature, getEmotionCouplingConfigs, getContentSourcesConfig } from '../persona/persona-loader';
import { resolveRoute, resolveRouteBySkillName, fuzzyResolveSkillName, buildContext, executeSubSkill, getRouteTable } from '../router/skill-router';
import { createInstagramConfig, createSocialEngagementConfig, createContentBrowseConfig } from '../adapters/instagram-adapter';
import { recordSkillNeed, buildPendingNeedsHint } from '../hub/skill-need-tracker';
import { HEARTBEAT_CONFIG } from '../config';
import { runMorningPlan } from './morning-plan';
import { runNightReflect } from './night-reflect';
import { now, getLocalDate, getLocalHour, getLocalWeekday, formatLocalTime, getLocalTimeHHMM, setTimezone } from '../utils/time-utils';

// === Hashtag extraction helpers (used by heartbeat-social-routing tests) ===

function normalizeOutboundHashtag(tag: string): string | null {
  const normalized = tag.trim().replace(/^#+/, '').trim();
  return normalized || null;
}

export function getOutboundHashtagsFromInspiration(
  inspiration: Record<string, any> | null | undefined,
): string[] {
  const primary = inspiration?.instagram_trends?.trending_hashtags ?? [];
  const fallback = inspiration?.self_performance?.best_hashtag_combos?.flat() ?? [];
  const source = primary.length > 0 ? primary : fallback;
  const seen = new Set<string>();
  const hashtags: string[] = [];

  for (const rawTag of source) {
    const normalized = normalizeOutboundHashtag(String(rawTag ?? ''));
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    hashtags.push(normalized);
  }

  return hashtags;
}

// Default initial states
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
const DEFAULT_EVENT_QUEUE: EventQueue = { events: [], max_size: HEARTBEAT_CONFIG.EVENT_QUEUE_MAX_SIZE };
const DEFAULT_HEARTBEAT_LOG: HeartbeatLog = { logs: [], retention_days: HEARTBEAT_CONFIG.LOG_RETENTION_DAYS };

const VALID_CATEGORIES: ReadonlySet<string> = new Set<IntentCategory>(['produce', 'connect', 'consume', 'express', 'learn', 'rest', 'aspire']);

function toIntentCategory(s: string): IntentCategory {
  if (VALID_CATEGORIES.has(s)) return s as IntentCategory;
  return 'express';
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
    /** 技能渴望：当角色想做某事但知道没有对应技能时，填写期望的技能名称 */
    wished_skill?: string | null;
  }>;
}

function formatTime(): string {
  return formatLocalTime();
}

/**
 * Get the active rigid schedule for the current time.
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
 * Build the perception summary for LLM.
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
 * Execute a simulated action via LLM.
 */
async function executeSimulatedAction(
  actionDesc: string,
  emotion: EmotionState,
  scheduleContext: string,
  voiceDirective: string,
  recentDiaryEntries: string,
  llm: { callJSON<T>(prompt: string, maxTokens?: number): Promise<T> },
): Promise<ActionOutput> {
  let template = readTemplate('simulated-action.md');
  template = injectPersona(template);
  const emotionSummary = `${emotion.mood.description}（valence=${emotion.mood.valence.toFixed(2)}, arousal=${emotion.mood.arousal.toFixed(2)}, energy=${emotion.energy.toFixed(2)}, stress=${emotion.stress.toFixed(2)}, creativity=${emotion.creativity.toFixed(2)}, sociability=${emotion.sociability.toFixed(2)}）`;
  const recentDiaryContext = recentDiaryEntries
    ? `## 最近写过的日记（不要重复类似的内容和句式！）\n\n${recentDiaryEntries}`
    : '';
  const prompt = template
    .replace('{action_description}', actionDesc)
    .replace('{emotion_summary}', emotionSummary)
    .replace('{current_time}', formatTime())
    .replace('{schedule_context}', scheduleContext)
    .replace('{recent_diary_context}', recentDiaryContext)
    .replace('{voice_directive}', voiceDirective || '正常叙事语气。');

  return llm.callJSON<ActionOutput>(prompt);
}

/**
 * Registry of platform config factories for sub-skills.
 * Add new sub-skill configs here when registering new adapters.
 */
const skillConfigFactories: Record<string, () => Record<string, unknown>> = {
  'instagram': () => createInstagramConfig() as unknown as Record<string, unknown>,
  'social-engagement': () => createSocialEngagementConfig() as unknown as Record<string, unknown>,
  // content-browse uses a dynamic factory — see resolveSkillConfig below
};

/**
 * Resolve platform config for a sub-skill by name.
 * Maps orchestration sub-skills to their adapter configs.
 * Optionally injects actionContext from the heartbeat LLM decision
 * so sub-skills can use it (e.g. content-browse uses it to generate
 * intent-driven search keywords via LLM).
 *
 * For content-browse: injects persona's content_sources so the browsing
 * targets platforms and keywords configured in persona.yaml.
 */
function resolveSkillConfig(skillName: string, actionContext?: string, persona?: import('../utils/types').PersonaConfig): Record<string, unknown> {
  let config: Record<string, unknown>;

  if (skillName === 'content-browse') {
    const contentSources = persona ? getContentSourcesConfig(persona) : undefined;
    const { ContentProviderRegistry } = require('../adapters/content-provider');
    const registry = new ContentProviderRegistry();
    config = createContentBrowseConfig({
      contentSources,
      registry,
    }) as unknown as Record<string, unknown>;
  } else {
    const factory = skillConfigFactories[skillName];
    config = factory ? factory() : {};
  }

  if (actionContext) {
    config.actionContext = actionContext;
  }
  return config;
}

/**
 * Regular heartbeat tick.
 */
export async function regularTick(
  llm: { callJSON<T>(prompt: string, maxTokens?: number): Promise<T>; call(prompt: string, maxTokens?: number): Promise<string> },
): Promise<void> {
  const currentTime = now();
  const hour = getLocalHour(currentTime);
  const weekday = getLocalWeekday(currentTime);
  const todayStr = getLocalDate(currentTime);
  const timeStr = getLocalTimeHHMM(currentTime);

  const persona = loadPersona();
  const voiceSignature = buildVoiceSignature(persona);
  const intentEnabled = isFeatureEnabled(persona, 'intent');

  // 0b. Set timezone from persona config (fixes UTC vs local time issue)
  setTimezone(persona.schedule?.timezone ?? null);

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

  // 1b. Afternoon rest recovery (13:00-15:00, vitality < 50)
  vitality = afternoonRestRecovery(vitality, hour);

  // 2. Perception: three-layer emotion decay + rumination + threshold break
  if (isFeatureEnabled(persona, 'emotion')) {
    emotion = decayThreeLayer(emotion);
  }
  const flowDrainModifier = flowState.status === 'flow' ? HEARTBEAT_CONFIG.FLOW_DRAIN_MODIFIER : 1.0;
  if (isFeatureEnabled(persona, 'vitality')) {
    vitality = drainVitality(vitality, emotion, flowDrainModifier);
  }
  if (isFeatureEnabled(persona, 'confidence')) {
    confidence = decayConfidence(confidence);
  }

  // Rumination check
  const ruminationResult = rollRumination(emotion);
  emotion = ruminationResult.state;
  if (ruminationResult.diaryEntry) {
    appendText(PATHS.diary, `\n## ${todayStr} ${timeStr}\n${ruminationResult.diaryEntry}\n情绪: ${emotion.mood.description} | 重要性: 3\n标签: 反刍\n`);
  }

  // Threshold break check
  const thresholdResult = checkThresholdBreak(emotion);
  emotion = thresholdResult.state;
  const thresholdBroke = thresholdResult.diaryEntry !== null;
  if (thresholdResult.diaryEntry) {
    appendText(PATHS.diary, `\n## ${todayStr} ${timeStr}\n${thresholdResult.diaryEntry}\n情绪: ${emotion.mood.description} | 重要性: 8\n标签: 情绪爆发\n`);
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
  }

  // 2c. Social graph: decay relations, process dormancy, generate social intents
  //     Gated by features.social_graph (default: true)
  const socialGraphEnabled = isFeatureEnabled(persona, 'social_graph');
  let socialRelations: SocialRelation[] = [];
  let socialIntents: Array<{ category: IntentCategory; description: string; intensity: number }> = [];
  const unprocessedEvents = events.events.filter(e => !e.processed);
  const hasNewEvent = unprocessedEvents.length > 0;

  if (socialGraphEnabled) {
    const socialMeta = readJSON<SocialMeta>(PATHS.socialMeta, { following: {}, stats: { core: 0, familiar: 0, cognitive: 0, dormant: 0 } });
    socialRelations = readAllJSON<SocialRelation>(PATHS.socialDir);
    socialRelations = decayAllRelations(socialRelations, currentTime);
    const dormancyResult = processDormancy(socialRelations, currentTime);
    socialRelations = dormancyResult.active;

    // 2d. Reactivate dormant relations with new interactions
    for (const event of unprocessedEvents) {
      const eventUserId = (event.data as { user_id?: string }).user_id;
      if (!eventUserId) continue;
      socialRelations = socialRelations.map(r =>
        r.id === eventUserId && classifyTier(r.relationship.closeness) === 'dormant'
          ? reactivateRelation(r, currentTime.toISOString())
          : r,
      );
    }
    socialIntents = generateSocialIntents(socialRelations, socialMeta, currentTime);

    // Write updated social relations back
    for (const r of socialRelations) {
      writeSocialRelation(PATHS.socialDir, r);
    }
    const updatedMeta = updateMetaStats(socialMeta, socialRelations);
    writeJSON(PATHS.socialMeta, updatedMeta);
  }

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
  const voiceDirective = computeVoiceDirective(flowState.status, emotion, thresholdBroke, voiceSignature);

  // 4. Flow state judgment
  const rigidNow = getActiveRigidSchedule(schedule, hour, weekday);
  const scheduleContext = rigidNow
    ? `${rigidNow.activity}中，可做: ${rigidNow.allowed_actions.join(', ')}`
    : '自由时段';

  // Path A: currently in flow (gated by features.flow_states)
  if (flowState.status === 'flow' && isFeatureEnabled(persona, 'flow_states')) {
    const exitCheck = checkFlowExit(flowState, intentPool, vitality.vitality, rigidNow, hasNewEvent);
    if (!exitCheck.shouldExit) {
      flowState = tickFlow(flowState);

      // P0-2: Flow 期间仍需运行 intent 消化逻辑
      // 即使在 flow 中，intent 仍然会积累和衰变，避免 intent 堆积
      if (intentEnabled) {
        intentPool = decaySatisfied(intentPool);
        intentPool = accumulateIntents(intentPool, hour, 24, heartbeatLog.logs.filter(l => l.status === 'completed').slice(-10).length, hasNewEvent);
      }

      let flowDiary: string;
      let tickSummary: string;

      if (shouldEvolveFlow(flowState.duration_ticks)) {
        // 偶数 tick: 轻量 LLM 调用让活动自然演化（活人感）
        try {
          let evoTemplate = readTemplate('flow-evolution-prompt.md');
          evoTemplate = injectPersona(evoTemplate, persona);
          evoTemplate = evoTemplate
            .replace('{activity}', flowState.activity ?? '做事')
            .replace('{duration}', String(flowState.duration_ticks))
            .replace('{emotion_summary}', `${emotion.mood.description}`)
            .replace('{vitality}', `${Math.round(vitality.vitality)}/100`);

          const evolution = await llm.callJSON<FlowEvolution>(evoTemplate);
          flowDiary = evolution.diary_line;
          tickSummary = `flow中: ${evolution.micro_activity}`;
        } catch {
          // fallback to template on LLM failure
          flowDiary = generateFlowDiary(flowState, emotion);
          tickSummary = `flow中: ${flowState.activity}`;
        }
      } else {
        // 奇数 tick: 用模板（效率优先）
        flowDiary = generateFlowDiary(flowState, emotion);
        tickSummary = `flow中: ${flowState.activity}`;
      }

      appendText(PATHS.diary, `\n## ${todayStr} ${timeStr}\n${flowDiary}\n情绪: ${emotion.mood.description} | 重要性: 7\n标签: flow, ${flowState.category}\n`);

      writeFlowTickState(currentTime, emotion, intentPool, events, vitality, confidence, flowState, chainState, heartbeatLog, {
        tickSummary,
        innerMonologue: null,
        actions: [`[flow] ${flowState.activity}`],
        importance: 7,
        voiceDirective,
      });
      console.log(`Flow tick #${flowState.duration_ticks}: ${flowState.activity}`);
      return;
    }
    console.log(`Flow exit: ${exitCheck.reason}`);
    appendText(PATHS.diary, `\n> 💭 ${exitCheck.reason}...从${flowState.activity}中回过神来\n`);
    flowState = resetFlow();
  }

  // Path B: currently in drift (gated by features.flow_states)
  if (flowState.status === 'drift' && isFeatureEnabled(persona, 'flow_states')) {
    const exitCheck = checkDriftExit(flowState, intentPool, vitality.vitality, hasNewEvent);
    if (!exitCheck.shouldExit) {
      flowState = tickFlow(flowState);
      vitality = replenishVitality(vitality, 'browsing_light');
      const driftDiary = generateDriftDiary(flowState);
      appendText(PATHS.diary, `\n## ${todayStr} ${timeStr}\n${driftDiary}\n情绪: ${emotion.mood.description} | 重要性: 2\n标签: drift\n`);

      writeFlowTickState(currentTime, emotion, intentPool, events, vitality, confidence, flowState, chainState, heartbeatLog, {
        tickSummary: 'drift中: 刷手机/发呆',
        innerMonologue: null,
        actions: ['[drift] 刷手机'],
        importance: 2,
        voiceDirective,
      });
      console.log(`Drift tick #${flowState.duration_ticks}`);
      return;
    }
    console.log(`Drift exit: ${exitCheck.reason}`);
    appendText(PATHS.diary, `\n> 💭 ${exitCheck.reason}...不再发呆了\n`);
    flowState = resetFlow();
  }

  // Auto-reset flow/drift if features.flow_states is disabled but state lingers
  if (!isFeatureEnabled(persona, 'flow_states') && flowState.status !== 'none') {
    flowState = resetFlow();
  }

  // Path C: normal tick
  const consecutiveActive = heartbeatLog.logs.filter(l => l.status === 'completed').slice(-10).length;
  const lastActionHoursAgo = 24; // generic fallback

  const vitalityConstraints = getVitalityConstraints(vitality.vitality);
  const produceMultiplier = getProduceRateMultiplier(confidence.confidence);

  // 5. Intent phase: rule engine
  if (intentEnabled) {
    intentPool = decaySatisfied(intentPool);
    intentPool = accumulateIntents(intentPool, hour, lastActionHoursAgo, consecutiveActive, hasNewEvent);
    intentPool = applyEventBoosts(intentPool, events);
    intentPool = injectScheduleIntents(intentPool, schedule, hour);

    // 5b. Inject social graph intents
    for (const si of socialIntents) {
      intentPool = addIntent(intentPool, si.category, si.description, si.intensity, 'accumulation');
    }

    // 5c. Apply emotion→intent coupling (uses persona.intent_config if available)
    const emotionCouplings = getEmotionCouplingConfigs(persona);
    const couplingMultipliers = computeEmotionIntentCoupling(emotion, emotionCouplings);
    intentPool = {
      ...intentPool,
      intents: intentPool.intents.map(i => {
        if (i.satisfied_at !== null) return i;
        const coupling = couplingMultipliers[i.category] ?? 1.0;
        const vitalityMod = vitalityConstraints.intentMultiplier;
        const confidenceMod = i.category === 'produce' ? produceMultiplier : 1.0;
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
  }

  // 5f. Context-aware random event (gated by features.random_events)
  if (isFeatureEnabled(persona, 'random_events')) {
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

      chainState = {
        ...chainState,
        cooldowns: { ...chainState.cooldowns, [randomResult.event.description]: currentTime.toISOString() },
      };
    }
    chainState = {
      ...chainState,
      pending: [...chainState.pending, ...randomResult.newChainEvents],
    };
  }

  // 6. Build perception summary + LLM decision
  const perceptionSummary = buildPerceptionSummary(emotion, schedule, events, hour, weekday, worldContext);

  let template = readTemplate('heartbeat-prompt.md');
  template = injectPersona(template, persona);

  const intentSummary = intentEnabled
    ? getTopIntentsRaw(intentPool, HEARTBEAT_CONFIG.TOP_INTENTS_FOR_LLM)
        .map(i => {
          const net = i.intensity - i.resistance;
          const skippedInfo = i.skipped_count > 0 ? `, 拖延: ${i.skipped_count}次` : '';
          return `- [${i.category}] ${i.description} (强度: ${i.intensity.toFixed(1)}, 门槛: ${i.resistance.toFixed(1)}, 净值: ${net.toFixed(1)}${skippedInfo}) id=${i.id}`;
        })
        .join('\n')
    : '（intent 引擎已关闭）';

  const personalityDrift = readJSON(PATHS.personalityDrift, { base: persona.personality.mbti, modifiers: [] });
  const personalityContext = `${persona.personality.mbti}基底。${personalityDrift.modifiers.map((m: { effect: string }) => m.effect).join('；')}`;

  // Build registered skills summary for LLM (filtered by persona.sub_skills)
  const routeTable = getRouteTable(persona);
  const handledIntents = Object.keys(routeTable);

  // 构建详细的 sub-skill 列表供 LLM 参考
  const subSkillListLines: string[] = [];
  for (const [intentCat, routes] of Object.entries(routeTable)) {
    for (const route of routes) {
      subSkillListLines.push(
        `  - \`${route.skillName}\`（类别: ${intentCat}）— ${route.manifest.description ?? route.action}`
      );
    }
  }
  const subSkillList = subSkillListLines.length > 0
    ? subSkillListLines.join('\n')
    : '  （当前没有注册的 sub-skill）';

  const skillHint = handledIntents.length > 0
    ? `可用技能: ${handledIntents.join(', ')}。在 chosen_actions 中使用 type: "real", skill: "<skill_name>" 来调用。`
    : '';

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
    .replace('{voice_directive}', voiceDirective)
    .replace('{sub_skill_list}', subSkillList)
    .replace('{skill_hint}', skillHint)
    .replace('{pending_skill_needs}', isFeatureEnabled(persona, 'skill_discovery') ? buildPendingNeedsHint() : '');

  let decision: HeartbeatDecision;
  try {
    decision = await llm.callJSON<HeartbeatDecision>(prompt);
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
  if (intentEnabled) {
    for (const newImpulse of decision.new_impulses) {
      intentPool = addIntent(intentPool, toIntentCategory(newImpulse.category), newImpulse.description, newImpulse.intensity, 'llm');
    }
  }

  // 8. Execute actions
  let totalImportance = 0;
  const actionResults: string[] = [];
  const chosenIntentIds = new Set<string>();
  const collectedFeedback: FeedbackEvent[] = [];

  for (const action of decision.chosen_actions) {
    if (intentEnabled && action.satisfies_intent) {
      chosenIntentIds.add(action.satisfies_intent);
      const satisfiedIntent = intentPool.intents.find(i => i.id === action.satisfies_intent);
      intentPool = satisfyIntent(intentPool, action.satisfies_intent);
      if (satisfiedIntent) {
        emotion = intentSatisfactionFeedback(emotion, satisfiedIntent.category);
      }
    }

    if (action.type === 'simulated' || action.type === 'inner') {
      try {
        const result = await executeSimulatedAction(action.action, emotion, scheduleContext, voiceDirective, recentDiary, llm);
        emotion = applyDelta(emotion, result.emotion_delta, result.narrative.slice(0, 50));

        if (action.action.includes('休息') || action.action.includes('摸鱼') || action.action.includes('追番')) {
          vitality = replenishVitality(vitality, 'rest');
        } else if (action.action.includes('刷') || action.action.includes('看手机')) {
          vitality = replenishVitality(vitality, 'browsing_light');
        }

        // 通道2：隐性渴望 — wished_skill 字段捕获能力缺口 (gated by features.skill_discovery)
        if (action.wished_skill && isFeatureEnabled(persona, 'skill_discovery')) {
          try {
            const satisfiedIntent = intentPool.intents.find(i => i.id === action.satisfies_intent);
            recordSkillNeed({
              intent_category: satisfiedIntent?.category ?? toIntentCategory(action.action.split(' ')[0] ?? ''),
              description: action.action,
              wished_skill_name: action.wished_skill,
              source: 'wished',
              original_action: action.action,
              intensity: satisfiedIntent?.intensity ?? 5,
            });
            console.log(`[skill-discovery] Recorded wished skill: ${action.wished_skill} for "${action.action}"`);
          } catch (err) {
            console.error(`[skill-discovery] Failed to record wished skill: ${(err as Error).message}`);
          }
        }

        appendText(PATHS.diary, `\n## ${todayStr} ${timeStr}\n${result.diary_entry}\n情绪: ${emotion.mood.description} | 重要性: 4\n标签: heartbeat, ${action.type}\n`);
        totalImportance += 4;
        actionResults.push(action.action);
      } catch (err) {
        console.error(`Action failed: ${action.action}: ${(err as Error).message}`);
      }
    } else if (action.type === 'real' && action.skill) {
      // Route to sub-skill via skill-router
      // Try intent category first (e.g. "创作"), then fall back to skill name (e.g. "instagram"),
      // then fuzzy-match for LLM hallucinated names (e.g. "social-media-posting" → "instagram")
      const route = resolveRoute(action.skill) ?? resolveRouteBySkillName(action.skill) ?? fuzzyResolveSkillName(action.skill);
      if (route) {
        try {
          const satisfiedIntent = intentPool.intents.find(i => i.id === action.satisfies_intent);
          const resolvedIntent = {
            id: action.satisfies_intent ?? 'anonymous',
            category: satisfiedIntent?.category ?? toIntentCategory(action.skill),
            description: action.action,
            intensity: satisfiedIntent?.intensity ?? 5,
            action: route.action,
          };

          // Inject platform config based on skill name + action context
          const skillConfig = resolveSkillConfig(route.skillName, action.action, persona);
          const ctx = buildContext(persona, emotion, vitality.vitality, confidence.confidence, resolvedIntent, llm, skillConfig);
          const subResult = await executeSubSkill(route, ctx);

          // Apply sub-skill results
          for (const delta of subResult.emotion_deltas ?? []) {
            emotion = applyDelta(emotion, delta, subResult.narrative.slice(0, 30));
          }
          if (subResult.vitality_cost) {
            vitality = applyActionCost(vitality, 'sub_skill', subResult.vitality_cost);
          }
          if (subResult.feedback) {
            collectedFeedback.push(...subResult.feedback);
          }

          appendText(PATHS.diary, `\n## ${todayStr} ${timeStr}\n${subResult.narrative}\n情绪: ${emotion.mood.description} | 重要性: 5\n标签: heartbeat, real, ${route.skillName}\n`);
          totalImportance += 5;
          actionResults.push(`[${route.skillName}] ${action.action}`);

          // Post-hook: content-browse → trigger discovery pipeline
          if (route.skillName === 'content-browse') {
            try {
              const { processInspirationForDiscovery, processInspirationForAccountDiscovery } = require('../ops/discovery-engine');
              const discovered = processInspirationForDiscovery();
              const newCandidates = processInspirationForAccountDiscovery();
              if (discovered > 0 || newCandidates > 0) {
                console.log(`[discovery] +${discovered} content discoveries, +${newCandidates} candidate accounts`);
              }
            } catch (discErr) {
              console.warn(`[discovery] Post-browse discovery failed: ${(discErr as Error).message}`);
            }
          }
        } catch (err) {
          console.error(`[router] Sub-skill ${route.skillName} failed: ${(err as Error).message}`);
          actionResults.push(`[error:${route.skillName}] ${action.action}`);
        }
      } else {
        console.log(`[router] No sub-skill handles skill="${action.skill}" for: ${action.action} — falling back to simulated`);

        // Fallback: execute as simulated action instead of leaving as [unhandled]
        try {
          const result = await executeSimulatedAction(action.action, emotion, scheduleContext, voiceDirective, recentDiary, llm);
          emotion = applyDelta(emotion, result.emotion_delta, result.narrative.slice(0, 50));
          appendText(PATHS.diary, `\n## ${todayStr} ${timeStr}\n${result.diary_entry}\n情绪: ${emotion.mood.description} | 重要性: 4\n标签: heartbeat, simulated-fallback\n`);
          totalImportance += 4;
          actionResults.push(`[fallback:${action.skill}] ${action.action}`);
        } catch (simErr) {
          console.error(`[router] Simulated fallback also failed: ${(simErr as Error).message}`);
          actionResults.push(`[unhandled] ${action.action}`);
        }

        // 通道1：显性失败 — 路由找不到对应 sub-skill，记录能力缺口 (gated by features.skill_discovery)
        if (isFeatureEnabled(persona, 'skill_discovery')) {
          try {
            const satisfiedIntent = intentPool.intents.find(i => i.id === action.satisfies_intent);
            recordSkillNeed({
              intent_category: satisfiedIntent?.category ?? toIntentCategory(action.skill ?? ''),
              description: action.action,
              wished_skill_name: action.skill,
              source: 'unhandled',
              original_action: action.action,
              intensity: satisfiedIntent?.intensity ?? 5,
            });
            console.log(`[skill-discovery] Recorded unhandled skill need: ${action.skill} for "${action.action}"`);
          } catch (err) {
            console.error(`[skill-discovery] Failed to record unhandled need: ${(err as Error).message}`);
          }
        }
      }
    }
  }

  // 8a. Safety net: if LLM produced no actions but has monologue, write a diary entry
  if (actionResults.length === 0 && decision.inner_monologue) {
    appendText(PATHS.diary, `\n## ${todayStr} ${timeStr}\n${decision.inner_monologue}\n情绪: ${emotion.mood.description} | 重要性: 3\n标签: heartbeat, inner\n`);
    totalImportance += 3;
    actionResults.push(decision.inner_monologue.slice(0, 50));
  }

  // 8b. Apply collected feedback to confidence
  if (collectedFeedback.length > 0) {
    confidence = updateConfidenceFromBatch(confidence, collectedFeedback);
  }

  // 8c. Procrastination tracking (gated by features.procrastination + features.intent)
  if (intentEnabled && isFeatureEnabled(persona, 'procrastination')) {
    const procResult = processProcrastination(intentPool, chosenIntentIds, Math.random, emotion.stress);
    intentPool = procResult.pool;
    if (procResult.stressDelta > 0) {
      emotion = applyDelta(emotion, { stress: procResult.stressDelta }, '拖延压力');
    }
    for (const entry of procResult.diaryEntries) {
      appendText(PATHS.diary, `\n> 💭 ${entry}\n`);
    }
  }

  // 9. Write inner monologue to diary
  if (decision.inner_monologue) {
    appendText(PATHS.diary, `\n> 💭 ${decision.inner_monologue}\n`);
  }

  // 10. Check flow/drift entry after action execution (gated by features.flow_states)
  if (isFeatureEnabled(persona, 'flow_states')) {
    const lastAction: LastAction | null = actionResults.length > 0
      ? { category: toIntentCategory(decision.chosen_actions[0]?.action?.split(' ')[0] ?? ''), activity: actionResults[0] }
      : null;

    const lastSatisfiedIntent = decision.chosen_actions.find(a => a.satisfies_intent);
    const lastActionForFlow: LastAction | null = lastSatisfiedIntent
      ? (() => {
          const intent = intentPool.intents.find(i => i.id === lastSatisfiedIntent.satisfies_intent);
          return intent ? { category: intent.category, activity: lastSatisfiedIntent.action } : lastAction;
        })()
      : lastAction;

    flowState = checkFlowEntry(flowState, lastActionForFlow, intentPool, emotion.energy, flowState.cooldown_remaining);
    if (flowState.status === 'none') {
      flowState = checkDriftEntry(flowState, vitality.vitality, intentPool, emotion.stress);
      // Decrement cooldown on normal ticks (when not entering flow/drift)
      if (flowState.status === 'none' && flowState.cooldown_remaining > 0) {
        flowState = { ...flowState, cooldown_remaining: flowState.cooldown_remaining - 1 };
      }
    }
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

  writeFlowTickState(currentTime, emotion, intentPool, updatedEvents, vitality, confidence, flowState, chainState, heartbeatLog, {
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
  if (logJson.length > HEARTBEAT_CONFIG.LOG_SIZE_LIMIT) {
    updatedLog = { ...updatedLog, logs: updatedLog.logs.slice(-HEARTBEAT_CONFIG.LOG_TRIM_KEEP) };
  }
  writeJSON(PATHS.heartbeatLog, updatedLog);
}

// Entry point: route to the right handler
export async function main(
  llm: { callJSON<T>(prompt: string, maxTokens?: number): Promise<T>; call(prompt: string, maxTokens?: number): Promise<string> },
): Promise<void> {
  const currentTime = now();
  const hour = getLocalHour(currentTime);
  const todayStr = getLocalDate(currentTime);

  const cronSchedule = readJSON<CronSchedule>(PATHS.cronSchedule, { date: '', heartbeats: [] });

  // First-wake detection
  if (cronSchedule.date !== todayStr) {
    console.log(`First wake of ${todayStr} (schedule date: ${cronSchedule.date || 'none'}) — running morning plan`);
    await runMorningPlan(llm);
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
      await runMorningPlan(llm);
      break;
    case 'night':
      console.log('Night heartbeat — running night reflection');
      await runNightReflect(llm);
      break;
    case 'regular':
      await regularTick(llm);
      break;
  }
}
