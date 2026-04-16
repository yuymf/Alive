import { describe, it, expect } from 'vitest';
import { checkDiversity, filterByDiversity } from '../../scripts/ops/diversity-gate';
import type { FilteredTrend } from '../../scripts/ops/trend-analyzer';
import type { QueueItem, IdentityMode } from '../../scripts/utils/types';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTrend(overrides?: Partial<FilteredTrend>): FilteredTrend {
  return {
    keyword: '测试关键词',
    platform: 'xhs',
    velocity_score: 2.0,
    priority_score: 80,
    hook_angle: '从痛点切入',
    identity_mode: 'lifestyle',
    source_bucket: 'hot',
    ...overrides,
  };
}

function makeQueueItem(overrides?: Partial<QueueItem>): QueueItem {
  return {
    id: 'test-1',
    status: 'pending',
    topic: '蹭 测试关键词：从痛点切入',
    trend_hook: '测试关键词 (xhs, 2.0x)',
    identity_mode: 'lifestyle',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    content: {
      xhs: { title: '', body: '', tags: [], cover_images: [] },
      douyin: { script: '', bgm_suggestion: '', key_captions: [], cover_images: [] },
    },
    edit_history: [],
    ...overrides,
  };
}

// ─── checkDiversity ─────────────────────────────────────────────────────────

