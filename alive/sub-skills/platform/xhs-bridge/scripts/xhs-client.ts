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
 *
 * 风控防护：
 * - 全局冷却：检测到风控后进入冷却期，冷却期内所有请求直接跳过
 * - 指数退避：连续失败时递增等待间隔（base×2^hits，封顶 30 分钟）
 * - 风控信号识别：CLI stderr/error 中包含 rate/429/限制/验证码 等关键词
 * - 成功重置：请求成功后清零连续触发计数
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

const XHS_CLI_TIMEOUT = 75_000;  // 延长至 75s，减少因慢速响应触发的风控重试

// ─── 搜索结果 TTL 缓存 ────────────────────────────────────────────────────────

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 小时

function resolveXhsCacheFile(): string {
  const envOverride = process.env.XHS_CACHE_FILE_OVERRIDE;
  if (envOverride) return envOverride;
  const persona = process.env.ALIVE_PERSONA ?? 'default';
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return path.join(home, '.openclaw', 'workspace', 'memory', persona, 'xhs-search-cache.json');
}

interface XhsCacheEntry {
  fetched_at: string;
  data: XhsNote[];
}

interface XhsCache {
  version: number;
  entries: Record<string, XhsCacheEntry>;
}

function loadXhsCache(): XhsCache {
  const filePath = resolveXhsCacheFile();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as XhsCache;
    if (parsed && typeof parsed === 'object' && parsed.entries) return parsed;
  } catch {
    // Corrupt or missing — start fresh
  }
  return { version: 1, entries: {} };
}

function saveXhsCache(cache: XhsCache): void {
  const filePath = resolveXhsCacheFile();
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('[xhs-cache] Failed to save cache:', err);
  }
}

function pruneOldEntries(cache: XhsCache, ttlMs: number): XhsCache {
  const now = Date.now();
  const entries: Record<string, XhsCacheEntry> = {};
  for (const [key, entry] of Object.entries(cache.entries)) {
    if (now - new Date(entry.fetched_at).getTime() < ttlMs) {
      entries[key] = entry;
    }
  }
  return { ...cache, entries };
}

async function withCache(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<XhsNote[]>,
): Promise<XhsNote[]> {
  const cache = loadXhsCache();
  const entry = cache.entries[key];

  if (entry) {
    const age = Date.now() - new Date(entry.fetched_at).getTime();
    if (age < ttlMs) {
      return entry.data;
    }
  }

  const data = await fetcher();

  if (data.length > 0) {
    const pruned = pruneOldEntries(cache, ttlMs);
    pruned.entries[key] = { fetched_at: new Date().toISOString(), data };
    saveXhsCache(pruned);
  }

  return data;
}

/** 测试用：重置搜索缓存状态（删除缓存文件或清空内存中的 entries） */
export function resetSearchCacheForTests(): void {
  const filePath = resolveXhsCacheFile();
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore
  }
}

/**
 * 高斯随机延迟：以 (minMs+maxMs)/2 为均值，(maxMs-minMs)/6 为标准差，
 * 生成更接近人类节奏的间隔分布（大多数在均值附近，偶尔特别长或短）。
 * 结果裁剪到 [minMs, maxMs] 范围内。
 */
function gaussianJitter(minMs: number, maxMs: number): number {
  const mean = (minMs + maxMs) / 2;
  const stddev = (maxMs - minMs) / 6;  // 99.7% 落在 [min, max] 内（3σ 原则）
  // Box-Muller 变换
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
  return Math.max(minMs, Math.min(maxMs, mean + z * stddev));
}

