import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setBasePaths, resetBasePaths, writeJSON, PATHS } from '../../scripts/utils/file-utils';
import { setTimeOverride } from '../../scripts/utils/time-utils';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ContentAnalysis, PerformanceTier } from '../../scripts/utils/types';

const tmpDir = path.join(os.tmpdir(), 'alive-strategy-test-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
  setTimeOverride(new Date('2026-04-07T08:00:00Z')); // Monday morning
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeAnalysis(overrides: Partial<ContentAnalysis>): ContentAnalysis {
  return {
    item_id: 'q_test',
    analyzed_at: '2026-04-05T12:00:00Z',
    performance_tier: 'normal',
    engagement_score: 50,
    platform: 'xhs',
    identity_mode: 'esports',
    template_type: '赛场高燃瞬间',
    pattern_analysis: {
      hook_effectiveness: 5, emotional_resonance: 5, trending_alignment: 5,
      visual_impact: 5, call_to_action: 5,
      key_success_factors: [], improvement_areas: [],
    },
    persona_alignment: {
      score: 7, identity_mode_match: true,
      tone_consistency: 'on_brand', specific_notes: '',
    },
    ...overrides,
  };
}

describe('computeTierDistribution', () => {
  it('should count entries per tier', async () => {
    const { computeTierDistribution } = await import('../../scripts/ops/strategy-engine');
    const entries: ContentAnalysis[] = [
      makeAnalysis({ performance_tier: 'viral' }),
      makeAnalysis({ performance_tier: 'above_avg' }),
      makeAnalysis({ performance_tier: 'normal' }),
      makeAnalysis({ performance_tier: 'normal' }),
      makeAnalysis({ performance_tier: 'below_avg' }),
    ];
    const dist = computeTierDistribution(entries);
    expect(dist).toEqual({ viral: 1, above_avg: 1, normal: 2, below_avg: 1 });
  });
});

describe('computeContentMix', () => {
  it('should compute percentage by identity_mode', async () => {
    const { computeContentMix } = await import('../../scripts/ops/strategy-engine');
    const entries: ContentAnalysis[] = [
      makeAnalysis({ identity_mode: 'esports' }),
      makeAnalysis({ identity_mode: 'esports' }),
      makeAnalysis({ identity_mode: 'singer' }),
      makeAnalysis({ identity_mode: 'daily' }),
    ];
    const mix = computeContentMix(entries);
    expect(mix.esports).toBe(50);
    expect(mix.singer).toBe(25);
    expect(mix.daily).toBe(25);
  });
});

describe('findBestWorstTemplate', () => {
  it('should find best and worst performing templates by avg score', async () => {
    const { findBestWorstTemplate } = await import('../../scripts/ops/strategy-engine');
    const entries: ContentAnalysis[] = [
      makeAnalysis({ template_type: 'A', engagement_score: 90 }),
      makeAnalysis({ template_type: 'A', engagement_score: 80 }),
      makeAnalysis({ template_type: 'B', engagement_score: 30 }),
      makeAnalysis({ template_type: 'B', engagement_score: 20 }),
    ];
    const { best, worst } = findBestWorstTemplate(entries);
    expect(best).toBe('A');
    expect(worst).toBe('B');
  });
});
