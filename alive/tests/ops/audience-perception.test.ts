/**
 * audience-perception.test.ts
 * Unit tests for audience-perception.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setBasePaths, resetBasePaths } from '../../scripts/utils/file-utils';
import { setTimeOverride, clearTimeOverride } from '../../scripts/utils/time-utils';
import {
  loadAudiencePerception,
  buildAudiencePerceptionEntry,
  upsertAudiencePerceptionEntry,
  buildAudiencePerceptionContext,
  getRecentPerceptionEntries,
} from '../../scripts/ops/audience-perception';

// ─── Sandbox setup ────────────────────────────────────────────────────────────

let sandboxDir: string;

beforeEach(() => {
  sandboxDir = fs.mkdtempSync(path.join('/tmp', 'audience-perception-test-'));
  setBasePaths(sandboxDir, sandboxDir);
  setTimeOverride(new Date('2026-04-16T10:00:00Z'));
});

afterEach(() => {
  resetBasePaths();
  clearTimeOverride();
  fs.rmSync(sandboxDir, { recursive: true, force: true });
});

// ─── buildAudiencePerceptionEntry ─────────────────────────────────────────────

describe('buildAudiencePerceptionEntry', () => {
  it('builds entry from comment_analysis', () => {
    const entry = buildAudiencePerceptionEntry({
      item_id: 'q_1',
      platform: 'xhs',
      identity_mode: 'esports',
      comment_analysis: {
        top_keywords: ['专业', '冷静'],
        constructive_feedback: ['想看更多赛事判断'],
        positive_ratio: 0.8,
        negative_ratio: 0.1,
        neutral_ratio: 0.1,
      },
    });

    expect(entry.item_id).toBe('q_1');
    expect(entry.platform).toBe('xhs');
    expect(entry.perceived_traits).toContain('专业');
    expect(entry.desire_signals).toContain('想看更多赛事判断');
    expect(entry.generated_at).toBe('2026-04-16T10:00:00.000Z');
  });

  it('falls back to aggregated insights when no comment_analysis', () => {
    const entry = buildAudiencePerceptionEntry({
      item_id: 'q_2',
      platform: 'douyin',
      identity_mode: 'lifestyle',
      aggregatedInsights: {
        topKeywords: ['真实', '治愈'],
        constructiveFeedback: ['多拍日常'],
        avgPositiveRatio: 0.75,
      },
    });

    expect(entry.perceived_traits).toContain('真实');
    expect(entry.desire_signals).toContain('多拍日常');
  });

  it('produces empty-but-valid entry when no data available', () => {
    const entry = buildAudiencePerceptionEntry({
      item_id: 'q_3',
      platform: 'xhs',
      identity_mode: 'esports',
    });

    expect(entry.perceived_traits).toEqual([]);
    expect(entry.desire_signals).toEqual([]);
    expect(entry.summary).toBeTruthy();
  });

  it('detects resistance signals from high negative_ratio', () => {
    const entry = buildAudiencePerceptionEntry({
      item_id: 'q_4',
      platform: 'xhs',
      identity_mode: 'esports',
      comment_analysis: {
        top_keywords: ['无聊'],
        constructive_feedback: [],
        positive_ratio: 0.3,
        negative_ratio: 0.6,
        neutral_ratio: 0.1,
      },
    });

    expect(entry.resistance_signals).toContain('负面反馈偏高');
  });
});

// ─── upsertAudiencePerceptionEntry ────────────────────────────────────────────

describe('upsertAudiencePerceptionEntry', () => {
  it('appends a new entry to the store', () => {
    const entry = buildAudiencePerceptionEntry({
      item_id: 'q_1',
      platform: 'xhs',
      identity_mode: 'esports',
      comment_analysis: {
        top_keywords: ['专业'],
        constructive_feedback: [],
        positive_ratio: 0.9,
        negative_ratio: 0.05,
        neutral_ratio: 0.05,
      },
    });

    const store = upsertAudiencePerceptionEntry(entry);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0].item_id).toBe('q_1');
  });

  it('replaces entry with same item_id + platform (upsert)', () => {
    const entry1 = buildAudiencePerceptionEntry({
      item_id: 'q_1',
      platform: 'xhs',
      identity_mode: 'esports',
      comment_analysis: {
        top_keywords: ['专业'],
        constructive_feedback: [],
        positive_ratio: 0.9,
        negative_ratio: 0.05,
        neutral_ratio: 0.05,
      },
    });
    upsertAudiencePerceptionEntry(entry1);

    // Update the same entry
    const entry2: typeof entry1 = {
      ...entry1,
      perceived_traits: ['专业', '冷静'],
      summary: '更新后的摘要',
    };
    const store = upsertAudiencePerceptionEntry(entry2);

    expect(store.entries).toHaveLength(1); // Not duplicated
    expect(store.entries[0].perceived_traits).toContain('冷静');
    expect(store.entries[0].summary).toBe('更新后的摘要');
  });

  it('keeps different platforms for same item_id as separate entries', () => {
    const xhsEntry = buildAudiencePerceptionEntry({
      item_id: 'q_1',
      platform: 'xhs',
      identity_mode: 'esports',
      comment_analysis: {
        top_keywords: ['专业'],
        constructive_feedback: [],
        positive_ratio: 0.8,
        negative_ratio: 0.1,
        neutral_ratio: 0.1,
      },
    });
    upsertAudiencePerceptionEntry(xhsEntry);

    const douyinEntry = buildAudiencePerceptionEntry({
      item_id: 'q_1',
      platform: 'douyin',
      identity_mode: 'esports',
      comment_analysis: {
        top_keywords: ['帅气'],
        constructive_feedback: [],
        positive_ratio: 0.7,
        negative_ratio: 0.1,
        neutral_ratio: 0.2,
      },
    });
    const store = upsertAudiencePerceptionEntry(douyinEntry);

    expect(store.entries).toHaveLength(2);
  });

  it('caps store to MAX_ENTRIES and keeps most recent', () => {
    // Insert 60 entries with incrementing time
    for (let i = 0; i < 60; i++) {
      const day = i < 24 ? 16 : i < 48 ? 17 : 18;
      const hour = i % 24;
      setTimeOverride(new Date(`2026-04-${day}T${String(hour).padStart(2, '0')}:00:00Z`));
      const entry = buildAudiencePerceptionEntry({
        item_id: `q_${i}`,
        platform: 'xhs',
        identity_mode: 'esports',
      });
      upsertAudiencePerceptionEntry(entry);
    }

    const store = loadAudiencePerception();
    expect(store.entries.length).toBeLessThanOrEqual(50);
  });
});

// ─── buildAudiencePerceptionContext ───────────────────────────────────────────

describe('buildAudiencePerceptionContext', () => {
  it('returns empty string when no entries exist', () => {
    const ctx = buildAudiencePerceptionContext();
    expect(ctx).toBe('');
  });

  it('aggregates traits, desires and resistances across entries', () => {
    const entry1 = buildAudiencePerceptionEntry({
      item_id: 'q_1',
      platform: 'xhs',
      identity_mode: 'esports',
      comment_analysis: {
        top_keywords: ['专业', '冷静'],
        constructive_feedback: ['想看更多赛事判断'],
        positive_ratio: 0.9,
        negative_ratio: 0.05,
        neutral_ratio: 0.05,
      },
    });
    upsertAudiencePerceptionEntry(entry1);

    const entry2 = buildAudiencePerceptionEntry({
      item_id: 'q_2',
      platform: 'xhs',
      identity_mode: 'esports',
      comment_analysis: {
        top_keywords: ['专业', '毒舌'],
        constructive_feedback: ['多来点生活反差'],
        positive_ratio: 0.85,
        negative_ratio: 0.1,
        neutral_ratio: 0.05,
      },
    });
    upsertAudiencePerceptionEntry(entry2);

    const ctx = buildAudiencePerceptionContext();
    expect(ctx).toContain('专业');
    expect(ctx).toContain('赛事判断');
    expect(ctx).toContain('生活反差');
  });

  it('filters by identityMode when provided', () => {
    const esportsEntry = buildAudiencePerceptionEntry({
      item_id: 'q_1',
      platform: 'xhs',
      identity_mode: 'esports',
      comment_analysis: {
        top_keywords: ['专业'],
        constructive_feedback: [],
        positive_ratio: 0.8,
        negative_ratio: 0.1,
        neutral_ratio: 0.1,
      },
    });
    upsertAudiencePerceptionEntry(esportsEntry);

    const lifestyleEntry = buildAudiencePerceptionEntry({
      item_id: 'q_2',
      platform: 'xhs',
      identity_mode: 'lifestyle',
      comment_analysis: {
        top_keywords: ['治愈'],
        constructive_feedback: [],
        positive_ratio: 0.9,
        negative_ratio: 0.05,
        neutral_ratio: 0.05,
      },
    });
    upsertAudiencePerceptionEntry(lifestyleEntry);

    const ctx = buildAudiencePerceptionContext({ identityMode: 'esports' });
    expect(ctx).toContain('专业');
    expect(ctx).not.toContain('治愈');
  });

  it('respects maxChars budget', () => {
    const entry = buildAudiencePerceptionEntry({
      item_id: 'q_1',
      platform: 'xhs',
      identity_mode: 'esports',
      comment_analysis: {
        top_keywords: ['专业', '冷静', '犀利', '有深度', '权威', '清晰', '直接', '犀利', '独特', '有料'],
        constructive_feedback: ['多来点赛事分析', '想看更多深度内容', '继续加油', '期待下期', '可以更深入'],
        positive_ratio: 0.9,
        negative_ratio: 0.05,
        neutral_ratio: 0.05,
      },
    });
    upsertAudiencePerceptionEntry(entry);

    const ctx = buildAudiencePerceptionContext({ maxChars: 50 });
    expect(ctx.length).toBeLessThanOrEqual(50);
  });
});

// ─── getRecentPerceptionEntries ───────────────────────────────────────────────

describe('getRecentPerceptionEntries', () => {
  it('returns recent entries in order', () => {
    for (let i = 0; i < 5; i++) {
      upsertAudiencePerceptionEntry(buildAudiencePerceptionEntry({
        item_id: `q_${i}`,
        platform: 'xhs',
        identity_mode: 'esports',
      }));
    }

    const entries = getRecentPerceptionEntries({ maxEntries: 3 });
    expect(entries).toHaveLength(3);
  });

  it('filters by identityMode', () => {
    upsertAudiencePerceptionEntry(buildAudiencePerceptionEntry({
      item_id: 'q_1',
      platform: 'xhs',
      identity_mode: 'esports',
      comment_analysis: {
        top_keywords: ['专业'],
        constructive_feedback: [],
        positive_ratio: 0.8,
        negative_ratio: 0.1,
        neutral_ratio: 0.1,
      },
    }));

    upsertAudiencePerceptionEntry(buildAudiencePerceptionEntry({
      item_id: 'q_2',
      platform: 'xhs',
      identity_mode: 'lifestyle',
      comment_analysis: {
        top_keywords: ['治愈'],
        constructive_feedback: [],
        positive_ratio: 0.9,
        negative_ratio: 0.05,
        neutral_ratio: 0.05,
      },
    }));

    const entries = getRecentPerceptionEntries({ identityMode: 'esports' });
    expect(entries).toHaveLength(1);
    expect(entries[0].identity_mode).toBe('esports');
  });
});
