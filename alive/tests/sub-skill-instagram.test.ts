// alive/tests/sub-skill-instagram.test.ts
// Tests for the Instagram sub-skill

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { actions } from '../sub-skills/instagram/scripts/index';
import type {
  PostImpulseState,
  PhotoIntent,
  PostIntent,
} from '../sub-skills/instagram/scripts/index';
import type { SubSkillContext, EmotionState, MemoryAccessor } from '../scripts/utils/types';
import { DEFAULT_MOMENTUM, DEFAULT_UNDERTONE } from '../scripts/utils/types';

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

function makePhotoIntent(): PhotoIntent {
  return {
    style: 'daily',
    scene_description: 'Coffee shop selfie',
    outfit_description: 'Casual',
    emotion_tone: 'relaxed',
    shots: [{ description: 'Close up', camera_angle: 'front', mood: 'warm' }],
  };
}

function makePostIntent(): PostIntent {
  return {
    caption: '今天的咖啡超好喝☕',
    hashtags: ['#cafe', '#daily'],
    style: 'daily',
    photo_paths: ['/tmp/photo1.jpg'],
  };
}

function makeCtx(overrides: Partial<SubSkillContext> = {}): SubSkillContext {
  return {
    persona: {
      meta: { name: 'TestChar', tagline: '测试角色' },
      personality: { mbti: 'INFP', core_traits: ['creative'] },
      voice: { language: 'zh', style: '活泼', sample_lines: [] },
    } as any,
    emotion: makeEmotion(),
    vitality: 80,
    confidence: 1.0,
    intent: { id: 'i1', category: '创作' as const, description: '想发ins', intensity: 8, action: 'instagram-post' },
    memory: makeMemory(),
    socialGraph: { getRelations: vi.fn(() => []), updateRelation: vi.fn() },
    llm: { callJSON: vi.fn(async () => ({})), call: vi.fn(async () => '') },
    config: {},
    ...overrides,
  };
}

// ── instagram-post action ────────────────────────────────────────

