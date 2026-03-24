// alive/tests/sub-skill-social-engagement.test.ts
// Tests for the social-engagement sub-skill

import { describe, it, expect, vi } from 'vitest';
import { isSpam, actions } from '../sub-skills/social-engagement/scripts/index';
import type { SubSkillContext, EmotionState, MemoryAccessor } from '../scripts/utils/types';
import { DEFAULT_MOMENTUM, DEFAULT_UNDERTONE } from '../scripts/utils/types';

// ── isSpam ───────────────────────────────────────────────────────

describe('social-engagement/isSpam', () => {
  it('detects pure emoji as spam', () => {
    expect(isSpam('🔥🔥🔥')).toBe(true);
  });

  it('detects pure emoji with spaces', () => {
    expect(isSpam('🔥 🔥 🔥')).toBe(true);
  });

  it('detects single emoji', () => {
    expect(isSpam('❤️')).toBe(true);
  });

  it('detects very short text as spam', () => {
    expect(isSpam('hi')).toBe(true);
    expect(isSpam('x')).toBe(true);
  });

  it('detects empty/whitespace as spam', () => {
    expect(isSpam('')).toBe(true);
    expect(isSpam('  ')).toBe(true);
  });

  it('allows real comment text', () => {
    expect(isSpam('这张照片好好看！')).toBe(false);
  });

  it('allows mixed emoji + text', () => {
    expect(isSpam('好看哦 🔥')).toBe(false);
  });

  it('allows text exactly 3 chars', () => {
    expect(isSpam('好的!')).toBe(false);
  });

  it('allows English comments', () => {
    expect(isSpam('This is amazing!')).toBe(false);
  });

  it('allows longer meaningful text', () => {
    expect(isSpam('这个cosplay做得也太好了吧，请问是什么材料？')).toBe(false);
  });
});

// ── Mock helpers ─────────────────────────────────────────────────

function makeEmotion(overrides: Partial<EmotionState> = {}): EmotionState {
  return {
    mood: { valence: 0.3, arousal: 0.5, description: '平静' },
    energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
    last_updated: null, recent_cause: 'test',
    momentum: { ...DEFAULT_MOMENTUM },
    undertone: { ...DEFAULT_UNDERTONE },
    impulse_history: [], consecutive_high_stress: 0, threshold_break_cooldown: 0,
    ...overrides,
  };
}

function makeMemory(store: Record<string, unknown> = {}): MemoryAccessor {
  const jsonStore: Record<string, unknown> = { ...store };
  const diaryEntries: string[] = [];
  return {
    readDiary: vi.fn(() => diaryEntries.join('\n')),
    appendDiary: vi.fn((entry: string) => diaryEntries.push(entry)),
    readJSON: vi.fn(<T>(key: string, fallback: T) => (jsonStore[key] as T) ?? fallback),
    writeJSON: vi.fn(<T>(key: string, data: T) => { jsonStore[key] = data; }),
  };
}

function makeCtx(overrides: Partial<SubSkillContext> = {}): SubSkillContext {
  return {
    persona: {
      meta: { name: 'TestChar', tagline: '测试角色' },
      personality: { mbti: 'INFP', core_traits: ['friendly'] },
      voice: { language: 'zh', style: '温柔', sample_lines: [] },
    } as any,
    emotion: makeEmotion(),
    vitality: 80,
    confidence: 1.0,
    intent: { id: 'i1', category: '社交' as const, description: '想和大家互动', intensity: 5, action: 'social-engagement' },
    memory: makeMemory(),
    socialGraph: { getRelations: vi.fn(() => []), updateRelation: vi.fn() },
    llm: {
      callJSON: vi.fn(async () => []),
      call: vi.fn(async () => ''),
    },
    config: {},
    ...overrides,
  };
}

// ── comment-reply action ─────────────────────────────────────────

