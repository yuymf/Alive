/**
 * douyin-client.ts
 * TypeScript 调用层，通过 uv run 执行 douyin-skills CLI。
 * 镜像 xhs-bridge/scripts/xhs-client.ts 的设计模式。
 *
 * 风控防护：
 * - 全局冷却：检测到风控后进入冷却期，冷却期内所有请求直接跳过
 * - 指数退避：连续失败时递增等待间隔（封顶 5 分钟）
 * - 风控信号识别：CLI 退出码 3 = 风控限流（captcha/403/429）
 */

import { spawnSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import {
  enterPlatformCooldown,
  getPlatformCooldownRemainingMs,
  getPlatformRuntime,
  recordPlatformSuccess,
} from '../../../../scripts/utils/platform-runtime';


const DOUYIN_SKILLS_DIR = process.env.DOUYIN_SKILLS_DIR
  ?? path.join(os.homedir(), '.openclaw', 'skills', 'douyin-skills');
const DOUYIN_CLI = path.join(DOUYIN_SKILLS_DIR, 'scripts', 'cli.py');

// ─── 登录状态缓存（60s TTL，避免高频探测触发风控） ─────────────────────────
interface LoginCache {
  result: { success: boolean; logged_in?: boolean; error?: string };
  expiresAt: number;
}
let _loginCache: LoginCache | null = null;

// ─── 全局风控冷却状态 ────────────────────────────────────────────────────────

interface RateLimitState {
  /** 冷却期结束时间（Date.now() 毫秒） */
  cooldownUntil: number;
  /** 连续风控触发次数（用于指数递增冷却时长） */
  consecutiveHits: number;
  /** 最近一次触发原因 */
  lastReason: string;
}

const _rateLimitState: RateLimitState = {
  cooldownUntil: 0,
  consecutiveHits: 0,
  lastReason: '',
};

/** 基础冷却时长（秒），实际 = base × 2^consecutiveHits，封顶 30 分钟 */
const BASE_COOLDOWN_S = 60;
const MAX_COOLDOWN_S = 1800;
/** 连续多少次风控后进入长冷却（10分钟+） */
const LONG_COOLDOWN_THRESHOLD = 3;

function syncCooldownFromStore(): void {
  const stored = getPlatformRuntime('douyin');
  const storedUntil = stored.cooldown_until ? new Date(stored.cooldown_until).getTime() : 0;
  if (storedUntil > _rateLimitState.cooldownUntil) {
    _rateLimitState.cooldownUntil = storedUntil;
    _rateLimitState.consecutiveHits = stored.consecutive_hits;
    _rateLimitState.lastReason = stored.last_reason;
  }
}

function isInCooldown(): boolean {
  syncCooldownFromStore();
  return Date.now() < _rateLimitState.cooldownUntil;
}

function enterCooldown(reason: string, retryAfterS: number = 0): void {
  syncCooldownFromStore();
  _rateLimitState.consecutiveHits++;
  _rateLimitState.lastReason = reason;

  let cooldownS: number;
  if (retryAfterS > 0) {
    // 服务端指定了等待时长
    cooldownS = retryAfterS;
  } else {
    // 指数递增：base × 2^hits，封顶 MAX_COOLDOWN_S
    cooldownS = Math.min(
      MAX_COOLDOWN_S,
      BASE_COOLDOWN_S * Math.pow(2, _rateLimitState.consecutiveHits - 1),
    );
  }

  // 加入 ±20% 随机噪声
  const noise = cooldownS * 0.2 * (Math.random() * 2 - 1);
  const actualS = Math.max(30, cooldownS + noise);

  _rateLimitState.cooldownUntil = Date.now() + actualS * 1000;
  const persisted = enterPlatformCooldown('douyin', reason, { cooldownMs: actualS * 1000 });
  _rateLimitState.consecutiveHits = persisted.consecutive_hits;
  console.warn(
    `[douyin-client] 风控冷却: ${reason}, 等待 ${Math.round(actualS)}s ` +
    `(连续 ${_rateLimitState.consecutiveHits} 次)`,
  );
}

function resetCooldown(): void {
  if (_rateLimitState.consecutiveHits > 0) {
    console.log(
      `[douyin-client] 风控冷却重置 (之前连续 ${_rateLimitState.consecutiveHits} 次)`,
    );
  }
  _rateLimitState.cooldownUntil = 0;
  _rateLimitState.consecutiveHits = 0;
  _rateLimitState.lastReason = '';
  recordPlatformSuccess('douyin');
}


// ─── 节流工具 ─────────────────────────────────────────────────────────────────

/** 随机等待 minMs~maxMs 毫秒，模拟人类操作节奏。 */
function jitterSync(minMs: number, maxMs: number): void {
  const ms = Math.floor(minMs + Math.random() * (maxMs - minMs));
  // spawnSync 是同步调用，用 sleep 实现阻塞等待
  spawnSync('sleep', [String(ms / 1000)], { timeout: ms + 5000 });
}

export interface DouyinVideo {
  aweme_id: string;
  desc: string;
  create_time: number;
  is_top: boolean;
  author: string;
  digg_count: number;
}

export interface DouyinResult {
  success: boolean;
  videos?: DouyinVideo[];
  error?: string;
  /** 是否因风控限流 */
  rate_limited?: boolean;
  /** 建议等待秒数 */
  retry_after?: number;
  /** 风控原因 */
  reason?: string;
}

function buildChromeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // On Linux as root, Chrome requires --no-sandbox
  if (process.platform === 'linux' && process.getuid && process.getuid() === 0) {
    if (!env.CHROME_FLAGS) {
      env.CHROME_FLAGS = '--no-sandbox';
    } else if (!env.CHROME_FLAGS.includes('--no-sandbox')) {
      env.CHROME_FLAGS = `${env.CHROME_FLAGS} --no-sandbox`;
    }
  }
  return env;
}

