/**
 * competitor-tracker.ts
 * Monitors competitor accounts by fetching their latest content via
 * xhs-bridge (search) and yt-dlp-downloader + video-summary ClawHub skills.
 * All failures are graceful — missing data is noted but never fatal.
 */

import { execFileSync } from 'child_process';
import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now, getLocalDate } from '../utils/time-utils';
import { CompetitorUpdate, CompetitorLog, OpsConfig } from '../utils/types';

// ─── Constants ───────────────────────────────────────────────────────────────

const NO_POSTS_FOUND_DAYS = 99;
const FETCH_FAILED_DAYS = -1;
const MAX_COMPETITOR_LOG_ENTRIES = 200;

// ─── Pure functions (exported for testing) ───────────────────────────────────

export function buildCompetitorSummary(updates: CompetitorUpdate[]): string {
  if (updates.length === 0) return '无竞品数据';
  return updates.map(u => {
    if (!u.latest_post) return `@${u.account}  ${u.days_since_last_post}天未更新`;
    const { topic, engagement } = u.latest_post;
    return `@${u.account}  今日发布「${topic}」互动${engagement}`;
  }).join('\n');
}

// ─── ClawHub skill calls ──────────────────────────────────────────────────────

function fetchXhsAccount(account: string): CompetitorUpdate {
  try {
    const raw = execFileSync('openclaw', [
      'skill', 'run', 'xhs-bridge',
      '--args', JSON.stringify({ action: 'search', keyword: account, limit: 3 }),
    ], { timeout: 30_000, encoding: 'utf8' });
    const results = JSON.parse(raw) as Array<{
      title?: string; likes?: number; timestamp?: string;
    }>;
    if (results.length === 0) {
      return { account, platform: 'xhs', latest_post: null, days_since_last_post: NO_POSTS_FOUND_DAYS, fetched_at: now().toISOString() };
    }
    const latest = results[0];
    const postedAt = latest.timestamp ? new Date(latest.timestamp) : now();
    const daysSince = Math.floor((now().getTime() - postedAt.getTime()) / (1000 * 60 * 60 * 24));
    return {
      account,
      platform: 'xhs',
      latest_post: {
        time: postedAt.toISOString(),
        content_type: '图文',
        topic: latest.title ?? '未知',
        engagement: latest.likes ?? 0,
        summary: latest.title ?? '',
      },
      days_since_last_post: daysSince,
      fetched_at: now().toISOString(),
    };
  } catch {
    return { account, platform: 'xhs', latest_post: null, days_since_last_post: FETCH_FAILED_DAYS, fetched_at: now().toISOString() };
  }
}

function fetchDouyinAccount(accountId: string): CompetitorUpdate {
  try {
    // Use yt-dlp to get latest video info
    const raw = execFileSync('openclaw', [
      'skill', 'run', 'yt-dlp-downloader',
      '--args', JSON.stringify({
        url: `https://www.douyin.com/user/${accountId}`,
        action: 'info',
        limit: 1,
      }),
    ], { timeout: 45_000, encoding: 'utf8' });
    const info = JSON.parse(raw) as { title?: string; like_count?: number; upload_date?: string };
    const postedAt = info.upload_date
      ? new Date(`${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}`)
      : now();
    const daysSince = Math.floor((now().getTime() - postedAt.getTime()) / (1000 * 60 * 60 * 24));

    const summary = info.title ?? '';

    return {
      account: accountId,
      platform: 'douyin',
      latest_post: {
        time: postedAt.toISOString(),
        content_type: '视频',
        topic: info.title ?? '未知',
        engagement: info.like_count ?? 0,
        summary,
      },
      days_since_last_post: daysSince,
      fetched_at: now().toISOString(),
    };
  } catch {
    return { account: accountId, platform: 'douyin', latest_post: null, days_since_last_post: FETCH_FAILED_DAYS, fetched_at: now().toISOString() };
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function trackCompetitors(ops: OpsConfig): CompetitorUpdate[] {
  const xhsUpdates = ops.competitor_accounts.xhs.map(fetchXhsAccount);
  const douyinUpdates = ops.competitor_accounts.douyin.map(fetchDouyinAccount);
  const all = [...xhsUpdates, ...douyinUpdates];

  // Persist
  const existing = readJSON<CompetitorLog>(PATHS.competitorLog, { entries: [], last_updated: '' });
  const today = getLocalDate(now());
  const withoutToday = existing.entries.filter(e => !e.fetched_at.startsWith(today));
  const log: CompetitorLog = {
    entries: [...withoutToday, ...all].slice(-MAX_COMPETITOR_LOG_ENTRIES), // keep last 200 entries
    last_updated: now().toISOString(),
  };
  writeJSON(PATHS.competitorLog, log);
  return all;
}
