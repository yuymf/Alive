/**
 * douyin-client.ts
 * TypeScript 调用层，通过 uv run 执行 douyin-skills CLI。
 * 镜像 xhs-bridge/scripts/xhs-client.ts 的设计模式。
 */

import { spawnSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

const DOUYIN_SKILLS_DIR = process.env.DOUYIN_SKILLS_DIR
  ?? path.join(os.homedir(), '.openclaw', 'skills', 'douyin-skills');
const DOUYIN_CLI = path.join(DOUYIN_SKILLS_DIR, 'scripts', 'cli.py');

export interface DouyinVideo {
  aweme_id: string;
  desc: string;
  create_time: number;
  author: string;
  digg_count: number;
}

export interface DouyinResult {
  success: boolean;
  videos?: DouyinVideo[];
  error?: string;
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

function runDouyinCli(args: string[], timeoutMs = 60_000): DouyinResult {
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
      return JSON.parse(stdout) as DouyinResult;
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
  return runDouyinCli(['user-posts', '--sec-uid', secUid, '--count', String(count)]);
}

/** 搜索抖音视频。 */
export function searchDouyinVideos(keyword: string, count = 10): DouyinResult {
  return runDouyinCli(['search-videos', '--keyword', keyword, '--count', String(count)]);
}

/** 检查登录状态。 */
export function checkDouyinLogin(): { success: boolean; logged_in?: boolean; error?: string } {
  const result = spawnSync(
    'uv',
    ['run', '--directory', DOUYIN_SKILLS_DIR, 'python', DOUYIN_CLI, 'check-login'],
    { timeout: 30_000, encoding: 'utf8', env: buildChromeEnv() },
  );

  const stdout = (result.stdout ?? '').trim();
  const stderr = (result.stderr ?? '').trim();

  if (result.error) {
    return { success: false, error: result.error.message };
  }

  if (stdout) {
    try {
      return JSON.parse(stdout);
    } catch {
      return { success: false, error: `Invalid JSON: ${stdout.slice(0, 200)}` };
    }
  }

  return { success: false, error: stderr.slice(0, 300) || `exit ${result.status}` };
}
