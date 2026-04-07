/**
 * douyin-client.ts
 * TypeScript 调用层，通过 uv run 执行 douyin-skills CLI。
 * 镜像 xhs-bridge/scripts/xhs-client.ts 的设计模式。
 */

import { execFileSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

const DOUYIN_SKILLS_DIR = path.join(os.homedir(), '.openclaw', 'skills', 'douyin-skills');
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

function runDouyinCli(args: string[], timeoutMs = 60_000): DouyinResult {
  try {
    const raw = execFileSync(
      'uv',
      ['run', '--directory', DOUYIN_SKILLS_DIR, 'python', DOUYIN_CLI, ...args],
      { timeout: timeoutMs, encoding: 'utf8' },
    );
    return JSON.parse(raw.trim()) as DouyinResult;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
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
  try {
    const raw = execFileSync(
      'uv',
      ['run', '--directory', DOUYIN_SKILLS_DIR, 'python', DOUYIN_CLI, 'check-login'],
      { timeout: 30_000, encoding: 'utf8' },
    );
    return JSON.parse(raw.trim());
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