/** 随机等待 minMs~maxMs 毫秒，使用高斯分布模拟人类操作节奏。 */
function jitter(minMs: number, maxMs: number): Promise<void> {
  const ms = gaussianJitter(minMs, maxMs);
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── 全局 XHS 请求速率限制器 ─────────────────────────────────────────────

/**
 * 双重限制：令牌桶（每小时 20 次上限）+ 最小间隔（10~18s 人类节奏）。
 * 风控冷却：触发风控后进入指数退避冷却期，冷却期内所有请求直接跳过。
 * 所有 XHS CLI 调用通过 acquire() + 冷却闸门，确保不触发且不怕平台风控。
 */
interface XhsRateLimiter {
  acquire(): Promise<void>;
  getCachedLoginStatus(): boolean | null;
  setCachedLoginStatus(status: boolean): void;
  reset(): void;
}

function createRateLimiter(): XhsRateLimiter {
  const BUCKET_MAX = 20;           // 令牌桶容量：每小时最多 20 次（留更大余量防风控）
  const BUCKET_REFILL_MS = 60 * 60 * 1000; // 1 小时全量回补
  const MIN_INTERVAL_MS = 10_000;  // 最小请求间隔 10s（更接近人类节奏）
  const MAX_JITTER_MS = 8_000;     // 额外随机抖动 0~8s（总间隔 10~18s）
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

      // 最小间隔检查（高斯分布抖动，更接近人类节奏）
      const sinceLastRequest = Date.now() - lastRequestTime;
      if (lastRequestTime > 0 && sinceLastRequest < MIN_INTERVAL_MS) {
        const baseWait = MIN_INTERVAL_MS - sinceLastRequest;
        const jitterWait = gaussianJitter(0, MAX_JITTER_MS);
        const totalWait = baseWait + jitterWait;
        console.log(`[xhs-bridge] Rate limiter: waiting ${(totalWait / 1000).toFixed(1)}s (interval + gaussian jitter)`);
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

// ─── 全局风控冷却状态 ────────────────────────────────────────────────────────

interface XhsRateLimitState {
  /** 冷却期结束时间（Date.now() 毫秒） */
  cooldownUntil: number;
  /** 连续风控触发次数（用于指数递增冷却时长） */
  consecutiveHits: number;
  /** 最近一次触发原因 */
  lastReason: string;
}

const _xhsRateLimitState: XhsRateLimitState = {
  cooldownUntil: 0,
  consecutiveHits: 0,
  lastReason: '',
};

/** 基础冷却时长（秒），实际 = base × 2^hits，封顶 30 分钟 */
const XHS_BASE_COOLDOWN_S = 60;
const XHS_MAX_COOLDOWN_S = 1800;

/** 风控信号关键词（CLI stderr / stdout 中出现时判定为风控） */
const XHS_RATE_LIMIT_SIGNALS = [
  'rate', 'limit', '429', '461', 'captcha', '验证码',
  '限制', '风控', '频繁', 'blocked', 'too many',
  'request_denied', 'access_denied', 'forbidden',
  '滑块', 'slider', 'challenge',
] as const;

/** 461 专属信号（小红书特有，触发时需要更长冷却） */
const XHS_461_SIGNALS = ['461', '滑块', 'slider', 'captcha', '验证码', 'challenge'] as const;

/** 检测是否为 461 类风控（需要滑块验证，比普通限流更严重） */
function isXhs461Signal(text: string): boolean {
  const lower = text.toLowerCase();
  return XHS_461_SIGNALS.some(signal => lower.includes(signal));
}

function xhsIsInCooldown(): boolean {
  return Date.now() < _xhsRateLimitState.cooldownUntil;
}

function xhsEnterCooldown(reason: string, retryAfterS: number = 0): void {
  _xhsRateLimitState.consecutiveHits++;
  _xhsRateLimitState.lastReason = reason;

  let cooldownS: number;
  if (retryAfterS > 0) {
    cooldownS = retryAfterS;
  } else {
    // 指数递增：base × 2^hits，封顶 MAX_COOLDOWN_S
    cooldownS = Math.min(
      XHS_MAX_COOLDOWN_S,
      XHS_BASE_COOLDOWN_S * Math.pow(2, _xhsRateLimitState.consecutiveHits - 1),
    );
  }

  // 加入 ±20% 随机噪声
  const noise = cooldownS * 0.2 * (Math.random() * 2 - 1);
  const actualS = Math.max(30, cooldownS + noise);

  _xhsRateLimitState.cooldownUntil = Date.now() + actualS * 1000;
  console.warn(
    `[xhs-bridge] 风控冷却: ${reason}, 等待 ${Math.round(actualS)}s ` +
    `(连续 ${_xhsRateLimitState.consecutiveHits} 次)`,
  );
}

function xhsResetCooldown(): void {
  if (_xhsRateLimitState.consecutiveHits > 0) {
    console.log(
      `[xhs-bridge] 风控冷却重置 (之前连续 ${_xhsRateLimitState.consecutiveHits} 次)`,
    );
  }
  _xhsRateLimitState.consecutiveHits = 0;
  _xhsRateLimitState.lastReason = '';
  // 注意：不重置 cooldownUntil，让当前冷却期自然结束
}

/** 检测 CLI 输出中是否包含风控信号 */
function isXhsRateLimitSignal(text: string): boolean {
  const lower = text.toLowerCase();
  return XHS_RATE_LIMIT_SIGNALS.some(signal => lower.includes(signal));
}

/** 获取当前风控状态（供 Provider 和调试使用）。 */
export function getXhsRateLimitStatus(): {
  in_cooldown: boolean;
  cooldown_remaining_s: number;
  consecutive_hits: number;
  last_reason: string;
} {
  const remaining = Math.max(0, Math.round((_xhsRateLimitState.cooldownUntil - Date.now()) / 1000));
  return {
    in_cooldown: xhsIsInCooldown(),
    cooldown_remaining_s: remaining,
    consecutive_hits: _xhsRateLimitState.consecutiveHits,
    last_reason: _xhsRateLimitState.lastReason,
  };
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

// ─── 写入命令黑名单 — AI 绝对不允许直接执行任何发布/互动操作 ─────────────
// 所有内容必须走 review-queue → 运营确认 → 运营手动发布 → 回传 URL 记录。
const XHS_WRITE_COMMANDS: ReadonlySet<string> = new Set([
  'publish', 'publish-video', 'fill-publish', 'click-publish',
  'save-draft', 'post-comment', 'like-feed', 'favorite-feed',
  'follow-user', 'delete-note', 'unfollow-user', 'unlike-feed',
]);

async function callXhsCli(command: string, args: string[] = []): Promise<unknown> {
  // 硬锁：写入命令绝对禁止，必须由运营手动操作
  if (XHS_WRITE_COMMANDS.has(command)) {
    throw new Error(
      `[xhs-bridge] WRITE_BLOCKED: command "${command}" is blocked. ` +
      `AI must NOT publish directly. Prepare content → push to review queue → ` +
      `operator publishes manually → mark as published via "已发 <URL>".`
    );
  }

  // 风控冷却闸门：冷却期内直接抛错，不发起请求
  if (xhsIsInCooldown()) {
    const remaining = Math.round((_xhsRateLimitState.cooldownUntil - Date.now()) / 1000);
    throw new Error(
      `[xhs-bridge] 风控冷却中，剩余 ${remaining}s (原因: ${_xhsRateLimitState.lastReason})`
    );
  }

  // 全局速率限制：排队等待（令牌桶 + 最小间隔）
  await rateLimiter.acquire();

  return new Promise((resolve, reject) => {
    const xhsDir = resolveXhsDir();
    const cliPath = path.join(xhsDir, 'scripts', 'cli.py');
    // Use `uv run --directory <dir> python` so the .venv is auto-activated
    const uvArgs = ['run', '--directory', xhsDir, 'python', cliPath, command, ...args];

    execFile('uv', uvArgs, { timeout: XHS_CLI_TIMEOUT }, (error, stdout, stderr) => {
      const stderrText = stderr?.trim() ?? '';
      if (stderrText && (process.env.ALIVE_DEBUG === '1' || process.env.ALIVE_DEBUG === 'true')) console.error(`[xhs-bridge] ${stderrText}`);

      // 检测风控信号：stderr 或 error.message 中出现关键词
      const combinedText = `${stderrText} ${(error?.message ?? '')}`.toLowerCase();
      if (isXhsRateLimitSignal(combinedText)) {
        // 461 类风控（滑块验证）比普通限流更严重，使用加长冷却
        if (isXhs461Signal(combinedText)) {
          xhsEnterCooldown(`CLI ${command} 触发461/验证码风控`, 300);  // 461 固定 5 分钟冷却
        } else {
          xhsEnterCooldown(`CLI ${command} 触发风控信号`);
        }
        return reject(new Error(
          `[xhs-bridge] ${command} 触发风控，已进入冷却 (连续 ${_xhsRateLimitState.consecutiveHits} 次)`
        ));
      }

      if (error) {
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.error) {
            // JSON error 中也可能包含风控信号
            if (isXhsRateLimitSignal(parsed.error)) {
              if (isXhs461Signal(parsed.error)) {
                xhsEnterCooldown(parsed.error, 300);  // 461 固定 5 分钟冷却
              } else {
                xhsEnterCooldown(parsed.error);
              }
            }
            return reject(new Error(parsed.error));
          }
        } catch {
          if (stdout) console.error(`[xhs-bridge] Unparseable stdout: ${stdout.slice(0, 200)}`);
        }
        return reject(new Error(`xhs-bridge ${command} failed: ${error.message}`));
      }
      try {
        const result = JSON.parse(stdout);
        // 成功请求 → 重置冷却计数
        xhsResetCooldown();
        resolve(result);
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

// ─── 首页 Feed 内存缓存（由 searchXhsNotes 写入，listXhsFeed 优先复用） ─────

let _feedCache: { data: XhsNote[]; fetchedAt: number } | null = null;
const FEED_CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟

/** 由 searchXhsNotes 调用时写入缓存（搜索前浏览首页附带提取的 feeds） */
export function setFeedCache(data: XhsNote[]): void {
  _feedCache = { data, fetchedAt: Date.now() };
}

/** Homepage recommendation feed — 优先使用缓存，避免额外请求。 */
export async function listXhsFeed(): Promise<XhsNote[]> {
  // 优先检查内存缓存（来自 search 前的浏览行为）
  if (_feedCache && Date.now() - _feedCache.fetchedAt < FEED_CACHE_TTL_MS) {
    console.log('[xhs-bridge] listXhsFeed: 使用搜索前浏览的缓存');
    return _feedCache.data;
  }

  // 缓存未命中，走原始请求
  const result = await callXhsCli('list-feeds') as Record<string, unknown>;
  const feeds = (result.feeds ?? []) as Array<Record<string, unknown>>;
  const notes = feeds.map(mapFeedToNote);

  // 写入缓存
  if (notes.length > 0) {
    _feedCache = { data: notes, fetchedAt: Date.now() };
  }

  return notes;
}

/** Keyword search. Results are cached for 4 hours per (keyword, sortBy, publishTime) key. */
export async function searchXhsNotes(keyword: string, options: XhsSearchOptions = {}): Promise<XhsNote[]> {
  const sortBy = options.sortBy ?? '';
  const publishTime = options.publishTime ?? '';
  const cacheKey = `search:${keyword}:${sortBy}:${publishTime}`;

  return withCache(cacheKey, CACHE_TTL_MS, async () => {
    const args = ['--keyword', keyword];
    if (options.sortBy) args.push('--sort-by', options.sortBy);
    if (options.noteType) args.push('--note-type', options.noteType);
    if (options.publishTime) args.push('--publish-time', options.publishTime);
    if (options.searchScope) args.push('--search-scope', options.searchScope);
    if (options.location) args.push('--location', options.location);

    const result = await callXhsCli('search-feeds', args) as Record<string, unknown>;

    // ★ 提取搜索过程中缓存的首页 feeds（Python 端通过 cached_home_feeds 额外返回）
    const cachedFeeds = result.cached_home_feeds as Array<Record<string, unknown>> | undefined;
    if (cachedFeeds && cachedFeeds.length > 0) {
      setFeedCache(cachedFeeds.map(mapFeedToNote));
    }

    const feeds = (result.feeds ?? []) as Array<Record<string, unknown>>;
    return feeds.map(mapFeedToNote);
  });
}

/** Full note detail with comments. */
export async function getXhsNoteDetail(noteId: string, xsecToken: string): Promise<XhsNoteDetail> {
  const result = await callXhsCli('get-feed-detail', ['--feed-id', noteId, '--xsec-token', xsecToken]);
  return mapDetailToNoteDetail(result as Record<string, unknown>);
}

/** Fetch a user's notes by XHS user ID (precise, no search fallback). Results cached for 4 hours. */
export async function getUserProfileNotes(
  userId: string, limit = 20
): Promise<XhsNote[]> {
  return withCache(`userid:${userId}`, CACHE_TTL_MS, async () => {
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
  });
}

/** Fetch a user's recent notes by account name. Falls back to search if CLI command unsupported. Results cached for 4 hours. */
export async function getUserNotes(accountName: string, limit = 20): Promise<XhsNote[]> {
  return withCache(`user:${accountName}`, CACHE_TTL_MS, async () => {
    // ── 预检登录闸门：未登录直接抛出，不执行高频抓取操作 ──
    const loginOk = await isXhsAvailable();
    if (!loginOk) {
      throw new Error('[xhs-bridge] Not logged in — skipping getUserNotes to avoid rate-limit trigger');
    }

    // ── 节流：抓取前高斯随机等待 3~8s，模拟人类间歇节奏 ──
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
  });
}
