/**
 * performance-tracker.ts
 * Tracks post-publication metrics for content items.
 * Provides CRUD for performance-log.json and aggregation helpers.
 */

import { execFileSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now } from '../utils/time-utils';
import {
  PerformanceLog, PerformanceEntry, PerformanceSnapshot, PerformanceMetrics,
  IdentityMode,
} from '../utils/types';

export const DEFAULT_PERFORMANCE_LOG: PerformanceLog = { entries: [], last_updated: '' };

const RETENTION_DAYS = 30;

// ─── CRUD ───────────────────────────────────────────────────────────────────

export function loadPerformanceLog(): PerformanceLog {
  return readJSON<PerformanceLog>(PATHS.performanceLog, DEFAULT_PERFORMANCE_LOG);
}

interface AppendSnapshotInput {
  item_id: string;
  identity_mode: IdentityMode;
  template_type: string;
  topic: string;
  platform: 'xhs' | 'douyin';
  url: string;
  published_at: string;
  tags_used: string[];
}

export function appendSnapshot(input: AppendSnapshotInput, metrics: PerformanceMetrics): void {
  const log = loadPerformanceLog();
  const ts = now().toISOString();
  const snapshot: PerformanceSnapshot = { fetched_at: ts, metrics };

  const existingIdx = log.entries.findIndex(
    e => e.item_id === input.item_id && e.platform === input.platform,
  );

  let updatedEntries: PerformanceEntry[];

  if (existingIdx >= 0) {
    const existing = log.entries[existingIdx];
    const newPeak = mergePeakMetrics(existing.peak_metrics, metrics);
    const updatedEntry: PerformanceEntry = {
      ...existing,
      snapshots: [...existing.snapshots, snapshot],
      peak_metrics: newPeak,
    };
    updatedEntries = log.entries.map((e, i) => i === existingIdx ? updatedEntry : e);
  } else {
    const newEntry: PerformanceEntry = {
      ...input,
      snapshots: [snapshot],
      peak_metrics: { ...metrics },
    };
    updatedEntries = [...log.entries, newEntry];
  }

  writeJSON(PATHS.performanceLog, { entries: updatedEntries, last_updated: ts });
}

function maxOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return Math.max(a ?? 0, b ?? 0);
}

function mergePeakMetrics(current: PerformanceMetrics, incoming: PerformanceMetrics): PerformanceMetrics {
  return {
    views: maxOptional(current.views, incoming.views),
    likes: Math.max(current.likes, incoming.likes),
    comments: Math.max(current.comments, incoming.comments),
    saves: maxOptional(current.saves, incoming.saves),
    shares: maxOptional(current.shares, incoming.shares),
    forwards: maxOptional(current.forwards, incoming.forwards),
  };
}

// ─── Query helpers ──────────────────────────────────────────────────────────

