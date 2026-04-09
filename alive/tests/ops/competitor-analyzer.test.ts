import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setBasePaths, resetBasePaths } from '../../scripts/utils/file-utils';
import {
  buildAnalysisPrompt,
  parseAnalysisResponse,
  MIN_POSTS_FOR_ANALYSIS,
} from '../../scripts/ops/competitor-analyzer';
import type { CompetitorProfile, CompetitorPost } from '../../scripts/utils/types';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const tmpDir = path.join(os.tmpdir(), 'alive-competitor-analyzer-test-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const mockProfile: CompetitorProfile = {
  name: 'TestAccount',
  platform: 'xhs',
  tag: '电竞解说',
  tag_desc: '专注电竞内容',
  reference_type: 'primary',
};

const makePosts = (n: number): CompetitorPost[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `post_${i}`,
    title: `帖子标题${i}`,
    engagement: (i + 1) * 100,
    posted_at: '2026-04-01T00:00:00.000Z',
  }));

describe('MIN_POSTS_FOR_ANALYSIS', () => {
  it('is 5', () => {
    expect(MIN_POSTS_FOR_ANALYSIS).toBe(5);
  });
});

describe('buildAnalysisPrompt', () => {
  it('includes account name and platform', () => {
    const posts = makePosts(5);
    const prompt = buildAnalysisPrompt(mockProfile, posts);
    expect(prompt).toContain('TestAccount');
    expect(prompt).toContain('xhs');
  });

  it('includes post titles and engagement in numbered list', () => {
    const posts = makePosts(3);
    const prompt = buildAnalysisPrompt(mockProfile, posts);
    expect(prompt).toContain('帖子标题0');
    expect(prompt).toContain('100');
  });

  it('includes formula field in hook_patterns JSON schema', () => {
    const posts = makePosts(5);
    const prompt = buildAnalysisPrompt(mockProfile, posts);
    expect(prompt).toContain('"formula"');
  });

  it('includes placeholder syntax in formula field description', () => {
    const posts = makePosts(5);
    const prompt = buildAnalysisPrompt(mockProfile, posts);
    // The prompt should instruct the LLM to use [占位符] bracket syntax
    expect(prompt).toContain('[占位符]');
  });

  it('includes content_mix section when profile has content_mix', () => {
    const profileWithMix: CompetitorProfile = {
      ...mockProfile,
      content_mix: { '电竞解说': 60, '生活日常': 40 },
    };
    const prompt = buildAnalysisPrompt(profileWithMix, makePosts(5));
    expect(prompt).toContain('电竞解说');
    expect(prompt).toContain('60%');
  });

  it('includes audience when present', () => {
    const profileWithAudience: CompetitorProfile = {
      ...mockProfile,
      audience: '18-25岁电竞爱好者',
    };
    const prompt = buildAnalysisPrompt(profileWithAudience, makePosts(5));
    expect(prompt).toContain('18-25岁电竞爱好者');
  });
});

describe('parseAnalysisResponse', () => {
  const validRaw = JSON.stringify({
    hook_patterns: [
      {
        pattern: '数字冲击型',
        formula: '[数字]个[身份]不会告诉你的[场景]秘密',
        examples: ['3个电竞选手不会告诉你的训练秘密'],
        frequency: '高',
      },
    ],
    cover_formulas: [],
    topic_clusters: [
      { cluster_name: '训练技巧', post_count: 5, avg_engagement: 500, representative_titles: ['标题1'] },
    ],
    engagement_pattern: {
      best_performing_type: '技巧分享',
      avg_engagement: 500,
      posting_frequency: '每天1条',
      peak_days: ['周一', '周三'],
    },
    key_insight: '核心洞察文字',
  });

  it('parses a valid JSON response', () => {
    const result = parseAnalysisResponse(validRaw, 'TestAccount', 'xhs');
    expect(result).not.toBeNull();
    expect(result?.account_name).toBe('TestAccount');
    expect(result?.platform).toBe('xhs');
  });

  it('strips markdown fences before parsing', () => {
    const fenced = '```json\n' + validRaw + '\n```';
    const result = parseAnalysisResponse(fenced, 'TestAccount', 'xhs');
    expect(result).not.toBeNull();
  });

  it('preserves formula field in hook_patterns', () => {
    const result = parseAnalysisResponse(validRaw, 'TestAccount', 'xhs');
    expect(result?.hook_patterns[0].formula).toBe('[数字]个[身份]不会告诉你的[场景]秘密');
  });

  it('defaults formula to empty string when missing from LLM output', () => {
    const rawWithoutFormula = JSON.stringify({
      hook_patterns: [{ pattern: '某类型', examples: ['例子'], frequency: '中' }],
      topic_clusters: [],
      engagement_pattern: { best_performing_type: '', avg_engagement: 0, posting_frequency: '', peak_days: [] },
      key_insight: '洞察',
    });
    const result = parseAnalysisResponse(rawWithoutFormula, 'TestAccount', 'xhs');
    expect(result?.hook_patterns[0].formula).toBe('');
  });

  it('defaults frequency to 低 when missing', () => {
    const rawWithoutFreq = JSON.stringify({
      hook_patterns: [{ pattern: '某类型', formula: '句式', examples: [] }],
      topic_clusters: [],
      engagement_pattern: { best_performing_type: '', avg_engagement: 0, posting_frequency: '', peak_days: [] },
      key_insight: '洞察',
    });
    const result = parseAnalysisResponse(rawWithoutFreq, 'TestAccount', 'xhs');
    expect(result?.hook_patterns[0].frequency).toBe('低');
  });

  it('returns null for missing required fields', () => {
    const incomplete = JSON.stringify({ hook_patterns: [] });
    expect(parseAnalysisResponse(incomplete, 'Acc', 'xhs')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseAnalysisResponse('not json at all', 'Acc', 'xhs')).toBeNull();
  });

  it('overrides analyzed_at with current time', () => {
    const before = Date.now();
    const result = parseAnalysisResponse(validRaw, 'TestAccount', 'xhs');
    const after = Date.now();
    const analyzed = new Date(result!.analyzed_at).getTime();
    expect(analyzed).toBeGreaterThanOrEqual(before);
    expect(analyzed).toBeLessThanOrEqual(after);
  });
});
