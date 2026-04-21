/**
 * cache-age.ts
 *
 * Helpers for formatting cache freshness in user-facing output.
 *
 * Since the ops pipeline is now fully async-decoupled (all platform IO happens
 * in cron, consumers only read caches), every read returns data that was
 * produced at some earlier `computed_at`. We surface this age transparently so
 * users know whether they're looking at fresh or stale data.
 */

import { now } from '../utils/time-utils';

/**
 * Format a cache timestamp into a human-readable "X 前" string.
 * Returns `null` if the input is missing or unparseable — callers decide
 * whether to render a fallback like "数据未就绪".
 */
export function formatCacheAge(computedAt: string | null | undefined): string | null {
  if (!computedAt) return null;
  const t = Date.parse(computedAt);
  if (!Number.isFinite(t)) return null;

  const ageMs = now().getTime() - t;
  if (ageMs < 0) return '刚刚';

  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remMin = minutes % 60;
    return remMin > 0 ? `${hours} 小时 ${remMin} 分钟前` : `${hours} 小时前`;
  }

  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

/**
 * Build a single-line cache freshness banner suitable for appending to
 * command output, e.g. `📊 数据更新于 23 分钟前（来自后台定时任务）`.
 * Returns empty string when no valid timestamp is available.
 */
export function buildCacheFreshnessBanner(
  computedAt: string | null | undefined,
  kind = '数据',
): string {
  const age = formatCacheAge(computedAt);
  if (!age) return `📊 ${kind}暂未就绪（后台定时任务尚未完成首轮采集）`;
  return `📊 ${kind}更新于 ${age}（来自后台定时任务）`;
}
