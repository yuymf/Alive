import { PATHS, readJSON, writeJSON } from './file-utils';
import { wallNow } from './time-utils';

export type RuntimePlatform = 'xhs' | 'douyin' | 'bilibili';

export interface PlatformRuntimeEntry {
  cooldown_until?: string | null;
  consecutive_hits: number;
  last_reason: string;
  last_attempted_at?: string;
  last_success_at?: string;
  last_failed_at?: string;
  disabled_until?: string | null;
}

export interface AccountRuntimeEntry {
  backoff_until?: string | null;
  consecutive_failures: number;
  last_error: string;
  last_attempted_at?: string;
  last_success_at?: string;
  last_failed_at?: string;
  needs_manual_check?: boolean;
}

export interface PlatformRuntimeStore {
  version: 1;
  platforms: Partial<Record<RuntimePlatform, PlatformRuntimeEntry>>;
  accounts: Record<string, AccountRuntimeEntry>;
}


const DEFAULT_PLATFORM: PlatformRuntimeEntry = {
  cooldown_until: null,
  consecutive_hits: 0,
  last_reason: '',
};

export function loadPlatformRuntime(): PlatformRuntimeStore {
  const loaded = readJSON<PlatformRuntimeStore>(PATHS.platformRuntime, {
    version: 1,
    platforms: {},
    accounts: {},
  });
  return {
    version: 1,
    platforms: loaded.platforms ?? {},
    accounts: loaded.accounts ?? {},
  };
}

export function savePlatformRuntime(store: PlatformRuntimeStore): void {
  writeJSON(PATHS.platformRuntime, store);
}

export function getPlatformRuntime(platform: RuntimePlatform): PlatformRuntimeEntry {
  const store = loadPlatformRuntime();
  return { ...DEFAULT_PLATFORM, ...(store.platforms[platform] ?? {}) };
}

export function getPlatformCooldownRemainingMs(platform: RuntimePlatform): number {
  const entry = getPlatformRuntime(platform);
  const until = entry.cooldown_until ? new Date(entry.cooldown_until).getTime() : 0;
  return Math.max(0, until - Date.now());
}

export function isPlatformCoolingDown(platform: RuntimePlatform): boolean {
  return getPlatformCooldownRemainingMs(platform) > 0;
}

export function enterPlatformCooldown(
  platform: RuntimePlatform,
  reason: string,
  options: { cooldownMs?: number; retryAfterS?: number } = {},
): PlatformRuntimeEntry {
  const store = loadPlatformRuntime();
  const current = { ...DEFAULT_PLATFORM, ...(store.platforms[platform] ?? {}) };
  const hits = current.consecutive_hits + 1;
  const cooldownMs = options.cooldownMs
    ?? (options.retryAfterS && options.retryAfterS > 0 ? options.retryAfterS * 1000 : Math.min(30 * 60_000, 60_000 * Math.pow(2, hits - 1)));
  const now = wallNow().toISOString();
  const next: PlatformRuntimeEntry = {
    ...current,
    cooldown_until: new Date(Date.now() + Math.max(30_000, cooldownMs)).toISOString(),
    consecutive_hits: hits,
    last_reason: reason,
    last_attempted_at: now,
    last_failed_at: now,
  };
  store.platforms = { ...store.platforms, [platform]: next };
  savePlatformRuntime(store);
  return next;
}

export function recordPlatformSuccess(platform: RuntimePlatform): PlatformRuntimeEntry {
  const store = loadPlatformRuntime();
  const current = { ...DEFAULT_PLATFORM, ...(store.platforms[platform] ?? {}) };
  const now = wallNow().toISOString();
  const next: PlatformRuntimeEntry = {
    ...current,
    cooldown_until: null,
    consecutive_hits: 0,
    last_reason: '',
    last_attempted_at: now,
    last_success_at: now,
  };
  store.platforms = { ...store.platforms, [platform]: next };
  savePlatformRuntime(store);
  return next;
}

export function getAccountRuntime(key: string): AccountRuntimeEntry {
  const store = loadPlatformRuntime();
  return store.accounts[key] ?? { consecutive_failures: 0, last_error: '', backoff_until: null };
}

export function getAccountBackoffRemainingMs(key: string): number {
  const entry = getAccountRuntime(key);
  const until = entry.backoff_until ? new Date(entry.backoff_until).getTime() : 0;
  return Math.max(0, until - Date.now());
}

export function isAccountBackoffActive(key: string): boolean {
  return getAccountBackoffRemainingMs(key) > 0;
}

export function recordAccountFailure(
  key: string,
  error: string,
  options: { backoffMs?: number; manualCheckThreshold?: number } = {},
): AccountRuntimeEntry {
  const store = loadPlatformRuntime();
  const current = getAccountRuntime(key);
  const failures = current.consecutive_failures + 1;
  const backoffMs = options.backoffMs ?? Math.min(24 * 60 * 60_000, 60 * 60_000 * Math.pow(2, failures - 1));
  const now = wallNow().toISOString();
  const next: AccountRuntimeEntry = {
    ...current,
    backoff_until: new Date(Date.now() + backoffMs).toISOString(),
    consecutive_failures: failures,
    last_error: error,
    last_attempted_at: now,
    last_failed_at: now,
    needs_manual_check: failures >= (options.manualCheckThreshold ?? 3),
  };
  store.accounts = { ...store.accounts, [key]: next };
  savePlatformRuntime(store);
  return next;
}

export function recordAccountSuccess(key: string): AccountRuntimeEntry {
  const store = loadPlatformRuntime();
  const now = wallNow().toISOString();
  const next: AccountRuntimeEntry = {
    backoff_until: null,
    consecutive_failures: 0,
    last_error: '',
    last_attempted_at: now,
    last_success_at: now,
    needs_manual_check: false,
  };
  store.accounts = { ...store.accounts, [key]: next };
  savePlatformRuntime(store);
  return next;
}
