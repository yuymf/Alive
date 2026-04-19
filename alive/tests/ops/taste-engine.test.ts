/**
 * taste-engine.test.ts
 * Tests for the content taste memory engine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { setBasePaths, resetBasePaths, PATHS } from '../../scripts/utils/file-utils';
import {
  loadContentTaste,
  saveContentTaste,
  updateTasteFromAnalysis,
  buildTasteContext,
  runTasteDecay,
} from '../../scripts/ops/taste-engine';
import { ContentAnalysis, DEFAULT_CONTENT_TASTE, TastePreference } from '../../scripts/utils/types';

const TEST_DIR = path.join(__dirname, '__taste_test_sandbox__');

function makeAnalysis(overrides: Partial<ContentAnalysis> = {}): ContentAnalysis {
  return {
    item_id: 'test-001',
    analyzed_at: new Date().toISOString(),
    performance_tier: 'above_avg',
    engagement_score: 75,
    platform: 'xhs',
    identity_mode: 'esports',
    template_type: '赛场高燃瞬间',
    hook_angle: '反常识',
    topic_tags: ['赛事分析', '选手故事'],
    pattern_analysis: {
      hook_effectiveness: 8,
      emotional_resonance: 7,
      trending_alignment: 6,
      visual_impact: 8,
      call_to_action: 5,
      key_success_factors: ['反转式开头', '真实感表达'],
      improvement_areas: ['互动引导不足'],
    },
    extracted_patterns: [
      {
        pattern_type: '先抑后扬',
        description: '先说失败再翻转',
        applicable_templates: ['赛场高燃瞬间'],
        confidence: 0.85,
      },
    ],
    persona_alignment: {
      score: 8,
      identity_mode_match: true,
      tone_consistency: 'on_brand',
      specific_notes: '',
    },
    ...overrides,
  };
}

describe('taste-engine', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    setBasePaths(TEST_DIR, path.join(TEST_DIR, '_skills'));
  });

  afterEach(() => {
    resetBasePaths();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('loads default taste when no file exists', () => {
    const taste = loadContentTaste();
    expect(taste.visual_styles).toEqual([]);
    expect(taste.hook_formulas).toEqual([]);
    expect(taste.anti_patterns).toEqual([]);
    expect(taste.angle_preferences).toEqual([]);
    expect(taste.topic_preferences).toEqual([]);
    expect(taste.persona_mode_preferences).toEqual([]);
  });

  it('saves and loads taste', () => {
    const taste = { ...DEFAULT_CONTENT_TASTE, anti_patterns: ['过度卖萌'] };
    saveContentTaste(taste);
    const loaded = loadContentTaste();
    expect(loaded.anti_patterns).toEqual(['过度卖萌']);
    expect(loaded.last_updated).toBeTruthy();
  });

  it('updates taste from above_avg analysis', () => {
    const analysis = makeAnalysis({ performance_tier: 'above_avg' });
    updateTasteFromAnalysis(analysis);
    const taste = loadContentTaste();
    // Should have hook_formulas from key_success_factors + extracted_patterns
    expect(taste.hook_formulas.length).toBeGreaterThan(0);
    const labels = taste.hook_formulas.map(h => h.label);
    expect(labels).toContain('反转式开头');
    expect(labels).toContain('先抑后扬');
    // Visual style from template_type
    expect(taste.visual_styles.some(v => v.label === '赛场高燃瞬间')).toBe(true);
    // No anti-patterns for above_avg
    expect(taste.anti_patterns).toEqual([]);
  });

  it('adds anti-patterns from below_avg analysis', () => {
    const analysis = makeAnalysis({
      performance_tier: 'below_avg',
      pattern_analysis: {
        hook_effectiveness: 3,
        emotional_resonance: 3,
        trending_alignment: 2,
        visual_impact: 4,
        call_to_action: 2,
        key_success_factors: [],
        improvement_areas: ['标题缺乏吸引力', '内容太长节奏拖沓'],
      },
    });
    updateTasteFromAnalysis(analysis);
    const taste = loadContentTaste();
    expect(taste.anti_patterns).toContain('标题缺乏吸引力');
    expect(taste.anti_patterns).toContain('内容太长节奏拖沓');
  });

  it('uses EMA to smooth affinity when same label seen multiple times', () => {
    // First: viral
    updateTasteFromAnalysis(makeAnalysis({
      performance_tier: 'viral',
      pattern_analysis: {
        hook_effectiveness: 10, emotional_resonance: 10, trending_alignment: 10,
        visual_impact: 10, call_to_action: 10,
        key_success_factors: ['数据冲击'], improvement_areas: [],
      },
    }));
    const taste1 = loadContentTaste();
    const first = taste1.hook_formulas.find(h => h.label === '数据冲击')!;
    expect(first.affinity).toBe(1.0); // First observation = raw affinity

    // Second: below_avg — same label
    updateTasteFromAnalysis(makeAnalysis({
      performance_tier: 'below_avg',
      pattern_analysis: {
        hook_effectiveness: 3, emotional_resonance: 3, trending_alignment: 2,
        visual_impact: 2, call_to_action: 2,
        key_success_factors: ['数据冲击'], improvement_areas: [],
      },
    }));
    const taste2 = loadContentTaste();
    const second = taste2.hook_formulas.find(h => h.label === '数据冲击')!;
    // EMA: 1.0 * 0.7 + (-0.5) * 0.3 = 0.55
    expect(second.affinity).toBeCloseTo(0.55, 1);
    expect(second.sample_count).toBe(2);
  });

  it('buildTasteContext returns empty when insufficient data', () => {
    expect(buildTasteContext()).toBe('');
  });

  it('buildTasteContext includes strong preferences', () => {
    // Manually set up taste with enough data
    saveContentTaste({
      visual_styles: [{ label: '赛场高燃', affinity: 0.8, sample_count: 5, last_updated: new Date().toISOString() }],
      hook_formulas: [
        { label: '反转式开头', affinity: 0.9, sample_count: 4, last_updated: new Date().toISOString() },
        { label: '数据冲击', affinity: 0.7, sample_count: 3, last_updated: new Date().toISOString() },
      ],
      tone_preferences: [],
      engagement_drivers: [],
      angle_preferences: [],
      topic_preferences: [],
      persona_mode_preferences: [],
      anti_patterns: ['过度卖萌', '标题太长'],
      last_updated: '',
    });

    const ctx = buildTasteContext();
    expect(ctx).toContain('网感偏好');
    expect(ctx).toContain('反转式开头');
    expect(ctx).toContain('赛场高燃');
    expect(ctx).toContain('过度卖萌');
  });

  // ── New dimension tests: angle, topic, persona_mode ──

  it('tracks angle preferences from hook_angle', () => {
    const analysis = makeAnalysis({
      performance_tier: 'viral',
      hook_angle: '冲突对比',
    });
    updateTasteFromAnalysis(analysis);
    const taste = loadContentTaste();
    const angle = taste.angle_preferences.find(a => a.label === '冲突对比');
    expect(angle).toBeDefined();
    expect(angle!.affinity).toBe(1.0); // viral = 1.0
    expect(angle!.sample_count).toBe(1);
  });

  it('tracks topic preferences from topic_tags', () => {
    const analysis = makeAnalysis({
      performance_tier: 'above_avg',
      topic_tags: ['赛事复盘', '战术拆解'],
    });
    updateTasteFromAnalysis(analysis);
    const taste = loadContentTaste();
    const topicLabels = taste.topic_preferences.map(t => t.label);
    expect(topicLabels).toContain('赛事复盘');
    expect(topicLabels).toContain('战术拆解');
    // above_avg affinity = 0.6
    for (const t of taste.topic_preferences) {
      expect(t.affinity).toBe(0.6);
    }
  });

  it('tracks persona mode preferences from identity_mode', () => {
    const analysis = makeAnalysis({
      performance_tier: 'viral',
      identity_mode: 'lifestyle',
    });
    updateTasteFromAnalysis(analysis);
    const taste = loadContentTaste();
    const mode = taste.persona_mode_preferences.find(m => m.label === 'lifestyle');
    expect(mode).toBeDefined();
    expect(mode!.affinity).toBe(1.0);
  });

  it('does not add angle preference when hook_angle is missing', () => {
    const analysis = makeAnalysis({ hook_angle: undefined });
    updateTasteFromAnalysis(analysis);
    const taste = loadContentTaste();
    expect(taste.angle_preferences).toEqual([]);
  });

  it('does not add topic preferences when topic_tags is empty', () => {
    const analysis = makeAnalysis({ topic_tags: undefined });
    updateTasteFromAnalysis(analysis);
    const taste = loadContentTaste();
    expect(taste.topic_preferences).toEqual([]);
  });

  it('buildTasteContext includes angle and topic preferences', () => {
    saveContentTaste({
      visual_styles: [],
      hook_formulas: [],
      tone_preferences: [],
      engagement_drivers: [],
      angle_preferences: [
        { label: '反常识', affinity: 0.9, sample_count: 5, last_updated: new Date().toISOString() },
        { label: '共鸣式', affinity: 0.7, sample_count: 3, last_updated: new Date().toISOString() },
      ],
      topic_preferences: [
        { label: '赛事分析', affinity: 0.8, sample_count: 4, last_updated: new Date().toISOString() },
      ],
      persona_mode_preferences: [
        { label: 'esports', affinity: 0.85, sample_count: 6, last_updated: new Date().toISOString() },
      ],
      anti_patterns: [],
      last_updated: '',
    });

    const ctx = buildTasteContext();
    expect(ctx).toContain('高效角度');
    expect(ctx).toContain('反常识');
    expect(ctx).toContain('共鸣式');
    expect(ctx).toContain('热门话题');
    expect(ctx).toContain('赛事分析');
    expect(ctx).toContain('人设偏好');
    expect(ctx).toContain('esports');
  });

  // ── Decay & Eviction tests ──

  it('evicts preferences not updated for 30+ days', () => {
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    const taste: typeof DEFAULT_CONTENT_TASTE = {
      ...DEFAULT_CONTENT_TASTE,
      hook_formulas: [
        { label: '旧偏好', affinity: 0.9, sample_count: 5, last_updated: thirtyOneDaysAgo },
        { label: '新偏好', affinity: 0.8, sample_count: 3, last_updated: recent },
      ],
    };

    const result = runTasteDecay(taste);
    const labels = result.hook_formulas.map(h => h.label);
    expect(labels).not.toContain('旧偏好');
    expect(labels).toContain('新偏好');
  });

  it('applies decay to preferences not updated for 14+ days', () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    const taste: typeof DEFAULT_CONTENT_TASTE = {
      ...DEFAULT_CONTENT_TASTE,
      angle_preferences: [
        { label: '衰减中', affinity: 0.9, sample_count: 5, last_updated: twentyDaysAgo },
        { label: '新鲜的', affinity: 0.8, sample_count: 3, last_updated: recent },
      ],
    };

    const result = runTasteDecay(taste);
    const decaying = result.angle_preferences.find(a => a.label === '衰减中')!;
    const fresh = result.angle_preferences.find(a => a.label === '新鲜的')!;
    // 20 days since update, 6 days of decay: affinity * 0.9^6
    const expectedDecayedAffinity = 0.9 * Math.pow(0.9, 6);
    expect(decaying.affinity).toBeCloseTo(expectedDecayedAffinity, 3);
    expect(fresh.affinity).toBe(0.8); // No decay
  });

  it('evicts low-sample low-affinity preferences', () => {
    const recent = new Date().toISOString();
    const taste: typeof DEFAULT_CONTENT_TASTE = {
      ...DEFAULT_CONTENT_TASTE,
      topic_preferences: [
        { label: '噪声话题', affinity: 0.05, sample_count: 1, last_updated: recent },
        { label: '有效话题', affinity: 0.8, sample_count: 1, last_updated: recent },
        { label: '负向话题', affinity: -0.3, sample_count: 1, last_updated: recent },
      ],
    };

    const result = runTasteDecay(taste);
    const labels = result.topic_preferences.map(t => t.label);
    // sample_count < 2 AND affinity < 0.1 → evicted
    expect(labels).not.toContain('噪声话题');
    expect(labels).not.toContain('负向话题');
    // affinity 0.8 is above 0.1 threshold even with sample_count=1
    expect(labels).toContain('有效话题');
  });

  it('decay pass runs automatically during updateTasteFromAnalysis', () => {
    // Create a stale preference that should be evicted
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    saveContentTaste({
      ...DEFAULT_CONTENT_TASTE,
      hook_formulas: [
        { label: '过期偏好', affinity: 0.9, sample_count: 5, last_updated: thirtyOneDaysAgo },
      ],
    });

    // Update should trigger decay
    updateTasteFromAnalysis(makeAnalysis({
      performance_tier: 'viral',
      pattern_analysis: {
        hook_effectiveness: 10, emotional_resonance: 10, trending_alignment: 10,
        visual_impact: 10, call_to_action: 10,
        key_success_factors: ['新偏好'], improvement_areas: [],
      },
    }));

    const taste = loadContentTaste();
    const labels = taste.hook_formulas.map(h => h.label);
    expect(labels).not.toContain('过期偏好');
    expect(labels).toContain('新偏好');
  });
});
