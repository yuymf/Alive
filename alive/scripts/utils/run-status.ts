import { PATHS, readJSON, writeJSON } from './file-utils';
import { wallNow } from './time-utils';

export type OpsRunStatusKind =
  | 'running'
  | 'success'
  | 'degraded_success'
  | 'skipped'
  | 'skipped_due_to_cooldown'
  | 'skipped_due_to_budget'
  | 'failed'
  | 'timeout_risk_aborted';

export interface OpsRunStatusEntry {
  readonly job: string;
  readonly status: OpsRunStatusKind;
  readonly started_at: string;
  readonly updated_at: string;
  readonly finished_at?: string;
  readonly duration_ms?: number;
  readonly warnings: readonly string[];
  readonly outputs?: Record<string, unknown>;
  readonly error?: string;
}

export type OpsRunStatusStore = Record<string, OpsRunStatusEntry>;

export interface OpsRunHandle {
  readonly job: string;
  readonly startedAtMs: number;
  readonly startedAtIso: string;
}

function loadStore(): OpsRunStatusStore {
  const loaded = readJSON<OpsRunStatusStore | undefined>(PATHS.opsRunStatus, {});
  return loaded && typeof loaded === 'object' ? loaded : {};
}


export function beginOpsRun(job: string): OpsRunHandle {
  const now = wallNow();
  const handle: OpsRunHandle = {
    job,
    startedAtMs: Date.now(),
    startedAtIso: now.toISOString(),
  };
  const store = loadStore();
  store[job] = {
    job,
    status: 'running',
    started_at: handle.startedAtIso,
    updated_at: handle.startedAtIso,
    warnings: [],
  };
  writeJSON(PATHS.opsRunStatus, store);
  return handle;
}

export function finishOpsRun(
  handle: OpsRunHandle,
  status: OpsRunStatusKind,
  options: {
    warnings?: readonly string[];
    outputs?: Record<string, unknown>;
    error?: string;
  } = {},
): void {
  const now = wallNow().toISOString();
  const store = loadStore();
  store[handle.job] = {
    job: handle.job,
    status,
    started_at: handle.startedAtIso,
    updated_at: now,
    finished_at: now,
    duration_ms: Date.now() - handle.startedAtMs,
    warnings: options.warnings ?? [],
    ...(options.outputs ? { outputs: options.outputs } : {}),
    ...(options.error ? { error: options.error } : {}),
  };
  writeJSON(PATHS.opsRunStatus, store);
}
