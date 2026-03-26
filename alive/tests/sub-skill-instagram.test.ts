// alive/tests/sub-skill-instagram.test.ts
// Tests for the Instagram sub-skill

import { describe, it, expect, vi } from 'vitest';
import { actions } from '../sub-skills/instagram/scripts/index';
import type {
  PhotoIntent,
  PostIntent,
} from '../sub-skills/instagram/scripts/index';
import type { SubSkillContext, EmotionState, MemoryAccessor, WorkImpulseState } from '../scripts/utils/types';
import { DEFAULT_MOMENTUM, DEFAULT_UNDERTONE, DEFAULT_WORK_IMPULSE_STATE } from '../scripts/utils/types';

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

/** Helper to create a core WorkImpulseState with overrides */
function makeImpulse(overrides: Partial<WorkImpulseState> = {}): WorkImpulseState {
  return { ...DEFAULT_WORK_IMPULSE_STATE, ...overrides };
}

function makeMemory(store: Record<string, unknown> = {}): MemoryAccessor {
  const jsonStore: Record<string, unknown> = { ...store };
  const diaryEntries: string[] = [];
  const readDiary = vi.fn(() => diaryEntries.join('\n'));
  const appendDiary = vi.fn((entry: string) => diaryEntries.push(entry));
  const readJSON = vi.fn(<T>(key: string, fallback: T) => (jsonStore[key] as T) ?? fallback) as MemoryAccessor['readJSON'];
  const writeJSON = vi.fn(<T>(key: string, data: T) => { jsonStore[key] = data; }) as MemoryAccessor['writeJSON'];

  return {
    readDiary,
    appendDiary,
    readJSON,
    writeJSON,
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
    intent: { id: 'i1', category: 'produce' as const, description: '想发ins', intensity: 8, action: 'instagram-post' },
    memory: makeMemory(),
    socialGraph: { getRelations: vi.fn(() => []), updateRelation: vi.fn() },
    llm: {
      callJSON: vi.fn(async <T>() => ({} as T)) as SubSkillContext['llm']['callJSON'],
      call: vi.fn(async () => '') as SubSkillContext['llm']['call'],
    },
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
        'work-impulse': makeImpulse({ value: 30 }),
      }),
    });

    const result = await actions['instagram-post'](ctx);
    expect(result.narrative).toContain('冲动还不够强');
    expect(result.vitality_cost).toBe(0);
  });

  it('accumulates impulse when below threshold', async () => {
    const memory = makeMemory({
      'work-impulse': makeImpulse({ value: 30 }),
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
      (c: unknown[]) => c[0] === 'work-impulse'
    );
    const updatedState = writeCall![1] as WorkImpulseState;
    expect(updatedState.value).toBeGreaterThan(30);
  });

  it('bypasses impulse gating when work_impulse feature is disabled', async () => {
    const planPhoto = vi.fn(async () => makePhotoIntent());
    const generateImages = vi.fn(async () => ({
      paths: ['/tmp/photo1.jpg'],
      urls: ['https://cdn.example.com/photo1.jpg'],
    }));
    const planPost = vi.fn(async () => makePostIntent());
    const publishPost = vi.fn(async () => ({ media_id: 'media123', success: true }));

    const ctx = makeCtx({
      persona: {
        meta: { name: 'TestChar', tagline: '测试角色' },
        personality: { mbti: 'INFP', core_traits: ['creative'] },
        voice: { language: 'zh', style: '活泼', sample_lines: [] },
        features: { work_impulse: false },
      } as any,
      config: { planPhoto, generateImages, planPost, publishPost },
      memory: makeMemory({
        'work-impulse': makeImpulse({ value: 5 }),
      }),
    });

    const result = await actions['instagram-post'](ctx);
    expect(planPhoto).toHaveBeenCalled();
    expect(publishPost).toHaveBeenCalled();
    expect(result.narrative).toContain('发了一条 Instagram');
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
      'work-impulse': makeImpulse({ value: 90 }),
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
      'work-impulse': makeImpulse({ value: 90 }),
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
      (c: unknown[]) => c[0] === 'work-impulse'
    );
    const lastImpulse = impulseWrites[impulseWrites.length - 1][1] as WorkImpulseState;
    // resetImpulseAfterOutput sets value to 0
    expect(lastImpulse.value).toBe(0);
  });

  it('records post in post-history', async () => {
    const memory = makeMemory({
      'work-impulse': makeImpulse({ value: 90 }),
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
      'work-impulse': makeImpulse({ value: 90 }),
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
      'work-impulse': makeImpulse({ value: 90 }),
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
      'work-impulse': makeImpulse({ value: 90 }),
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
      'work-impulse': makeImpulse({ value: 90 }),
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
      'work-impulse': makeImpulse({ value: 90 }),
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
      'work-impulse': makeImpulse({ value: 50 }),
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
      (c: unknown[]) => c[0] === 'work-impulse'
    );
    const lastImpulse = impulseWrites[impulseWrites.length - 1][1] as WorkImpulseState;
    // 50 - 3 (BASE_DECAY) + 5~15 (accumulation) = 52~62
    expect(lastImpulse.value).toBeGreaterThanOrEqual(47);
    expect(lastImpulse.value).toBeLessThanOrEqual(67);
  });
});

// ── instagram-check-stats action ─────────────────────────────────

describe('instagram/instagram-check-stats', () => {
  it('returns early when checkPostStats not configured', async () => {
    const ctx = makeCtx({
      intent: { id: 'i1', category: 'consume' as const, description: '看看数据', intensity: 4, action: 'instagram-check-stats' },
    });
    const result = await actions['instagram-check-stats'](ctx);
    expect(result.narrative).toContain('未配置');
    expect(result.vitality_cost).toBe(0);
  });

  it('returns when no unchecked posts', async () => {
    const ctx = makeCtx({
      config: { checkPostStats: vi.fn() },
      memory: makeMemory({ 'post-history': { posts: [] } }),
      intent: { id: 'i1', category: 'consume' as const, description: '看数据', intensity: 4, action: 'instagram-check-stats' },
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
      intent: { id: 'i1', category: 'consume' as const, description: '看数据', intensity: 4, action: 'instagram-check-stats' },
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
      intent: { id: 'i1', category: 'consume' as const, description: '看数据', intensity: 4, action: 'instagram-check-stats' },
    });

    await actions['instagram-check-stats'](ctx);
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
      intent: { id: 'i1', category: 'consume' as const, description: '看数据', intensity: 4, action: 'instagram-check-stats' },
    });

    await actions['instagram-check-stats'](ctx);
    expect(checkPostStats).not.toHaveBeenCalled();
  });
});
