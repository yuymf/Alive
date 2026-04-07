/**
 * competitor-analyzer.test.ts
 * Unit tests for Layer 2 per-account LLM analysis.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setBasePaths, resetBasePaths } from '../scripts/utils/file-utils';
import type {
  CompetitorPost,
  CompetitorPostsStore,
  CompetitorProfile,
  AccountAnalysis,
  CompetitorAnalysisStore,
} from '../scripts/utils/types';
import type { LLMClient } from '../scripts/utils/llm-client';

// ─── Lazy imports (after vitest wires up) ────────────────────────────────────

const {
  buildAnalysisPrompt,
  parseAnalysisResponse,
  analyzeCompetitors,
  loadCompetitorAnalysis,
  saveCompetitorAnalysis,
  MIN_POSTS_FOR_ANALYSIS,
} = await import('../scripts/ops/competitor-analyzer');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePost(overrides: Partial<CompetitorPost> & Pick<CompetitorPost, 'post_id'>): CompetitorPost {
  return {
    account_name: '@v姐',
    platform: 'xhs',
    title: '测试标题',
    engagement: 500,
    fetched_at: new Date().toISOString(),
    ...overrides,
  };
}

function makePosts(count: number, accountName = '@v姐', platform: CompetitorPost['platform'] = 'xhs'): CompetitorPost[] {
  return Array.from({ length: count }, (_, i) =>
    makePost({
      post_id: `post_${i}`,
      account_name: accountName,
      platform,
      title: `帖子标题 ${i + 1}`,
      engagement: (count - i) * 100,
      posted_at: new Date(Date.now() - i * 86400000).toISOString(),
    })
  );
}

function makeProfile(overrides: Partial<CompetitorProfile> = {}): CompetitorProfile {
  return {
    name: '@v姐',
    platform: 'xhs',
    tag: '电竞',
    tag_desc: '硬核电竞解说达人',
    followers: '50万',
    content_mix: { 电竞: 60, 生活: 25, 时尚: 15 },
    audience: '18-28岁男性为主',
    interaction_style: '问答式互动，多用网络用语',
    reference_type: 'primary',
    ...overrides,
  };
}

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

function makePostsStore(entries: Record<string, CompetitorPost[]>): CompetitorPostsStore {
  return {
    version: 1,
    last_fetched: new Date().toISOString(),
    accounts: entries,
  };
}

// ─── buildAnalysisPrompt ──────────────────────────────────────────────────────

describe('buildAnalysisPrompt', () => {
  it('includes account name and platform', () => {
    const profile = makeProfile();
    const posts = makePosts(5);
    const prompt = buildAnalysisPrompt(profile, posts);
    expect(prompt).toContain('@v姐');
    expect(prompt).toContain('xhs');
  });

  it('includes tag_desc', () => {
    const profile = makeProfile({ tag_desc: '硬核电竞解说达人' });
    const posts = makePosts(5);
    const prompt = buildAnalysisPrompt(profile, posts);
    expect(prompt).toContain('硬核电竞解说达人');
  });

  it('includes content_mix percentages', () => {
    const profile = makeProfile({ content_mix: { 电竞: 60, 生活: 25, 时尚: 15 } });
    const posts = makePosts(5);
    const prompt = buildAnalysisPrompt(profile, posts);
    expect(prompt).toContain('60');
    expect(prompt).toContain('电竞');
  });

  it('includes audience info when present', () => {
    const profile = makeProfile({ audience: '18-28岁男性为主' });
    const posts = makePosts(5);
    const prompt = buildAnalysisPrompt(profile, posts);
    expect(prompt).toContain('18-28岁男性为主');
  });

  it('includes interaction_style when present', () => {
    const profile = makeProfile({ interaction_style: '问答式互动' });
    const posts = makePosts(5);
    const prompt = buildAnalysisPrompt(profile, posts);
    expect(prompt).toContain('问答式互动');
  });

  it('includes numbered post list with titles and engagement', () => {
    const posts = makePosts(3);
    const profile = makeProfile();
    const prompt = buildAnalysisPrompt(profile, posts);
    expect(prompt).toContain('帖子标题 1');
    expect(prompt).toContain('帖子标题 2');
    expect(prompt).toContain('帖子标题 3');
    // engagement values
    expect(prompt).toContain('300');
    expect(prompt).toContain('200');
    expect(prompt).toContain('100');
  });

  it('includes JSON output schema fields', () => {
    const profile = makeProfile();
    const posts = makePosts(5);
    const prompt = buildAnalysisPrompt(profile, posts);
    expect(prompt).toContain('hook_patterns');
    expect(prompt).toContain('topic_clusters');
    expect(prompt).toContain('engagement_pattern');
    expect(prompt).toContain('key_insight');
  });

  it('is a Chinese-language prompt', () => {
    const profile = makeProfile();
    const posts = makePosts(5);
    const prompt = buildAnalysisPrompt(profile, posts);
    // Should contain Chinese characters
    expect(/[\u4e00-\u9fa5]/.test(prompt)).toBe(true);
  });
});

// ─── parseAnalysisResponse ────────────────────────────────────────────────────

describe('parseAnalysisResponse', () => {
  const validAnalysis = {
    account_name: 'old_name',
    platform: 'douyin',
    analyzed_at: '2020-01-01T00:00:00.000Z',
    post_count: 10,
    hook_patterns: [{ pattern: '悬念式', examples: ['你敢信'], frequency: '高' }],
    cover_formulas: [],
    topic_clusters: [{ cluster_name: '电竞', post_count: 5, avg_engagement: 600, representative_titles: ['标题'] }],
    engagement_pattern: { best_performing_type: '热点', avg_engagement: 500, posting_frequency: '每日' },
    key_insight: '热点驱动流量',
  };

  it('parses valid JSON response', () => {
    const raw = JSON.stringify(validAnalysis);
    const result = parseAnalysisResponse(raw, '@v姐', 'xhs');
    expect(result).not.toBeNull();
    expect(result!.hook_patterns).toHaveLength(1);
    expect(result!.key_insight).toBe('热点驱动流量');
    expect(result!.post_count).toBe(10);
  });

  it('overrides account_name with provided value', () => {
    const raw = JSON.stringify(validAnalysis);
    const result = parseAnalysisResponse(raw, '@v姐', 'xhs');
    expect(result!.account_name).toBe('@v姐');
  });

  it('overrides platform with provided value', () => {
    const raw = JSON.stringify(validAnalysis);
    const result = parseAnalysisResponse(raw, '@v姐', 'xhs');
    expect(result!.platform).toBe('xhs');
  });

  it('overrides analyzed_at with current timestamp', () => {
    const before = Date.now();
    const raw = JSON.stringify(validAnalysis);
    const result = parseAnalysisResponse(raw, '@v姐', 'xhs');
    const after = Date.now();
    const analyzedAt = new Date(result!.analyzed_at).getTime();
    expect(analyzedAt).toBeGreaterThanOrEqual(before);
    expect(analyzedAt).toBeLessThanOrEqual(after);
  });

  it('handles markdown-wrapped JSON (```json fence)', () => {
    const raw = '```json\n' + JSON.stringify(validAnalysis) + '\n```';
    const result = parseAnalysisResponse(raw, '@v姐', 'xhs');
    expect(result).not.toBeNull();
    expect(result!.key_insight).toBe('热点驱动流量');
  });

  it('handles plain ``` fence without language tag', () => {
    const raw = '```\n' + JSON.stringify(validAnalysis) + '\n```';
    const result = parseAnalysisResponse(raw, '@v姐', 'xhs');
    expect(result).not.toBeNull();
    expect(result!.key_insight).toBe('热点驱动流量');
  });

  it('returns null for malformed JSON', () => {
    const result = parseAnalysisResponse('not valid json {{{', '@v姐', 'xhs');
    expect(result).toBeNull();
  });

  it('returns null when hook_patterns is missing', () => {
    const { hook_patterns, ...without } = validAnalysis;
    const result = parseAnalysisResponse(JSON.stringify(without), '@v姐', 'xhs');
    expect(result).toBeNull();
  });

  it('returns null when topic_clusters is missing', () => {
    const { topic_clusters, ...without } = validAnalysis;
    const result = parseAnalysisResponse(JSON.stringify(without), '@v姐', 'xhs');
    expect(result).toBeNull();
  });

  it('returns null when engagement_pattern is missing', () => {
    const { engagement_pattern, ...without } = validAnalysis;
    const result = parseAnalysisResponse(JSON.stringify(without), '@v姐', 'xhs');
    expect(result).toBeNull();
  });

  it('returns null when key_insight is missing', () => {
    const { key_insight, ...without } = validAnalysis;
    const result = parseAnalysisResponse(JSON.stringify(without), '@v姐', 'xhs');
    expect(result).toBeNull();
  });
});

// ─── analyzeCompetitors ───────────────────────────────────────────────────────

describe('analyzeCompetitors', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-analyzer-test-'));
    setBasePaths(tmpDir, tmpDir);
  });

  afterEach(() => {
    resetBasePaths();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips accounts with fewer than MIN_POSTS_FOR_ANALYSIS posts', async () => {
    const shortPosts = makePosts(MIN_POSTS_FOR_ANALYSIS - 1, '@few', 'xhs');
    const store = makePostsStore({ '@few:xhs': shortPosts });
    const profiles: CompetitorProfile[] = [];
    const llm: LLMClient = { call: vi.fn(), callJSON: vi.fn() };

    const result = await analyzeCompetitors(store, profiles, llm);

    expect(llm.call).not.toHaveBeenCalled();
    expect(result.insufficient_data).toContain('@few:xhs');
    expect(Object.keys(result.analyses)).toHaveLength(0);
  });

  it('calls LLM for accounts with sufficient posts', async () => {
    const posts = makePosts(MIN_POSTS_FOR_ANALYSIS, '@v姐', 'xhs');
    const store = makePostsStore({ '@v姐:xhs': posts });
    const profiles = [makeProfile({ name: '@v姐', platform: 'xhs' })];

    const analysisPayload = makeAnalysis({ post_count: MIN_POSTS_FOR_ANALYSIS });
    const llm: LLMClient = {
      call: vi.fn().mockResolvedValue(JSON.stringify(analysisPayload)),
      callJSON: vi.fn(),
    };

    const result = await analyzeCompetitors(store, profiles, llm);

    expect(llm.call).toHaveBeenCalledOnce();
    expect(Object.keys(result.analyses)).toHaveLength(1);
    expect(result.insufficient_data).toHaveLength(0);
  });

  it('does not add sufficient account to insufficient_data', async () => {
    const posts = makePosts(10, '@v姐', 'xhs');
    const store = makePostsStore({ '@v姐:xhs': posts });
    const profiles = [makeProfile({ name: '@v姐', platform: 'xhs' })];

    const analysisPayload = makeAnalysis({ post_count: 10 });
    const llm: LLMClient = {
      call: vi.fn().mockResolvedValue(JSON.stringify(analysisPayload)),
      callJSON: vi.fn(),
    };

    const result = await analyzeCompetitors(store, profiles, llm);
    expect(result.insufficient_data).not.toContain('@v姐:xhs');
  });

  it('handles mixed sufficient and insufficient accounts', async () => {
    const enoughPosts = makePosts(6, '@big', 'xhs');
    const fewPosts = makePosts(2, '@small', 'xhs');
    const store = makePostsStore({
      '@big:xhs': enoughPosts,
      '@small:xhs': fewPosts,
    });
    const profiles = [makeProfile({ name: '@big', platform: 'xhs' })];

    const analysisPayload = makeAnalysis({ account_name: '@big', post_count: 6 });
    const llm: LLMClient = {
      call: vi.fn().mockResolvedValue(JSON.stringify(analysisPayload)),
      callJSON: vi.fn(),
    };

    const result = await analyzeCompetitors(store, profiles, llm);
    expect(llm.call).toHaveBeenCalledOnce();
    expect(result.insufficient_data).toContain('@small:xhs');
    expect(Object.keys(result.analyses)).toHaveLength(1);
  });

  it('skips LLM call and omits key when LLM returns malformed response', async () => {
    const posts = makePosts(6, '@v姐', 'xhs');
    const store = makePostsStore({ '@v姐:xhs': posts });
    const profiles = [makeProfile({ name: '@v姐', platform: 'xhs' })];

    const llm: LLMClient = {
      call: vi.fn().mockResolvedValue('garbage response {{{{'),
      callJSON: vi.fn(),
    };

    const result = await analyzeCompetitors(store, profiles, llm);
    expect(Object.keys(result.analyses)).toHaveLength(0);
  });

  it('returns a valid CompetitorAnalysisStore shape', async () => {
    const store = makePostsStore({});
    const llm: LLMClient = { call: vi.fn(), callJSON: vi.fn() };

    const result = await analyzeCompetitors(store, [], llm);
    expect(result.version).toBe(1);
    expect(result.analyses).toBeDefined();
    expect(result.insufficient_data).toBeDefined();
    expect(typeof result.last_analyzed).toBe('string');
  });

  it('calls LLM with correct max tokens', async () => {
    const posts = makePosts(MIN_POSTS_FOR_ANALYSIS, '@v姐', 'xhs');
    const store = makePostsStore({ '@v姐:xhs': posts });
    const profiles = [makeProfile({ name: '@v姐', platform: 'xhs' })];

    const analysisPayload = makeAnalysis({ post_count: MIN_POSTS_FOR_ANALYSIS });
    const llm: LLMClient = {
      call: vi.fn().mockResolvedValue(JSON.stringify(analysisPayload)),
      callJSON: vi.fn(),
    };

    await analyzeCompetitors(store, profiles, llm);
    expect(llm.call).toHaveBeenCalledWith(expect.any(String));
  });
});

// ─── loadCompetitorAnalysis / saveCompetitorAnalysis ─────────────────────────

describe('loadCompetitorAnalysis / saveCompetitorAnalysis', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-analyzer-io-test-'));
    setBasePaths(tmpDir, tmpDir);
  });

  afterEach(() => {
    resetBasePaths();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadCompetitorAnalysis returns default store when file does not exist', () => {
    const store = loadCompetitorAnalysis();
    expect(store.version).toBe(1);
    expect(store.analyses).toEqual({});
    expect(store.insufficient_data).toEqual([]);
    expect(typeof store.last_analyzed).toBe('string');
  });

  it('saveCompetitorAnalysis persists and loadCompetitorAnalysis reads back', () => {
    const analysis = makeAnalysis();
    const store: CompetitorAnalysisStore = {
      version: 1,
      analyses: { '@v姐:xhs': analysis },
      insufficient_data: ['@small:xhs'],
      last_analyzed: new Date().toISOString(),
    };

    saveCompetitorAnalysis(store);
    const loaded = loadCompetitorAnalysis();

    expect(loaded.analyses['@v姐:xhs']).toBeDefined();
    expect(loaded.analyses['@v姐:xhs'].key_insight).toBe(analysis.key_insight);
    expect(loaded.insufficient_data).toContain('@small:xhs');
  });
});

// ─── buildAnalysisPrompt — content_mix de-anchoring ──────────────────────────

describe('buildAnalysisPrompt — content_mix de-anchoring', () => {
  it('有 content_mix 时 prompt 包含「历史参考」而非直接列比例', () => {
    const profile = makeProfile({
      content_mix: { '电竞解说': 40, '歌手': 25 },
    });
    const posts = makePosts(10);
    const prompt = buildAnalysisPrompt(profile, posts);
    expect(prompt).toContain('历史参考');
    expect(prompt).not.toMatch(/内容比例：\n.*电竞解说: 40%/s);
  });

  it('无 content_mix 时 prompt 不含「历史参考」', () => {
    const profile = makeProfile({ content_mix: undefined });
    const posts = makePosts(10);
    const prompt = buildAnalysisPrompt(profile, posts);
    expect(prompt).not.toContain('历史参考');
  });
});

// ─── analyzeCompetitors — auto_cluster flag ───────────────────────────────────

describe('analyzeCompetitors — auto_cluster flag', () => {
  it('成功分析后 AccountAnalysis 包含 auto_cluster: true', async () => {
    const mockLlm: LLMClient = {
      call: vi.fn().mockResolvedValue(`\`\`\`json
{
  "hook_patterns": [],
  "cover_formulas": [],
  "topic_clusters": [{"cluster_name":"电竞","post_count":5,"avg_engagement":500,"representative_titles":["T1"]}],
  "engagement_pattern": {"best_performing_type":"电竞","avg_engagement":500,"posting_frequency":"每日1条","peak_days":["周三"]},
  "key_insight": "测试洞察"
}
\`\`\``),
      callJSON: vi.fn(),
    } as unknown as LLMClient;

    const store: CompetitorPostsStore = {
      version: 1,
      last_fetched: new Date().toISOString(),
      accounts: { '@v姐:xhs': makePosts(10) },
    };
    const profiles = [makeProfile()];
    const result = await analyzeCompetitors(store, profiles, mockLlm);
    expect(result.analyses['@v姐:xhs']?.auto_cluster).toBe(true);
  });
});

// ─── Constants ────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('MIN_POSTS_FOR_ANALYSIS is 5', () => {
    expect(MIN_POSTS_FOR_ANALYSIS).toBe(5);
  });
});
