import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { setBasePaths, resetBasePaths, PATHS, readJSON } from '../scripts/utils/file-utils';
import { setTimeOverride, clearTimeOverride } from '../scripts/utils/time-utils';
import {
  PostPlatform,
  PostContent,
  PostAnalysisResult,
  PostAnalysisLog,
  EngagementSignals,
} from '../scripts/utils/types';

// ─── Sandbox setup ───────────────────────────────────────────────────────────

let sandboxDir: string;

beforeEach(() => {
  sandboxDir = fs.mkdtempSync(path.join('/tmp', 'viral-analyzer-test-'));
  setBasePaths(sandboxDir, sandboxDir);
  setTimeOverride(new Date('2026-04-02T10:00:00+09:00'));
});

afterEach(() => {
  resetBasePaths();
  clearTimeOverride();
  fs.rmSync(sandboxDir, { recursive: true, force: true });
});

// ─── Import module ───────────────────────────────────────────────────────────

import {
  detectPlatform,
  extractXhsNoteId,
  extractDouyinVideoId,
  buildAnalysisPrompt,
  formatAnalysisCard,
  persistAnalysis,
  analyzePost,
  computeEngagementSignals,
} from '../scripts/ops/viral-analyzer';

// ─── detectPlatform ──────────────────────────────────────────────────────────

describe('detectPlatform', () => {
  it('should detect xiaohongshu.com as xhs', () => {
    expect(detectPlatform('https://www.xiaohongshu.com/explore/abc123')).toBe('xhs');
  });

  it('should detect xhslink.com as xhs', () => {
    expect(detectPlatform('https://xhslink.com/abc123')).toBe('xhs');
  });

  it('should detect douyin.com as douyin', () => {
    expect(detectPlatform('https://www.douyin.com/video/1234567890')).toBe('douyin');
  });

  it('should detect v.douyin.com as douyin', () => {
    expect(detectPlatform('https://v.douyin.com/abc123')).toBe('douyin');
  });

  it('should return generic for unknown URLs', () => {
    expect(detectPlatform('https://example.com/post/123')).toBe('generic');
    expect(detectPlatform('https://weibo.com/12345')).toBe('generic');
  });
});

// ─── extractXhsNoteId ───────────────────────────────────────────────────────

describe('extractXhsNoteId', () => {
  it('should extract from /explore/{id}', () => {
    const result = extractXhsNoteId('https://www.xiaohongshu.com/explore/abc123def');
    expect(result).toEqual({ noteId: 'abc123def', xsecToken: null });
  });

  it('should extract from /discovery/item/{id}', () => {
    const result = extractXhsNoteId('https://www.xiaohongshu.com/discovery/item/xyz789');
    expect(result).toEqual({ noteId: 'xyz789', xsecToken: null });
  });

  it('should extract xsec_token from query params', () => {
    const result = extractXhsNoteId('https://www.xiaohongshu.com/explore/abc123?xsec_token=tok123');
    expect(result).toEqual({ noteId: 'abc123', xsecToken: 'tok123' });
  });

  it('should return null for unmatched URLs', () => {
    expect(extractXhsNoteId('https://www.xiaohongshu.com/user/profile123')).toBeNull();
    expect(extractXhsNoteId('https://example.com')).toBeNull();
  });
});

// ─── extractDouyinVideoId ────────────────────────────────────────────────────

describe('extractDouyinVideoId', () => {
  it('should extract video ID from /video/{id}', () => {
    expect(extractDouyinVideoId('https://www.douyin.com/video/7123456789012345')).toBe('7123456789012345');
  });

  it('should return null for non-video URLs', () => {
    expect(extractDouyinVideoId('https://www.douyin.com/user/abc')).toBeNull();
    expect(extractDouyinVideoId('https://v.douyin.com/shortlink')).toBeNull();
  });
});

// ─── buildAnalysisPrompt ─────────────────────────────────────────────────────

