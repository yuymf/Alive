// alive/tests/lifecycle.test.ts
// Tests for lifecycle utilities: memory-reflect + cron-sync

import { describe, it, expect, vi } from 'vitest';
import { extractHighImportanceMemories } from '../scripts/lifecycle/memory-reflect';

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
