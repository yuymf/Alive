/**
 * health-check.test.ts
 * Task 13: Verify health check reports correct status for various scenarios.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setBasePaths, resetBasePaths, PATHS, writeJSON } from '../../scripts/utils/file-utils';
import { setTimeOverride, clearTimeOverride } from '../../scripts/utils/time-utils';
import { runHealthCheck, formatHealthReport } from '../../scripts/ops/health-check';
import { addItem, markPublished } from '../../scripts/ops/review-queue';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const tmpDir = path.join(os.tmpdir(), 'alive-health-check-' + Date.now());

const seedContent = {
  xhs: { title: 't', body: 'b', tags: [] as string[], cover_images: [] as string[] },
  douyin: { script: 's', bgm_suggestion: '', key_captions: [] as string[], cover_images: [] as string[] },
};

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
  setTimeOverride(new Date('2026-04-03T10:00:00Z'));
});

afterEach(() => {
  resetBasePaths();
  clearTimeOverride();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runHealthCheck', () => {
  it('reports all missing when no data exists', async () => {
    const report = await runHealthCheck();
    expect(report.summary.missing).toBeGreaterThanOrEqual(5);
    expect(report.summary.ok).toBe(0);
  });

  it('reports ok for published items', async () => {
    const item = await addItem({ topic: 'test', trend_hook: 'h', identity_mode: 'daily', content: seedContent });
    await markPublished(item.id, { platform: 'xhs', url: 'https://example.com' });

    const report = await runHealthCheck();
    const pubItem = report.items.find(i => i.name === '发布记录');
    expect(pubItem?.status).toBe('ok');
    expect(pubItem?.detail).toContain('1 条已发布');
  });

  it('reports warn for stale performance data', async () => {
    writeJSON(PATHS.performanceLog, {
      entries: [{
        item_id: 'old', platform: 'xhs', published_at: '2026-03-20T00:00:00Z',
        identity_mode: 'daily', template_type: '写实',
        snapshots: [], peak_metrics: { likes: 10, comments: 2 },
      }],
      last_updated: '2026-03-20T00:00:00Z',
    });

    const report = await runHealthCheck();
    const perfItem = report.items.find(i => i.name === '表现追踪');
    expect(perfItem?.status).toBe('warn');
  });

  it('reports ok for recent inspiration browsing', async () => {
    writeJSON(PATHS.inspirationState, {
      last_refreshed_at: '2026-04-03T08:00:00Z',
      feed_highlights: [{ title: 'test', likes: 100, topic: 'AI' }],
    });

    const report = await runHealthCheck();
    const inspoItem = report.items.find(i => i.name === '灵感浏览');
    expect(inspoItem?.status).toBe('ok');
  });

  it('reports ok for patterns with usage', async () => {
    writeJSON(PATHS.contentPatterns, {
      updated_at: '2026-04-03T00:00:00Z',
      patterns: [
        { type: 'test', source: 'self', source_post: 'p', formula: 'f', success_rate: 0.8, times_used: 3, examples: [], discovered_at: '2026-04-01' },
      ],
      competitor_insights: [],
      cover_trends: [],
    });

    const report = await runHealthCheck();
    const patItem = report.items.find(i => i.name === '内容模式库');
    expect(patItem?.status).toBe('ok');
    expect(patItem?.detail).toContain('1 个被使用过');
  });
});

describe('formatHealthReport', () => {
  it('formats report with icons', async () => {
    const item = await addItem({ topic: 'test', trend_hook: 'h', identity_mode: 'daily', content: seedContent });
    await markPublished(item.id, { platform: 'xhs', url: 'https://example.com' });

    const report = await runHealthCheck();
    const formatted = formatHealthReport(report);
    expect(formatted).toContain('🏥');
    expect(formatted).toContain('✅');
    expect(formatted).toContain('总计');
  });
});