describe('instagram/instagram-post', () => {
  it('returns early when platform functions not configured', async () => {
    const ctx = makeCtx();
    const result = await actions['instagram-post'](ctx);
    expect(result.narrative).toContain('未配置');
    expect(result.vitality_cost).toBe(0);
  });

  it('returns when impulse below threshold', async () => {
    const ctx = makeCtx({
      config: {
        planPhoto: vi.fn(),
        generateImages: vi.fn(),
        planPost: vi.fn(),
        publishPost: vi.fn(),
      },
      memory: makeMemory({
        'post-impulse': {
          impulse: 30, // below 80 threshold
          last_accumulated: new Date().toISOString().slice(0, 10),
          daily_accumulation: 0,
          dormancy_days: 0,
          last_posted_date: null,
        },
      }),
    });

    const result = await actions['instagram-post'](ctx);
    expect(result.narrative).toContain('冲动还不够强');
    expect(result.vitality_cost).toBe(0);
  });

  it('accumulates impulse when below threshold', async () => {
    const memory = makeMemory({
      'post-impulse': {
        impulse: 30,
        last_accumulated: new Date().toISOString().slice(0, 10),
        daily_accumulation: 0,
        dormancy_days: 0,
        last_posted_date: null,
      },
    });

    const ctx = makeCtx({
      config: {
        planPhoto: vi.fn(),
        generateImages: vi.fn(),
        planPost: vi.fn(),
        publishPost: vi.fn(),
      },
      memory,
    });

    await actions['instagram-post'](ctx);

    const writeCall = (memory.writeJSON as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'post-impulse'
    );
    const updatedState = writeCall![1] as PostImpulseState;
    expect(updatedState.impulse).toBeGreaterThan(30);
  });

  it('runs full pipeline when impulse exceeds threshold', async () => {
    const planPhoto = vi.fn(async () => makePhotoIntent());
    const generateImages = vi.fn(async () => ({
      paths: ['/tmp/photo1.jpg'],
      urls: ['https://cdn.example.com/photo1.jpg'],
    }));
    const planPost = vi.fn(async () => makePostIntent());
    const publishPost = vi.fn(async () => ({ media_id: 'media123', success: true }));
    const scheduleCommentCheck = vi.fn();

    const memory = makeMemory({
      'post-impulse': {
        impulse: 90, // above 80 threshold
        last_accumulated: new Date().toISOString().slice(0, 10),
        daily_accumulation: 0,
        dormancy_days: 0,
        last_posted_date: null,
      },
    });

    const ctx = makeCtx({
      config: { planPhoto, generateImages, planPost, publishPost, scheduleCommentCheck },
      memory,
    });

    const result = await actions['instagram-post'](ctx);

    expect(planPhoto).toHaveBeenCalled();
    expect(generateImages).toHaveBeenCalled();
    expect(planPost).toHaveBeenCalled();
    expect(publishPost).toHaveBeenCalled();
    expect(scheduleCommentCheck).toHaveBeenCalledWith('media123', expect.any(String));
    expect(result.narrative).toContain('发了一条 Instagram');
    expect(result.vitality_cost).toBe(40);
    expect(result.emotion_deltas).toEqual(expect.arrayContaining([
      expect.objectContaining({ valence: 0.15, creativity: 0.1 }),
    ]));
  });

  it('resets impulse after successful post', async () => {
    const memory = makeMemory({
      'post-impulse': {
        impulse: 90,
        last_accumulated: new Date().toISOString().slice(0, 10),
        daily_accumulation: 0,
        dormancy_days: 0,
        last_posted_date: null,
      },
    });

    const ctx = makeCtx({
      config: {
        planPhoto: vi.fn(async () => makePhotoIntent()),
        generateImages: vi.fn(async () => ({ paths: ['/tmp/p.jpg'], urls: ['https://cdn/p.jpg'] })),
        planPost: vi.fn(async () => makePostIntent()),
        publishPost: vi.fn(async () => ({ media_id: 'm1', success: true })),
      },
      memory,
    });

    await actions['instagram-post'](ctx);

    const impulseWrites = (memory.writeJSON as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'post-impulse'
    );
    const lastImpulse = impulseWrites[impulseWrites.length - 1][1] as PostImpulseState;
    expect(lastImpulse.impulse).toBeLessThan(90 * 0.31); // should be ~27 (90 * 0.3)
    expect(lastImpulse.last_posted_date).toBe(new Date().toISOString().slice(0, 10));
  });

  it('records post in post-history', async () => {
    const memory = makeMemory({
      'post-impulse': { impulse: 90, last_accumulated: new Date().toISOString().slice(0, 10), daily_accumulation: 0, dormancy_days: 0, last_posted_date: null },
    });

    const ctx = makeCtx({
      config: {
        planPhoto: vi.fn(async () => makePhotoIntent()),
        generateImages: vi.fn(async () => ({ paths: ['/tmp/p.jpg'], urls: ['https://cdn/p.jpg'] })),
        planPost: vi.fn(async () => makePostIntent()),
        publishPost: vi.fn(async () => ({ media_id: 'm1', success: true })),
      },
      memory,
    });

    await actions['instagram-post'](ctx);

    const historyWrite = (memory.writeJSON as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'post-history'
    );
    expect(historyWrite).toBeDefined();
    const history = historyWrite![1] as { posts: any[] };
    expect(history.posts).toHaveLength(1);
    expect(history.posts[0].media_id).toBe('m1');
    expect(history.posts[0].style).toBe('daily');
  });

  it('handles planPhoto failure gracefully', async () => {
    const memory = makeMemory({
      'post-impulse': { impulse: 90, last_accumulated: new Date().toISOString().slice(0, 10), daily_accumulation: 0, dormancy_days: 0, last_posted_date: null },
    });

    const ctx = makeCtx({
      config: {
        planPhoto: vi.fn(async () => { throw new Error('planning failed'); }),
        generateImages: vi.fn(),
        planPost: vi.fn(),
        publishPost: vi.fn(),
      },
      memory,
    });

    const result = await actions['instagram-post'](ctx);
    expect(result.narrative).toContain('没想好');
    expect(result.vitality_cost).toBe(10);
  });

  it('handles generateImages failure', async () => {
    const memory = makeMemory({
      'post-impulse': { impulse: 90, last_accumulated: new Date().toISOString().slice(0, 10), daily_accumulation: 0, dormancy_days: 0, last_posted_date: null },
    });

    const ctx = makeCtx({
      config: {
        planPhoto: vi.fn(async () => makePhotoIntent()),
        generateImages: vi.fn(async () => { throw new Error('gen failed'); }),
        planPost: vi.fn(),
        publishPost: vi.fn(),
      },
      memory,
    });

    const result = await actions['instagram-post'](ctx);
    expect(result.narrative).toContain('失败');
    expect(result.vitality_cost).toBe(20);
  });

  it('handles empty generated images', async () => {
    const memory = makeMemory({
      'post-impulse': { impulse: 90, last_accumulated: new Date().toISOString().slice(0, 10), daily_accumulation: 0, dormancy_days: 0, last_posted_date: null },
    });

    const ctx = makeCtx({
      config: {
        planPhoto: vi.fn(async () => makePhotoIntent()),
        generateImages: vi.fn(async () => ({ paths: [], urls: [] })),
        planPost: vi.fn(),
        publishPost: vi.fn(),
      },
      memory,
    });

    const result = await actions['instagram-post'](ctx);
    expect(result.narrative).toContain('质量不够');
  });

  it('handles publish failure', async () => {
    const memory = makeMemory({
      'post-impulse': { impulse: 90, last_accumulated: new Date().toISOString().slice(0, 10), daily_accumulation: 0, dormancy_days: 0, last_posted_date: null },
    });

    const ctx = makeCtx({
      config: {
        planPhoto: vi.fn(async () => makePhotoIntent()),
        generateImages: vi.fn(async () => ({ paths: ['/tmp/p.jpg'], urls: ['https://cdn/p.jpg'] })),
        planPost: vi.fn(async () => makePostIntent()),
        publishPost: vi.fn(async () => ({ media_id: '', success: false })),
      },
      memory,
    });

    const result = await actions['instagram-post'](ctx);
    expect(result.narrative).toContain('失败');
  });

  it('adds confidence bonus to emotion deltas when confidence > 1.0', async () => {
    const memory = makeMemory({
      'post-impulse': { impulse: 90, last_accumulated: new Date().toISOString().slice(0, 10), daily_accumulation: 0, dormancy_days: 0, last_posted_date: null },
    });

    const ctx = makeCtx({
      confidence: 1.2,
      config: {
        planPhoto: vi.fn(async () => makePhotoIntent()),
        generateImages: vi.fn(async () => ({ paths: ['/tmp/p.jpg'], urls: ['https://cdn/p.jpg'] })),
        planPost: vi.fn(async () => makePostIntent()),
        publishPost: vi.fn(async () => ({ media_id: 'm1', success: true })),
      },
      memory,
    });

    const result = await actions['instagram-post'](ctx);
    expect(result.emotion_deltas).toEqual(expect.arrayContaining([
      expect.objectContaining({ valence: 0.05 }), // confidence bonus
    ]));
  });

  it('applies impulse decay when called on a new day', async () => {
    const memory = makeMemory({
      'post-impulse': {
        impulse: 50,
        last_accumulated: '2026-03-20', // old date
        daily_accumulation: 10,
        dormancy_days: 0,
        last_posted_date: null,
      },
    });

    const ctx = makeCtx({
      config: {
        planPhoto: vi.fn(),
        generateImages: vi.fn(),
        planPost: vi.fn(),
        publishPost: vi.fn(),
      },
      memory,
    });

    await actions['instagram-post'](ctx);

    const impulseWrites = (memory.writeJSON as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'post-impulse'
    );
    const lastImpulse = impulseWrites[impulseWrites.length - 1][1] as PostImpulseState;
    // 50 - 5 (decay) + 5~15 (accumulation) = 50~60
    expect(lastImpulse.impulse).toBeGreaterThanOrEqual(45);
    expect(lastImpulse.impulse).toBeLessThanOrEqual(65);
  });
});

