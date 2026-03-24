#!/usr/bin/env -S npx tsx
/**
 * e2e/e2e-real-day.ts
 *
 * Real-day E2E test script for the Alive digital life engine.
 * Simulates a full day (morning plan → hourly heartbeats → night reflection)
 * using REAL LLM, REAL image generation, REAL Instagram posting, and REAL XHS browsing.
 *
 * Usage:
 *   npx tsx e2e/e2e-real-day.ts [--persona <path>] [--slug <slug>] [--dry-run]
 *
 * Env vars are loaded automatically from ~/.openclaw/openclaw.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';

import { setBasePaths, resetBasePaths, PATHS, readJSON, readText } from '../alive/scripts/utils/file-utils';
import { setTimeOverride, clearTimeOverride, now } from '../alive/scripts/utils/time-utils';
import { setPersonaName } from '../alive/scripts/utils/file-utils';
import { clearPersonaCache } from '../alive/scripts/persona/persona-loader';
import { createRealLLMClient } from '../alive/scripts/utils/llm-client';
import type { LLMClient } from '../alive/scripts/utils/llm-client';
import { runMorningPlan } from '../alive/scripts/lifecycle/morning-plan';
import { regularTick, main as heartbeatMain } from '../alive/scripts/lifecycle/heartbeat-tick';
import { runNightReflect } from '../alive/scripts/lifecycle/night-reflect';
import type {
  EmotionState, IntentPool, HeartbeatLog, ScheduleToday, CronSchedule,
} from '../alive/scripts/utils/types';

import { loadApiKeys, applyApiKeys, requireEnvVars } from './shared/setup';

// ════════════════════════════════════════════════════
// Chain Tracking Types & Helpers (exported for unit tests)
// ════════════════════════════════════════════════════

export interface ChainResult {
  triggered: boolean;
  succeeded: boolean;
  errors: string[];
}

export interface LiveChainResults {
  instagramBrowse: ChainResult;
  xhsBrowse: ChainResult;
  instagramPost: ChainResult;
  instagramOutboundComment: ChainResult;
  instagramReplyComment: ChainResult;
}

export interface ChainStatusEntry {
  status: 'success' | 'failed' | 'not_triggered';
  errors: string[];
}

export type LiveChainSummary = Record<keyof LiveChainResults, ChainStatusEntry>;

/**
 * Resolve a chain result into a human-readable status.
 */
export function resolveNaturalChainStatus(
  chain: ChainResult,
): 'success' | 'failed' | 'not_triggered' {
  if (!chain.triggered) return 'not_triggered';
  return chain.succeeded ? 'success' : 'failed';
}

/**
 * Build a summary from all chain results.
 */
export function buildLiveChainSummary(chains: LiveChainResults): LiveChainSummary {
  const summary = {} as LiveChainSummary;
  for (const [key, result] of Object.entries(chains) as [keyof LiveChainResults, ChainResult][]) {
    summary[key] = {
      status: resolveNaturalChainStatus(result),
      errors: result.errors,
    };
  }
  return summary;
}

// ════════════════════════════════════════════════════
// Day Simulation
// ════════════════════════════════════════════════════

interface DayConfig {
  /** Persona slug (default: 'alive') */
  slug: string;
  /** Simulated date string (default: today) */
  date: string;
  /** Wake hour (default: 7) */
  wakeHour: number;
  /** Sleep hour (default: 23) */
  sleepHour: number;
  /** If true, skip actual LLM calls (just verify plumbing) */
  dryRun: boolean;
  /** Skill install directory (auto-detected from ~/.openclaw/skills/<slug>) */
  skillDir: string;
  /** Memory directory (auto-detected from ~/.openclaw/workspace/memory/<slug>) */
  memoryDir: string;
}

interface HourResult {
  hour: number;
  phase: 'morning' | 'regular' | 'night';
  durationMs: number;
  error?: string;
}

