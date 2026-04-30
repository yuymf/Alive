// alive/api-server/lib/cron-status.ts
//
// Read OpenClaw cron state via gateway WebSocket RPC and aggregate per-job
// status. Exposed to the frontend via /api/health so operators can see at a
// glance which cron jobs are healthy vs errored.
//
// Uses gateway-rpc.js (direct WebSocket) instead of `openclaw cron list --json`
// because the CLI hangs on Windows when called via spawnSync.

import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

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
  /** Reason why we couldn't query cron state (e.g. gateway not running). */
  error_reason?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Cache the last successful cron snapshot; served as fallback on transient failures. */
let lastGoodReport: CronStatusReport | null = null;
let lastGoodAtMs = 0;
const LAST_GOOD_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolve path to gateway-rpc.js helper.
 */
function resolveGatewayRpcPath(): string | null {
  // 1. OPENCLAW_GATEWAY_RPC env override
  if (process.env.OPENCLAW_GATEWAY_RPC) return process.env.OPENCLAW_GATEWAY_RPC;

  // 2. Look relative to this file (works for both ts-source and compiled dist)
  const relCandidates = [
    path.resolve(__dirname, '..', '..', '..', 'bin', 'gateway-rpc.js'),  // alive/api-server/lib → project-root/bin
    path.resolve(__dirname, '..', '..', '..', '..', 'bin', 'gateway-rpc.js'), // dist-alive/api-server/lib → project-root/bin
  ];
  for (const c of relCandidates) {
    if (fs.existsSync(c)) return c;
  }

  return null;
}

/**
 * Call gateway RPC via gateway-rpc.js helper (direct WebSocket).
 * Same pattern as bin/cli.js callGatewayDirect().
 */
function callGatewayRPC<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs: number): T {
  const helperPath = resolveGatewayRpcPath();
  if (!helperPath) {
    throw new Error('gateway-rpc.js not found. Set OPENCLAW_GATEWAY_RPC to its full path.');
  }
  const result = execFileSync(process.execPath, [
    helperPath, method, JSON.stringify(params), '--timeout', String(timeoutMs),
  ], {
    timeout: timeoutMs + 5_000,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(result.trim()) as T;
}

export function fetchCronStatus(opts?: { agentId?: string; timeoutMs?: number }): CronStatusReport {
  // Gateway RPC can occasionally fail transiently. Retry once and, if still
  // failing, fall back to the last known-good snapshot if it's still recent.
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
    const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const rpcResult = callGatewayRPC<{ jobs?: unknown[] }>('cron.list', {}, timeout);

    if (!rpcResult || !Array.isArray(rpcResult.jobs)) {
      return { available: false, total: 0, ok: 0, error: 0, deliveryError: 0, idle: 0, jobs: [], error_reason: 'unexpected payload shape from gateway RPC' };
    }

    const wantedAgent = (opts?.agentId || process.env.ALIVE_PERSONA || '').trim();
    const jobs: CronJobStatus[] = [];

    for (const raw of rpcResult.jobs) {
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
    const msg = (err as Error).message || String(err);
    let reason = msg;
    if (msg.includes('ECONNREFUSED') || msg.includes('WebSocket closed')) {
      reason = 'gateway not reachable — is openclaw gateway running?';
    } else if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
      reason = 'gateway RPC timed out — is openclaw gateway running?';
    } else if (msg.includes('not found')) {
      reason = msg;
    }
    return { available: false, total: 0, ok: 0, error: 0, deliveryError: 0, idle: 0, jobs: [], error_reason: reason };
  }
}
