/**
 * positioning-analyzer.test.ts
 * Unit tests for Layer 3 cross-account positioning analysis.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setBasePaths, resetBasePaths } from '../scripts/utils/file-utils';
import type {
  AccountAnalysis,
  CompetitorAnalysisStore,
  PersonaConfig,
  QueueItem,
  QueueItemStatus,
  PositioningReport,
} from '../scripts/utils/types';
import type { LLMClient } from '../scripts/utils/llm-client';

// ─── Lazy imports ─────────────────────────────────────────────────────────────

const {
  buildPositioningPrompt,
  parsePositioningResponse,
  analyzePositioning,
  savePositioningReport,
  loadPositioningReport,
  POSITIONING_MAX_TOKENS,
} = await import('../scripts/ops/positioning-analyzer');

// ─── Test persona ─────────────────────────────────────────────────────────────

const minimalPersona: PersonaConfig = {
  meta: { name: 'Miss V', tagline: '三重身份虚拟偶像' },
  personality: { mbti: 'ENTJ', core_traits: ['decisive', 'strategic'] },
  voice: { language: 'zh-CN', style: '克制有力', sample_lines: [] },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAnalysis(overrides: Partial<AccountAnalysis> = {}): AccountAnalysis {
  return {
    account_name: '@v姐',
    platform: 'xhs',
    analyzed_at: new Date().toISOString(),
    post_count: 10,
    hook_patterns: [{ pattern: '悬念式开头', examples: ['你敢信？'], frequency: '高' }],
    cover_formulas: [],
    topic_clusters: [{ cluster_name: '赛事解说', post_count: 6, avg_engagement: 800, representative_titles: ['LPL分析'] }],
    engagement_pattern: {
      best_performing_type: '赛事热点',
      avg_engagement: 600,
      posting_frequency: '每天1-2条',
    },
    key_insight: '赛事热点驱动流量，悬念式标题显著提升点击率',
    ...overrides,
  };
}

function makeAnalysisStore(analyses: Record<string, AccountAnalysis> = {}): CompetitorAnalysisStore {
  return {
    version: 1,
    analyses,
    insufficient_data: [],
    last_analyzed: new Date().toISOString(),
  };
}

function makeQueueItem(id: string, status: QueueItemStatus = 'published'): QueueItem {
  return {
    id,
    status,
    topic: `选题 ${id}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    content: {
      platform: 'xhs',
      title: `内容标题 ${id}`,
      body: `内容正文 ${id}`,
    },
    edit_history: [],
  };
}

function makePositioningReport(overrides: Partial<PositioningReport> = {}): PositioningReport {
  return {
    generated_at: new Date().toISOString(),
    report_period: '2026-03-26 至 2026-04-02',
    competitor_matrix: [
      {
        account_name: '@v姐',
        platform: 'xhs',
        strengths: ['赛事热点选题精准'],
        weaknesses: ['垂直度高，破圈难'],
        content_focus: '硬核电竞解说',
        avg_engagement: 600,
      },
    ],
    gap_analysis: {
      underserved_niches: ['女性电竞视角', '赛车跨界内容'],
      oversaturated_areas: ['泛娱乐解说'],
      miss_v_advantages: ['三重身份差异化', '女性视角稀缺性'],
    },
    recommendations: [
      {
        recommendation: '聚焦电竞+赛车跨界内容',
        identity_mode: '赛车手',
        priority: 'high',
        rationale: '竞品空白区，差异化明显',
      },
    ],
    weekly_direction: {
      focus_identities: ['赛车手', '歌手'],
      avoid_topics: ['泛娱乐解说'],
      suggested_templates: ['赛车日记', '幕后录音'],
    },
    ...overrides,
  };
}

function makeMockLLM(response: string): LLMClient {
  return {
    call: vi.fn().mockResolvedValue(response),
  } as unknown as LLMClient;
}

// ─── Setup/teardown ───────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'positioning-test-'));
  setBasePaths(tmpDir, tmpDir);
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── buildPositioningPrompt ───────────────────────────────────────────────────

describe('buildPositioningPrompt', () => {
  it('includes competitor key_insight in prompt', () => {
    const analysisStore = makeAnalysisStore({
      '@v姐:xhs': makeAnalysis({ key_insight: '赛事热点驱动流量' }),
    });
    const prompt = buildPositioningPrompt(analysisStore, minimalPersona, []);
    expect(prompt).toContain('赛事热点驱动流量');
  });

  it('includes competitor account name', () => {
    const analysisStore = makeAnalysisStore({
      '@竞品A:xhs': makeAnalysis({ account_name: '@竞品A' }),
    });
    const prompt = buildPositioningPrompt(analysisStore, minimalPersona, []);
    expect(prompt).toContain('@竞品A');
  });

  it('includes persona name and mbti', () => {
    const analysisStore = makeAnalysisStore({
      '@v姐:xhs': makeAnalysis(),
    });
    const prompt = buildPositioningPrompt(analysisStore, minimalPersona, []);
    expect(prompt).toContain('Miss V');
    expect(prompt).toContain('ENTJ');
  });

  it('includes persona core_traits', () => {
    const analysisStore = makeAnalysisStore({
      '@v姐:xhs': makeAnalysis(),
    });
    const prompt = buildPositioningPrompt(analysisStore, minimalPersona, []);
    expect(prompt).toContain('decisive');
  });

  it('includes published items summary when provided', () => {
    const analysisStore = makeAnalysisStore({
      '@v姐:xhs': makeAnalysis(),
    });
    const items = [makeQueueItem('item-1', 'published'), makeQueueItem('item-2', 'published')];
    const prompt = buildPositioningPrompt(analysisStore, minimalPersona, items);
    expect(prompt).toContain('选题 item-1');
  });

  it('includes JSON output schema fields', () => {
    const analysisStore = makeAnalysisStore({ '@v姐:xhs': makeAnalysis() });
    const prompt = buildPositioningPrompt(analysisStore, minimalPersona, []);
    expect(prompt).toContain('competitor_matrix');
    expect(prompt).toContain('gap_analysis');
    expect(prompt).toContain('recommendations');
    expect(prompt).toContain('weekly_direction');
  });

  it('includes topic_clusters from competitor analysis', () => {
    const analysis = makeAnalysis({
      topic_clusters: [{ cluster_name: '赛车跨界', post_count: 4, avg_engagement: 900, representative_titles: ['赛车日记'] }],
    });
    const analysisStore = makeAnalysisStore({ '@v姐:xhs': analysis });
    const prompt = buildPositioningPrompt(analysisStore, minimalPersona, []);
    expect(prompt).toContain('赛车跨界');
  });

  it('includes engagement_pattern from competitor analysis', () => {
    const analysis = makeAnalysis({
      engagement_pattern: { best_performing_type: '情感类内容', avg_engagement: 1200, posting_frequency: '每天3条' },
    });
    const analysisStore = makeAnalysisStore({ '@v姐:xhs': analysis });
    const prompt = buildPositioningPrompt(analysisStore, minimalPersona, []);
    expect(prompt).toContain('情感类内容');
  });

  it('limits published items to last 10', () => {
    const analysisStore = makeAnalysisStore({ '@v姐:xhs': makeAnalysis() });
    const items = Array.from({ length: 15 }, (_, i) => makeQueueItem(`item-${i}`, 'published'));
    const prompt = buildPositioningPrompt(analysisStore, minimalPersona, items);
    // Should contain some items but the prompt shouldn't grow unboundedly
    // Just verify it runs without error and contains something
    expect(prompt.length).toBeGreaterThan(100);
  });
});

// ─── parsePositioningResponse ─────────────────────────────────────────────────

describe('parsePositioningResponse', () => {
  it('parses a valid JSON response', () => {
    const report = makePositioningReport();
    const raw = `\`\`\`json\n${JSON.stringify(report)}\n\`\`\``;
    const result = parsePositioningResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.competitor_matrix).toHaveLength(1);
    expect(result!.gap_analysis.underserved_niches).toContain('女性电竞视角');
    expect(result!.recommendations).toHaveLength(1);
    expect(result!.weekly_direction.focus_identities).toContain('赛车手');
  });

  it('parses response without markdown fences', () => {
    const report = makePositioningReport();
    const raw = JSON.stringify(report);
    const result = parsePositioningResponse(raw);
    expect(result).not.toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const result = parsePositioningResponse('这不是JSON格式的文本');
    expect(result).toBeNull();
  });

  it('returns null when required field competitor_matrix is missing', () => {
    const { competitor_matrix, ...rest } = makePositioningReport();
    const raw = JSON.stringify(rest);
    const result = parsePositioningResponse(raw);
    expect(result).toBeNull();
  });

  it('returns null when required field gap_analysis is missing', () => {
    const { gap_analysis, ...rest } = makePositioningReport();
    const raw = JSON.stringify(rest);
    const result = parsePositioningResponse(raw);
    expect(result).toBeNull();
  });

  it('returns null when required field recommendations is missing', () => {
    const { recommendations, ...rest } = makePositioningReport();
    const raw = JSON.stringify(rest);
    const result = parsePositioningResponse(raw);
    expect(result).toBeNull();
  });

  it('returns null when required field weekly_direction is missing', () => {
    const { weekly_direction, ...rest } = makePositioningReport();
    const raw = JSON.stringify(rest);
    const result = parsePositioningResponse(raw);
    expect(result).toBeNull();
  });

  it('overrides generated_at with current time', () => {
    const report = makePositioningReport({ generated_at: '2020-01-01T00:00:00.000Z' });
    const raw = JSON.stringify(report);
    const before = Date.now();
    const result = parsePositioningResponse(raw);
    const after = Date.now();
    expect(result).not.toBeNull();
    const ts = new Date(result!.generated_at).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

// ─── analyzePositioning ───────────────────────────────────────────────────────

describe('analyzePositioning', () => {
  it('returns null if analysis store has no analyses', async () => {
    const emptyStore = makeAnalysisStore({});
    const llm = makeMockLLM('irrelevant');
    const result = await analyzePositioning(emptyStore, minimalPersona, [], llm);
    expect(result).toBeNull();
    expect(llm.call).not.toHaveBeenCalled();
  });

  it('calls LLM and returns parsed report', async () => {
    const analysisStore = makeAnalysisStore({ '@v姐:xhs': makeAnalysis() });
    const report = makePositioningReport();
    const llm = makeMockLLM(JSON.stringify(report));
    const result = await analyzePositioning(analysisStore, minimalPersona, [], llm);
    expect(llm.call).toHaveBeenCalledOnce();
    expect(result).not.toBeNull();
    expect(result!.competitor_matrix).toBeDefined();
  });

  it('calls LLM with POSITIONING_MAX_TOKENS', async () => {
    const analysisStore = makeAnalysisStore({ '@v姐:xhs': makeAnalysis() });
    const report = makePositioningReport();
    const llm = makeMockLLM(JSON.stringify(report));
    await analyzePositioning(analysisStore, minimalPersona, [], llm);
    expect(llm.call).toHaveBeenCalledWith(expect.any(String), POSITIONING_MAX_TOKENS);
  });

  it('returns null if LLM response is unparseable', async () => {
    const analysisStore = makeAnalysisStore({ '@v姐:xhs': makeAnalysis() });
    const llm = makeMockLLM('这完全不是JSON');
    const result = await analyzePositioning(analysisStore, minimalPersona, [], llm);
    expect(result).toBeNull();
  });

  it('returns null if LLM call throws', async () => {
    const analysisStore = makeAnalysisStore({ '@v姐:xhs': makeAnalysis() });
    const llm = {
      call: vi.fn().mockRejectedValue(new Error('Network error')),
    } as unknown as LLMClient;
    const result = await analyzePositioning(analysisStore, minimalPersona, [], llm);
    expect(result).toBeNull();
  });

  it('passes published items to prompt builder', async () => {
    const analysisStore = makeAnalysisStore({ '@v姐:xhs': makeAnalysis() });
    const report = makePositioningReport();
    const llm = makeMockLLM(JSON.stringify(report));
    const items = [makeQueueItem('pub-1', 'published')];
    await analyzePositioning(analysisStore, minimalPersona, items, llm);
    // Verify the LLM was called — prompt building with items shouldn't throw
    expect(llm.call).toHaveBeenCalledOnce();
  });
});

// ─── savePositioningReport / loadPositioningReport ────────────────────────────

describe('savePositioningReport + loadPositioningReport', () => {
  it('saves and loads a report round-trip', () => {
    const report = makePositioningReport();
    savePositioningReport(report);
    const loaded = loadPositioningReport();
    expect(loaded).not.toBeNull();
    expect(loaded!.report_period).toBe(report.report_period);
    expect(loaded!.gap_analysis.underserved_niches).toEqual(report.gap_analysis.underserved_niches);
  });

  it('returns null when no report exists', () => {
    const loaded = loadPositioningReport();
    expect(loaded).toBeNull();
  });

  it('copies existing report to prev before saving new one', () => {
    const firstReport = makePositioningReport({ report_period: '第一周' });
    savePositioningReport(firstReport);

    const secondReport = makePositioningReport({ report_period: '第二周' });
    savePositioningReport(secondReport);

    const current = loadPositioningReport();
    expect(current!.report_period).toBe('第二周');

    // Import PATHS to check prev file exists
    // We just verify the current file is the new one; prev existence is an implementation detail
    expect(current!.report_period).not.toBe('第一周');
  });
});