interface DayResult {
  config: DayConfig;
  hourResults: HourResult[];
  chains: LiveChainResults;
  summary: LiveChainSummary;
  totalDurationMs: number;
  diary: string;
  heartbeatLogCount: number;
}

function parseArgs(): Partial<DayConfig> {
  const args = process.argv.slice(2);
  const result: Partial<DayConfig> = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--slug':
        result.slug = args[++i];
        break;
      case '--date':
        result.date = args[++i];
        break;
      case '--dry-run':
        result.dryRun = true;
        break;
      case '--wake-hour':
        result.wakeHour = parseInt(args[++i], 10);
        break;
      case '--sleep-hour':
        result.sleepHour = parseInt(args[++i], 10);
        break;
      case '--persona':
        // Parse persona YAML to extract slug
        try {
          const personaRaw = fs.readFileSync(path.resolve(args[++i]), 'utf8');
          const persona = YAML.parse(personaRaw) as Record<string, unknown>;
          const meta = persona.meta as Record<string, string> | undefined;
          result.slug = (meta?.id || meta?.name || 'alive')
            .toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
        } catch (err) {
          console.error(`Failed to parse persona file: ${(err as Error).message}`);
        }
        break;
    }
  }
  return result;
}

function initChainResults(): LiveChainResults {
  return {
    instagramBrowse: { triggered: false, succeeded: false, errors: [] },
    xhsBrowse: { triggered: false, succeeded: false, errors: [] },
    instagramPost: { triggered: false, succeeded: false, errors: [] },
    instagramOutboundComment: { triggered: false, succeeded: false, errors: [] },
    instagramReplyComment: { triggered: false, succeeded: false, errors: [] },
  };
}

/**
 * Extract skill name from a chosen_actions string.
 * Supports formats:
 *   "[skillName] description"       → { skill: "skillName", fallback: false, error: false }
 *   "[fallback:skillName] desc"     → { skill: "skillName", fallback: true,  error: false }
 *   "[error:skillName] desc"        → { skill: "skillName", fallback: false, error: true  }
 *   "[mock:skillName] desc"         → { skill: "skillName", fallback: false, error: false }
 *   "[flow] activity"               → { skill: "flow",      fallback: false, error: false }
 *   "[drift] activity"              → { skill: "drift",     fallback: false, error: false }
 *   "plain description"             → null  (no skill tag)
 */
export function parseActionTag(action: string): { skill: string; fallback: boolean; error: boolean } | null {
  const match = action.match(/^\[((?:fallback|error|mock):)?([^\]]+)\]/);
  if (!match) return null;
  const prefix = match[1] ?? '';
  const skill = match[2].trim();
  return {
    skill,
    fallback: prefix === 'fallback:',
    error: prefix === 'error:',
  };
}

/**
 * Detect chain activity by inspecting heartbeat log and post-history changes.
 * Reads `chosen_actions` from HeartbeatLogEntry, which are strings like:
 *   "[instagram] 精选了5张照片准备发Instagram carousel"
 *   "[fallback:instagram] ..."
 *   "[error:social-engagement] ..."
 */
