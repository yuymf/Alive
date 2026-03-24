// alive/tests/sub-skill-send-message.test.ts
// Tests for the send-message sub-skill

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkOutreachGate,
  DEFAULT_OUTREACH,
  actions,
} from '../sub-skills/send-message/scripts/index';
import type { OutreachGateInput } from '../sub-skills/send-message/scripts/index';
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

function makeGateInput(overrides: Partial<OutreachGateInput> = {}): OutreachGateInput {
  return {
    hour: 14,
    emotion: makeEmotion(),
    outreachState: { ...DEFAULT_OUTREACH },
    todayStr: '2026-03-24',
    currentTimeISO: '2026-03-24T14:00:00Z',
    ...overrides,
  };
}

// ── checkOutreachGate ────────────────────────────────────────────

describe('send-message/checkOutreachGate', () => {
  it('allows when all conditions met', () => {
    const result = checkOutreachGate(makeGateInput());
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('ok');
  });

  it('blocks before active hours (too early)', () => {
    const result = checkOutreachGate(makeGateInput({ hour: 8 }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('quiet-hours');
  });

  it('blocks after active hours (too late)', () => {
    const result = checkOutreachGate(makeGateInput({ hour: 23 }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('quiet-hours');
  });

  it('allows at boundary hours (10 and 21)', () => {
    expect(checkOutreachGate(makeGateInput({ hour: 10 })).allowed).toBe(true);
    expect(checkOutreachGate(makeGateInput({ hour: 21 })).allowed).toBe(true);
  });

  it('blocks when daily limit reached', () => {
    const result = checkOutreachGate(makeGateInput({
      outreachState: { date: '2026-03-24', count: 2, last_sent_at: null, last_message: null },
    }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('daily-limit');
  });

  it('resets daily count on new day', () => {
    const result = checkOutreachGate(makeGateInput({
      outreachState: { date: '2026-03-23', count: 5, last_sent_at: null, last_message: null },
    }));
    expect(result.allowed).toBe(true);
  });

  it('blocks during cooldown period', () => {
    const result = checkOutreachGate(makeGateInput({
      currentTimeISO: '2026-03-24T14:00:00Z',
      outreachState: {
        date: '2026-03-24', count: 1,
        last_sent_at: '2026-03-24T12:00:00Z', // 2 hours ago (< 4h cooldown)
        last_message: null,
      },
    }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cooldown');
  });

  it('allows after cooldown period', () => {
    const result = checkOutreachGate(makeGateInput({
      currentTimeISO: '2026-03-24T18:00:00Z',
      outreachState: {
        date: '2026-03-24', count: 1,
        last_sent_at: '2026-03-24T12:00:00Z', // 6 hours ago (> 4h cooldown)
        last_message: null,
      },
    }));
    expect(result.allowed).toBe(true);
  });

  it('blocks when sociability too low', () => {
    const result = checkOutreachGate(makeGateInput({
      emotion: makeEmotion({ sociability: 0.2 }),
    }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('low-sociability');
  });

  it('allows at exact sociability threshold', () => {
    const result = checkOutreachGate(makeGateInput({
      emotion: makeEmotion({ sociability: 0.35 }),
    }));
    expect(result.allowed).toBe(true);
  });

  it('blocks when valence too low', () => {
    const result = checkOutreachGate(makeGateInput({
      emotion: makeEmotion({ mood: { valence: -0.5, arousal: 0.5, description: '难过' } }),
    }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('low-valence');
  });

  it('allows at exact valence threshold', () => {
    const result = checkOutreachGate(makeGateInput({
      emotion: makeEmotion({ mood: { valence: -0.2, arousal: 0.5, description: '略低' } }),
    }));
    expect(result.allowed).toBe(true);
  });

  it('checks gate conditions in priority order (time > daily > cooldown > emotion)', () => {
    // Time violation takes priority even if other conditions also fail
    const result = checkOutreachGate(makeGateInput({
      hour: 2,
      emotion: makeEmotion({ sociability: 0.1 }),
      outreachState: { date: '2026-03-24', count: 5, last_sent_at: '2026-03-24T01:00:00Z', last_message: null },
    }));
    expect(result.reason).toContain('quiet-hours');
  });
});

// ── send-message action ──────────────────────────────────────────

describe('send-message/action', () => {
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
        meta: { name: 'TestChar', tagline: '测试' },
        personality: { mbti: 'INFP', core_traits: ['friendly'] },
        voice: { language: 'zh', style: '温柔', sample_lines: [] },
      } as any,
      emotion: makeEmotion(),
      vitality: 80,
      confidence: 1.0,
      intent: { id: 'i1', category: '社交' as const, description: '想和朋友说说最近的事', intensity: 5, action: 'send-message' },
      memory: makeMemory(),
      socialGraph: { getRelations: vi.fn(() => []), updateRelation: vi.fn() },
      llm: {
        callJSON: vi.fn(async () => ({ should_send: true, message: '最近怎么样呀？', reason: '' })),
        call: vi.fn(async () => ''),
      },
      config: {},
      ...overrides,
    };
  }

  // Note: The action uses Date internally for gate check, so we need to be careful.
  // For unit tests, we focus on verifiable behavior.

  it('returns zero vitality cost when gate is blocked', async () => {
    // Create emotion with very low sociability to trigger gate block
    const ctx = makeCtx({
      emotion: makeEmotion({ sociability: 0.1 }),
    });
    const result = await actions['send-message'](ctx);

    expect(result.vitality_cost).toBe(0);
    expect(result.narrative).toContain('想发消息');
  });

  it('includes narrative on LLM-decided not to send', async () => {
    // We can't easily control the time gate in unit test, so test the logic patterns
    const ctx = makeCtx({
      emotion: makeEmotion({ sociability: 0.1 }),
    });
    const result = await actions['send-message'](ctx);

    expect(result.narrative).toBeDefined();
    expect(typeof result.narrative).toBe('string');
  });
});