export function getEntriesForPeriod(days: number): PerformanceEntry[] {
  const log = loadPerformanceLog();
  const cutoff = new Date(now().getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  return log.entries.filter(e => e.published_at >= cutoff);
}

export interface AggregatedStats {
  count: number;
  avg_likes: number;
  avg_comments: number;
  avg_saves: number;
}

export function aggregateByIdentity(entries: PerformanceEntry[]): Record<string, AggregatedStats> {
  return aggregateBy(entries, e => e.identity_mode);
}

export function aggregateByTemplate(entries: PerformanceEntry[]): Record<string, AggregatedStats> {
  return aggregateBy(entries, e => e.template_type);
}

function aggregateBy(
  entries: PerformanceEntry[],
  keyFn: (e: PerformanceEntry) => string,
): Record<string, AggregatedStats> {
  const groups: Record<string, PerformanceEntry[]> = {};
  for (const entry of entries) {
    const key = keyFn(entry);
    groups[key] = [...(groups[key] ?? []), entry];
  }
  const result: Record<string, AggregatedStats> = {};
  for (const [key, group] of Object.entries(groups)) {
    const count = group.length;
    result[key] = {
      count,
      avg_likes: Math.round(group.reduce((s, e) => s + e.peak_metrics.likes, 0) / count),
      avg_comments: Math.round(group.reduce((s, e) => s + e.peak_metrics.comments, 0) / count),
      avg_saves: Math.round(group.reduce((s, e) => s + (e.peak_metrics.saves ?? 0), 0) / count),
    };
  }
  return result;
}

// ─── Platform data fetching ─────────────────────────────────────────────────

export function fetchXhsMetrics(url: string): PerformanceMetrics | null {
  try {
    const raw = execFileSync('openclaw', [
      'skills', 'run', 'xhs-bridge',
      '--args', JSON.stringify({ action: 'get_note_details', url }),
    ], { timeout: 30_000, encoding: 'utf8' });
    const result = JSON.parse(raw) as {
      liked_count?: number; comment_count?: number; collected_count?: number; share_count?: number;
    };
    return {
      likes: result.liked_count ?? 0,
      comments: result.comment_count ?? 0,
      saves: result.collected_count ?? 0,
      shares: result.share_count ?? 0,
    };
  } catch (err) {
    console.error('[performance-tracker] fetchXhsMetrics failed:', url, err);
    return null;
  }
}

export function fetchDouyinMetrics(url: string): PerformanceMetrics | null {
  try {
    const ytDlpDir = process.env.YTDLP_SKILLS_DIR ?? path.join(os.homedir(), '.openclaw', 'workspace', 'skills', 'yt-dlp-downloader');
    const raw = execFileSync('python3', [
      path.join(ytDlpDir, 'scripts', 'main.py'),
      '--url', url,
    ], { timeout: 30_000, encoding: 'utf8' });
    const result = JSON.parse(raw) as {
      like_count?: number; comment_count?: number; view_count?: number; repost_count?: number;
    };
    return {
      views: result.view_count ?? 0,
      likes: result.like_count ?? 0,
      comments: result.comment_count ?? 0,
      forwards: result.repost_count ?? 0,
    };
  } catch (err) {
    console.error('[performance-tracker] fetchDouyinMetrics failed:', url, err);
    return null;
  }
}

export function fetchMetrics(platform: 'xhs' | 'douyin', url: string): PerformanceMetrics | null {
  return platform === 'xhs' ? fetchXhsMetrics(url) : fetchDouyinMetrics(url);
}

export function cleanupOldEntries(): void {
  const log = loadPerformanceLog();
  const cutoff = new Date(now().getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const kept = log.entries.filter(e => e.published_at >= cutoff);
  if (kept.length < log.entries.length) {
    writeJSON(PATHS.performanceLog, { entries: kept, last_updated: now().toISOString() });
  }
}

/**
 * Fetch live metrics for a published queue item and record a snapshot for each
 * platform URL present. Returns a summary describing what was refreshed.
 *
 * - Requires item.status === 'published' and at least one URL in published_urls.
 * - Marks performance_tracked = true after at least one successful fetch.
 * - Per-platform failures are captured in `failures`; they do not abort the whole refresh.
 */
export async function refreshMetricsForQueueItem(id: string): Promise<{
  ok: boolean;
  item_id: string;
  refreshed: { platform: 'xhs' | 'douyin'; url: string; metrics: PerformanceMetrics }[];
  failures: { platform: 'xhs' | 'douyin' | ''; url: string; reason: string }[];
}> {
  const { getItem, markPerformanceTracked } = await import('./review-queue');
  const item = await getItem(id);
  if (!item) {
    return { ok: false, item_id: id, refreshed: [], failures: [{ platform: '', url: '', reason: 'item not found' }] };
  }
  if (item.status !== 'published') {
    return { ok: false, item_id: id, refreshed: [], failures: [{ platform: '', url: '', reason: `status is ${item.status}, not published` }] };
  }
  const urls = item.published_urls ?? {};
  const platforms: ('xhs' | 'douyin')[] = [];
  if (urls.xhs) platforms.push('xhs');
  if (urls.douyin) platforms.push('douyin');
  if (platforms.length === 0) {
    return { ok: false, item_id: id, refreshed: [], failures: [{ platform: '', url: '', reason: 'no published_urls' }] };
  }

  const publishedAt = item.published_at ?? now().toISOString();
  const templateType = item.template_spec?.content_type ?? 'unknown';
  const refreshed: { platform: 'xhs' | 'douyin'; url: string; metrics: PerformanceMetrics }[] = [];
  const failures: { platform: 'xhs' | 'douyin' | ''; url: string; reason: string }[] = [];

  for (const platform of platforms) {
    const url = urls[platform]!;
    const tagsUsed: string[] = platform === 'xhs'
      ? (item.content?.xhs?.tags ?? [])
      : (item.content?.douyin?.key_captions ?? []);
    try {
      const metrics = fetchMetrics(platform, url);
      if (!metrics) {
        failures.push({ platform, url, reason: 'fetchMetrics returned null' });
        continue;
      }
      appendSnapshot({
        item_id: item.id,
        identity_mode: item.identity_mode,
        template_type: templateType,
        topic: item.topic,
        platform,
        url,
        published_at: publishedAt,
        tags_used: tagsUsed,
      }, metrics);
      refreshed.push({ platform, url, metrics });
    } catch (err) {
      failures.push({ platform, url, reason: (err as Error).message ?? String(err) });
    }
  }

  if (refreshed.length > 0) {
    await markPerformanceTracked(id);
  }
  return { ok: refreshed.length > 0, item_id: id, refreshed, failures };
}
