/**
 * taste-engine.test.ts
 * Tests for the content taste memory engine.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { setBasePaths, resetBasePaths, PATHS } from '../../scripts/utils/file-utils';
import {
  loadContentTaste,
  saveContentTaste,
  updateTasteFromAnalysis,
  buildTasteContext,
} from '../../scripts/ops/taste-engine';
import { ContentAnalysis, DEFAULT_CONTENT_TASTE } from '../../scripts/utils/types';

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
      visual_styles: [{ label: '赛场高燃', affinity: 0.8, sample_count: 5, last_updated: '' }],
      hook_formulas: [
        { label: '反转式开头', affinity: 0.9, sample_count: 4, last_updated: '' },
        { label: '数据冲击', affinity: 0.7, sample_count: 3, last_updated: '' },
      ],
      tone_preferences: [],
      engagement_drivers: [],
      anti_patterns: ['过度卖萌', '标题太长'],
      last_updated: '',
    });

    const ctx = buildTasteContext();
    expect(ctx).toContain('网感偏好');
    expect(ctx).toContain('反转式开头');
    expect(ctx).toContain('赛场高燃');
    expect(ctx).toContain('过度卖萌');
  });
});