function detectChainActivity(
  chains: LiveChainResults,
  logBefore: number,
  memoryDir: string,
): void {
  // Check heartbeat log for sub-skill execution records
  const heartbeatLog = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
  const newLogs = heartbeatLog.logs.slice(logBefore);

  for (const log of newLogs) {
    const chosenActions = log.chosen_actions ?? [];

    for (const actionStr of chosenActions) {
      const tag = parseActionTag(actionStr);
      if (!tag) continue; // plain simulated action, no skill tag

      const skillId = tag.skill.toLowerCase();
      const actionLower = actionStr.toLowerCase();
      const success = !tag.error;

      // Instagram browse: content-browse skill touching instagram, or explicit browse action
      if (
        (skillId.includes('content-browse') && actionLower.includes('instagram')) ||
        (skillId.includes('instagram') && (actionLower.includes('browse') || actionLower.includes('窥屏') || actionLower.includes('刷')))
      ) {
        chains.instagramBrowse.triggered = true;
        if (success) chains.instagramBrowse.succeeded = true;
        if (tag.error) chains.instagramBrowse.errors.push(`[${tag.skill}] ${actionStr.slice(0, 80)}`);
      }

      // XHS browse
      if (skillId.includes('xhs') || skillId.includes('小红书') || skillId.includes('xiaohongshu') ||
          actionLower.includes('小红书') || actionLower.includes('xhs')) {
        chains.xhsBrowse.triggered = true;
        if (success) chains.xhsBrowse.succeeded = true;
        if (tag.error) chains.xhsBrowse.errors.push(`[${tag.skill}] ${actionStr.slice(0, 80)}`);
      }

      // Instagram post
      if (
        (skillId === 'instagram' && !actionLower.includes('browse') && !actionLower.includes('comment') && !actionLower.includes('reply')) ||
        skillId.includes('post-pipeline') ||
        (skillId.includes('instagram') && (actionLower.includes('post') || actionLower.includes('发') || actionLower.includes('carousel')))
      ) {
        chains.instagramPost.triggered = true;
        if (success) chains.instagramPost.succeeded = true;
        if (tag.error) chains.instagramPost.errors.push(`[${tag.skill}] ${actionStr.slice(0, 80)}`);
      }

      // Instagram outbound comment (proactive commenting)
      if (
        (skillId.includes('social-engagement') || skillId.includes('comment')) &&
        (actionLower.includes('comment') || actionLower.includes('评论')) &&
        !actionLower.includes('reply') && !actionLower.includes('回复')
      ) {
        chains.instagramOutboundComment.triggered = true;
        if (success) chains.instagramOutboundComment.succeeded = true;
        if (tag.error) chains.instagramOutboundComment.errors.push(`[${tag.skill}] ${actionStr.slice(0, 80)}`);
      }

      // Instagram reply comment
      if (
        (skillId.includes('social-engagement') || skillId.includes('comment')) &&
        (actionLower.includes('reply') || actionLower.includes('回复') || actionLower.includes('dm'))
      ) {
        chains.instagramReplyComment.triggered = true;
        if (success) chains.instagramReplyComment.succeeded = true;
        if (tag.error) chains.instagramReplyComment.errors.push(`[${tag.skill}] ${actionStr.slice(0, 80)}`);
      }
    }
  }

  // Also check post-history for successful Instagram posts
  const postHistoryPath = path.join(memoryDir, 'post-history.json');
  if (fs.existsSync(postHistoryPath)) {
    try {
      const postHistory = JSON.parse(fs.readFileSync(postHistoryPath, 'utf8'));
      const posts = postHistory.posts || postHistory || [];
      if (Array.isArray(posts) && posts.length > 0) {
        chains.instagramPost.triggered = true;
        chains.instagramPost.succeeded = true;
      }
    } catch { /* ignore */ }
  }
}

// ════════════════════════════════════════════════════
// Main Runner
// ════════════════════════════════════════════════════

