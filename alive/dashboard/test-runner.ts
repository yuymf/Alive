#!/usr/bin/env tsx
/**
 * test-runner.ts
 * Lightweight script runner for the /test dashboard.
 *
 * Called by server.js via child_process:
 *   tsx test-runner.ts <command> [--persona <name>] [--param <json>]
 *
 * Commands:
 *   heartbeat        — Run regularTick()
 *   morning          — Run runMorningPlan()
 *   night            — Run runNightReflect()
 *   skill:<name>:<action> — Run a sub-skill action
 *   set-state        — Directly write to a state file
 *   get-state        — Read all state (for UI refresh)
 *   list-skills      — List available sub-skills
 *   full-day         — Run complete day simulation: morning → N heartbeats → night
 *   reset-state      — Reset all state files to clean defaults
 *   get-diary        — Read diary.md content
 *   get-heartbeat-log — Read heartbeat log
 */

import * as fs from 'fs';
import { setPersonaName, PATHS, readJSON, writeJSON, loadSkillEnvVars } from '../scripts/utils/file-utils';
import { createRealLLMClient } from '../scripts/utils/llm-client';
import { createContentBrowseConfig, createInstagramConfig, createSocialEngagementConfig } from '../scripts/adapters/instagram-adapter';
import { ContentProviderRegistry } from '../scripts/adapters/content-provider';
import { BilibiliProvider } from '../scripts/adapters/providers/bilibili-provider';
import { RedditProvider } from '../scripts/adapters/providers/reddit-provider';
import { DailyHotApiProvider } from '../scripts/adapters/providers/dailyhot-provider';
import { WeiboProvider } from '../scripts/adapters/providers/weibo-provider';
import { ZhihuProvider } from '../scripts/adapters/providers/zhihu-provider';
import { XhsProvider } from '../scripts/adapters/providers/xhs-provider';
import { DouyinProvider } from '../scripts/adapters/providers/douyin-provider';
import { getContentSourcesConfig } from '../scripts/persona/persona-loader';
import { regularTick } from '../scripts/lifecycle/heartbeat-tick';
import { runMorningPlan } from '../scripts/lifecycle/morning-plan';
import { runNightReflect } from '../scripts/lifecycle/night-reflect';
import { loadPersona } from '../scripts/persona/persona-loader';
import {
  buildRouteTable, resolveRouteBySkillName, buildContext, executeSubSkill,
  getRegisteredSkills, clearRouteTable,
} from '../scripts/router/skill-router';
import { hydrateEmotionState, VitalityState, ConfidenceState } from '../scripts/utils/types';
import { setTimeOverride, clearTimeOverride } from '../scripts/utils/time-utils';

// ── Ops module imports ──────────────────────────────────────────────
import { analyzeTrends, buildPersonaIdentities } from '../scripts/ops/trend-analyzer';
import { trackCompetitors, buildCompetitorSummary } from '../scripts/ops/competitor-tracker';
import { generateTopics } from '../scripts/ops/topic-generator';
import { loadQueue, markApproved, markDiscarded, markPublished } from '../scripts/ops/review-queue';
import { formatBriefCard, BriefEnrichment, formatStrategySection } from '../scripts/ops/brief-generator';
import { runHealthCheck, formatHealthReport } from '../scripts/ops/health-check';
import { analyzePost, formatAnalysisCard } from '../scripts/ops/viral-analyzer';
import { generatePersonaReport, formatAlignmentCard } from '../scripts/ops/persona-advisor';
import { loadStrategy, computeStrategy, confirmStrategy } from '../scripts/ops/strategy-engine';
import { loadDiscoveryPool, loadCandidateAccounts, approveCandidate, dismissCandidate } from '../scripts/ops/discovery-engine';
import { loadKeywordState, buildKeywordContext } from '../scripts/ops/keyword-tracker';
import { runViralSearch, runCrossPlatformRadar, runAutoBreakdown } from '../scripts/ops/viral-search';
import { loadContentPatterns, getRelevantPatterns } from '../scripts/ops/content-analyzer';
import { loadContentTaste } from '../scripts/ops/taste-engine';
import { loadPerformanceLog } from '../scripts/ops/performance-tracker';
import { loadAnalysisLog } from '../scripts/ops/post-analyzer';

// ── Parse CLI args ────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