describe('social-engagement/comment-reply', () => {
  it('returns early when no platform functions configured', async () => {
    const ctx = makeCtx();
    const result = await actions['comment-reply'](ctx);
    expect(result.narrative).toContain('没有需要回复的评论');
    expect(result.vitality_cost).toBe(0);
  });

  it('returns early when pendingMediaPks is empty', async () => {
    const ctx = makeCtx({
      config: {
        getComments: vi.fn(),
        replyComment: vi.fn(),
        pendingMediaPks: [],
      },
    });
    const result = await actions['comment-reply'](ctx);
    expect(result.narrative).toContain('没有需要回复的评论');
  });

  it('filters spam comments before replying', async () => {
    const getComments = vi.fn(async () => [
      { comment_pk: 'c1', username: 'user1', user_id: 'u1', text: '🔥🔥🔥', like_count: 5 },
      { comment_pk: 'c2', username: 'user2', user_id: 'u2', text: '这张照片太好看了！', like_count: 3 },
    ]);
    const replyComment = vi.fn(async () => {});

    const ctx = makeCtx({
      config: {
        getComments,
        replyComment,
        pendingMediaPks: ['m1'],
      },
      llm: {
        callJSON: vi.fn(async () => [{ comment_pk: 'c2', reply: '谢谢！' }]),
        call: vi.fn(async () => ''),
      },
    });

    const result = await actions['comment-reply'](ctx);
    // Should only process c2 (non-spam), not c1 (spam)
    expect(replyComment).toHaveBeenCalledWith('m1', 'c2', '谢谢！');
    expect(replyComment).not.toHaveBeenCalledWith('m1', 'c1', expect.any(String));
  });

  it('tracks replied comment IDs to avoid duplicates', async () => {
    const getComments = vi.fn(async () => [
      { comment_pk: 'c1', username: 'user1', user_id: 'u1', text: '很棒的照片！', like_count: 5 },
    ]);
    const replyComment = vi.fn(async () => {});

    const ctx = makeCtx({
      config: {
        getComments,
        replyComment,
        pendingMediaPks: ['m1'],
      },
      memory: makeMemory({
        'pending-engagement': {
          pending_replies: [{ media_pk: 'm1', replied_comment_ids: ['c1'] }],
        },
      }),
      llm: {
        callJSON: vi.fn(async () => []),
        call: vi.fn(async () => ''),
      },
    });

    await actions['comment-reply'](ctx);
    // c1 already replied, should not be passed to LLM
    expect(replyComment).not.toHaveBeenCalled();
  });

  it('updates social graph on reply', async () => {
    const getComments = vi.fn(async () => [
      { comment_pk: 'c1', username: 'user1', user_id: 'u1', text: '好看！！！！', like_count: 3 },
    ]);
    const replyComment = vi.fn(async () => {});
    const updateRelation = vi.fn();

    const ctx = makeCtx({
      config: {
        getComments,
        replyComment,
        pendingMediaPks: ['m1'],
      },
      socialGraph: { getRelations: vi.fn(() => []), updateRelation },
      llm: {
        callJSON: vi.fn(async () => [{ comment_pk: 'c1', reply: '谢谢❤️' }]),
        call: vi.fn(async () => ''),
      },
    });

    await actions['comment-reply'](ctx);
    expect(updateRelation).toHaveBeenCalledWith('u1', expect.objectContaining({
      last_interaction: expect.any(String),
    }));
  });

  it('returns feedback for confidence engine', async () => {
    const getComments = vi.fn(async () => [
      { comment_pk: 'c1', username: 'u1', user_id: 'u1', text: '真的太好看了', like_count: 10 },
    ]);
    const replyComment = vi.fn(async () => {});

    const ctx = makeCtx({
      config: { getComments, replyComment, pendingMediaPks: ['m1'] },
      llm: {
        callJSON: vi.fn(async () => [{ comment_pk: 'c1', reply: '谢谢！' }]),
        call: vi.fn(async () => ''),
      },
    });

    const result = await actions['comment-reply'](ctx);
    expect(result.feedback).toBeDefined();
    expect(result.feedback!.length).toBeGreaterThan(0);
    expect(result.feedback![0].source).toBe('comment-reply');
  });
});