// ── instagram-check-stats action ─────────────────────────────────

describe('instagram/instagram-check-stats', () => {
  it('returns early when checkPostStats not configured', async () => {
    const ctx = makeCtx({
      intent: { id: 'i1', category: '窥屏' as const, description: '看看数据', intensity: 4, action: 'instagram-check-stats' },
    });
    const result = await actions['instagram-check-stats'](ctx);
    expect(result.narrative).toContain('未配置');
    expect(result.vitality_cost).toBe(0);
  });

  it('returns when no unchecked posts', async () => {
    const ctx = makeCtx({
      config: { checkPostStats: vi.fn() },
      memory: makeMemory({ 'post-history': { posts: [] } }),
      intent: { id: 'i1', category: '窥屏' as const, description: '看数据', intensity: 4, action: 'instagram-check-stats' },
    });
    const result = await actions['instagram-check-stats'](ctx);
    expect(result.narrative).toContain('没有');
  });

  it('checks stats for posts older than 24h', async () => {
    const oldTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const checkPostStats = vi.fn(async () => ({
      likes: 50, comments: 10, reach: 500, saves: 5,
    }));

    const memory = makeMemory({
      'post-history': {
        posts: [{
          id: 'p1', media_id: 'media1', timestamp: oldTimestamp,
          style: 'daily', caption: 'test', hashtags: [], photo_urls: [],
        }],
      },
    });

    const ctx = makeCtx({
      config: { checkPostStats, avgEngagement: 30 },
      memory,
      intent: { id: 'i1', category: '窥屏' as const, description: '看数据', intensity: 4, action: 'instagram-check-stats' },
    });

    const result = await actions['instagram-check-stats'](ctx);
    expect(checkPostStats).toHaveBeenCalledWith('media1');
    expect(result.narrative).toContain('50');
    expect(result.feedback).toBeDefined();
    expect(result.feedback!.length).toBeGreaterThan(0);
    expect(result.feedback![0].source).toBe('instagram-stats');
  });

  it('skips posts without media_id', async () => {
    const oldTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const checkPostStats = vi.fn(async () => ({ likes: 10, comments: 1, reach: 100, saves: 1 }));

    const ctx = makeCtx({
      config: { checkPostStats },
      memory: makeMemory({
        'post-history': {
          posts: [{
            id: 'p1', timestamp: oldTimestamp, // no media_id
            style: 'daily', caption: 'test', hashtags: [], photo_urls: [],
          }],
        },
      }),
      intent: { id: 'i1', category: '窥屏' as const, description: '看数据', intensity: 4, action: 'instagram-check-stats' },
    });

    const result = await actions['instagram-check-stats'](ctx);
    expect(checkPostStats).not.toHaveBeenCalled();
  });

  it('skips already-checked posts', async () => {
    const oldTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const checkPostStats = vi.fn(async () => ({ likes: 10, comments: 1, reach: 100, saves: 1 }));

    const ctx = makeCtx({
      config: { checkPostStats },
      memory: makeMemory({
        'post-history': {
          posts: [{
            id: 'p1', media_id: 'media1', timestamp: oldTimestamp,
            style: 'daily', caption: 'test', hashtags: [], photo_urls: [],
            stats: { likes: 50, comments: 10, reach: 500, saves: 5, checked_at: '2026-03-23T12:00:00Z' },
          }],
        },
      }),
      intent: { id: 'i1', category: '窥屏' as const, description: '看数据', intensity: 4, action: 'instagram-check-stats' },
    });

    const result = await actions['instagram-check-stats'](ctx);
    expect(checkPostStats).not.toHaveBeenCalled();
  });
});