function runDouyinCli(args: string[], timeoutMs = 90_000): DouyinResult {
  // 冷却期检查：直接返回，不发起请求
  if (isInCooldown()) {
    const remainS = Math.round((_rateLimitState.cooldownUntil - Date.now()) / 1000);
    return {
      success: false,
      rate_limited: true,
      error: `风控冷却中，剩余 ${remainS}s (原因: ${_rateLimitState.lastReason})`,
      retry_after: remainS,
      reason: _rateLimitState.lastReason,
    };
  }

  const result = spawnSync(
    'uv',
    ['run', '--directory', DOUYIN_SKILLS_DIR, 'python', DOUYIN_CLI, ...args],
    { timeout: timeoutMs, encoding: 'utf8', env: buildChromeEnv() },
  );

  // Prefer stdout; fall back to stderr when stdout is empty (e.g. Chrome crash output)
  const stdout = (result.stdout ?? '').trim();
  const stderr = (result.stderr ?? '').trim();

  if (result.error) {
    return { success: false, error: result.error.message };
  }

  if (stdout) {
    try {
      const parsed = JSON.parse(stdout) as DouyinResult;

      // 检测风控信号：CLI 退出码 3 或响应中 rate_limited=true
      if (result.status === 3 || parsed.rate_limited) {
        enterCooldown(
          parsed.reason || 'unknown',
          parsed.retry_after || 0,
        );
        return { ...parsed, rate_limited: true };
      }

      // 成功请求 → 重置冷却计数
      if (parsed.success) {
        resetCooldown();
      }

      return parsed;
    } catch {
      return { success: false, error: `Invalid JSON from CLI: ${stdout.slice(0, 200)}` };
    }
  }

  // stdout is empty — Chrome likely crashed; surface the stderr message
  if (stderr) {
    return { success: false, error: stderr.slice(0, 300) };
  }

  return { success: false, error: `CLI exited with code ${result.status} and no output` };
}

/** 获取用户主页的视频列表（通过 sec_uid）。 */
export function listDouyinUserPosts(secUid: string, count = 10): DouyinResult {
  // 节流：抓取前随机等待 2~5s，模拟人类间歇节奏，降低风控触发率
  jitterSync(2000, 5000);
  return runDouyinCli(['user-posts', '--sec-uid', secUid, '--count', String(count)]);
}

/** 搜索抖音视频。 */
export function searchDouyinVideos(keyword: string, count = 10): DouyinResult {
  jitterSync(1500, 4000);
  return runDouyinCli(['search-videos', '--keyword', keyword, '--count', String(count)]);
}

/** 获取抖音首页推荐流。 */
export function fetchDouyinFeed(count = 20, refreshIndex = 0): DouyinResult {
  // 节流：抓取前随机等待 3~6s，推荐流请求较重，模拟人类间歇节奏
  jitterSync(3000, 6000);
  return runDouyinCli(['fetch-feed', '--count', String(count), '--refresh-index', String(refreshIndex)], 120_000);
}

/** 检查登录状态（结果缓存 60s，避免高频探测触发风控）。 */
export function checkDouyinLogin(): { success: boolean; logged_in?: boolean; error?: string } {
  const now = Date.now();
  if (_loginCache && now < _loginCache.expiresAt) {
    return _loginCache.result;
  }

  // 登录检查也受冷却期限制
  if (isInCooldown()) {
    return { success: false, error: `风控冷却中，跳过登录检测` };
  }

  const result = spawnSync(
    'uv',
    ['run', '--directory', DOUYIN_SKILLS_DIR, 'python', DOUYIN_CLI, 'check-login'],
    { timeout: 30_000, encoding: 'utf8', env: buildChromeEnv() },
  );

  const stdout = (result.stdout ?? '').trim();
  const stderr = (result.stderr ?? '').trim();

  let loginResult: { success: boolean; logged_in?: boolean; error?: string };

  if (result.error) {
    loginResult = { success: false, error: result.error.message };
  } else if (stdout) {
    try {
      loginResult = JSON.parse(stdout);
    } catch {
      loginResult = { success: false, error: `Invalid JSON: ${stdout.slice(0, 200)}` };
    }
  } else {
    loginResult = { success: false, error: stderr.slice(0, 300) || `exit ${result.status}` };
  }

  // 缓存 60s（仅缓存成功状态；失败时缓存更短，10s 后可重试）
  _loginCache = {
    result: loginResult,
    expiresAt: now + (loginResult.success ? 60_000 : 10_000),
  };

  return loginResult;
}

/** 获取当前风控状态（供 dashboard 和调试使用）。 */
export function getDouyinRateLimitStatus(): {
  in_cooldown: boolean;
  cooldown_remaining_s: number;
  consecutive_hits: number;
  last_reason: string;
} {
  syncCooldownFromStore();
  const remainingMs = Math.max(getPlatformCooldownRemainingMs('douyin'), _rateLimitState.cooldownUntil - Date.now());
  const stored = getPlatformRuntime('douyin');
  return {
    in_cooldown: remainingMs > 0,
    cooldown_remaining_s: Math.max(0, Math.round(remainingMs / 1000)),
    consecutive_hits: Math.max(_rateLimitState.consecutiveHits, stored.consecutive_hits),
    last_reason: stored.last_reason || _rateLimitState.lastReason,
  };
}

