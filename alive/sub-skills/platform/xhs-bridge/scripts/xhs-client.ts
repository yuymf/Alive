/**
 * xhs-client.ts
 * Thin CLI client for xiaohongshu-skills Python scripts.
 * Migrated from skill/scripts/xhs-bridge-client.ts
 *
 * Changes from skill version:
 * - Renamed file from xhs-bridge-client.ts to xhs-client.ts
 * - No import path changes (self-contained module)
 *
 * Follows the same subprocess pattern as instagram-bridge —
 * spawns `uv run python cli.py <command>` and parses JSON from stdout.
 *
 * The CLI outputs camelCase JSON; this module normalises it to the
 * snake_case interfaces that inspiration-collector.ts expects.
 */

import * as path from 'path';
import { execFile } from 'child_process';

const XHS_CLI_TIMEOUT = 75_000;  // 延长至 75s，减少因慢速响应触发的风控重试

/** 随机等待 minMs~maxMs 毫秒，模拟人类操作节奏。 */
function jitter(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── 全局 XHS 请求速率限制器 ─────────────────────────────────────────────

/**
 * 双重限制：令牌桶（每小时 30 次上限）+ 最小间隔（8~15s 人类节奏）。
 * 所有 XHS CLI 调用通过 acquire() 排队，确保不触发平台风控。
 */
interface XhsRateLimiter {
  acquire(): Promise<void>;
  getCachedLoginStatus(): boolean | null;
  setCachedLoginStatus(status: boolean): void;
  reset(): void;
}

function createRateLimiter(): XhsRateLimiter {
  const BUCKET_MAX = 30;           // 令牌桶容量：每小时最多 30 次
  const BUCKET_REFILL_MS = 60 * 60 * 1000; // 1 小时全量回补
  const MIN_INTERVAL_MS = 8_000;   // 最小请求间隔 8s
  const MAX_JITTER_MS = 7_000;     // 额外随机抖动 0~7s（总间隔 8~15s）
  const LOGIN_CACHE_TTL_MS = 5 * 60 * 1000; // check-login 缓存 5 分钟

  let tokens = BUCKET_MAX;
  let lastRefill = Date.now();
  let lastRequestTime = 0;
  let loginCacheValue: boolean | null = null;
  let loginCacheTime = 0;

  function refillTokens() {
    const elapsed = Date.now() - lastRefill;
    if (elapsed >= BUCKET_REFILL_MS) {
      tokens = BUCKET_MAX;
      lastRefill = Date.now();
    } else {
      // 按比例回补
      const refill = Math.floor((elapsed / BUCKET_REFILL_MS) * BUCKET_MAX);
      if (refill > 0) {
        tokens = Math.min(BUCKET_MAX, tokens + refill);
        lastRefill = Date.now();
      }
    }
  }

  return {
    async acquire() {
      refillTokens();

      // 令牌桶检查
      if (tokens <= 0) {
        const waitMs = BUCKET_REFILL_MS - (Date.now() - lastRefill);
        console.log(`[xhs-bridge] Rate limiter: bucket empty, waiting ${Math.round(waitMs / 1000)}s for refill`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        refillTokens();
      }

      // 最小间隔检查
      const sinceLastRequest = Date.now() - lastRequestTime;
      if (lastRequestTime > 0 && sinceLastRequest < MIN_INTERVAL_MS) {
        const baseWait = MIN_INTERVAL_MS - sinceLastRequest;
        const jitterWait = Math.random() * MAX_JITTER_MS;
        const totalWait = baseWait + jitterWait;
        console.log(`[xhs-bridge] Rate limiter: waiting ${(totalWait / 1000).toFixed(1)}s (interval + jitter)`);
        await new Promise(resolve => setTimeout(resolve, totalWait));
      }

      tokens--;
      lastRequestTime = Date.now();
    },

    getCachedLoginStatus(): boolean | null {
      if (loginCacheValue === null) return null;
      if (Date.now() - loginCacheTime > LOGIN_CACHE_TTL_MS) {
        loginCacheValue = null;
        return null;
      }
      return loginCacheValue;
    },

    setCachedLoginStatus(status: boolean) {
      loginCacheValue = status;
      loginCacheTime = Date.now();
    },

    reset() {
      tokens = BUCKET_MAX;
      lastRefill = Date.now();
      lastRequestTime = 0;
      loginCacheValue = null;
      loginCacheTime = 0;
    },
  };
}

/** 模块级单例速率限制器 */
const rateLimiter = createRateLimiter();

/** 测试用：重置速率限制器状态 */
export function resetRateLimiterForTests(): void {
  rateLimiter.reset();
}

export interface XhsNote {
  id: string;
  xsec_token: string;
  title: string;
  description: string;
  likes: number;
  user: string;
  tags: string[];
}

export interface XhsNoteDetail extends XhsNote {
  comments: Array<{ user: string; content: string; likes: number }>;
  images: string[];
  collected_count: number;
  share_count: number;
}

export interface XhsSearchOptions {
  sortBy?: string;
  noteType?: string;
  publishTime?: string;
  searchScope?: string;
  location?: string;
}

function resolveXhsDir(): string {
  const envDir = process.env.XHS_SKILLS_DIR;
  if (envDir) return envDir;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return path.join(home, '.openclaw', 'skills', 'xiaohongshu-skills');
}

async function callXhsCli(command: string, args: string[] = []): Promise<unknown> {
  // 全局速率限制：排队等待（令牌桶 + 最小间隔）
  await rateLimiter.acquire();

  return new Promise((resolve, reject) => {
    const xhsDir = resolveXhsDir();
    const cliPath = path.join(xhsDir, 'scripts', 'cli.py');
    // Use `uv run --directory <dir> python` so the .venv is auto-activated
    const uvArgs = ['run', '--directory', xhsDir, 'python', cliPath, command, ...args];

    execFile('uv', uvArgs, { timeout: XHS_CLI_TIMEOUT }, (error, stdout, stderr) => {
      if (stderr && (process.env.ALIVE_DEBUG === '1' || process.env.ALIVE_DEBUG === 'true')) console.error(`[xhs-bridge] ${stderr.trim()}`);
      if (error) {
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.error) return reject(new Error(parsed.error));
        } catch {
          if (stdout) console.error(`[xhs-bridge] Unparseable stdout: ${stdout.slice(0, 200)}`);
        }
        return reject(new Error(`xhs-bridge ${command} failed: ${error.message}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Failed to parse xhs-bridge output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

// ─── CLI → interface mapping ─────────────────────────────────

/**
 * Parse a Chinese-style count string like "3.4万" or "52" into a number.
 * Returns 0 for empty/unparseable strings.
 */
function parseCount(s: unknown): number {
  const str = String(s ?? '').trim();
  if (!str) return 0;
  const wanMatch = str.match(/^([\d.]+)\s*万$/);
  if (wanMatch) return Math.round(parseFloat(wanMatch[1]) * 10000);
  const num = parseInt(str, 10);
  return Number.isNaN(num) ? 0 : num;
}

/** Map a single CLI feed object to XhsNote. */
function mapFeedToNote(raw: Record<string, unknown>): XhsNote {
  const interact = (raw.interactInfo ?? {}) as Record<string, unknown>;
  const userObj = (raw.user ?? {}) as Record<string, unknown>;
  return {
    id: String(raw.id ?? ''),
    xsec_token: String(raw.xsecToken ?? ''),
    title: String(raw.displayTitle ?? ''),
    description: String(raw.displayTitle ?? ''),
    likes: parseCount(interact.likedCount),
    user: String(userObj.nickname ?? ''),
    tags: [],  // CLI feed does not include tags
  };
}

/** Map a CLI feed-detail response to XhsNoteDetail. */
function mapDetailToNoteDetail(raw: Record<string, unknown>): XhsNoteDetail {
  // get-feed-detail wraps the note inside { note: {...}, comments: [...] }
  const note = (raw.note ?? raw) as Record<string, unknown>;
  const rawComments = (raw.comments ?? []) as Array<Record<string, unknown>>;

  const interact = (note.interactInfo ?? {}) as Record<string, unknown>;
  const userObj = (note.user ?? {}) as Record<string, unknown>;
  const imageList = (note.imageList ?? []) as Array<Record<string, unknown>>;

  const comments = rawComments.map(c => {
    const cUser = (c.user ?? {}) as Record<string, unknown>;
    return {
      user: String(cUser.nickname ?? ''),
      content: String(c.content ?? ''),
      likes: parseCount(c.likeCount),
    };
  });

  return {
    id: String(note.noteId ?? ''),
    xsec_token: '',
    title: String(note.title ?? ''),
    description: String(note.desc ?? ''),
    likes: parseCount(interact.likedCount),
    user: String(userObj.nickname ?? ''),
    tags: [],
    comments,
    images: imageList.map(img => String(img.urlDefault ?? '')),
    collected_count: parseCount(interact.collectedCount),
    share_count: parseCount(interact.sharedCount),
  };
}

// ─── Public API ──────────────────────────────────────────────

/** Check if xiaohongshu-skills CLI is available and logged in. Uses 5-minute cache to avoid repeated check-login calls. */
export async function isXhsAvailable(): Promise<boolean> {
  if (process.env.E2E_MOCK_XHS === '1') return false;

  // 使用缓存的登录状态，避免频繁触发 check-login
  const cached = rateLimiter.getCachedLoginStatus();
  if (cached !== null) return cached;

  try {
    await callXhsCli('check-login');
    rateLimiter.setCachedLoginStatus(true);
    return true;
  } catch {
    rateLimiter.setCachedLoginStatus(false);
    return false;
  }
}

/** Homepage recommendation feed — different content each call. */
export async function listXhsFeed(): Promise<XhsNote[]> {
  const result = await callXhsCli('list-feeds') as Record<string, unknown>;
  const feeds = (result.feeds ?? []) as Array<Record<string, unknown>>;
  return feeds.map(mapFeedToNote);
}

/** Keyword search. */
export async function searchXhsNotes(keyword: string, options: XhsSearchOptions = {}): Promise<XhsNote[]> {
  const args = ['--keyword', keyword];
  if (options.sortBy) args.push('--sort-by', options.sortBy);
  if (options.noteType) args.push('--note-type', options.noteType);
  if (options.publishTime) args.push('--publish-time', options.publishTime);
  if (options.searchScope) args.push('--search-scope', options.searchScope);
  if (options.location) args.push('--location', options.location);

  const result = await callXhsCli('search-feeds', args) as Record<string, unknown>;
  const feeds = (result.feeds ?? []) as Array<Record<string, unknown>>;
  return feeds.map(mapFeedToNote);
}

/** Full note detail with comments. */
export async function getXhsNoteDetail(noteId: string, xsecToken: string): Promise<XhsNoteDetail> {
  const result = await callXhsCli('get-feed-detail', ['--feed-id', noteId, '--xsec-token', xsecToken]);
  return mapDetailToNoteDetail(result as Record<string, unknown>);
}

/** Fetch a user's notes by XHS user ID (precise, no search fallback). */
export async function getUserProfileNotes(
  userId: string, limit = 20
): Promise<XhsNote[]> {
  const loginOk = await isXhsAvailable();
  if (!loginOk) {
    throw new Error('[xhs-bridge] Not logged in — skipping getUserProfileNotes');
  }

  await jitter(3000, 8000);

  const result = await callXhsCli('user-profile', [
    '--user-id', userId, '--xsec-token', '',
  ]) as Record<string, unknown>;
  const notes = (result.feeds ?? []) as Array<Record<string, unknown>>;
  return notes.slice(0, limit).map(mapFeedToNote);
}

/** Fetch a user's recent notes by account name. Falls back to search if CLI command unsupported. */
export async function getUserNotes(accountName: string, limit = 20): Promise<XhsNote[]> {
  // ── 预检登录闸门：未登录直接抛出，不执行高频抓取操作 ──
  const loginOk = await isXhsAvailable();
  if (!loginOk) {
    throw new Error('[xhs-bridge] Not logged in — skipping getUserNotes to avoid rate-limit trigger');
  }

  // ── 节流：抓取前随机等待 3~8s，模拟人类间歇节奏 ──
  await jitter(3000, 8000);

  try {
    const result = await callXhsCli('get-user-notes', ['--user', accountName, '--limit', String(limit)]);
    const data = result as Record<string, unknown>;
    const notes = (data.notes ?? []) as Array<Record<string, unknown>>;
    return notes.map(mapFeedToNote);
  } catch {
    console.error(`[xhs-bridge] get-user-notes not supported, falling back to search for "${accountName}"`);
    await jitter(3000, 6000);  // fallback 前再加一次抖动
    return searchXhsNotes(accountName, { sortBy: '最新' });
  }
}
