/**
 * viral-kb-store.test.ts
 * Unit tests for viral-kb-store.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setBasePaths, resetBasePaths } from '../scripts/utils/file-utils';
import {
  loadEntries, saveEntries,
  loadFormulas, saveFormulas,
  loadQueue, saveQueue,
  addToQueue, dequeueItems,
  upsertEntry, checkFormulaPromotion,
  queryTrack, queryAll, queryFormulas, getStats,
  extractTriggerWords,
} from '../scripts/ops/viral-kb-store';
import { ViralEntry, DissectQueueItem } from '../scripts/utils/types';

// ─── Sandbox setup ────────────────────────────────────────────────────────────

let sandboxDir: string;

beforeEach(() => {
  sandboxDir = fs.mkdtempSync(path.join('/tmp', 'viral-kb-store-test-'));
  setBasePaths(sandboxDir, sandboxDir);
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(sandboxDir, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<ViralEntry> = {}): ViralEntry {
  return {
    id: 'entry-001',
    platform: 'xhs',
    source_id: 'src-001',
    source_type: 'competitor',
    persona_id: 'miss-v',
    title: 'Test title',
    description: 'Test description',
    likes: 8000,
    comments: 300,
    shares: 200,
    collected_at: new Date().toISOString(),
    dissection: {
      hook_type: '数字冲击',
      content_type: '种草类',
      identity_mode: null,
      emotion_arc: '焦虑→共鸣→解脱',
      interaction_design: '评论区问答',
      visual_style: '简约白',
      cta_type: '关注解锁',
      summary: '用数字引发共鸣',
    },
    dissection_status: 'done',
    kb_tier: 'universal',
    promoted_to_template: false,
    times_referenced: 0,
    ...overrides,
  };
}

function makeQueueItem(overrides: Partial<DissectQueueItem> = {}): DissectQueueItem {
  return {
    id: 'q-item-001',
    platform: 'xhs',
    source_id: 'src-q-001',
    source_type: 'trending_feed',
    title: 'Queue item title',
    description: 'Queue description',
    likes: 9000,
    comments: 400,
    shares: 150,
    queued_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Cold-start (empty files) ─────────────────────────────────────────────────

describe('cold start — empty files do not throw', () => {
  it('loadEntries returns []', () => {
    expect(loadEntries(sandboxDir)).toEqual([]);
  });

  it('loadFormulas returns []', () => {
    expect(loadFormulas(sandboxDir)).toEqual([]);
  });

  it('loadQueue returns []', () => {
    expect(loadQueue(sandboxDir)).toEqual([]);
  });

  it('getStats returns zeroed stats', () => {
    const stats = getStats(sandboxDir);
    expect(stats.total).toBe(0);
    expect(stats.queue_length).toBe(0);
    expect(stats.formula_count).toBe(0);
  });
});

// ─── upsertEntry dedup ────────────────────────────────────────────────────────

describe('upsertEntry', () => {
  it('inserts a new entry', () => {
    const entry = makeEntry();
    upsertEntry(sandboxDir, entry);
    expect(loadEntries(sandboxDir)).toHaveLength(1);
  });

  it('updates an existing entry by id (dedup)', () => {
    const entry = makeEntry();
    upsertEntry(sandboxDir, entry);
    const updated = makeEntry({ times_referenced: 5 });
    upsertEntry(sandboxDir, updated);
    const entries = loadEntries(sandboxDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].times_referenced).toBe(5);
  });

  it('inserts two distinct entries', () => {
    upsertEntry(sandboxDir, makeEntry({ id: 'a' }));
    upsertEntry(sandboxDir, makeEntry({ id: 'b' }));
    expect(loadEntries(sandboxDir)).toHaveLength(2);
  });
});

// ─── addToQueue / dequeueItems ────────────────────────────────────────────────

describe('queue operations', () => {
  it('addToQueue appends a new item', () => {
    const item = makeQueueItem();
    addToQueue(sandboxDir, item);
    expect(loadQueue(sandboxDir)).toHaveLength(1);
  });

  it('addToQueue deduplicates by id', () => {
    const item = makeQueueItem();
    addToQueue(sandboxDir, item);
    addToQueue(sandboxDir, item);
    expect(loadQueue(sandboxDir)).toHaveLength(1);
  });

  it('dequeueItems returns n items and removes them', () => {
    addToQueue(sandboxDir, makeQueueItem({ id: 'q1', source_id: 's1' }));
    addToQueue(sandboxDir, makeQueueItem({ id: 'q2', source_id: 's2' }));
    addToQueue(sandboxDir, makeQueueItem({ id: 'q3', source_id: 's3' }));

    const taken = dequeueItems(sandboxDir, 2);
    expect(taken).toHaveLength(2);
    expect(loadQueue(sandboxDir)).toHaveLength(1);
  });

  it('dequeueItems on empty queue returns []', () => {
    expect(dequeueItems(sandboxDir, 5)).toEqual([]);
  });

  it('dequeueItems requesting more than available returns all', () => {
    addToQueue(sandboxDir, makeQueueItem({ id: 'q1', source_id: 's1' }));
    const taken = dequeueItems(sandboxDir, 10);
    expect(taken).toHaveLength(1);
    expect(loadQueue(sandboxDir)).toHaveLength(0);
  });
});

// ─── checkFormulaPromotion ────────────────────────────────────────────────────

describe('checkFormulaPromotion', () => {
  function makeUniversalEntry(id: string): ViralEntry {
    return makeEntry({
      id,
      dissection: {
        hook_type: '数字冲击',
        content_type: '种草类',
        identity_mode: null,         // universal
        emotion_arc: '焦虑→解脱',
        interaction_design: '问答',
        visual_style: '简约',
        cta_type: '关注',
        summary: '数字吸引眼球',
      },
      kb_tier: 'universal',
    });
  }

  it('count 1 → no promotion', () => {
    const result = checkFormulaPromotion(sandboxDir, makeUniversalEntry('e1'));
    expect(result.promoted).toBe(false);
    expect(loadFormulas(sandboxDir)[0].occurrence_count).toBe(1);
  });

  it('count 2 → no promotion yet', () => {
    checkFormulaPromotion(sandboxDir, makeUniversalEntry('e1'));
    const result = checkFormulaPromotion(sandboxDir, makeUniversalEntry('e2'));
    expect(result.promoted).toBe(false);
    expect(loadFormulas(sandboxDir)[0].occurrence_count).toBe(2);
  });

  it('count 3 → promotion triggered', () => {
    checkFormulaPromotion(sandboxDir, makeUniversalEntry('e1'));
    checkFormulaPromotion(sandboxDir, makeUniversalEntry('e2'));
    const result = checkFormulaPromotion(sandboxDir, makeUniversalEntry('e3'));
    expect(result.promoted).toBe(true);
    expect(result.formula).toBeDefined();
    expect(result.formula?.occurrence_count).toBe(3);
    expect(result.formula?.injected_to_templates).toBe(true);
  });

  it('after promotion, further entries do not re-promote (single-shot)', () => {
    checkFormulaPromotion(sandboxDir, makeUniversalEntry('e1'));
    checkFormulaPromotion(sandboxDir, makeUniversalEntry('e2'));
    checkFormulaPromotion(sandboxDir, makeUniversalEntry('e3')); // promotes
    const result = checkFormulaPromotion(sandboxDir, makeUniversalEntry('e4'));
    expect(result.promoted).toBe(false);
  });

  it('track entries (identity_mode != null) do not count towards formulas', () => {
    const trackEntry = makeEntry({
      id: 't1',
      kb_tier: 'track',
      dissection: {
        hook_type: '数字冲击',
        content_type: '种草类',
        identity_mode: 'esports',    // track — should be ignored
        emotion_arc: '',
        interaction_design: '',
        visual_style: '',
        cta_type: '',
        summary: '',
      },
    });
    const result = checkFormulaPromotion(sandboxDir, trackEntry);
    expect(result.promoted).toBe(false);
    expect(loadFormulas(sandboxDir)).toHaveLength(0);
  });
});

// ─── queryTrack ───────────────────────────────────────────────────────────────

describe('queryTrack', () => {
  function makeTrackEntry(id: string, platform: 'xhs' | 'douyin', identityMode: string): ViralEntry {
    return makeEntry({
      id,
      platform,
      kb_tier: 'track',
      dissection: {
        hook_type: '反问式',
        content_type: '情绪类',
        identity_mode: identityMode,
        emotion_arc: '共鸣',
        interaction_design: '投票',
        visual_style: '动感',
        cta_type: '评论',
        summary: '身份引共鸣',
      },
    });
  }

  beforeEach(() => {
    saveEntries(sandboxDir, [
      makeTrackEntry('t-xhs-esports', 'xhs', 'esports'),
      makeTrackEntry('t-douyin-esports', 'douyin', 'esports'),
      makeTrackEntry('t-xhs-racer', 'xhs', 'racer'),
      makeEntry({ id: 'u-universal', kb_tier: 'universal' }), // should be excluded
    ]);
  });

  it('filters by platform', () => {
    const result = queryTrack(sandboxDir, { platform: 'xhs' });
    expect(result.every(e => e.platform === 'xhs')).toBe(true);
    expect(result).toHaveLength(2);
  });

  it('filters by identity_mode', () => {
    const result = queryTrack(sandboxDir, { identity_mode: 'esports' });
    expect(result).toHaveLength(2);
    expect(result.every(e => e.dissection.identity_mode === 'esports')).toBe(true);
  });

  it('filters by platform + identity_mode', () => {
    const result = queryTrack(sandboxDir, { platform: 'xhs', identity_mode: 'esports' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('t-xhs-esports');
  });

  it('excludes universal entries', () => {
    const result = queryTrack(sandboxDir, {});
    expect(result.every(e => e.kb_tier === 'track')).toBe(true);
  });

  it('respects limit', () => {
    const result = queryTrack(sandboxDir, { limit: 1 });
    expect(result).toHaveLength(1);
  });
});

// ─── extractTriggerWords ────────────────────────────────────────────────────

describe('extractTriggerWords', () => {
  it('提取出现 ≥2 次的情绪词，按频率降序', () => {
    const titles = [
      '震惊！这个方法居然有效',
      '没想到结果这么震惊',
      '居然还有这种操作',
    ];
    const result = extractTriggerWords(titles, 2);
    expect(result).toContain('震惊');
    expect(result).toContain('居然');
    // 震惊 appears 2x, 居然 appears 2x
    expect(result).toHaveLength(2);
  });

  it('频率不足 minFreq 的词不返回', () => {
    const titles = [
      '太绝了这个视频',
      '另一个普通标题',
    ];
    const result = extractTriggerWords(titles, 2);
    expect(result).toHaveLength(0);
  });

  it('空标题列表返回空数组', () => {
    expect(extractTriggerWords([])).toEqual([]);
  });
});

// ─── checkFormulaPromotion with trigger_words ───────────────────────────────

describe('checkFormulaPromotion trigger_words 集成', () => {
  it('promotion 时从源条目提取 trigger_words', () => {
    // Create 3 entries with emotion words in titles
    const makeUniversal = (id: string, title: string): ViralEntry => makeEntry({
      id,
      title,
      dissection: {
        hook_type: '反问式',
        content_type: '情绪类',
        identity_mode: null,
        emotion_arc: '共鸣→爆发',
        interaction_design: '投票',
        visual_style: '动感',
        cta_type: '关注',
        summary: '情绪共鸣',
      },
      kb_tier: 'universal',
    });

    // Upsert entries first so they can be found by checkFormulaPromotion
    upsertEntry(sandboxDir, makeUniversal('e1', '震惊！居然这么做'));
    upsertEntry(sandboxDir, makeUniversal('e2', '震惊！没想到效果这么好'));
    upsertEntry(sandboxDir, makeUniversal('e3', '震惊！这也太离谱了'));

    checkFormulaPromotion(sandboxDir, makeUniversal('e1', '震惊！居然这么做'));
    checkFormulaPromotion(sandboxDir, makeUniversal('e2', '震惊！没想到效果这么好'));
    const result = checkFormulaPromotion(sandboxDir, makeUniversal('e3', '震惊！这也太离谱了'));

    expect(result.promoted).toBe(true);
    expect(result.formula?.trigger_words).toBeDefined();
    expect(result.formula?.trigger_words).toContain('震惊');
  });
});
