import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setBasePaths, resetBasePaths } from '../../scripts/utils/file-utils';
import { setTimeOverride } from '../../scripts/utils/time-utils';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { PerformanceLog, PerformanceEntry, ReviewQueue } from '../../scripts/utils/types';

const tmpDir = path.join(os.tmpdir(), 'alive-post-analyzer-test-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
  setTimeOverride(new Date('2026-04-02T12:00:00Z'));
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('computeEngagementScore', () => {
  it('should compute XHS engagement score with correct weights', async () => {
    const { computeEngagementScore } = await import('../../scripts/ops/post-analyzer');
    const score = computeEngagementScore(
      { likes: 100, comments: 50, saves: 30, views: 10000 },
      'xhs',
    );
    // XHS: likes*1.0 + comments*3.0 + saves*5.0 + shares*4.0
    // = 100 + 150 + 150 + 0 = 400
    expect(score).toBe(400);
  });

  it('should compute Douyin engagement score with views weight', async () => {
    const { computeEngagementScore } = await import('../../scripts/ops/post-analyzer');
    const score = computeEngagementScore(
      { likes: 100, comments: 50, saves: 30, views: 10000, shares: 20 },
      'douyin',
    );
    // Douyin: likes*1.0 + comments*2.0 + saves*3.0 + shares*5.0 + views*0.01
    // = 100 + 100 + 90 + 100 + 100 = 490
    expect(score).toBe(490);
  });
});

describe('classifyTier', () => {
  it('should classify as viral when score > baseline * 2.0', async () => {
    const { classifyTier } = await import('../../scripts/ops/post-analyzer');
    expect(classifyTier(210, 100)).toBe('viral');
  });

  it('should classify as above_avg when score > baseline * 1.3', async () => {
    const { classifyTier } = await import('../../scripts/ops/post-analyzer');
    expect(classifyTier(140, 100)).toBe('above_avg');
  });

  it('should classify as normal when score >= baseline * 0.7', async () => {
    const { classifyTier } = await import('../../scripts/ops/post-analyzer');
    expect(classifyTier(80, 100)).toBe('normal');
  });

  it('should classify as below_avg when score < baseline * 0.7', async () => {
    const { classifyTier } = await import('../../scripts/ops/post-analyzer');
    expect(classifyTier(60, 100)).toBe('below_avg');
  });

  it('should use flat baseline of 50 when no baseline data', async () => {
    const { classifyTier } = await import('../../scripts/ops/post-analyzer');
    expect(classifyTier(110, 0)).toBe('viral'); // 110 > 50 * 2.0
  });
});

// ─── Task 4: Baseline & Pending Detection ────────────────────────────────────

function makePerformanceEntry(overrides: Partial<PerformanceEntry> & { item_id: string }): PerformanceEntry {
  return {
    identity_mode: 'esports',
    template_type: '赛场高燃瞬间',
    topic: 'test topic',
    platform: 'xhs',
    url: 'https://example.com',
    published_at: '2026-03-30T10:00:00Z',
    snapshots: [{ fetched_at: '2026-04-01T10:00:00Z', metrics: { likes: 100, comments: 50 } }],
    peak_metrics: { likes: 100, comments: 50 },
    tags_used: [],
    ...overrides,
  };
}

describe('computeBaseline', () => {
  it('should compute average engagement over window', async () => {
    const { computeBaseline } = await import('../../scripts/ops/post-analyzer');
    const entries: PerformanceEntry[] = [
      makePerformanceEntry({ item_id: 'a', platform: 'xhs', published_at: '2026-03-28T10:00:00Z' }),
      makePerformanceEntry({
        item_id: 'b', platform: 'xhs', published_at: '2026-03-29T10:00:00Z',
        peak_metrics: { likes: 200, comments: 100 },
      }),
    ];
    // Entry a: 100*1 + 50*3 = 250
    // Entry b: 200*1 + 100*3 = 500
    // avg = 375
    const baseline = computeBaseline(entries, 'xhs', 7);
    expect(baseline).toBe(375);
  });

  it('should return 0 when no entries in window', async () => {
    const { computeBaseline } = await import('../../scripts/ops/post-analyzer');
    expect(computeBaseline([], 'xhs', 7)).toBe(0);
  });
});

describe('findPendingAnalysis', () => {
  it('should find entries published >= 24h ago not yet analyzed', async () => {
    const { findPendingAnalysis } = await import('../../scripts/ops/post-analyzer');
    const perfLog: PerformanceLog = {
      entries: [
        makePerformanceEntry({ item_id: 'old', published_at: '2026-03-31T08:00:00Z' }),
        makePerformanceEntry({ item_id: 'recent', published_at: '2026-04-02T11:00:00Z' }),
      ],
      last_updated: '',
    };
    const analysisLog = { entries: [], last_updated: '' };

    // At 2026-04-02T12:00:00Z, 'old' is >24h, 'recent' is only 1h
    const pending = findPendingAnalysis(perfLog, analysisLog, 24);
    expect(pending).toHaveLength(1);
    expect(pending[0].item_id).toBe('old');
  });

  it('should exclude already-analyzed entries', async () => {
    const { findPendingAnalysis } = await import('../../scripts/ops/post-analyzer');
    const perfLog: PerformanceLog = {
      entries: [makePerformanceEntry({ item_id: 'done', published_at: '2026-03-30T08:00:00Z' })],
      last_updated: '',
    };
    const analysisLog = {
      entries: [{ item_id: 'done', analyzed_at: '2026-04-01T08:00:00Z' } as any],
      last_updated: '',
    };

    const pending = findPendingAnalysis(perfLog, analysisLog, 24);
    expect(pending).toHaveLength(0);
  });
});

// ─── Task 5: LLM Prompt Building & Response Parsing ──────────────────────────

describe('buildPostAnalysisPrompt', () => {
  it('should include content text, metrics, and persona context', async () => {
    const { buildPostAnalysisPrompt } = await import('../../scripts/ops/post-analyzer');
    const prompt = buildPostAnalysisPrompt({
      contentText: '电竞女孩的一天',
      platform: 'xhs',
      metrics: { likes: 5000, comments: 200, saves: 300 },
      templateType: '赛场高燃瞬间',
      identityMode: 'esports',
      baseline: 500,
      personaSummary: 'V姐：ENTJ三栖虚拟偶像',
    });
    expect(prompt).toContain('电竞女孩的一天');
    expect(prompt).toContain('5000');
    expect(prompt).toContain('赛场高燃瞬间');
    expect(prompt).toContain('V姐');
    expect(prompt).toContain('performance_tier');
  });
});

describe('parseAnalysisResponse', () => {
  it('should parse valid LLM response into ContentAnalysis', async () => {
    const { parseAnalysisResponse } = await import('../../scripts/ops/post-analyzer');
    const llmResponse = {
      performance_tier: 'viral',
      engagement_score: 85,
      pattern_analysis: {
        hook_effectiveness: 9,
        emotional_resonance: 8,
        trending_alignment: 7,
        visual_impact: 8,
        call_to_action: 6,
        key_success_factors: ['反转标题', '情绪共鸣'],
        improvement_areas: ['互动引导弱'],
      },
      extracted_patterns: [{
        pattern_type: '反转式开头',
        description: '先说反面观点再翻转',
        applicable_templates: ['赛场高燃瞬间'],
        confidence: 0.8,
      }],
      persona_alignment: {
        score: 9,
        identity_mode_match: true,
        tone_consistency: 'on_brand',
        specific_notes: '完全符合ENTJ强势风格',
      },
    };

    const result = parseAnalysisResponse(llmResponse, {
      item_id: 'q_123',
      platform: 'xhs',
      identity_mode: 'esports',
      template_type: '赛场高燃瞬间',
    });

    expect(result.item_id).toBe('q_123');
    expect(result.performance_tier).toBe('viral');
    expect(result.pattern_analysis.hook_effectiveness).toBe(9);
    expect(result.extracted_patterns).toHaveLength(1);
    expect(result.persona_alignment.score).toBe(9);
    expect(result.analyzed_at).toBeTruthy();
  });

  it('should handle missing optional fields gracefully', async () => {
    const { parseAnalysisResponse } = await import('../../scripts/ops/post-analyzer');
    const minimal = {
      performance_tier: 'normal',
      engagement_score: 50,
      pattern_analysis: {
        hook_effectiveness: 5, emotional_resonance: 5, trending_alignment: 5,
        visual_impact: 5, call_to_action: 5,
        key_success_factors: ['ok'], improvement_areas: ['could improve'],
      },
      persona_alignment: {
        score: 7, identity_mode_match: true,
        tone_consistency: 'on_brand', specific_notes: 'fine',
      },
    };

    const result = parseAnalysisResponse(minimal, {
      item_id: 'q_456', platform: 'douyin',
      identity_mode: 'singer', template_type: 'MV片段',
    });

    expect(result.extracted_patterns).toBeUndefined();
    expect(result.performance_tier).toBe('normal');
  });
});
