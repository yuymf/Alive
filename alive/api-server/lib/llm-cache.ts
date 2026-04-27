// alive/api-server/lib/llm-cache.ts
//
// Disk-backed TTL cache for heavy LLM-backed CLI routes.
//
// Design:
// - Each cached entry is a single JSON file under
//   ~/.openclaw/workspace-<persona>/runtime/ops-api-cache/<key>.json.
// - Cache write is atomic via temp-rename.
// - `?refresh=1` on the consumer forces a bypass.
// - Stale-while-revalidate: when cache is present but expired, we return the
//   stale payload immediately AND kick off a background refresh. The next
//   request (after refresh completes) will get fresh data. This is the
//   cheapest way to keep running-average latency low for slow CLIs like
//   brief/advice that take 2–6 minutes.
// - Concurrent refreshes for the same key are deduplicated via an in-memory
//   promise map.
//
// Usage:
//   const result = await cachedCliRun({
//     key: 'brief',
//     ttlMs: 30 * 60 * 1000,
//     forceRefresh: req.query.refresh === '1',
//     run: () => spawnCli('brief'),
//   });
//   // result = { output, cached_at, stale, from_cache }

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface CacheEntry {
  key: string;
  output: string;
  cached_at: string;      // ISO timestamp
  elapsed_ms: number;     // time the underlying CLI took (informational)
}

export interface CachedCliResult {
  output: string;
  cached_at: string | null;
  stale: boolean;
  from_cache: boolean;
}

function getCacheDir(): string {
  const persona = process.env.ALIVE_PERSONA || 'default';
  const home = process.env.HOME || os.homedir();
  // Align with existing alive runtime layout:
  // `~/.openclaw/workspace-<persona>/runtime/ops-api-cache/`
  const dir = path.join(home, '.openclaw', `workspace-${persona}`, 'runtime', 'ops-api-cache');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getCachePath(key: string): string {
  // Make the key filesystem-safe
  const safe = key.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(getCacheDir(), `${safe}.json`);
}

function readCache(key: string): CacheEntry | null {
  try {
    const p = getCachePath(key);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as CacheEntry;
    if (typeof parsed.output !== 'string' || typeof parsed.cached_at !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(key: string, output: string, elapsedMs: number): void {
  const p = getCachePath(key);
  const entry: CacheEntry = {
    key,
    output,
    cached_at: new Date().toISOString(),
    elapsed_ms: elapsedMs,
  };
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(entry), 'utf8');
    fs.renameSync(tmp, p);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    console.error(`[llm-cache] failed to write cache for ${key}:`, err);
  }
}

function ageMs(entry: CacheEntry): number {
  return Date.now() - new Date(entry.cached_at).getTime();
}

// In-flight refresh promises, keyed by cache key. Used to dedup concurrent
// refreshes so multiple clients hitting the same endpoint don't all spawn
// their own LLM CLI.
const inflight = new Map<string, Promise<string>>();

async function runAndCache(
  key: string,
  run: () => Promise<string>,
): Promise<string> {
  const existing = inflight.get(key);
  if (existing) return existing;

  const start = Date.now();
  const task = (async () => {
    try {
      const output = await run();
      writeCache(key, output, Date.now() - start);
      return output;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

export interface CachedCliOptions {
  /** Unique cache key (e.g. "brief", "advice", `idea:${direction}`). */
  key: string;
  /** How long a cached entry stays fresh (ms). */
  ttlMs: number;
  /** When true, ignore the cache and always run the CLI. */
  forceRefresh?: boolean;
  /**
   * When true, return stale cache immediately AND kick off a background
   * refresh that will update the file for the next request. Recommended for
   * slow CLIs (brief, advice) so the UI is never left waiting minutes.
   * When false, an expired cache is treated as a miss and the request blocks
   * until the CLI finishes.
   */
  staleWhileRevalidate?: boolean;
  /** The actual CLI-spawning function. Should return the raw stdout string. */
  run: () => Promise<string>;
}

export async function cachedCliRun(opts: CachedCliOptions): Promise<CachedCliResult> {
  const { key, ttlMs, forceRefresh, staleWhileRevalidate, run } = opts;

  if (forceRefresh) {
    const output = await runAndCache(key, run);
    return { output, cached_at: new Date().toISOString(), stale: false, from_cache: false };
  }

  const cached = readCache(key);

  // Fresh cache hit
  if (cached && ageMs(cached) < ttlMs) {
    return {
      output: cached.output,
      cached_at: cached.cached_at,
      stale: false,
      from_cache: true,
    };
  }

  // Stale hit — optionally serve stale while revalidating
  if (cached && staleWhileRevalidate) {
    // Fire-and-forget refresh; swallow errors here (they'll be logged in runAndCache)
    runAndCache(key, run).catch(err => {
      console.error(`[llm-cache] background refresh failed for ${key}:`, err);
    });
    return {
      output: cached.output,
      cached_at: cached.cached_at,
      stale: true,
      from_cache: true,
    };
  }

  // Miss — block until the CLI completes
  const output = await runAndCache(key, run);
  return { output, cached_at: new Date().toISOString(), stale: false, from_cache: false };
}

/** Utility for tests / debugging. */
export function clearCacheEntry(key: string): void {
  try {
    const p = getCachePath(key);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* ignore */ }
}