function getArg(name: string): string | null {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

/** Emit a progress event for streaming to the frontend (SSE-compatible) */
function emitProgress(step: string, detail: string, progress?: number) {
  const event = { type: 'progress', step, detail, progress, timestamp: new Date().toISOString() };
  // Write to stderr so it doesn't interfere with final JSON output on stdout
  process.stderr.write(`__PROGRESS__${JSON.stringify(event)}\n`);
}

export function assertDispatchSucceeded(result: Record<string, unknown>): void {
  const error = result.error;
  if (typeof error === 'string' && error.trim().length > 0) {
    throw new Error(error);
  }
}

export async function main() {
  // Load environment variables from openclaw.json
  loadSkillEnvVars('alive');

  const persona = getArg('persona');
  if (persona) {
    setPersonaName(persona);
    process.env.ALIVE_PERSONA = persona;
  }

  // Handle time override
  const timeStr = getArg('time');
  if (timeStr) {
    const d = new Date(timeStr);
    if (!isNaN(d.getTime())) {
      setTimeOverride(d);
    }
  }

  if (!command) {
    console.error(JSON.stringify({ error: 'No command specified' }));
    process.exit(1);
  }

  try {
    const result = await dispatch(command);
    assertDispatchSucceeded(result);
    // Clear any time override before exiting
    clearTimeOverride();
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (err) {
    clearTimeOverride();
    console.error(JSON.stringify({ error: (err as Error).message, stack: (err as Error).stack }));
    process.exit(1);
  }
}

export async function dispatch(cmd: string): Promise<Record<string, unknown>> {
  // ── Lifecycle commands ──────────────────────────────────────────
  if (cmd === 'heartbeat') {
    const llm = createRealLLMClient('test-heartbeat');
    await regularTick(llm);
    // Read post-tick state for richer response
    const emotion = readJSON(PATHS.emotionState, null);
    const log = readJSON<{ logs?: Array<Record<string, unknown>> }>(PATHS.heartbeatLog, { logs: [] });
    const lastEntry = log.logs && log.logs.length > 0 ? log.logs[log.logs.length - 1] : null;
    return {
      command: 'heartbeat',
      message: 'Heartbeat tick completed',
      lastTick: lastEntry,
      emotion,
    };
  }

  if (cmd === 'morning') {
    const llm = createRealLLMClient('test-morning');
    await runMorningPlan(llm);
    const schedule = readJSON(PATHS.scheduleToday, null);
    const intents = readJSON(PATHS.intentPool, null);
    const emotion = readJSON(PATHS.emotionState, null);
    return {
      command: 'morning',
      message: 'Morning plan completed',
      schedule,
      intents,
      emotion,
    };
  }

  if (cmd === 'night') {
    const llm = createRealLLMClient('test-night');
    await runNightReflect(llm);
    const emotion = readJSON(PATHS.emotionState, null);
    const wisdom = readJSON(PATHS.coreWisdom, null);
    return {
      command: 'night',
      message: 'Night reflection completed',
      emotion,
      wisdom,
    };
  }

  // ── Full Day Simulation ────────────────────────────────────────
  if (cmd === 'full-day') {
    const paramJson = getArg('param');
    const params = paramJson ? JSON.parse(paramJson) : {};
    const heartbeatCount = params.heartbeats ?? 3;
    const startHour = params.startHour ?? 8;
    const endHour = params.endHour ?? 23;
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth();
    const day = today.getDate();

    const totalSteps = 2 + heartbeatCount; // morning + N heartbeats + night
    let currentStep = 0;
    const timeline: Array<{ phase: string; hour: number; duration: number; summary: string; error?: string }> = [];

    // --- Phase 1: Morning Plan ---
    emitProgress('morning', '开始晨间规划...', 0);
    const morningStart = Date.now();
    try {
      setTimeOverride(new Date(year, month, day, startHour, 0, 0));
      const llm = createRealLLMClient('e2e-morning');
      await runMorningPlan(llm);
      const elapsed = Date.now() - morningStart;
      const schedule = readJSON(PATHS.scheduleToday, null);
      timeline.push({
        phase: 'morning',
        hour: startHour,
        duration: elapsed,
        summary: `晨间规划完成 — ${schedule && (schedule as Record<string, unknown>).flexible ? ((schedule as Record<string, unknown>).flexible as unknown[]).length : 0} 个弹性任务`,
      });
    } catch (err) {
      timeline.push({
        phase: 'morning',
        hour: startHour,
        duration: Date.now() - morningStart,
        summary: '晨间规划失败',
        error: (err as Error).message,
      });
    }
    currentStep++;
    emitProgress('morning', '晨间规划完成', Math.round((currentStep / totalSteps) * 100));

    // --- Phase 2: Heartbeat Ticks ---
    const hoursAvailable = endHour - startHour - 1; // Reserve last hour for night
    const heartbeatInterval = heartbeatCount > 1 ? Math.floor(hoursAvailable / heartbeatCount) : hoursAvailable;

    for (let i = 0; i < heartbeatCount; i++) {
      const tickHour = startHour + 1 + (i * heartbeatInterval);
      if (tickHour >= endHour) break;

      emitProgress('heartbeat', `心跳 ${i + 1}/${heartbeatCount} — 模拟 ${tickHour}:00`, Math.round((currentStep / totalSteps) * 100));
      const tickStart = Date.now();
      try {
        setTimeOverride(new Date(year, month, day, tickHour, 0, 0));
        const llm = createRealLLMClient(`e2e-tick-${i}`);
        await regularTick(llm);
        const elapsed = Date.now() - tickStart;

        // Read last heartbeat entry for summary
        const log = readJSON<{ logs?: Array<Record<string, unknown>> }>(PATHS.heartbeatLog, { logs: [] });
        const lastEntry = log.logs && log.logs.length > 0 ? log.logs[log.logs.length - 1] : null;
        const summary = lastEntry
          ? (lastEntry.tick_summary as string || lastEntry.inner_monologue as string || 'tick completed')
          : 'tick completed';

        timeline.push({
          phase: 'heartbeat',
          hour: tickHour,
          duration: elapsed,
          summary: summary.slice(0, 200),
        });
      } catch (err) {
        timeline.push({
          phase: 'heartbeat',
          hour: tickHour,
          duration: Date.now() - tickStart,
          summary: `心跳 ${i + 1} 失败`,
          error: (err as Error).message,
        });
      }
      currentStep++;
      emitProgress('heartbeat', `心跳 ${i + 1}/${heartbeatCount} 完成`, Math.round((currentStep / totalSteps) * 100));
    }

    // --- Phase 3: Night Reflection ---
    emitProgress('night', '开始睡前反思...', Math.round((currentStep / totalSteps) * 100));
    const nightStart = Date.now();
    try {
      setTimeOverride(new Date(year, month, day, endHour, 0, 0));
      const llm = createRealLLMClient('e2e-night');
      await runNightReflect(llm);
      const elapsed = Date.now() - nightStart;
      timeline.push({
        phase: 'night',
        hour: endHour,
        duration: elapsed,
        summary: '睡前反思完成',
      });
    } catch (err) {
      timeline.push({
        phase: 'night',
        hour: endHour,
        duration: Date.now() - nightStart,
        summary: '睡前反思失败',
        error: (err as Error).message,
      });
    }
    currentStep++;
    emitProgress('night', '全天模拟完成！', 100);

    clearTimeOverride();

    // Gather final state
    const finalEmotion = readJSON(PATHS.emotionState, null);
    const finalVitality = readJSON(PATHS.vitalityState, null);
    const finalConfidence = readJSON(PATHS.confidenceState, null);
    const heartbeatLog = readJSON<{ logs?: unknown[] }>(PATHS.heartbeatLog, { logs: [] });
    const diary = fs.existsSync(PATHS.diary) ? fs.readFileSync(PATHS.diary, 'utf-8') : '';
    const schedule = readJSON(PATHS.scheduleToday, null);
    const wisdom = readJSON(PATHS.coreWisdom, null);
    const totalDuration = timeline.reduce((sum, t) => sum + t.duration, 0);
    const errors = timeline.filter(t => t.error);

    return {
      command: 'full-day',
      message: `全天模拟完成：${timeline.length} 个阶段，${errors.length} 个错误，总耗时 ${Math.round(totalDuration / 1000)}s`,
      timeline,
      totalDuration,
      finalState: {
        emotion: finalEmotion,
        vitality: finalVitality,
        confidence: finalConfidence,
      },
      heartbeatLog: heartbeatLog.logs ? heartbeatLog.logs.slice(-10) : [],
      diary: diary.slice(-2000), // Last 2000 chars of diary
      schedule,
      wisdom,
    };
  }

  // ── Reset State ────────────────────────────────────────────────
  if (cmd === 'reset-state') {
    const now = new Date().toISOString();

    // Default emotion state (new format)
    writeJSON(PATHS.emotionState, {
      mood: { valence: 0.3, arousal: 0.5, description: '平静' },
      energy: 0.7,
      stress: 0.2,
      creativity: 0.5,
      sociability: 0.5,
      undertone: { label: 'neutral', intensity: 0.3, since: now },
      momentum: { direction: 'neutral', strength: 0.0, streak_days: 0 },
      resistance: { threshold: 0.6, current: 0.0 },
      last_updated: now,
      recent_cause: 'state reset from test panel',
    });

    // Default vitality
    writeJSON(PATHS.vitalityState, {
      vitality: 85,
      last_updated: now,
      consecutive_low_days: 0,
    });

    // Default confidence
    writeJSON(PATHS.confidenceState, {
      confidence: 1.0,
      streak: 0,
      last_updated: now,
    });

    // Default flow state
    writeJSON(PATHS.flowState, {
      status: 'none',
      depth: 0,
      activity: null,
      entered_at: null,
      last_updated: now,
    });

    // Empty intent pool
    writeJSON(PATHS.intentPool, {
      intents: [],
      last_updated: now,
    });

    // Empty heartbeat log
    writeJSON(PATHS.heartbeatLog, {
      logs: [],
      retention_days: 3,
    });

    // Empty schedule
    writeJSON(PATHS.scheduleToday, {
      date: now.slice(0, 10),
      rigid: [],
      flexible: [],
    });

    // Clear event queue
    writeJSON(PATHS.eventQueue, {
      events: [],
      last_processed: now,
    });

    // Clear pending chains
    writeJSON(PATHS.pendingChains, {
      pending: [],
      cooldowns: {},
    });

    return {
      command: 'reset-state',
      message: '所有状态已重置为默认值',
      resetFiles: [
        'emotion-state', 'vitality-state', 'confidence-state',
        'flow-state', 'intent-pool', 'heartbeat-log',
        'schedule-today', 'event-queue', 'pending-chains',
      ],
    };
  }

  // ── Get Diary ──────────────────────────────────────────────────
  if (cmd === 'get-diary') {
    const diary = fs.existsSync(PATHS.diary) ? fs.readFileSync(PATHS.diary, 'utf-8') : '';
    return { command: 'get-diary', diary };
  }

  // ── Get Heartbeat Log ─────────────────────────────────────────
  if (cmd === 'get-heartbeat-log') {
    const log = readJSON<{ logs?: unknown[] }>(PATHS.heartbeatLog, { logs: [] });
    return {
      command: 'get-heartbeat-log',
      entries: log.logs || [],
      count: (log.logs || []).length,
    };
  }

  // ── Sub-skill execution ────────────────────────────────────────
  if (cmd.startsWith('skill:')) {
    const parts = cmd.split(':');
    const skillName = parts[1];
    const actionName = parts[2] || null;

    const personaConfig = loadPersona();
    clearRouteTable();
    buildRouteTable(undefined, personaConfig);

    const route = resolveRouteBySkillName(skillName);
    if (!route) {
      // Try finding action directly
      const skills = getRegisteredSkills();
      return { error: `Skill "${skillName}" not found. Available: ${skills.map(s => s.name).join(', ')}` };
    }

    // If specific action was requested, find it
    let targetRoute = route;
    if (actionName) {
      // Check if the skill has this specific action
      const actionFn = route.skillModule.actions[actionName];
      if (typeof actionFn === 'function') {
        targetRoute = { ...route, action: actionName };
      } else {
        return { error: `Action "${actionName}" not found in skill "${skillName}". Available: ${Object.keys(route.skillModule.actions).join(', ')}` };
      }
    }

    const llm = createRealLLMClient(`test-skill-${skillName}`);

    // Read current state for context
    const rawEmotion = readJSON<Record<string, unknown>>(PATHS.emotionState, {});
    const emotion = hydrateEmotionState(rawEmotion);
    const vitality = readJSON<VitalityState>(PATHS.vitalityState, { vitality: 80, last_updated: null, consecutive_low_days: 0 });
    const confidence = readJSON<ConfidenceState>(PATHS.confidenceState, { confidence: 1.0, streak: 0, last_updated: null });

    const resolvedIntent = {
      id: `test_${Date.now()}`,
      category: 'express' as const,
      description: `Manual test: ${skillName}.${targetRoute.action}`,
      intensity: 7,
      action: targetRoute.action,
    };

    // Build skill-specific config (same as heartbeat-tick does for real runs)
    let skillConfig: Record<string, unknown> = {};
    if (skillName === 'content-browse') {
      const contentSources = getContentSourcesConfig(personaConfig);
      const registry = new ContentProviderRegistry();
      registry.register(new BilibiliProvider());
      registry.register(new RedditProvider());
      registry.register(new DailyHotApiProvider());
      registry.register(new WeiboProvider());
      registry.register(new ZhihuProvider());
      registry.register(new XhsProvider());
      registry.register(new DouyinProvider());
      skillConfig = createContentBrowseConfig({ contentSources, registry }) as unknown as Record<string, unknown>;
    } else if (skillName === 'instagram') {
      skillConfig = createInstagramConfig() as unknown as Record<string, unknown>;
    } else if (skillName === 'social-engagement') {
      skillConfig = createSocialEngagementConfig() as unknown as Record<string, unknown>;
    }

    const ctx = buildContext(personaConfig, emotion, vitality.vitality, confidence.confidence, resolvedIntent, llm, skillConfig);
    const subResult = await executeSubSkill(targetRoute, ctx);

    return {
      command: `skill:${skillName}:${targetRoute.action}`,
      message: subResult.narrative,
      emotion_deltas: subResult.emotion_deltas,
      vitality_cost: subResult.vitality_cost,
    };
  }

  // ── State manipulation ─────────────────────────────────────────
  if (cmd === 'set-state') {
    const paramJson = getArg('param');
    if (!paramJson) return { error: 'Missing --param' };

    const params = JSON.parse(paramJson) as {
      field: string;
      value: unknown;
    };

    const stateMap: Record<string, string> = {
      'emotion': PATHS.emotionState,
      'vitality': PATHS.vitalityState,
      'confidence': PATHS.confidenceState,
      'flow': PATHS.flowState,
      'intent': PATHS.intentPool,
    };

    const filePath = stateMap[params.field];
    if (!filePath) return { error: `Unknown state field: ${params.field}. Available: ${Object.keys(stateMap).join(', ')}` };

    // Merge with existing state
    const existing = readJSON(filePath, {});
    const merged = { ...existing, ...(params.value as Record<string, unknown>) };
    writeJSON(filePath, merged);

    return { command: 'set-state', field: params.field, message: `State "${params.field}" updated` };
  }

  if (cmd === 'get-state') {
    const emotion = readJSON(PATHS.emotionState, null);
    const vitality = readJSON(PATHS.vitalityState, null);
    const confidence = readJSON(PATHS.confidenceState, null);
    const flow = readJSON(PATHS.flowState, null);
    const schedule = readJSON(PATHS.scheduleToday, null);
    const intents = readJSON(PATHS.intentPool, null);
    const heartbeatLog = readJSON<{ logs?: unknown[] }>(PATHS.heartbeatLog, { logs: [] });

    return {
      command: 'get-state',
      state: { emotion, vitality, confidence, flow, schedule, intents },
      heartbeatCount: (heartbeatLog.logs || []).length,
    };
  }

  // ── List available skills ──────────────────────────────────────
  if (cmd === 'list-skills') {
    const personaConfig = loadPersona();
    clearRouteTable();
    buildRouteTable(undefined, personaConfig);
    const skills = getRegisteredSkills();

    return {
      command: 'list-skills',
      skills: skills.map(s => ({
        name: s.name,
        display_name: s.display_name,
        description: s.description,
        actions: [...new Set(s.intent_bindings.map(b => b.action))],
      })),
    };
  }

  // ══════════════════════════════════════════════════════════════
  // ── Ops Debugging Console Commands ─────────────────────────
  // ══════════════════════════════════════════════════════════════

  // ── Ops: Health Check ─────────────────────────────────────────
  if (cmd === 'ops-health') {
    const report = await runHealthCheck();
    const formatted = formatHealthReport(report);
    return {
      command: 'ops-health',
      message: `健康检查完成: ${report.summary.ok} ok / ${report.summary.warn} warn / ${report.summary.missing} missing`,
      report,
      formatted,
    };
  }

  // ── Ops: Trend Analysis ───────────────────────────────────────
  if (cmd === 'ops-trends') {
    const personaConfig = loadPersona();
    if (!personaConfig.ops) return { error: '当前 persona 未启用 ops 功能 (ops.enabled: false)' };
    const llm = createRealLLMClient('test-ops-trends');
    const identities = buildPersonaIdentities(personaConfig);
    const trends = await analyzeTrends(personaConfig.ops, identities, llm);
    // Also return signal_pool from cache for display
    const cache = readJSON<{ signal_pool?: { bucket: string; top: { keyword: string; platform: string; v: string; p: string }[] }[] }>(PATHS.trendsCache, {} as any);
    return {
      command: 'ops-trends',
      message: `趋势分析完成: 找到 ${trends.length} 个相关趋势`,
      trends,
      count: trends.length,
      signal_pool: cache?.signal_pool ?? [],
    };
  }

  // ── Ops: Competitor Tracking ──────────────────────────────────
  if (cmd === 'ops-competitors') {
    const personaConfig = loadPersona();
    if (!personaConfig.ops) return { error: '当前 persona 未启用 ops 功能' };
    const updates = trackCompetitors(personaConfig.ops);
    const summary = buildCompetitorSummary(updates);
    return {
      command: 'ops-competitors',
      message: `竞品追踪完成: ${updates.length} 个账号`,
      updates,
      summary,
      count: updates.length,
    };
  }

  // ── Ops: Topic Generation ─────────────────────────────────────
  if (cmd === 'ops-idea') {
    const personaConfig = loadPersona();
    if (!personaConfig.ops) return { error: '当前 persona 未启用 ops 功能' };
    const llm = createRealLLMClient('test-ops-idea');
    const identities = buildPersonaIdentities(personaConfig);
    const trends = await analyzeTrends(personaConfig.ops, identities, llm);
    const personaDescription = identities;
    await generateTopics(trends, personaConfig.ops, personaDescription, llm, personaConfig.voice);
    // After generation, load the queue to see new items
    const queue = await loadQueue();
    const pending = queue.items.filter(i => i.status === 'pending');
    return {
      command: 'ops-idea',
      message: `选题生成完成: 当前 ${pending.length} 条待审核`,
      trends_used: trends.length,
      pending_count: pending.length,
      latest_items: pending.slice(-3),
    };
  }

  // ── Ops: Review Queue (browse) ────────────────────────────────
  if (cmd === 'ops-queue') {
    const queue = await loadQueue();
    const counts = {
      pending: queue.items.filter(i => i.status === 'pending').length,
      approved: queue.items.filter(i => i.status === 'approved').length,
      published: queue.items.filter(i => i.status === 'published').length,
      discarded: queue.items.filter(i => i.status === 'discarded').length,
      total: queue.items.length,
    };
    return {
      command: 'ops-queue',
      message: `审核队列: ${counts.pending} 待审核, ${counts.approved} 已通过, ${counts.published} 已发布`,
      queue: queue.items,
      counts,
      last_updated: queue.last_updated,
    };
  }

  // ── Ops: Queue Actions (approve/discard/publish) ──────────────
  if (cmd === 'ops-queue-approve') {
    const paramJson = getArg('param');
    const params = paramJson ? JSON.parse(paramJson) : {};
    if (!params.id) return { error: '缺少参数: id (队列项ID)' };
    const result = await markApproved(params.id);
    // Write structured review feedback if reason provided
    if (result && (params.reason_summary || params.platform_fit_tags)) {
      const { addReviewFeedback } = await import('../scripts/ops/review-queue');
      await addReviewFeedback(params.id, {
        decision: 'approved' as const,
        source: 'dashboard' as const,
        reason_summary: params.reason_summary ?? '运营确认',
        persona_deviation_tags: params.persona_deviation_tags,
        risk_tags: params.risk_tags,
        platform_fit_tags: params.platform_fit_tags,
        improvement_directions: params.improvement_directions,
      });
    }
    return {
      command: 'ops-queue-approve',
      message: result ? `已通过: ${params.id}` : `未找到: ${params.id}`,
      success: result,
      itemId: params.id,
    };
  }

  if (cmd === 'ops-queue-discard') {
    const paramJson = getArg('param');
    const params = paramJson ? JSON.parse(paramJson) : {};
    if (!params.id) return { error: '缺少参数: id (队列项ID)' };
    const result = await markDiscarded(params.id);
    // Write structured review feedback if reason provided
    if (result && (params.reason_summary || params.persona_deviation_tags)) {
      const { addReviewFeedback } = await import('../scripts/ops/review-queue');
      await addReviewFeedback(params.id, {
        decision: 'discarded' as const,
        source: 'dashboard' as const,
        reason_summary: params.reason_summary ?? '运营否决',
        persona_deviation_tags: params.persona_deviation_tags,
        risk_tags: params.risk_tags,
        improvement_directions: params.improvement_directions,
      });
    }
    return {
      command: 'ops-queue-discard',
      message: result ? `已废弃: ${params.id}` : `未找到: ${params.id}`,
      success: result,
      itemId: params.id,
    };
  }

  if (cmd === 'ops-queue-publish') {
    const paramJson = getArg('param');
    const params = paramJson ? JSON.parse(paramJson) : {};
    if (!params.id) return { error: '缺少参数: id (队列项ID)' };
    const publishInput = {
      platform: params.platform || 'xhs',
      url: params.url || '',
    };
    const result = await markPublished(params.id, publishInput);
    return {
      command: 'ops-queue-publish',
      message: result ? `已标记发布: ${params.id}` : `未找到: ${params.id}`,
      success: result,
      itemId: params.id,
    };
  }

  // ── Ops: Full Brief Pipeline ──────────────────────────────────
  if (cmd === 'ops-brief') {
    const personaConfig = loadPersona();
    if (!personaConfig.ops) return { error: '当前 persona 未启用 ops 功能' };
    const llm = createRealLLMClient('test-ops-brief');

    emitProgress('ops-brief', '正在分析趋势...', 10);
    const identities = buildPersonaIdentities(personaConfig);
    const trends = await analyzeTrends(personaConfig.ops, identities, llm);

    emitProgress('ops-brief', '正在追踪竞品...', 30);
    const competitors = trackCompetitors(personaConfig.ops);

    emitProgress('ops-brief', '正在加载审核队列...', 50);
    const queue = await loadQueue();
    const pendingItems = queue.items.filter(i => i.status === 'pending' || i.status === 'approved');

    emitProgress('ops-brief', '正在运行健康检查...', 60);
    const healthReport = await runHealthCheck();

    emitProgress('ops-brief', '正在生成人设报告...', 70);
    let personaReport: Awaited<ReturnType<typeof generatePersonaReport>> | null = null;
    try {
      personaReport = await generatePersonaReport(personaConfig, trends, competitors, llm);
    } catch { /* non-fatal */ }

    emitProgress('ops-brief', '正在格式化简报...', 90);
    const today = new Date().toISOString().slice(0, 10);
    const enrichment: BriefEnrichment = {
      personaReport,
      fullQueueItems: queue.items,
      healthReport,
    };
    const brief = formatBriefCard(today, trends, competitors, pendingItems, enrichment);

    emitProgress('ops-brief', '简报生成完成', 100);

    return {
      command: 'ops-brief',
      message: `简报已生成: ${trends.length} 趋势, ${competitors.length} 竞品, ${pendingItems.length} 队列项`,
      brief,
      data: {
        trends_count: trends.length,
        competitors_count: competitors.length,
        queue_count: pendingItems.length,
        health: healthReport.summary,
      },
    };
  }

  // ── Ops: Viral Post Analysis ──────────────────────────────────
  if (cmd === 'ops-analyze') {
    const paramJson = getArg('param');
    const params = paramJson ? JSON.parse(paramJson) : {};
    if (!params.url) return { error: '缺少参数: url (帖子链接)' };
    const personaConfig = loadPersona();
    const llm = createRealLLMClient('test-ops-analyze');
    const result = await analyzePost(params.url, personaConfig, llm);
    const formatted = formatAnalysisCard(result);
    return {
      command: 'ops-analyze',
      message: `爆款分析完成: ${result.platform} — ${result.hook_patterns?.[0]?.formula || 'N/A'}`,
      analysis: result,
      formatted,
    };
  }

  // ── Ops: Persona Advice ───────────────────────────────────────
  if (cmd === 'ops-advice') {
    const personaConfig = loadPersona();
    if (!personaConfig.ops) return { error: '当前 persona 未启用 ops 功能' };
    const llm = createRealLLMClient('test-ops-advice');
    const identities = buildPersonaIdentities(personaConfig);
    const trends = await analyzeTrends(personaConfig.ops, identities, llm);
    const competitors = trackCompetitors(personaConfig.ops);
    const report = await generatePersonaReport(personaConfig, trends, competitors, llm);
    const formatted = formatAlignmentCard(report);
    return {
      command: 'ops-advice',
      message: `人设建议已生成: ${report.identity_analysis.length} 个身份评估`,
      report,
      formatted,
    };
  }

  // ── Ops: Strategy Engine ──────────────────────────────────────
  if (cmd === 'ops-strategy') {
    const strategy = loadStrategy();
    if (!strategy) {
      return {
        command: 'ops-strategy',
        message: '暂无策略数据 — 请先运行 ops-strategy-compute 生成策略',
        strategy: null,
      };
    }
    const formatted = formatStrategySection(strategy);
    return {
      command: 'ops-strategy',
      message: `当前策略: 生成于 ${strategy.generated_at || 'unknown'}`,
      strategy,
      formatted,
    };
  }

  if (cmd === 'ops-strategy-compute') {
    const personaConfig = loadPersona();
    const llm = createRealLLMClient('test-ops-strategy');
    const identities = buildPersonaIdentities(personaConfig);
    const success = await computeStrategy(llm, identities, {});
    const strategy = loadStrategy();
    return {
      command: 'ops-strategy-compute',
      message: success ? '策略计算完成' : '策略计算失败',
      success,
      strategy,
    };
  }

  if (cmd === 'ops-strategy-confirm') {
    const result = confirmStrategy();
    return {
      command: 'ops-strategy-confirm',
      message: result ? '策略已确认并应用' : '未找到待确认策略',
      success: result,
    };
  }

  // ── Ops: Discovery Engine ─────────────────────────────────────
  if (cmd === 'ops-discovery') {
    const pool = loadDiscoveryPool();
    const candidates = loadCandidateAccounts();
    return {
      command: 'ops-discovery',
      message: `发现池: ${pool.items.length} 内容, ${candidates.candidates.length} 候选账号`,
      pool,
      candidates,
    };
  }

  if (cmd === 'ops-candidate-approve') {
    const paramJson = getArg('param');
    const params = paramJson ? JSON.parse(paramJson) : {};
    if (!params.name || !params.platform) return { error: '缺少参数: name, platform' };
    const result = approveCandidate(params.name, params.platform);
    return {
      command: 'ops-candidate-approve',
      message: result ? `已批准: ${params.name} (${params.platform})` : `未找到: ${params.name}`,
      success: result,
    };
  }

  if (cmd === 'ops-candidate-dismiss') {
    const paramJson = getArg('param');
    const params = paramJson ? JSON.parse(paramJson) : {};
    if (!params.name || !params.platform) return { error: '缺少参数: name, platform' };
    const result = dismissCandidate(params.name, params.platform);
    return {
      command: 'ops-candidate-dismiss',
      message: result ? `已忽略: ${params.name} (${params.platform})` : `未找到: ${params.name}`,
      success: result,
    };
  }

  // ── Ops: Keyword Tracker ──────────────────────────────────────
  if (cmd === 'ops-keywords') {
    const state = loadKeywordState();
    const context = buildKeywordContext();
    return {
      command: 'ops-keywords',
      message: `关键词追踪: ${state.keywords.length} 个关键词`,
      state,
      context,
    };
  }

  // ── Ops: Content Patterns ─────────────────────────────────────
  if (cmd === 'ops-patterns') {
    const patterns = loadContentPatterns();
    const relevant = getRelevantPatterns();
    return {
      command: 'ops-patterns',
      message: `内容模式: ${patterns.patterns.length} 个模式, ${patterns.competitor_insights.length} 个竞品洞察`,
      patterns,
      relevant_summary: relevant,
    };
  }

  // ── Ops: Viral Search ────────────────────────────────────────────
  if (cmd === 'ops-viral-search') {
    const result = await runViralSearch({ forceFresh: true });
    return {
      command: 'ops-viral-search',
      message: `爆款搜索完成: ${result.xhs_found} XHS + ${result.douyin_found} 抖音, 注入 ${result.injected} 条`,
      ...result,
    };
  }

  // ── Ops: Cross-Platform Radar ────────────────────────────────────
  if (cmd === 'ops-radar') {
    const result = await runCrossPlatformRadar({ forceFresh: true });
    return {
      command: 'ops-radar',
      message: `跨平台雷达完成: ${result.xhs_found} XHS + ${result.douyin_found} 抖音, 注入 ${result.injected} 条`,
      ...result,
    };
  }

  // ── Ops: Auto-Breakdown ──────────────────────────────────────────
  if (cmd === 'ops-auto-breakdown') {
    const llm = createRealLLMClient('test-ops-auto-breakdown');
    const result = await runAutoBreakdown(llm, { forceFresh: true });
    return {
      command: 'ops-auto-breakdown',
      message: `自动拆解完成: ${result.analyzed}/${result.candidates_found} 条已分析`,
      ...result,
    };
  }

  // ── Ops: Verify persona.yaml competitor write ─────────────────
  if (cmd === 'ops-verify-persona') {
    const personaConfig = loadPersona();
    const competitors = personaConfig.ops?.competitors || [];
    const discovered = competitors.filter((c: Record<string, unknown>) => c.tag === 'discovered');
    const manual = competitors.filter((c: Record<string, unknown>) => c.tag !== 'discovered');
    const candidates = loadCandidateAccounts();
    const approvedCandidates = candidates.candidates.filter(c => c.status === 'approved');
    return {
      command: 'ops-verify-persona',
      message: `persona.yaml 竞品: ${competitors.length} 总计 (${discovered.length} discovered, ${manual.length} 手动)`,
      total: competitors.length,
      discovered: discovered.length,
      manual: manual.length,
      approved_candidates: approvedCandidates.length,
      match: discovered.length >= approvedCandidates.length,
      competitors: competitors.map((c: Record<string, unknown>) => ({
        name: c.name || c.account,
        platform: c.platform,
        tag: c.tag || 'manual',
      })),
    };
  }

  // ── Ops: Content Taste ────────────────────────────────────────
  if (cmd === 'ops-taste') {
    const taste = loadContentTaste();
    const visualCount = taste.visual_preferences?.length || 0;
    const hookCount = taste.hook_preferences?.length || 0;
    const toneCount = taste.tone_preferences?.length || 0;
    const antiCount = taste.anti_patterns?.length || 0;
    return {
      command: 'ops-taste',
      message: `网感偏好: ${visualCount} 视觉, ${hookCount} 钩子, ${toneCount} 语调, ${antiCount} 反模式`,
      taste,
      summary: {
        visual: visualCount,
        hook: hookCount,
        tone: toneCount,
        anti_patterns: antiCount,
        last_updated: taste.last_updated || null,
      },
    };
  }

  // ── Ops: Performance Log ──────────────────────────────────────
  if (cmd === 'ops-performance') {
    const log = loadPerformanceLog();
    const tierCounts = { viral: 0, above_avg: 0, average: 0, below_avg: 0, flop: 0 };
    log.entries.forEach(e => {
      const t = e.tier || 'average';
      if (t in tierCounts) (tierCounts as Record<string, number>)[t]++;
    });
    return {
      command: 'ops-performance',
      message: `发布效果追踪: ${log.entries.length} 条记录`,
      entries: log.entries,
      total: log.entries.length,
      tier_counts: tierCounts,
      last_updated: log.last_updated || null,
    };
  }

  // ── Ops: Analysis Log ─────────────────────────────────────────
  if (cmd === 'ops-analysis-log') {
    const log = loadAnalysisLog();
    const tierCounts = { viral: 0, above_avg: 0, average: 0, below_avg: 0, flop: 0 };
    log.entries.forEach(e => {
      const t = e.tier || 'average';
      if (t in tierCounts) (tierCounts as Record<string, number>)[t]++;
    });
    const tasteUpdated = log.entries.filter(e => e.taste_updated).length;
    return {
      command: 'ops-analysis-log',
      message: `分析日志: ${log.entries.length} 条记录, ${tasteUpdated} 条已更新网感`,
      entries: log.entries,
      total: log.entries.length,
      tier_counts: tierCounts,
      taste_updated_count: tasteUpdated,
      last_updated: log.last_updated || null,
    };
  }

  // ── Ops: Audience Perception ────────────────────────────────────
  if (cmd === 'ops-perception') {
    const { loadAudiencePerception, buildAudiencePerceptionContext } = await import('../scripts/ops/audience-perception');
    const store = loadAudiencePerception();
    const context = buildAudiencePerceptionContext({ maxEntries: 10, maxChars: 600 });
    return {
      command: 'ops-perception',
      message: `受众感知: ${store.entries.length} 条记录`,
      entries: store.entries,
      context: context || '',
    };
  }

  // ── Ops: Status Overview ──────────────────────────────────────
  if (cmd === 'ops-status') {
    const queue = await loadQueue();
    const healthReport = await runHealthCheck();
    const strategy = loadStrategy();
    const pool = loadDiscoveryPool();
    const kwState = loadKeywordState();
    const patterns = loadContentPatterns();

    const counts = {
      queue_pending: queue.items.filter(i => i.status === 'pending').length,
      queue_approved: queue.items.filter(i => i.status === 'approved').length,
      queue_published: queue.items.filter(i => i.status === 'published').length,
      queue_total: queue.items.length,
      health_ok: healthReport.summary.ok,
      health_warn: healthReport.summary.warn,
      health_missing: healthReport.summary.missing,
      discovery_items: pool.items.length,
      keywords: kwState.keywords.length,
      patterns: patterns.patterns.length,
      has_strategy: !!strategy,
      strategy_age: strategy?.generated_at || null,
    };

    return {
      command: 'ops-status',
      message: `Ops 状态: ${counts.queue_pending} 待审核, 健康 ${counts.health_ok}/${counts.health_ok + counts.health_warn + counts.health_missing}`,
      counts,
      healthReport,
    };
  }

  return { error: `Unknown command: ${cmd}` };
}

if (require.main === module) {
  main();
}
