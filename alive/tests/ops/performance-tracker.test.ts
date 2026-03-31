import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setBasePaths, resetBasePaths } from '../../scripts/utils/file-utils';
import { setTimeOverride } from '../../scripts/utils/time-utils';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  loadPerformanceLog,
  appendSnapshot,
  getEntriesForPeriod,
  aggregateByIdentity,
  aggregateByTemplate,
  DEFAULT_PERFORMANCE_LOG,
} from '../../scripts/ops/performance-tracker';

const tmpDir = path.join(os.tmpdir(), 'alive-perf-test-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
  setTimeOverride(new Date('2026-04-01T10:00:00Z'));
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadPerformanceLog', () => {
  it('returns default when file missing', () => {
    const log = loadPerformanceLog();
    expect(log.entries).toEqual([]);
  });
});

describe('appendSnapshot', () => {
  it('creates new entry and adds first snapshot', () => {
    appendSnapshot({
      item_id: 'q_1', identity_mode: 'esports', template_type: '赛场高燃瞬间',
      topic: '电竞S16', platform: 'xhs', url: 'https://xiaohongshu.com/explore/abc',
      published_at: '2026-03-31T18:00:00Z', tags_used: ['#电竞'],
    }, { likes: 100, comments: 20, saves: 10 });

    const log = loadPerformanceLog();
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].snapshots).toHaveLength(1);
    expect(log.entries[0].peak_metrics.likes).toBe(100);
  });

  it('appends to existing entry and updates peak', () => {
    appendSnapshot({
      item_id: 'q_1', identity_mode: 'esports', template_type: '赛场高燃瞬间',
      topic: '电竞S16', platform: 'xhs', url: 'https://xiaohongshu.com/explore/abc',
      published_at: '2026-03-31T18:00:00Z', tags_used: [],
    }, { likes: 100, comments: 20 });

    appendSnapshot({
      item_id: 'q_1', identity_mode: 'esports', template_type: '赛场高燃瞬间',
      topic: '电竞S16', platform: 'xhs', url: 'https://xiaohongshu.com/explore/abc',
      published_at: '2026-03-31T18:00:00Z', tags_used: [],
    }, { likes: 500, comments: 80 });

    const log = loadPerformanceLog();
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].snapshots).toHaveLength(2);
    expect(log.entries[0].peak_metrics.likes).toBe(500);
  });
});

describe('getEntriesForPeriod', () => {
  it('filters entries within date range', () => {
    appendSnapshot({
      item_id: 'q_old', identity_mode: 'daily', template_type: 'test',
      topic: 'old', platform: 'xhs', url: 'https://test.com/old',
      published_at: '2026-03-20T10:00:00Z', tags_used: [],
    }, { likes: 10, comments: 1 });

    appendSnapshot({
      item_id: 'q_new', identity_mode: 'esports', template_type: 'test',
      topic: 'new', platform: 'xhs', url: 'https://test.com/new',
      published_at: '2026-03-30T10:00:00Z', tags_used: [],
    }, { likes: 100, comments: 10 });

    const recent = getEntriesForPeriod(7);
    expect(recent).toHaveLength(1);
    expect(recent[0].item_id).toBe('q_new');
  });
});

describe('aggregateByIdentity', () => {
  it('groups entries by identity_mode and computes averages', () => {
    appendSnapshot({
      item_id: 'q_1', identity_mode: 'esports', template_type: 'a',
      topic: 'a', platform: 'xhs', url: 'u1', published_at: '2026-03-30T10:00:00Z', tags_used: [],
    }, { likes: 100, comments: 10 });

    appendSnapshot({
      item_id: 'q_2', identity_mode: 'esports', template_type: 'b',
      topic: 'b', platform: 'xhs', url: 'u2', published_at: '2026-03-30T12:00:00Z', tags_used: [],
    }, { likes: 200, comments: 20 });

    appendSnapshot({
      item_id: 'q_3', identity_mode: 'daily', template_type: 'c',
      topic: 'c', platform: 'xhs', url: 'u3', published_at: '2026-03-30T14:00:00Z', tags_used: [],
    }, { likes: 50, comments: 5 });

    const agg = aggregateByIdentity(getEntriesForPeriod(7));
    expect(agg.esports.count).toBe(2);
    expect(agg.esports.avg_likes).toBe(150);
    expect(agg.daily.count).toBe(1);
    expect(agg.daily.avg_likes).toBe(50);
  });
});

describe('aggregateByTemplate', () => {
  it('groups entries by template_type and computes averages', () => {
    appendSnapshot({
      item_id: 'q_1', identity_mode: 'esports', template_type: '赛场高燃瞬间',
      topic: 'a', platform: 'xhs', url: 'u1', published_at: '2026-03-30T10:00:00Z', tags_used: [],
    }, { likes: 200, comments: 30 });

    appendSnapshot({
      item_id: 'q_2', identity_mode: 'esports', template_type: '赛场高燃瞬间',
      topic: 'b', platform: 'xhs', url: 'u2', published_at: '2026-03-30T12:00:00Z', tags_used: [],
    }, { likes: 400, comments: 50 });

    const agg = aggregateByTemplate(getEntriesForPeriod(7));
    expect(agg['赛场高燃瞬间'].count).toBe(2);
    expect(agg['赛场高燃瞬间'].avg_likes).toBe(300);
  });
});