describe('buildAnalysisPrompt', () => {
  it('should include title, description, metrics, and identities', () => {
    const post: PostContent = {
      platform: 'xhs',
      url: 'https://xhs.com/explore/123',
      title: '今天的穿搭分享',
      description: '分享一下今天的日常穿搭～',
      images: ['img1.jpg'],
      likes: 5000,
      comments: ['好看！', '求链接'],
      collected_count: 2000,
      share_count: 300,
    };

    const prompt = buildAnalysisPrompt(post, 'ENTJ三重身份虚拟博主');

    expect(prompt).toContain('今天的穿搭分享');
    expect(prompt).toContain('分享一下今天的日常穿搭');
    expect(prompt).toContain('点赞5000');
    expect(prompt).toContain('收藏2000');
    expect(prompt).toContain('分享300');
    expect(prompt).toContain('好看！');
    expect(prompt).toContain('求链接');
    expect(prompt).toContain('ENTJ三重身份虚拟博主');
    expect(prompt).toContain('小红书');
    expect(prompt).toContain('hook_patterns');
    expect(prompt).toContain('core_selling_points');
    expect(prompt).toContain('comment_sentiment');
    expect(prompt).toContain('content_structure');
  });

  it('should handle empty comments gracefully', () => {
    const post: PostContent = {
      platform: 'douyin',
      url: 'https://douyin.com/video/123',
      title: '测试视频',
      description: '测试描述',
      images: [],
      likes: 100,
      comments: [],
      collected_count: 0,
      share_count: 0,
    };

    const prompt = buildAnalysisPrompt(post, '测试身份');
    expect(prompt).toContain('暂无评论数据');
    expect(prompt).toContain('抖音');
  });
});

// ─── formatAnalysisCard ──────────────────────────────────────────────────────

describe('formatAnalysisCard', () => {
  const mockResult: PostAnalysisResult = {
    url: 'https://xhs.com/explore/123',
    platform: 'xhs',
    title: '今日穿搭',
    hook_patterns: [
      { formula: '数字+反差', example: '全身只花200块', effectiveness_score: 8 },
    ],
    core_selling_points: ['平价好物', '日常可穿'],
    comment_sentiment: {
      positive_ratio: 0.7,
      negative_ratio: 0.1,
      neutral_ratio: 0.2,
      top_keywords: ['好看', '求链接'],
      emotional_triggers: ['共鸣感', '性价比'],
    },
    content_structure: {
      opening_hook: '反差开场',
      body_flow: '由远及近展示',
      closing_cta: '评论区抽奖',
      visual_strategy: '九宫格实拍',
    },
    analyzed_at: '2026-04-02T10:00:00+09:00',
  };

  it('should include all sections', () => {
    const card = formatAnalysisCard(mockResult);
    expect(card).toContain('🔍 爆款拆解');
    expect(card).toContain('今日穿搭');
    expect(card).toContain('钩子句式');
    expect(card).toContain('数字+反差');
    expect(card).toContain('全身只花200块');
    expect(card).toContain('核心卖点');
    expect(card).toContain('平价好物');
    expect(card).toContain('评论情绪');
    expect(card).toContain('70%');
    expect(card).toContain('好看');
    expect(card).toContain('内容结构');
    expect(card).toContain('反差开场');
  });

  it('should handle empty comments gracefully', () => {
    const emptyComments: PostAnalysisResult = {
      ...mockResult,
      comment_sentiment: {
        positive_ratio: 0,
        negative_ratio: 0,
        neutral_ratio: 0,
        top_keywords: [],
        emotional_triggers: [],
      },
    };
    const card = formatAnalysisCard(emptyComments);
    expect(card).toContain('暂无评论数据');
  });
});

// ─── persistAnalysis ─────────────────────────────────────────────────────────

describe('persistAnalysis', () => {
  it('should persist and append entries', () => {
    const result: PostAnalysisResult = {
      url: 'https://xhs.com/explore/123',
      platform: 'xhs',
      title: '测试',
      hook_patterns: [],
      core_selling_points: [],
      comment_sentiment: {
        positive_ratio: 0, negative_ratio: 0, neutral_ratio: 0,
        top_keywords: [], emotional_triggers: [],
      },
      content_structure: {
        opening_hook: '', body_flow: '', closing_cta: '', visual_strategy: '',
      },
      analyzed_at: '2026-04-02T10:00:00+09:00',
    };

    persistAnalysis(result);
    const log = readJSON<PostAnalysisLog>(PATHS.postAnalysisLog, { entries: [] });
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].url).toBe('https://xhs.com/explore/123');

    // Append second
    persistAnalysis({ ...result, url: 'https://douyin.com/video/456' });
    const log2 = readJSON<PostAnalysisLog>(PATHS.postAnalysisLog, { entries: [] });
    expect(log2.entries).toHaveLength(2);
  });
});

// ─── analyzePost integration ─────────────────────────────────────────────────

