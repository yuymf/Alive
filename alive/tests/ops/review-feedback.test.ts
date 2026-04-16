import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setBasePaths, resetBasePaths } from '../../scripts/utils/file-utils';
import { setTimeOverride } from '../../scripts/utils/time-utils';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  addItem, getItem, addReviewFeedback, getRecentReviewLearning,
  markApproved, markDiscarded,
} from '../../scripts/ops/review-queue';

const tmpDir = path.join(os.tmpdir(), 'alive-review-feedback-test-' + Date.now());

function seedQueueItem(overrides?: Record<string, unknown>) {
  return {
    topic: '电竞赛事解读',
    trend_hook: '#KPL春季赛 (douyin, 2.1x)',
    identity_mode: 'esports',
    content: {
      xhs: { title: 'test title', body: 'test body', tags: ['#电竞'], cover_images: [] },
      douyin: { script: 'test script', bgm_suggestion: 'none', key_captions: [], cover_images: [] },
    },
    ...overrides,
  };
}

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
  setTimeOverride(new Date('2026-04-16T10:00:00Z'));
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('addReviewFeedback', () => {
  it('stores structured approve feedback on queue item', async () => {
    const item = await addItem(seedQueueItem());
    const updated = await addReviewFeedback(item.id, {
      decision: 'approved',
      source: 'dashboard',
      reason_summary: '语气已贴近 V 姐，可直接发',
      persona_deviation_tags: [],
      risk_tags: [],
      platform_fit_tags: ['xhs-ready'],
    });

    expect(updated).not.toBeNull();
    expect(updated!.review_feedback).toHaveLength(1);
    expect(updated!.review_feedback![0].decision).toBe('approved');
    expect(updated!.review_feedback![0].platform_fit_tags).toContain('xhs-ready');
    expect(updated!.latest_review_summary).toContain('可直接发');
  });

  it('stores structured discard feedback with reason and tags', async () => {
    const item = await addItem(seedQueueItem());
    const updated = await addReviewFeedback(item.id, {
      decision: 'discarded',
      source: 'chat',
      reason_summary: '语气太像品牌稿，不像 V 姐本人',
      persona_deviation_tags: ['tone-too-formal', 'brand-voice'],
      risk_tags: ['persona-drift'],
      improvement_directions: ['更口语化', '加入 V 姐的毒舌金句'],
    });

    expect(updated).not.toBeNull();
    expect(updated!.review_feedback![0].decision).toBe('discarded');
    expect(updated!.review_feedback![0].persona_deviation_tags).toContain('tone-too-formal');
    expect(updated!.review_feedback![0].improvement_directions).toContain('更口语化');
    expect(updated!.latest_review_summary).toContain('品牌稿');
  });

  it('appends multiple feedback entries without overwriting', async () => {
    const item = await addItem(seedQueueItem());
    await addReviewFeedback(item.id, {
      decision: 'edit_requested',
      source: 'chat',
      reason_summary: '标题太平',
    });
    const updated = await addReviewFeedback(item.id, {
      decision: 'approved',
      source: 'chat',
      reason_summary: '修改后通过',
    });

    expect(updated!.review_feedback).toHaveLength(2);
    expect(updated!.review_feedback![0].decision).toBe('edit_requested');
    expect(updated!.review_feedback![1].decision).toBe('approved');
    expect(updated!.latest_review_summary).toBe('修改后通过');
  });

  it('returns null for unknown item id', async () => {
    const result = await addReviewFeedback('nonexistent', {
      decision: 'approved',
      source: 'dashboard',
      reason_summary: 'test',
    });
    expect(result).toBeNull();
  });

  it('works alongside markApproved without conflict', async () => {
    const item = await addItem(seedQueueItem());
    await markApproved(item.id);
    const updated = await addReviewFeedback(item.id, {
      decision: 'approved',
      source: 'dashboard',
      reason_summary: '前三秒冲突够强，可发',
    });

    expect(updated!.status).toBe('approved');
    expect(updated!.review_feedback).toHaveLength(1);
  });
});

describe('getRecentReviewLearning', () => {
  it('aggregates reasons and tags from recent items', async () => {
    const item1 = await addItem(seedQueueItem({ topic: '话题1' }));
    await addReviewFeedback(item1.id, {
      decision: 'approved',
      source: 'chat',
      reason_summary: '语气到位',
      platform_fit_tags: ['xhs-ready'],
    });

    const item2 = await addItem(seedQueueItem({ topic: '话题2', trend_hook: '话题2 hook' }));
    await addReviewFeedback(item2.id, {
      decision: 'discarded',
      source: 'dashboard',
      reason_summary: '抖音前三秒太弱',
      persona_deviation_tags: ['hook-too-weak'],
      risk_tags: ['low-retention'],
      improvement_directions: ['加强冲突开头'],
    });

    const learning = await getRecentReviewLearning();

    expect(learning.approveReasons).toContain('语气到位');
    expect(learning.discardReasons).toContain('抖音前三秒太弱');
    expect(learning.commonDeviationTags).toContain('hook-too-weak');
    expect(learning.commonRiskTags).toContain('low-retention');
    expect(learning.improvementDirections).toContain('加强冲突开头');
  });

  it('returns empty aggregates when no feedback exists', async () => {
    const learning = await getRecentReviewLearning();
    expect(learning.approveReasons).toEqual([]);
    expect(learning.discardReasons).toEqual([]);
    expect(learning.commonDeviationTags).toEqual([]);
  });
});
