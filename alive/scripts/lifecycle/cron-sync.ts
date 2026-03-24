// alive/scripts/lifecycle/cron-sync.ts
// Synchronizes heartbeat schedule with OpenClaw cron system.
//
// Generalized from skill/scripts/cron-sync.ts
// - Hardcoded 'minase:' job names → dynamic via persona slug parameter
// - Same OpenClaw CLI interface (openclaw cron list/edit)

import { execFileSync } from 'child_process';
import type { CronSchedule } from '../utils/types';

// ── Types ────────────────────────────────────────────────────────

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: {
    kind: string;
    expr: string;
    staggerMs: number;
  };
}

export interface CronExpressions {
  morning: string;
  tick: string | null;
  night: string;
}

type SyncStatus = 'synced' | 'edit_failed' | 'job_not_found' | 'no_regulars';

export interface SyncResult {
  synced: boolean;
  details: {
    morning: SyncStatus;
    tick: SyncStatus;
    night: SyncStatus;
  };
}

// ── Defaults ─────────────────────────────────────────────────────

const DEFAULT_EXPRESSIONS: CronExpressions = {
  morning: '0 7 * * *',
  tick: '0 8-22 * * *',
  night: '0 23 * * *',
};

// ── Job Name Builder ─────────────────────────────────────────────

function buildJobNames(personaSlug: string) {
  return {
    morning: `${personaSlug}:morning`,
    tick: `${personaSlug}:tick`,
    night: `${personaSlug}:night`,
  } as const;
}

// ── OpenClaw CLI Helpers ─────────────────────────────────────────

/**
 * List all OpenClaw cron jobs (single CLI call).
 * Returns empty array if Gateway is offline.
 */
function listAllCronJobs(): CronJob[] {
  try {
    const raw = execFileSync('openclaw', ['cron', 'list', '--json'], {
      timeout: 10_000,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : (parsed?.jobs ?? []);
  } catch {
    return [];
  }
}

/**
 * Find a cron job by name.
 */
export function findCronJobByName(name: string): CronJob | null {
  const jobs = listAllCronJobs();
  return jobs.find(j => j.name === name) ?? null;
}

/**
 * Edit a cron job's expression by job ID.
 * Uses --exact to disable staggering.
 */
export function editCronExpression(jobId: string, cronExpr: string): boolean {
  try {
    execFileSync('openclaw', ['cron', 'edit', jobId, '--cron', cronExpr, '--exact'], {
      timeout: 10_000,
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}

// ── Schedule Building ────────────────────────────────────────────

/**
 * Convert a CronSchedule (heartbeat list) into cron expressions.
 */
export function buildCronExpression(schedule: CronSchedule): CronExpressions {
  if (schedule.heartbeats.length === 0) {
    return { ...DEFAULT_EXPRESSIONS };
  }

  const morning = schedule.heartbeats.find(h => h.type === 'morning');
  const night = schedule.heartbeats.find(h => h.type === 'night');
  const regulars = schedule.heartbeats.filter(h => h.type === 'regular');

  const morningHour = morning ? parseInt(morning.time.split(':')[0], 10) : 7;
  const nightHour = night ? parseInt(night.time.split(':')[0], 10) : 23;

  const regularHours = regulars
    .map(h => parseInt(h.time.split(':')[0], 10))
    .sort((a, b) => a - b);

  const tickExpr = regularHours.length > 0
    ? `0 ${regularHours.join(',')} * * *`
    : null;

  return {
    morning: `0 ${morningHour} * * *`,
    tick: tickExpr,
    night: `0 ${nightHour} * * *`,
  };
}

// ── Main Sync ────────────────────────────────────────────────────

/**
 * Sync CronSchedule to OpenClaw cron system.
 *
 * @param schedule - Today's heartbeat schedule
 * @param personaSlug - Persona name slug (e.g. 'minase', 'my-character')
 */
export function syncCronSchedule(schedule: CronSchedule, personaSlug: string): SyncResult {
  // E2E mock support
  if (process.env.E2E_MOCK_CRON === '1') {
    return { synced: true, details: { morning: 'synced', tick: 'synced', night: 'synced' } };
  }

  const jobNames = buildJobNames(personaSlug);
  const expressions = buildCronExpression(schedule);
  const allJobs = listAllCronJobs();

  const syncOne = (jobName: string, expr: string | null): SyncStatus => {
    if (expr === null) return 'no_regulars';
    const job = allJobs.find(j => j.name === jobName) ?? null;
    if (!job) return 'job_not_found';
    if (job.schedule.expr === expr) return 'synced';
    return editCronExpression(job.id, expr) ? 'synced' : 'edit_failed';
  };

  const details = {
    morning: syncOne(jobNames.morning, expressions.morning),
    tick: syncOne(jobNames.tick, expressions.tick),
    night: syncOne(jobNames.night, expressions.night),
  };

  const synced = Object.values(details).every(s => s === 'synced' || s === 'no_regulars');
  return { synced, details };
}