describe('checkDiversity', () => {
  it('passes when no recent items exist', () => {
    const verdict = checkDiversity(makeTrend(), 'lifestyle', []);
    expect(verdict.pass).toBe(true);
  });

  it('blocks exact keyword duplicate in same identity mode', () => {
    const items = [makeQueueItem()];
    const verdict = checkDiversity(makeTrend(), 'lifestyle', items);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('重复关键词');
  });

  it('allows same keyword in different identity mode', () => {
    // Queue item has keyword '电竞关键词' in esports mode with different hook_angle
    const items = [makeQueueItem({
      identity_mode: 'esports',
      trend_hook: '电竞关键词 (xhs, 2.0x)',
      topic: '蹭 电竞关键词：赛事解读',
    })];
    const verdict = checkDiversity(
      makeTrend({ keyword: '电竞关键词', hook_angle: '情感共鸣' }),
      'lifestyle',
      items,
    );
    // Keyword dedup requires SAME identity_mode, so different mode should pass
    expect(verdict.pass).toBe(true);
  });

  it('blocks when identity mode is saturated', () => {
    const items = Array.from({ length: 4 }, (_, i) =>
      makeQueueItem({
        id: `item-${i}`,
        trend_hook: `关键词${i} (xhs, 2.0x)`,
        topic: `蹭 关键词${i}：角度${i}`,
        identity_mode: 'lifestyle',
      }),
    );
    const verdict = checkDiversity(makeTrend({ keyword: '全新关键词' }), 'lifestyle', items, { maxSameModeInWindow: 3 });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('身份');
  });

  it('blocks when last 3 items use same template type', () => {
    // Use different keywords so keyword dedup doesn't trigger first
    const items = Array.from({ length: 3 }, (_, i) =>
      makeQueueItem({
        id: `tpl-${i}`,
        trend_hook: `模板测试${i} (xhs, 2.0x)`,
        topic: `蹭 模板测试${i}：角度${i}`,
        identity_mode: 'esports', // different mode from our trend
        template_spec: { content_type: 'listicle' },
      }),
    );
    const verdict = checkDiversity(
      makeTrend({ keyword: '全新话题', identity_mode: 'esports' }),
      'esports',
      items,
      { maxSameModeInWindow: 10 }, // don't trigger mode saturation
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('模板');
  });

  it('blocks hook angle with high Jaccard similarity', () => {
    // Use nearly-identical angles to trigger Jaccard > 0.5
    const items = [makeQueueItem({
      id: 'angle-test-1',
      trend_hook: '另一个关键词 (xhs, 2.0x)',
      topic: '蹭 另一个关键词：从痛点切入深度分析视角',
      identity_mode: 'tech',
    })];
    const verdict = checkDiversity(
      makeTrend({ keyword: '全新词', hook_angle: '从痛点切入深度分析角度', identity_mode: 'tech' }),
      'tech',
      items,
      { minAngleDistance: 0.5, maxSameModeInWindow: 10 },
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('切入角度');
  });

  it('allows dissimilar hook angles', () => {
    const items = [makeQueueItem({
      trend_hook: '另一个关键词 (xhs, 2.0x)',
      topic: '蹭 另一个关键词：对比评测三款产品',
      identity_mode: 'tech',
    })];
    const verdict = checkDiversity(
      makeTrend({ keyword: '全新词', hook_angle: '深夜情感独白', identity_mode: 'tech' }),
      'tech',
      items,
      { maxSameModeInWindow: 10 },
    );
    expect(verdict.pass).toBe(true);
  });
});

// ─── filterByDiversity ──────────────────────────────────────────────────────

describe('filterByDiversity', () => {
  it('passes all trends when no conflicts', () => {
    const trends = [
      makeTrend({ keyword: '关键词A', hook_angle: '角度A' }),
      makeTrend({ keyword: '关键词B', hook_angle: '角度B' }),
    ];
    const result = filterByDiversity(trends, [], () => 'lifestyle');
    expect(result).toHaveLength(2);
  });

  it('filters out trends that conflict with queue history', () => {
    const trends = [
      makeTrend({ keyword: '已存在', hook_angle: '角度' }),
      makeTrend({ keyword: '新的', hook_angle: '新角度' }),
    ];
    const items = [makeQueueItem({ trend_hook: '已存在 (xhs, 2.0x)', identity_mode: 'lifestyle' })];
    const result = filterByDiversity(trends, items, () => 'lifestyle');
    expect(result).toHaveLength(1);
    expect(result[0].keyword).toBe('新的');
  });

  it('provides intra-batch diversity (same batch trends block each other)', () => {
    const trends = [
      makeTrend({ keyword: '重复词', hook_angle: '角度1' }),
      makeTrend({ keyword: '重复词', hook_angle: '角度2' }),
    ];
    const result = filterByDiversity(trends, [], () => 'lifestyle');
    // Second one should be blocked by first (same keyword, same mode in same batch)
    expect(result).toHaveLength(1);
  });

  // ── ensureMinimum (default: true) ──────────────────────────────────────

  it('ensureMinimum=true: falls back to first trend when all filtered out', () => {
    // 4 pending items with same mode → all new trends with same mode will be blocked
    const items = Array.from({ length: 4 }, (_, i) =>
      makeQueueItem({
        id: `sat-${i}`,
        trend_hook: `饱和词${i} (xhs, 2.0x)`,
        topic: `蹭 饱和词${i}：角度${i}`,
        identity_mode: 'esports',
      }),
    );
    const trends = [
      makeTrend({ keyword: '电竞选题1', identity_mode: 'esports' }),
      makeTrend({ keyword: '电竞选题2', identity_mode: 'esports' }),
    ];
    // Default ensureMinimum=true: should return at least 1
    const result = filterByDiversity(trends, items, (t) => t.identity_mode as IdentityMode, { maxSameModeInWindow: 3 });
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].keyword).toBe('电竞选题1');
  });

  it('ensureMinimum=false: returns empty when all filtered out', () => {
    const items = Array.from({ length: 4 }, (_, i) =>
      makeQueueItem({
        id: `sat-${i}`,
        trend_hook: `饱和词${i} (xhs, 2.0x)`,
        topic: `蹭 饱和词${i}：角度${i}`,
        identity_mode: 'esports',
      }),
    );
    const trends = [
      makeTrend({ keyword: '电竞选题1', identity_mode: 'esports' }),
    ];
    const result = filterByDiversity(trends, items, (t) => t.identity_mode as IdentityMode, { maxSameModeInWindow: 3, ensureMinimum: false });
    expect(result).toHaveLength(0);
  });

  // ── relaxedForDirection ────────────────────────────────────────────────

  it('relaxedForDirection=true: uses higher maxSameModeInWindow threshold', () => {
    // 4 pending esports items → would block at default maxSameMode=3
    // but relaxedForDirection raises it to 5, so it should pass
    const items = Array.from({ length: 4 }, (_, i) =>
      makeQueueItem({
        id: `dir-${i}`,
        trend_hook: `方向词${i} (xhs, 2.0x)`,
        topic: `蹭 方向词${i}：角度${i}`,
        identity_mode: 'esports',
      }),
    );
    const trends = [
      makeTrend({ keyword: '新电竞选题', identity_mode: 'esports', hook_angle: '全新角度解读' }),
    ];
    const result = filterByDiversity(trends, items, (t) => t.identity_mode as IdentityMode, { relaxedForDirection: true });
    expect(result).toHaveLength(1);
  });
});
