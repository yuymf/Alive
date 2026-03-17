import { execFileSync } from 'child_process';
import type { CronSchedule } from './types';

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

const DEFAULT_EXPRESSIONS: CronExpressions = {
  morning: '0 7 * * *',
  tick: '0 8-22 * * *',
  night: '0 23 * * *',
};

const JOB_NAMES = {
  morning: 'minase:morning',
  tick: 'minase:tick',
  night: 'minase:night',
} as const;

/**
 * List all OpenClaw cron jobs and find one by name.
 * Returns null if Gateway is offline or no match found.
 */
export function findCronJobByName(name: string): CronJob | null {
  try {
    const raw = execFileSync('openclaw', ['cron', 'list', '--json'], {
      timeout: 10_000,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(raw);
    // Handle both paginated object { jobs: [...] } and legacy bare array
    const jobs: CronJob[] = Array.isArray(parsed) ? parsed : (parsed?.jobs ?? []);
    return jobs.find(j => j.name === name) ?? null;
  } catch {
    return null;
  }
}

/**
 * Edit a cron job's expression by job ID.
 * Uses --exact to disable staggering (heartbeat timing is intentional).
 * Returns true on success, false on failure.
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

/**
 * Convert a CronSchedule (heartbeat list) into cron expressions for each job.
 * Morning/night get single-hour expressions. Tick gets comma-separated regular hours.
 * Returns defaults when schedule is empty.
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

/**
 * List all OpenClaw cron jobs (single CLI call).
 * Returns empty array if Gateway is offline.
 * NOTE: openclaw cron list --json returns { jobs: CronJob[], total, ... }, not a bare array.
 */
function listAllCronJobs(): CronJob[] {
  try {
    const raw = execFileSync('openclaw', ['cron', 'list', '--json'], {
      timeout: 10_000,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(raw);
    // Handle both paginated object { jobs: [...] } and legacy bare array
    return Array.isArray(parsed) ? parsed : (parsed?.jobs ?? []);
  } catch {
    return [];
  }
}

/**
 * Sync CronSchedule to OpenClaw cron system.
 * Lists all jobs once, then edits each matching job's cron expression.
 * Non-fatal: returns status per job so caller can log gracefully.
 */
export function syncCronSchedule(schedule: CronSchedule): SyncResult {
  if (process.env.E2E_MOCK_CRON === '1') {
    return { synced: true, details: { morning: 'synced', tick: 'synced', night: 'synced' } };
  }
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
    morning: syncOne(JOB_NAMES.morning, expressions.morning),
    tick: syncOne(JOB_NAMES.tick, expressions.tick),
    night: syncOne(JOB_NAMES.night, expressions.night),
  };

  const synced = Object.values(details).every(s => s === 'synced' || s === 'no_regulars');

  return { synced, details };
}