export async function runRealDay(overrides?: Partial<DayConfig>): Promise<DayResult> {
  const cliArgs = parseArgs();
  const today = new Date().toISOString().slice(0, 10);

  const slug = overrides?.slug || cliArgs.slug || 'alive';
  const home = process.env.HOME || '~';

  // Skill is always installed at ~/.openclaw/skills/alive/ regardless of persona slug.
  // Memory directory uses the persona slug (e.g. ~/.openclaw/workspace/memory/minase/).
  const config: DayConfig = {
    slug,
    date: overrides?.date || cliArgs.date || today,
    wakeHour: overrides?.wakeHour ?? cliArgs.wakeHour ?? 7,
    sleepHour: overrides?.sleepHour ?? cliArgs.sleepHour ?? 23,
    dryRun: overrides?.dryRun ?? cliArgs.dryRun ?? false,
    skillDir: overrides?.skillDir || path.join(home, '.openclaw', 'skills', 'alive'),
    memoryDir: overrides?.memoryDir || path.join(home, '.openclaw', 'workspace', 'memory', slug),
  };

  console.log('\n═══════════════════════════════════════════════');
  console.log('  Alive Real-Day E2E Test');
  console.log('═══════════════════════════════════════════════\n');
  console.log(`  Slug:       ${config.slug}`);
  console.log(`  Date:       ${config.date}`);
  console.log(`  Hours:      ${config.wakeHour}:00 – ${config.sleepHour}:00`);
  console.log(`  Dry run:    ${config.dryRun}`);
  console.log(`  Skill dir:  ${config.skillDir}`);
  console.log(`  Memory dir: ${config.memoryDir}`);

  // ── Step 1: Load & Apply API Keys ──
  // Always load from skill slug "alive" (not persona slug), since openclaw.json
  // registers the skill under "alive" regardless of which persona is active.
  console.log('\n  Step 1: Loading API keys from openclaw.json...');
  const keys = loadApiKeys('alive');
  const applied = applyApiKeys(keys);
  console.log(`  ✓ Applied ${applied.length} env keys: ${applied.join(', ')}`);

  // Verify critical keys
  requireEnvVars('LLM_API_KEY');
  console.log('  ✓ LLM_API_KEY is set');

  if (process.env.AIHUBMIX_API_KEY || process.env.FAL_KEY) {
    console.log('  ✓ Image generation key is set');
  } else {
    console.log('  ! No image generation key — posts may skip image gen');
  }

  if (process.env.INSTAGRAM_USERNAME) {
    console.log(`  ✓ Instagram: ${process.env.INSTAGRAM_USERNAME}`);
  } else {
    console.log('  ! No Instagram credentials — posting will be skipped');
  }

  // ── Step 2: Configure File Paths ──
  console.log('\n  Step 2: Configuring file paths...');

  if (!fs.existsSync(config.skillDir)) {
    throw new Error(`Skill directory not found: ${config.skillDir}\n  Run "alive --persona <path>" to install first.`);
  }
  if (!fs.existsSync(config.memoryDir)) {
    throw new Error(`Memory directory not found: ${config.memoryDir}\n  Run "alive --persona <path>" to install first.`);
  }

  setBasePaths(config.memoryDir, config.skillDir);
  setPersonaName(config.slug);
  clearPersonaCache();
  console.log('  ✓ Base paths set');

  // ── Step 3: Create LLM Client ──
  console.log('\n  Step 3: Creating real LLM client...');
  const llm = createRealLLMClient('e2e-real-day');
  console.log(`  ✓ LLM client ready (model: ${process.env.LLM_MODEL || 'minimax-m2.5'}, base: ${process.env.LLM_API_BASE || 'https://aihubmix.com/v1'})`);

  // ── Step 4: Run Full Day Simulation ──
  console.log('\n  Step 4: Running full day simulation...');
  console.log(`  Simulating ${config.date}: ${config.wakeHour}:00 → ${config.sleepHour}:00\n`);

  const chains = initChainResults();
  const hourResults: HourResult[] = [];
  const totalStart = Date.now();

  for (let hour = config.wakeHour; hour <= config.sleepHour; hour++) {
    const simDate = new Date(`${config.date}T${String(hour).padStart(2, '0')}:00:00`);
    setTimeOverride(simDate);

    let phase: 'morning' | 'regular' | 'night';
    if (hour === config.wakeHour) {
      phase = 'morning';
    } else if (hour === config.sleepHour) {
      phase = 'night';
    } else {
      phase = 'regular';
    }

    const hourStart = Date.now();
    const logCountBefore = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 }).logs.length;

    console.log(`  ┌─ ${String(hour).padStart(2, '0')}:00 [${phase}] ──────────────────────`);

    try {
      if (config.dryRun) {
        console.log(`  │  [dry-run] Skipping actual execution`);
      } else {
        switch (phase) {
          case 'morning':
            await runMorningPlan(llm);
            break;
          case 'night':
            await runNightReflect(llm);
            break;
          case 'regular':
            await regularTick(llm);
            break;
        }
      }

      const durationMs = Date.now() - hourStart;
      hourResults.push({ hour, phase, durationMs });

      // Detect chain activity from this tick
      if (!config.dryRun) {
        detectChainActivity(chains, logCountBefore, config.memoryDir);
      }

      console.log(`  └─ ✓ Completed in ${(durationMs / 1000).toFixed(1)}s\n`);
    } catch (err) {
      const durationMs = Date.now() - hourStart;
      const errorMsg = (err as Error).message;
      hourResults.push({ hour, phase, durationMs, error: errorMsg });
      console.log(`  └─ ✗ Error: ${errorMsg} (${(durationMs / 1000).toFixed(1)}s)\n`);
    }
  }

  clearTimeOverride();

  // ── Step 5: Collect Results ──
  console.log('\n  Step 5: Collecting results...');

  const diary = readText(PATHS.diary, '');
  const heartbeatLog = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
  const summary = buildLiveChainSummary(chains);
  const totalDurationMs = Date.now() - totalStart;

  // Reset paths
  resetBasePaths();
  clearPersonaCache();

  const result: DayResult = {
    config,
    hourResults,
    chains,
    summary,
    totalDurationMs,
    diary,
    heartbeatLogCount: heartbeatLog.logs.length,
  };

  // ── Print Report ──
  console.log('\n═══════════════════════════════════════════════');
  console.log('  Real-Day Test Report');
  console.log('═══════════════════════════════════════════════\n');

  console.log(`  Total duration: ${(totalDurationMs / 1000 / 60).toFixed(1)} minutes`);
  console.log(`  Heartbeat log entries: ${heartbeatLog.logs.length}`);
  console.log(`  Diary length: ${diary.length} chars\n`);

  console.log('  Chain Results:');
  for (const [key, entry] of Object.entries(summary)) {
    const icon = entry.status === 'success' ? '✓' : entry.status === 'failed' ? '✗' : '○';
    console.log(`    ${icon} ${key}: ${entry.status}${entry.errors.length ? ` (${entry.errors.join('; ')})` : ''}`);
  }

  const errorHours = hourResults.filter(h => h.error);
  if (errorHours.length > 0) {
    console.log('\n  Errors:');
    for (const h of errorHours) {
      console.log(`    ${String(h.hour).padStart(2, '0')}:00 — ${h.error}`);
    }
  }

  const successHours = hourResults.filter(h => !h.error);
  console.log(`\n  Success rate: ${successHours.length}/${hourResults.length} hours`);

  // Check if Instagram post was made
  const postMade = summary.instagramPost?.status === 'success';
  console.log(`\n  Instagram post published: ${postMade ? '✓ YES' : '✗ NO'}`);

  if (postMade) {
    console.log('\n  ★ PASS: Full day simulation completed with Instagram post! ★');
  } else {
    console.log('\n  Note: No Instagram post was published today.');
    console.log('  This may be normal — posting depends on impulse + intent engine decisions.');
  }

  console.log('\n═══════════════════════════════════════════════\n');

  return result;
}

// ════════════════════════════════════════════════════
// CLI Entry Point
// ════════════════════════════════════════════════════

if (require.main === module || process.argv[1]?.includes('e2e-real-day')) {
  runRealDay()
    .then(result => {
      const exitCode = result.hourResults.some(h => h.error) ? 1 : 0;
      process.exit(exitCode);
    })
    .catch(err => {
      console.error('\n  ✗ Fatal error:', err.message);
      console.error(err.stack);
      process.exit(2);
    });
}
