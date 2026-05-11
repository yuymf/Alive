#!/usr/bin/env node
/**
 * ops-browse.ts
 * Cron entry: Pure scheduled content browsing for ops personas.
 * Replaces heartbeat-tick for personas with enable_heartbeat_cron: false.
 * Directly calls content-browse sub-skill without intent engine or LLM decisions.
 */

import { loadPersona, getContentSourcesConfig } from '../persona/persona-loader';
import { wallNow, getLocalDate } from '../utils/time-utils';
import { PATHS, readJSON, writeJSON, appendText, setPersonaName, loadSkillEnvVars } from '../utils/file-utils';
import { TaskDeadline } from '../utils/task-deadline';
import { beginOpsRun, finishOpsRun } from '../utils/run-status';
import { getPlatformCooldownRemainingMs } from '../utils/platform-runtime';
import { processInspirationForDiscovery, processInspirationForAccountDiscovery } from '../ops/discovery-engine';

import { buildRouteTable, resolveRouteBySkillName, buildContext, executeSubSkill } from '../router/skill-router';
import { createRealLLMClient } from '../utils/llm-client';
import { hydrateEmotionState, DEFAULT_MOMENTUM, DEFAULT_UNDERTONE } from '../utils/types';
import type { HeartbeatLog, HeartbeatLogEntry, EmotionState, ResolvedIntent } from '../utils/types';
import { createContentBrowseConfig } from '../adapters/instagram-adapter';
import { ContentProviderRegistry, type ContentProvider } from '../adapters/content-provider';
import { BilibiliProvider } from '../adapters/providers/bilibili-provider';
import { RedditProvider } from '../adapters/providers/reddit-provider';
import { DailyHotApiProvider } from '../adapters/providers/dailyhot-provider';
import { WeiboProvider } from '../adapters/providers/weibo-provider';
import { ZhihuProvider } from '../adapters/providers/zhihu-provider';
import { XhsProvider } from '../adapters/providers/xhs-provider';
import { DouyinProvider } from '../adapters/providers/douyin-provider';
import { exaWebSearch } from '../utils/exa-client';
import { runKeywordSearch } from '../ops/keyword-tracker';
import { refreshSearchKeywordTrends } from '../ops/trend-analyzer';
import { deliverOpsResult } from '../ops/brief-generator';

// ── Types ────────────────────────────────────────────────────────

interface BrowseSourceResult {
  platform: string;
  items: Array<{ title: string; source: string }>;
}

// ── Provider mapping ─────────────────────────────────────────────

const PROVIDER_MAP: Record<string, () => ContentProvider> = {
  xhs: () => new XhsProvider(),
  douyin: () => new DouyinProvider(),
  bilibili: () => new BilibiliProvider(),
  weibo: () => new WeiboProvider(),
  zhihu: () => new ZhihuProvider(),
  reddit: () => new RedditProvider(),
  dailyhot: () => new DailyHotApiProvider(),
};

// ── Helpers (exported for testing) ───────────────────────────────

/**
 * Format browse results into a diary entry string.
 */