describe('analyzePost', () => {
  it('should produce a valid result with mocked LLM and generic platform', async () => {
    const mockLlm = {
      call: vi.fn(),
      callJSON: vi.fn().mockResolvedValue({
        hook_patterns: [{ formula: '数字法则', example: '3步搞定', effectiveness_score: 7 }],
        core_selling_points: ['简单易学'],
        comment_sentiment: {
          positive_ratio: 0.8, negative_ratio: 0.05, neutral_ratio: 0.15,
          top_keywords: ['实用'], emotional_triggers: ['好奇心'],
        },
        content_structure: {
          opening_hook: '提问式开头',
          body_flow: '分步讲解',
          closing_cta: '关注获取更多',
          visual_strategy: '大字报风',
        },
      }),
    };

    const persona = {
      meta: { name: 'TestV', tagline: '虚拟博主', id: 'testv' },
      personality: { mbti: 'ENTJ', core_traits: ['自信', '直率'] },
      voice: { language: 'zh-CN', style: '直接有力', sample_lines: [] },
    } as any;

    const result = await analyzePost('https://example.com/post/999', persona, mockLlm);

    expect(result.platform).toBe('generic');
    expect(result.hook_patterns).toHaveLength(1);
    expect(result.hook_patterns[0].formula).toBe('数字法则');
    expect(result.core_selling_points).toContain('简单易学');
    expect(result.comment_sentiment.positive_ratio).toBe(0.8);
    expect(result.content_structure.opening_hook).toBe('提问式开头');

    // Should be persisted
    const log = readJSON<PostAnalysisLog>(PATHS.postAnalysisLog, { entries: [] });
    expect(log.entries).toHaveLength(1);
  });
});

// ─── computeEngagementSignals ─────────────────────────────────────────────────

describe('computeEngagementSignals', () => {
  it('정상값: 수집률/공유율/댓글률/종합점수 계산', () => {
    const post: PostContent = {
      platform: 'xhs', url: 'https://x.com/1', title: 'T',
      description: '', images: [], comments: [],
      likes: 100, collected_count: 50, share_count: 20, comment_count: 10,
    };
    const s = computeEngagementSignals(post);
    expect(s.save_rate).toBeCloseTo(50 / 101, 2);
    expect(s.share_rate).toBeCloseTo(20 / 101, 2);
    expect(s.comment_rate).toBeCloseTo(10 / 101, 2);
    expect(s.engagement_score).toBe(100 * 1 + 50 * 5 + 20 * 4 + 10 * 3);
  });

  it('零좋아요: 분모 likes+1으로 제로제산 방지', () => {
    const post: PostContent = {
      platform: 'xhs', url: 'https://x.com/2', title: 'T',
      description: '', images: [], comments: [],
      likes: 0, collected_count: 5, share_count: 0, comment_count: 0,
    };
    const s = computeEngagementSignals(post);
    expect(s.save_rate).toBeCloseTo(5 / 1, 2);
    expect(s.engagement_score).toBe(0 + 5 * 5 + 0 + 0);
  });

  it('comment_count 없음: comment_rate=0, 점수에 댓글 미포함', () => {
    const post: PostContent = {
      platform: 'douyin', url: 'https://d.com/1', title: 'T',
      description: '', images: [], comments: [],
      likes: 200, collected_count: 0, share_count: 10,
      // comment_count missing
    };
    const s = computeEngagementSignals(post);
    expect(s.comment_rate).toBe(0);
    expect(s.engagement_score).toBe(200 * 1 + 0 * 5 + 10 * 4 + 0 * 3);
  });
});

// ─── buildAnalysisPrompt with signals ────────────────────────────────────────

describe('buildAnalysisPrompt with signals', () => {
  const basePost: PostContent = {
    platform: 'xhs', url: 'https://x.com/1', title: '电竞女生必看',
    description: '正文内容', images: [], comments: ['好看', '厉害'],
    likes: 1000, collected_count: 400, share_count: 150, comment_count: 80,
  };
  const signals: EngagementSignals = {
    save_rate: 0.40, share_rate: 0.15, comment_rate: 0.08,
    engagement_score: 1000 + 400 * 5 + 150 * 4 + 80 * 3,
  };

  it('传入 signals 时 prompt 包含互动信号解读块', () => {
    const prompt = buildAnalysisPrompt(basePost, 'ENTJ三栖', signals);
    expect(prompt).toContain('互动信号解读');
    expect(prompt).toContain('收藏率');
    expect(prompt).toContain('0.40');
    expect(prompt).toContain('attribution');
  });

  it('不传 signals 时 prompt 不含互动信号解读块', () => {
    const prompt = buildAnalysisPrompt(basePost, 'ENTJ三栖');
    expect(prompt).not.toContain('互动信号解读');
    expect(prompt).not.toContain('attribution');
  });
});
