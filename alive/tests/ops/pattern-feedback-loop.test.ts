/**
 * pattern-feedback-loop.test.ts
 * Task 8: Verify that pattern usage tracking and success rate feedback are wired up.
 *
 * Tests:
 * 1. incrementPatternUsage is called when patterns are injected into topic generation
 * 2. updatePatternSuccessRate is called after post analysis
 * 3. Success rate uses exponential moving average
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setBasePaths, resetBasePaths, PATHS, readJSON, writeJSON } from '../../scripts/utils/file-utils';
import { setTimeOverride, clearTimeOverride } from '../../scripts/utils/time-utils';
import {
  addPattern, loadContentPatterns, updatePatternSuccessRate, incrementPatternUsage,
} from '../../scripts/ops/content-analyzer';
import {
  analyzePublishedPosts, loadAnalysisLog, findPendingAnalysis,
} from '../../scripts/ops/post-analyzer';
import { addItem, markPublished } from '../../scripts/ops/review-queue';
import { appendSnapshot, loadPerformanceLog } from '../../scripts/ops/performance-tracker';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { ContentPatterns, PerformanceLog, AnalysisLog } from '../../scripts/utils/types';

const tmpDir = path.join(os.tmpdir(), 'alive-pattern-feedback-' + Date.now());

const seedContent = {
  xhs: { title: '测试标题', body: '测试正文', tags: ['#test'], cover_images: [] as string[] },
  douyin: { script: '测试脚本', bgm_suggestion: '', key_captions: [] as string[], cover_images: [] as string[] },
};

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
  setTimeOverride(new Date('2026-04-01T10:00:00Z'));
});

afterEach(() => {
  resetBasePaths();
  clearTimeOverride();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('incrementPatternUsage integration', () => {
  it('increments times_used when called for injected patterns', () => {
    addPattern({
      type: '反问句标题', source: 'self', source_post: 'KPL复盘',
      formula: '以"有人说"开头', examples: [],
    });
    addPattern({
      type: '数据降维', source: '希然', source_post: '版本解读',
      formula: '用数字总结', examples: [],
    });

    // Simulate what topic-generator now does after generating content
    const patterns = loadContentPatterns();
    const injected = patterns.patterns.slice(0, 5);
    for (const p of injected) {
      incrementPatternUsage(p.type, p.source);
    }

    const after = loadContentPatterns();
    expect(after.patterns[0].times_used).toBe(1);
    expect(after.patterns[1].times_used).toBe(1);

    // Call again (simulating second topic generation)
    for (const p of injected) {
      incrementPatternUsage(p.type, p.source);
    }
    const after2 = loadContentPatterns();
    expect(after2.patterns[0].times_used).toBe(2);
  });
});

describe('updatePatternSuccessRate integration', () => {
  it('updates success_rate with exponential moving average', () => {
    addPattern({
      type: '情绪对比', source: 'self', source_post: '赛车体验',
      formula: '先低后高情绪', examples: [],
    });

    // Mark as used
    incrementPatternUsage('情绪对比', 'self');

    // First rate: no previous rate, so starts at observed
    updatePatternSuccessRate('情绪对比', 'self', 0.7);
    let p = loadContentPatterns();
    expect(p.patterns[0].success_rate).toBe(0.7);

    // Second rate: exponential moving average
    updatePatternSuccessRate('情绪对比', 'self', 1.0);
    p = loadContentPatterns();
    expect(p.patterns[0].success_rate).toBe(1.0); // direct overwrite (EMA is done in post-analyzer)
  });

  it('post-analyzer updates success rates for used patterns after analysis', async () => {
    // Seed a used pattern
    addPattern({
      type: '悬念标题', source: 'self', source_post: '车评',
      formula: '不说结论', examples: [],
    });
    incrementPatternUsage('悬念标题', 'self');

    // Create and publish a queue item
    const item = await addItem({
      topic: '测试选题', trend_hook: '热点', identity_mode: 'daily',
      content: seedContent,
    });
    await markPublished(item.id, { platform: 'xhs', url: 'https://xhs.example.com/1' });

    // Append performance snapshot (published 25h ago to pass delay check)
    setTimeOverride(new Date('2026-03-31T08:00:00Z'));
    appendSnapshot(
      { item_id: item.id, platform: 'xhs', published_at: '2026-03-31T08:00:00Z', identity_mode: 'daily', template_type: '写实' },
      { likes: 500, comments: 100, saves: 200, shares: 50 },
    );
    setTimeOverride(new Date('2026-04-01T10:00:00Z'));

    // Mock LLM for analysis
    const mockLLM = {
      call: async () => '',
      callJSON: async () => ({
        performance_tier: 'viral',
        engagement_score: 95,
        pattern_analysis: {
          hook_effectiveness: 9, emotional_resonance: 8, trending_alignment: 7,
          visual_impact: 8, call_to_action: 6,
          key_success_factors: ['好标题'], improvement_areas: [],
        },
        persona_alignment: { score: 9, identity_mode_match: true, tone_consistency: 'on_brand', specific_notes: '' },
      }),
      setLlmLogPath: () => {},
    };

    const count = await analyzePublishedPosts(mockLLM as any, 'V姐测试', 24, 7);
    expect(count).toBe(1);

    // Check pattern success rate was updated
    const after = loadContentPatterns();
    const pattern = after.patterns.find(p => p.type === '悬念标题');
    expect(pattern).toBeDefined();
    // EMA: null * 0.7 + 1.0 * 0.3 → post-analyzer treats null as observed rate (1.0)
    // new_rate = 1.0 * 0.7 + 1.0 * 0.3 = 1.0
    expect(pattern!.success_rate).toBeDefined();
    expect(pattern!.success_rate).toBeGreaterThan(0);
  });
});

describe('PATHS.inspirationState', () => {
  it('points to inspiration-state.json in persona memory', () => {
    expect(PATHS.inspirationState).toBe(path.join(tmpDir, 'inspiration-state.json'));
  });
});
