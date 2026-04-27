// alive/api-server/lib/cron-status.ts
//
// Read OpenClaw cron state via `openclaw cron list --json` and aggregate per-job
// status. Exposed to the frontend via /api/health so operators can see at a
// glance which cron jobs are healthy vs errored.

import { spawnSync } from 'child_process';

export interface CronJobStatus {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  lastRunStatus: 'ok' | 'error' | 'idle' | 'unknown' | 'delivery-error';
  lastRunAtMs: number | null;
  nextRunAtMs: number | null;
  lastErrorSummary?: string | null;
  /** Non-empty when the error is only about delivery (e.g. WeCom webhook 403) */
  deliveryError?: string | null;
}

export interface CronStatusReport {
  available: boolean;
  total: number;
  ok: number;
  /** Real script-level errors — the job itself failed. */
  error: number;
  /** The script ran fine but notification delivery failed (e.g. WeCom 403). */
  deliveryError: number;
  idle: number;
  jobs: CronJobStatus[];
  /** Reason why we couldn't query cron state (e.g. openclaw binary missing). */
  error_reason?: string;
}

const DEFAULT_TIMEOUT_MS = 8_000;

/** Cache the last successful cron snapshot; served as fallback on transient failures. */
let lastGoodReport: CronStatusReport | null = null;
let lastGoodAtMs = 0;
const LAST_GOOD_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolve the `openclaw` binary path. Falls back to `openclaw` on PATH.
 * Allows OPENCLAW_BIN env to override for tests / non-default installs.
 */
function resolveOpenclawBin(): string {
  if (process.env.OPENCLAW_BIN) return process.env.OPENCLAW_BIN;
  // Common homebrew and user-local install locations
  const candidates = ['/opt/homebrew/bin/openclaw', '/usr/local/bin/openclaw'];
  for (const c of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs');
      if (fs.existsSync(c)) return c;
    } catch { /* continue */ }
  }
  return 'openclaw';
}

export function fetchCronStatus(opts?: { agentId?: string; timeoutMs?: number }): CronStatusReport {
  // openclaw's cron list occasionally exits 1 with empty output when the
  // config is mid-write. Retry once and, if still failing, fall back to the
  // last known-good snapshot if it's still recent.
  let lastReport: CronStatusReport | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    lastReport = fetchCronStatusOnce(opts);
    if (lastReport.available) {
      lastGoodReport = lastReport;
      lastGoodAtMs = Date.now();
      return lastReport;
    }
  }

  // Transient failure — serve cached snapshot if we have one recent enough
  if (lastGoodReport && Date.now() - lastGoodAtMs < LAST_GOOD_MAX_AGE_MS) {
    return { ...lastGoodReport, error_reason: `stale (${Math.floor((Date.now() - lastGoodAtMs) / 1000)}s old, live query failed: ${lastReport?.error_reason ?? 'unknown'})` };
  }
  return lastReport!;
}

function fetchCronStatusOnce(opts?: { agentId?: string; timeoutMs?: number }): CronStatusReport {
  try {
    const bin = resolveOpenclawBin();
    const result = spawnSync(bin, ['cron', 'list', '--json'], {
      timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      encoding: 'utf8',
      env: { ...process.env },
    });
    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim();
      const stdout = (result.stdout || '').trim();
      const detail = stderr || stdout || 'no output';
      return { available: false, total: 0, ok: 0, error: 0, deliveryError: 0, idle: 0, jobs: [], error_reason: `openclaw exit ${result.status}: ${detail.slice(0, 240)}` };
    }
    const parsed = JSON.parse(result.stdout) as { jobs?: unknown[] };
    if (!Array.isArray(parsed.jobs)) {
      return { available: false, total: 0, ok: 0, error: 0, deliveryError: 0, idle: 0, jobs: [], error_reason: 'unexpected payload shape' };
    }

    const wantedAgent = (opts?.agentId || process.env.ALIVE_PERSONA || '').trim();
    const jobs: CronJobStatus[] = [];

    for (const raw of parsed.jobs) {
      const j = raw as Record<string, any>;
      const jobAgent = String(j.agentId ?? '');
      if (wantedAgent && jobAgent !== wantedAgent) continue;

      const state = (j?.state ?? {}) as Record<string, any>;
      const rawStatus = String(state.lastRunStatus ?? state.lastStatus ?? 'unknown').toLowerCase();
      const errorReason = String(state.lastErrorReason ?? '').toLowerCase();
      const hasScriptError = typeof state.lastError === 'string' && state.lastError.length > 0;
      const hasDeliveryError = typeof state.lastDeliveryError === 'string' && state.lastDeliveryError.length > 0;

      // Distinguish "script failed" from "delivery to WeCom failed":
      //   - lastError present → real script-level failure
      //   - otherwise, if only lastDeliveryError is present → delivery-error (less alarming)
      //   - neither → ok (even if lastRunStatus=="error" because of delivery flakiness)
      let normalised: CronJobStatus['lastRunStatus'];
      if (rawStatus === 'ok') {
        normalised = hasDeliveryError ? 'delivery-error' : 'ok';
      } else if (rawStatus === 'idle' || rawStatus === 'unknown') {
        normalised = 'idle';
      } else if (hasScriptError || errorReason === 'script' || errorReason === 'timeout') {
        normalised = 'error';
      } else if (hasDeliveryError || errorReason === 'auth' || errorReason === 'delivery') {
        normalised = 'delivery-error';
      } else {
        normalised = 'error';
      }

      const summary = state.lastError
        ? String(state.lastError).slice(0, 240)
        : state.lastErrorReason
          ? `原因：${state.lastErrorReason}${state.lastDeliveryError ? ' — ' + String(state.lastDeliveryError).slice(0, 120) : ''}`
          : null;

      jobs.push({
        id: String(j.id ?? ''),
        name: String(j.name ?? ''),
        enabled: Boolean(j.enabled),
        schedule: String(j?.schedule?.expr ?? j?.schedule?.kind ?? ''),
        lastRunStatus: normalised,
        lastRunAtMs: typeof state.lastRunAtMs === 'number' ? state.lastRunAtMs : null,
        nextRunAtMs: typeof state.nextRunAtMs === 'number' ? state.nextRunAtMs : null,
        lastErrorSummary: summary,
        deliveryError: hasDeliveryError ? String(state.lastDeliveryError).slice(0, 240) : null,
      });
    }

    return {
      available: true,
      total: jobs.length,
      ok:             jobs.filter(j => j.lastRunStatus === 'ok').length,
      error:          jobs.filter(j => j.lastRunStatus === 'error').length,
      deliveryError:  jobs.filter(j => j.lastRunStatus === 'delivery-error').length,
      idle:           jobs.filter(j => j.lastRunStatus === 'idle' || j.lastRunStatus === 'unknown').length,
      jobs,
    };
  } catch (err) {
    return { available: false, total: 0, ok: 0, error: 0, deliveryError: 0, idle: 0, jobs: [], error_reason: (err as Error).message };
  }
}
