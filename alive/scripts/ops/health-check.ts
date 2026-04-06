/**
 * health-check.ts
 * Lightweight health check for the Alive ops pipeline.
 * Scans key data files and reports which links in the chain are active vs broken.
 */

import { PATHS, readJSON } from '../utils/file-utils';
import { now } from '../utils/time-utils';
import type {
  PerformanceLog, AnalysisLog, ContentPatterns,
} from '../utils/types';
import { loadQueue } from './review-queue';

export interface HealthCheckItem {
  name: string;
  status: 'ok' | 'warn' | 'missing';
  detail: string;
}

export interface HealthReport {
  timestamp: string;
  items: HealthCheckItem[];
  summary: { ok: number; warn: number; missing: number };
}

const STALE_DAYS = 7;

function daysSince(isoDate: string): number {
  const diff = now().getTime() - new Date(isoDate).getTime();
  return Math.floor(diff / (24 * 60 * 60 * 1000));
}

export async function runHealthCheck(): Promise<HealthReport> {
  const items: HealthCheckItem[] = [];

  // 1. Review queue — any published items?
  const queue = await loadQueue();
  const published = queue.items.filter(i => i.status === 'published');
  const pending = queue.items.filter(i => i.status === 'pending');
  if (published.length > 0) {
    items.push({ name: '发布记录', status: 'ok', detail: `${published.length} 条已发布` });
  } else if (pending.length > 0) {
    items.push({ name: '发布记录', status: 'warn', detail: `${pending.length} 条待审核，0 条已发布` });
  } else {
    items.push({ name: '发布记录', status: 'missing', detail: '审核队列为空' });
  }

  // 2. Performance log
  const perfLog = readJSON<PerformanceLog>(PATHS.performanceLog, { entries: [], last_updated: '' });
  if (perfLog.entries.length > 0) {
    const latest = perfLog.entries[perfLog.entries.length - 1];
    const age = daysSince(latest.published_at);
    items.push({
      name: '表现追踪',
      status: age <= STALE_DAYS ? 'ok' : 'warn',
      detail: `${perfLog.entries.length} 条记录，最近 ${age} 天前`,
    });
  } else {
    items.push({ name: '表现追踪', status: 'missing', detail: '无表现数据' });
  }

  // 3. Analysis log
  const analysisLog = readJSON<AnalysisLog>(PATHS.analysisLog, { entries: [], last_updated: '' });
  if (analysisLog.entries.length > 0) {
    const latest = analysisLog.entries[analysisLog.entries.length - 1];
    const age = daysSince(latest.analyzed_at);
    items.push({
      name: '内容分析',
      status: age <= STALE_DAYS ? 'ok' : 'warn',
      detail: `${analysisLog.entries.length} 条分析，最近 ${age} 天前`,
    });
  } else {
    items.push({ name: '内容分析', status: 'missing', detail: '无分析数据' });
  }

  // 4. Content patterns
  const patterns = readJSON<ContentPatterns>(PATHS.contentPatterns, { updated_at: '', patterns: [], competitor_insights: [], cover_trends: [] });
  if (patterns.patterns.length > 0) {
    const used = patterns.patterns.filter(p => p.times_used > 0).length;
    const withRate = patterns.patterns.filter(p => p.success_rate !== null).length;
    items.push({
      name: '内容模式库',
      status: used > 0 ? 'ok' : 'warn',
      detail: `${patterns.patterns.length} 个模式，${used} 个被使用过，${withRate} 个有成功率`,
    });
  } else {
    items.push({ name: '内容模式库', status: 'missing', detail: '无模式数据' });
  }

  // 5. Competitor log (handle legacy format: { competitors, lastUpdate })
  const rawCompetitorLog = readJSON<Record<string, unknown>>(PATHS.competitorLog, {});
  const competitorEntries: unknown[] =
    (rawCompetitorLog as any).entries ?? (rawCompetitorLog as any).competitors ?? [];
  const competitorLastUpdated: string =
    (rawCompetitorLog as any).last_updated ?? (rawCompetitorLog as any).lastUpdate ?? '';
  if (competitorEntries.length > 0) {
    const age = competitorLastUpdated ? daysSince(competitorLastUpdated) : 999;
    items.push({
      name: '竞品追踪',
      status: age <= STALE_DAYS ? 'ok' : 'warn',
      detail: `${competitorEntries.length} 条记录，最近更新 ${age} 天前`,
    });
  } else {
    items.push({ name: '竞品追踪', status: 'missing', detail: '无竞品数据' });
  }

  // 6. Inspiration state
  const inspoState = readJSON<{ last_refreshed_at: string | null }>(
    PATHS.inspirationState, { last_refreshed_at: null },
  );
  if (inspoState.last_refreshed_at) {
    const age = daysSince(inspoState.last_refreshed_at);
    items.push({
      name: '灵感浏览',
      status: age <= STALE_DAYS ? 'ok' : 'warn',
      detail: `最近浏览 ${age} 天前`,
    });
  } else {
    items.push({ name: '灵感浏览', status: 'missing', detail: '从未浏览过内容' });
  }

  // 7. Content strategy
  const strategy = readJSON<{ status?: string; generated_at?: string } | null>(
    PATHS.contentStrategy, null,
  );
  if (strategy?.generated_at) {
    const age = daysSince(strategy.generated_at);
    const statusLabel = strategy.status === 'confirmed' ? '已确认' : strategy.status === 'pending' ? '待确认' : '已过期';
    items.push({
      name: '内容策略',
      status: strategy.status === 'confirmed' && age <= STALE_DAYS ? 'ok' : 'warn',
      detail: `${statusLabel}，${age} 天前生成`,
    });
  } else {
    items.push({ name: '内容策略', status: 'missing', detail: '无策略数据' });
  }

  const summary = {
    ok: items.filter(i => i.status === 'ok').length,
    warn: items.filter(i => i.status === 'warn').length,
    missing: items.filter(i => i.status === 'missing').length,
  };

  return { timestamp: now().toISOString(), items, summary };
}

export function formatHealthReport(report: HealthReport): string {
  const statusIcon = { ok: '✅', warn: '⚠️', missing: '❌' };
  const lines: string[] = [
    `🏥 链路健康检查  ${report.timestamp.slice(0, 10)}`,
    '',
  ];

  for (const item of report.items) {
    lines.push(`${statusIcon[item.status]} ${item.name}：${item.detail}`);
  }

  lines.push('');
  lines.push(`总计：${report.summary.ok} 正常 / ${report.summary.warn} 警告 / ${report.summary.missing} 缺失`);

  return lines.join('\n');
}
