// alive/tests/lifecycle.test.ts
// Tests for lifecycle utilities: memory-reflect + cron-sync

import { describe, it, expect, vi } from 'vitest';
import { extractHighImportanceMemories } from '../scripts/lifecycle/memory-reflect';
import { buildCronExpression } from '../scripts/lifecycle/cron-sync';
import type { CronSchedule } from '../scripts/utils/types';

// ── memory-reflect/extractHighImportanceMemories ─────────────────

describe('memory-reflect/extractHighImportanceMemories', () => {
  const sampleDiary = `
## 2026-03-20 10:00
今天去了咖啡店
情绪: 开心 | 重要性: 3
标签: 日常

## 2026-03-20 15:00
拍了一组很满意的照片！
情绪: 兴奋 | 重要性: 8
标签: 创作

## 2026-03-21 09:00
学了新的修图技巧
情绪: 平静 | 重要性: 5
标签: 学习

## 2026-03-21 14:00
和粉丝互动感觉很温暖
情绪: 感动 | 重要性: 7
标签: 社交

## 2026-03-22 11:00
早上起来心情不太好
情绪: 低落 | 重要性: 6
标签: 情绪
`.trim();

  it('extracts entries with importance >= 6 by default', () => {
    const results = extractHighImportanceMemories(sampleDiary);
    expect(results.length).toBe(3); // importance 8, 7, 6
  });

  it('respects custom minImportance parameter', () => {
    const results = extractHighImportanceMemories(sampleDiary, 7);
    expect(results.length).toBe(2); // importance 8, 7
  });

  it('extracts correct entries', () => {
    const results = extractHighImportanceMemories(sampleDiary, 8);
    expect(results.length).toBe(1);
    expect(results[0]).toContain('拍了一组很满意的照片');
  });

  it('returns empty array for diary without high-importance entries', () => {
    const lowDiary = '## 2026-03-20\n简单一天\n重要性: 2';
    const results = extractHighImportanceMemories(lowDiary);
    expect(results).toHaveLength(0);
  });

  it('returns empty array for empty diary', () => {
    expect(extractHighImportanceMemories('')).toHaveLength(0);
  });

  it('limits to most recent 20 entries', () => {
    const manyEntries = Array.from({ length: 30 }, (_, i) =>
      `## Entry ${i}\n内容\n重要性: 9`
    ).join('\n\n');
    const results = extractHighImportanceMemories(manyEntries);
    expect(results.length).toBeLessThanOrEqual(20);
  });
});

// ── cron-sync/buildCronExpression ────────────────────────────────

describe('cron-sync/buildCronExpression', () => {
  it('returns defaults for empty heartbeat list', () => {
    const schedule: CronSchedule = { date: '2026-03-24', heartbeats: [] };
    const expr = buildCronExpression(schedule);
    expect(expr.morning).toBe('0 7 * * *');
    expect(expr.tick).toBe('0 8-22 * * *');
    expect(expr.night).toBe('0 23 * * *');
  });

  it('extracts morning hour correctly', () => {
    const schedule: CronSchedule = {
      date: '2026-03-24',
      heartbeats: [
        { time: '06:30', type: 'morning' },
        { time: '22:00', type: 'night' },
      ],
    };
    const expr = buildCronExpression(schedule);
    expect(expr.morning).toBe('0 6 * * *');
    expect(expr.night).toBe('0 22 * * *');
  });

  it('builds tick expression from regular heartbeats', () => {
    const schedule: CronSchedule = {
      date: '2026-03-24',
      heartbeats: [
        { time: '07:00', type: 'morning' },
        { time: '09:00', type: 'regular' },
        { time: '12:00', type: 'regular' },
        { time: '15:00', type: 'regular' },
        { time: '18:00', type: 'regular' },
        { time: '23:00', type: 'night' },
      ],
    };
    const expr = buildCronExpression(schedule);
    expect(expr.tick).toBe('0 9,12,15,18 * * *');
  });

  it('returns null tick when no regular heartbeats', () => {
    const schedule: CronSchedule = {
      date: '2026-03-24',
      heartbeats: [
        { time: '07:00', type: 'morning' },
        { time: '23:00', type: 'night' },
      ],
    };
    const expr = buildCronExpression(schedule);
    expect(expr.tick).toBeNull();
  });

  it('sorts regular hours in ascending order', () => {
    const schedule: CronSchedule = {
      date: '2026-03-24',
      heartbeats: [
        { time: '07:00', type: 'morning' },
        { time: '18:00', type: 'regular' },
        { time: '10:00', type: 'regular' },
        { time: '14:00', type: 'regular' },
        { time: '23:00', type: 'night' },
      ],
    };
    const expr = buildCronExpression(schedule);
    expect(expr.tick).toBe('0 10,14,18 * * *');
  });

  it('handles single regular heartbeat', () => {
    const schedule: CronSchedule = {
      date: '2026-03-24',
      heartbeats: [
        { time: '07:00', type: 'morning' },
        { time: '12:00', type: 'regular' },
        { time: '23:00', type: 'night' },
      ],
    };
    const expr = buildCronExpression(schedule);
    expect(expr.tick).toBe('0 12 * * *');
  });

  it('defaults morning to 7 when not in heartbeats', () => {
    const schedule: CronSchedule = {
      date: '2026-03-24',
      heartbeats: [
        { time: '12:00', type: 'regular' },
      ],
    };
    const expr = buildCronExpression(schedule);
    expect(expr.morning).toBe('0 7 * * *');
  });

  it('defaults night to 23 when not in heartbeats', () => {
    const schedule: CronSchedule = {
      date: '2026-03-24',
      heartbeats: [
        { time: '08:00', type: 'morning' },
        { time: '12:00', type: 'regular' },
      ],
    };
    const expr = buildCronExpression(schedule);
    expect(expr.night).toBe('0 23 * * *');
  });
});