export function buildBrowseSummary(results: BrowseSourceResult[]): string {
  const withItems = results.filter(r => r.items.length > 0);
  if (withItems.length === 0) return '';

  const lines: string[] = [];
  for (const r of withItems) {
    lines.push(`**${r.platform}** (${r.items.length}条):`);
    for (const item of r.items.slice(0, 5)) {
      lines.push(`  - ${item.title}`);
    }
  }
  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  loadSkillEnvVars('alive');
  process.env.ALIVE_CRON = process.env.ALIVE_CRON ?? '1';

  const personaArgIdx = process.argv.indexOf('--persona');

  if (personaArgIdx !== -1 && process.argv[personaArgIdx + 1]) {
    setPersonaName(process.argv[personaArgIdx + 1]);
  }

  const run = beginOpsRun('ops-browse');
  const warnings: string[] = [];
  const deadline = TaskDeadline.fromEnv('ops-browse', 'ALIVE_OPS_BROWSE_BUDGET_MS', 300_000);

  const persona = await loadPersona();

  const ops = persona.ops;


  if (!ops?.enabled) {
    console.log(`[${wallNow().toISOString()}] ops-browse: ops.enabled is false, skipping`);
    finishOpsRun(run, 'skipped', { warnings: ['ops.enabled is false'] });
    return;
  }


  // Determine if we should run:
  // 1. If browse_schedule is set → run at scheduled times only (check current time matches)
  // 2. If browse_schedule is NOT set → only run when heartbeat is disabled (legacy cron-only mode)
  const browseSchedule = ops.browse_schedule;
  if (browseSchedule && browseSchedule.length > 0) {
    const nowHour = wallNow().getHours();
    const nowMinute = wallNow().getMinutes();
    const matchesSchedule = browseSchedule.some(slot => {
      const [h, m] = slot.split(':').map(Number);
      return h === nowHour && m === nowMinute;
    });
    if (!matchesSchedule) {
      finishOpsRun(run, 'skipped', { warnings: ['not scheduled time'] });
      return; // silently skip — not a scheduled time
    }

    console.log(`[${wallNow().toISOString()}] ops-browse: scheduled browse at ${nowHour}:${String(nowMinute).padStart(2, '0')}`);
  } else {
    // Legacy mode: only run when heartbeat is disabled
    const enableHeartbeat = ops.automation?.enable_heartbeat_cron !== false;
    if (enableHeartbeat) {
      console.log(`[${wallNow().toISOString()}] ops-browse: heartbeat is enabled and no browse_schedule, skipping (use heartbeat-tick instead)`);
      finishOpsRun(run, 'skipped', { warnings: ['heartbeat cron is enabled'] });
      return;
    }

  }

  const llm = createRealLLMClient('ops-browse');
  const configuredBrowseSources = ops.browse_sources ?? [
    { platform: 'dailyhot', count: 5 },
  ];
  const xhsOnly = process.argv.includes('--xhs-only');
  const includeXhs = xhsOnly || process.env.ALIVE_OPS_BROWSE_INCLUDE_XHS === '1' || process.argv.includes('--include-xhs');
  const xhsCooldownMs = getPlatformCooldownRemainingMs('xhs');
  const browseSources = configuredBrowseSources.filter(source => {
    if (xhsOnly && source.platform !== 'xhs') return false;
    if (source.platform !== 'xhs') return true;
    if (includeXhs && xhsCooldownMs <= 0) return true;

    warnings.push(xhsCooldownMs > 0
      ? `XHS browse skipped due to cooldown (${Math.round(xhsCooldownMs / 1000)}s remaining)`
      : 'XHS browse skipped in main ops-browse; use --include-xhs for dedicated window');
    return false;
  });

  console.log(`[${wallNow().toISOString()}] ops-browse: starting for ${persona.meta.id}, ${browseSources.length}/${configuredBrowseSources.length} sources`);


  // Build route table for sub-skill access
  buildRouteTable(undefined, persona);
  const browseRoute = resolveRouteBySkillName('content-browse');

  if (!browseRoute) {
    console.log(`[${wallNow().toISOString()}] ops-browse: content-browse sub-skill not found, skipping`);
    finishOpsRun(run, 'skipped', { warnings: ['content-browse route not found'] });
    return;
  }


  const results: BrowseSourceResult[] = [];

  // Load emotion state for context (use defaults if not yet persisted)
  const DEFAULT_EMOTION: EmotionState = {
    mood: { valence: 0.3, arousal: 0.5, description: '平静' },
    energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
    last_updated: null, recent_cause: 'ops-browse初始化',
    momentum: { ...DEFAULT_MOMENTUM },
    undertone: { ...DEFAULT_UNDERTONE },
    impulse_history: [],
    consecutive_high_stress: 0,
    threshold_break_cooldown: 0,
  };
  const emotion = hydrateEmotionState(
    readJSON(PATHS.emotionState, DEFAULT_EMOTION) as unknown as Record<string, unknown>,
  );

  const browseIntent: ResolvedIntent = {
    id: 'ops-browse-consume',
    category: 'consume',
    description: '定时浏览内容',
    intensity: 0.5,
    action: 'feed-browse',
  };

  for (const source of browseSources) {
    if (!deadline.shouldStart(90_000, `browse:${source.platform}`)) {
      warnings.push(`skip ${source.platform}: budget low`);
      results.push({ platform: source.platform, items: [] });
      continue;
    }
    try {
      // Only register the provider for the current browse source platform

      const registry = new ContentProviderRegistry();
      const providerFactory = PROVIDER_MAP[source.platform];
      if (!providerFactory) {
        console.warn(`[ops-browse] Unknown platform: ${source.platform}, skipping`);
        results.push({ platform: source.platform, items: [] });
        continue;
      }
      registry.register(providerFactory());

      // Limit contentSources to the current platform only
      const contentSources = getContentSourcesConfig(persona);
      const singleSourceConfig = {
        platforms: [source.platform],
        keywords: contentSources.keywords,
        dailyhot_platforms: source.platform === 'dailyhot' ? contentSources.dailyhot_platforms : [],
      };

      const skillConfig = createContentBrowseConfig({
        contentSources: singleSourceConfig,
        registry,
        webSearch: (query, limit) => exaWebSearch(query, limit ?? 5),
      }) as unknown as Record<string, unknown>;
      skillConfig.actionContext = `定时浏览${source.platform}，了解最新动态`;

      const context = buildContext(
        persona,
        emotion,
        emotion.energy,
        1.0, // neutral confidence
        { ...browseIntent, description: `定时浏览${source.platform}` },
        llm,
        skillConfig,
      );

      const result = await executeSubSkill(browseRoute, context);

      results.push({
        platform: source.platform,
        items: (result.narrative ? [{ title: result.narrative.slice(0, 100), source: source.platform }] : []),
      });
    } catch (err) {
      const msg = (err as Error).message;
      warnings.push(`${source.platform} browse failed: ${msg}`);
      console.error(`[ops-browse] Failed to browse ${source.platform}: ${msg}`);
      results.push({ platform: source.platform, items: [] });
    }

  }

  // Post-browse hook: trigger discovery pipeline (matches heartbeat-tick post-hook)
  try {
    const discovered = processInspirationForDiscovery();
    const newCandidates = processInspirationForAccountDiscovery();
    if (discovered > 0 || newCandidates > 0) {
      console.log(`[ops-browse] discovery: +${discovered} content discoveries, +${newCandidates} candidate accounts`);
    }
  } catch (err) {
    console.error(`[ops-browse] discovery pipeline error: ${(err as Error).message}`);
  }

  // Post-browse hook: active keyword search is high-risk and opt-in for cron.
  const keywordSearchEnabled = process.env.ALIVE_OPS_BROWSE_KEYWORD_SEARCH === '1' || process.argv.includes('--keyword-search');
  if (keywordSearchEnabled && deadline.shouldStart(120_000, 'post-browse keyword search')) {
    try {
      const keywordRegistry = new ContentProviderRegistry();
      const registered = new Set<string>();
      for (const source of browseSources) {
        const factory = PROVIDER_MAP[source.platform];
        if (factory && !registered.has(source.platform)) {
          keywordRegistry.register(factory());
          registered.add(source.platform);
        }
      }

      const kResult = await runKeywordSearch(keywordRegistry);
      if (kResult.searched > 0) {
        console.log(`[keyword-tracker] Searched ${kResult.searched} keywords (${kResult.keywords.join(', ')}), +${kResult.totalDiscovered} discoveries`);
      }
    } catch (err) {
      const msg = (err as Error).message;
      warnings.push(`keyword search failed: ${msg}`);
      console.warn(`[keyword-tracker] Post-browse keyword search failed: ${msg}`);
    }
  } else {
    console.log('[keyword-tracker] Post-browse keyword search disabled by default');
  }


  if (process.env.ALIVE_OPS_BROWSE_PRECOMPUTE_SEARCH === '1' && deadline.shouldStart(150_000, 'post-browse search precompute')) {
    try {
      const skItems = await refreshSearchKeywordTrends(ops);

      if (skItems.length > 0) {
        console.log(`[search-keyword] Pre-computed ${skItems.length} trend items from keyword searches`);
      }
    } catch (err) {
      console.warn(`[search-keyword] Post-browse search-keyword pre-computation failed: ${(err as Error).message}`);
    }
  }

  // Write diary entry

  const summary = buildBrowseSummary(results);
  if (summary) {
    const timestamp = wallNow().toISOString();
    const diaryEntry = `\n### ${getLocalDate()} ops-browse\n${summary}\n`;
    appendText(PATHS.diary, diaryEntry);
    console.log(`[${timestamp}] ops-browse: wrote diary entry`);
  }

  // Append to heartbeat-log for continuity
  const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
  const logEntry: HeartbeatLogEntry = {
    timestamp: wallNow().toISOString(),
    type: 'regular',
    status: 'completed',
    chosen_actions: browseSources.map(s => `ops-browse:${s.platform}`),
    tick_summary: summary || 'No browse results',
  };
  const updatedLog: HeartbeatLog = {
    logs: [...log.logs.slice(-499), logEntry],
    retention_days: log.retention_days,
  };
  writeJSON(PATHS.heartbeatLog, updatedLog);

  // IM 投递
  if (summary) {
    const imSummary = `📰 定时浏览速报\n${summary}`;
    deliverOpsResult(imSummary, ops);
  }

  finishOpsRun(run, warnings.length > 0 ? 'degraded_success' : 'success', {
    warnings,
    outputs: {
      configured_sources: configuredBrowseSources.length,
      active_sources: browseSources.length,
      result_sources: results.filter(r => r.items.length > 0).length,
    },
  });

  console.log(`[${wallNow().toISOString()}] ops-browse: completed`);
}


// Guard: only run when executed directly (not when imported for testing)
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(`[${wallNow().toISOString()}] ops-browse ERROR:`, err);
      process.exit(1);
    });
}

