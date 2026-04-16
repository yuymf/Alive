import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  updatePreferenceFromFeedback,
  loadPreference,
  savePreference,
  buildPreferenceContext,
  DEFAULT_PREFERENCE_PROFILE,
} from '../../scripts/ops/operator-preference';
import { setBasePaths, resetBasePaths } from '../../scripts/utils/file-utils';
import type { QueueItem, QueueItemReviewFeedback } from '../../scripts/utils/types';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const tmpDir = path.join(os.tmpdir(), 'alive-op-pref-test-' + Date.now());

function makeItem(overrides?: Partial<QueueItem>): QueueItem {
  return {
    id: 'pref-test-1',
    status: 'approved',
    topic: '测试选题',
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

function makeFeedback(overrides?: Partial<QueueItemReviewFeedback>): QueueItemReviewFeedback {
  return {
    decision: 'approved',
    source: 'dashboard',
    reason_summary: '语气到位',
    persona_deviation_tags: [],
    risk_tags: [],
    ...overrides,
  };
}

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
  // Start with clean profile
  savePreference({ ...DEFAULT_PREFERENCE_PROFILE, last_updated: '' });
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('updatePreferenceFromFeedback', () => {
  it('adds preferred angle on approval', () => {
    const item = makeItem();
    const feedback = makeFeedback({ decision: 'approved', reason_summary: '情绪共鸣强' });
    updatePreferenceFromFeedback(item, feedback);

    const profile = loadPreference();
    expect(profile.preferred_angles).toHaveLength(1);
    expect(profile.preferred_angles[0].label).toBe('情绪共鸣强');
    expect(profile.preferred_angles[0].affinity).toBeGreaterThan(0);
  });

  it('adds avoided topic on discard', () => {
    const item = makeItem();
    const feedback = makeFeedback({ decision: 'discarded', reason_summary: '标题党' });
    updatePreferenceFromFeedback(item, feedback);

    const profile = loadPreference();
    expect(profile.avoided_topics).toHaveLength(1);
    expect(profile.avoided_topics[0].label).toBe('标题党');
  });

  it('adds edit directions on edit_requested', () => {
    const item = makeItem();
    const feedback = makeFeedback({
      decision: 'edit_requested',
      improvement_directions: ['标题要更抓人', '增加数据支撑'],
    });
    updatePreferenceFromFeedback(item, feedback);

    const profile = loadPreference();
    expect(profile.common_edit_directions).toHaveLength(2);
  });

  it('updates identity mode affinity on approval', () => {
    const item = makeItem({ identity_mode: 'esports' });
    const feedback = makeFeedback({ decision: 'approved' });
    updatePreferenceFromFeedback(item, feedback);

    const profile = loadPreference();
    expect(profile.identity_mode_affinity).toHaveLength(1);
    expect(profile.identity_mode_affinity[0].label).toBe('esports');
    expect(profile.identity_mode_affinity[0].affinity).toBeGreaterThan(0);
  });

  it('deduplicates labels with fuzzy matching (punctuation/whitespace)', () => {
    const item = makeItem();

    // First feedback
    updatePreferenceFromFeedback(item, makeFeedback({ decision: 'approved', reason_summary: '标题抓人' }));
    // Same meaning, slightly different formatting
    updatePreferenceFromFeedback(item, makeFeedback({ decision: 'approved', reason_summary: '标题、抓人' }));

    const profile = loadPreference();
    // Should merge into one signal, not two
    expect(profile.preferred_angles).toHaveLength(1);
    expect(profile.preferred_angles[0].sample_count).toBe(2);
    // Keeps the longer label
    expect(profile.preferred_angles[0].label).toBe('标题、抓人');
  });

  it('applies EMA smoothing on repeated signals', () => {
    const item = makeItem();
    updatePreferenceFromFeedback(item, makeFeedback({ decision: 'approved', reason_summary: '共鸣感' }));
    const after1 = loadPreference().preferred_angles[0].affinity;

    // Second approval with same label: EMA(0.7) = 0.3*0.7 + 0.7*0.7 = 0.7 (converges)
    updatePreferenceFromFeedback(item, makeFeedback({ decision: 'approved', reason_summary: '共鸣感' }));
    const after2 = loadPreference().preferred_angles[0].affinity;

    // Verify EMA formula holds
    const expected = 0.3 * 0.7 + 0.7 * after1;
    expect(after2).toBeCloseTo(expected, 4);

    // Discard on a different label adds to avoided_topics, not to preferred_angles
    // Verify sample_count increased
    expect(loadPreference().preferred_angles[0].sample_count).toBe(2);
  });

  it('records tone corrections from persona_deviation_tags', () => {
    const item = makeItem();
    updatePreferenceFromFeedback(item, makeFeedback({
      decision: 'discarded',
      persona_deviation_tags: ['tone-too-formal', 'brand-voice'],
    }));

    const profile = loadPreference();
    expect(profile.tone_corrections).toContain('tone-too-formal');
    expect(profile.tone_corrections).toContain('brand-voice');
  });
});

describe('buildPreferenceContext', () => {
  it('returns empty string on cold start', () => {
    const ctx = buildPreferenceContext();
    expect(ctx).toBe('');
  });

  it('returns formatted context when preferences exist', () => {
    const item = makeItem();
    updatePreferenceFromFeedback(item, makeFeedback({ decision: 'approved', reason_summary: '共鸣强' }));
    updatePreferenceFromFeedback(item, makeFeedback({ decision: 'discarded', reason_summary: '标题党' }));

    const ctx = buildPreferenceContext();
    expect(ctx).toContain('运营偏好画像');
    expect(ctx).toContain('共鸣强');
    expect(ctx).toContain('标题党');
  });

  it('respects maxAngles/maxAvoid limits', () => {
    const item = makeItem();
    for (let i = 0; i < 5; i++) {
      updatePreferenceFromFeedback(item, makeFeedback({ decision: 'approved', reason_summary: `方向${i}` }));
    }

    const ctx = buildPreferenceContext({ maxAngles: 2 });
    // Should only include top 2
    const matches = ctx.match(/方向\d/g);
    expect(matches).toHaveLength(2);
  });
});