// ── social-engagement action ─────────────────────────────────────

describe('social-engagement/social-engagement', () => {
  it('returns early when no platform functions configured', async () => {
    const ctx = makeCtx();
    const result = await actions['social-engagement'](ctx);
    expect(result.narrative).toContain('未配置');
    expect(result.vitality_cost).toBe(0);
  });

  it('respects daily outbound limit', async () => {
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const ctx = makeCtx({
      config: {
        getCandidates: vi.fn(async () => []),
        postComment: vi.fn(async () => {}),
      },
      // Fill outbound history to max
      memory: makeMemory({
        'outbound-history': {
          commented: Array.from({ length: 5 }, (_, i) => ({
            media_pk: `m${i}`,
            user_id: `u${i}`,
            commented_at: todayStart.getTime() + i * 1000,
          })),
        },
      }),
    });

    const result = await actions['social-engagement'](ctx);
    expect(result.narrative).toContain('评论够多了');
    expect(result.vitality_cost).toBe(0);
  });

  it('posts comments and updates outbound history', async () => {
    const getCandidates = vi.fn(async () => [
      { media_pk: 'm1', user_id: 'u1', username: 'alice', caption: 'Nice day', like_count: 50, comment_count: 3 },
    ]);
    const postComment = vi.fn(async () => {});

    const ctx = makeCtx({
      config: { getCandidates, postComment },
      llm: {
        callJSON: vi.fn(async () => [
          { media_pk: 'm1', user_id: 'u1', username: 'alice', comment: '好看！' },
        ]),
        call: vi.fn(async () => ''),
      },
    });

    const result = await actions['social-engagement'](ctx);
    expect(postComment).toHaveBeenCalledWith('m1', '好看！');
    expect(result.narrative).toContain('1');
    expect(result.feedback).toBeDefined();
    expect(ctx.memory.appendDiary).toHaveBeenCalled();
  });

  it('skips already-commented media', async () => {
    const getCandidates = vi.fn(async () => [
      { media_pk: 'm1', user_id: 'u1', username: 'alice', caption: 'Test', like_count: 10, comment_count: 1 },
    ]);
    const postComment = vi.fn(async () => {});

    const ctx = makeCtx({
      config: { getCandidates, postComment },
      memory: makeMemory({
        'outbound-history': {
          commented: [{ media_pk: 'm1', user_id: 'u1', commented_at: Date.now() }],
        },
      }),
    });

    const result = await actions['social-engagement'](ctx);
    expect(postComment).not.toHaveBeenCalled();
    expect(result.narrative).toContain('没看到');
  });

  it('handles getCandidates failure gracefully', async () => {
    const getCandidates = vi.fn(async () => { throw new Error('network error'); });
    const postComment = vi.fn(async () => {});

    const ctx = makeCtx({
      config: { getCandidates, postComment },
    });

    const result = await actions['social-engagement'](ctx);
    expect(result.narrative).toContain('没找到');
    expect(result.vitality_cost).toBe(5);
  });

  it('enforces per-user 24h comment limit', async () => {
    const now = Date.now();
    const getCandidates = vi.fn(async () => [
      { media_pk: 'm2', user_id: 'u1', username: 'alice', caption: 'Another', like_count: 10, comment_count: 1 },
    ]);
    const postComment = vi.fn(async () => {});

    const ctx = makeCtx({
      config: { getCandidates, postComment },
      memory: makeMemory({
        'outbound-history': {
          commented: [
            { media_pk: 'm0', user_id: 'u1', commented_at: now - 1000 },
            { media_pk: 'm1', user_id: 'u1', commented_at: now - 500 },
          ],
        },
      }),
    });

    const result = await actions['social-engagement'](ctx);
    // u1 already has 2 comments in 24h, should be filtered out
    expect(postComment).not.toHaveBeenCalled();
  });
});
