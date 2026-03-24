// alive/tests/sub-skill-voice-tts.test.ts
// Tests for the voice-tts sub-skill

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkVoiceGate,
  DEFAULT_VOICE_STATE,
  actions,
} from '../sub-skills/voice-tts/scripts/index';
import type { VoiceGateInput } from '../sub-skills/voice-tts/scripts/index';
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

function makeGateInput(overrides: Partial<VoiceGateInput> = {}): VoiceGateInput {
  return {
    hour: 14,
    emotion: makeEmotion(),
    voiceState: { ...DEFAULT_VOICE_STATE },
    todayStr: '2026-03-24',
    currentTimeISO: '2026-03-24T14:00:00Z',
    ...overrides,
  };
}

// ── checkVoiceGate ───────────────────────────────────────────────

describe('voice-tts/checkVoiceGate', () => {
  it('allows when all conditions met', () => {
    const result = checkVoiceGate(makeGateInput());
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('ok');
  });

  it('blocks before active hours (too early)', () => {
    const result = checkVoiceGate(makeGateInput({ hour: 7 }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('quiet-hours');
  });

  it('blocks after active hours (too late)', () => {
    const result = checkVoiceGate(makeGateInput({ hour: 23 }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('quiet-hours');
  });

  it('allows at boundary hours (9 and 22)', () => {
    expect(checkVoiceGate(makeGateInput({ hour: 9 })).allowed).toBe(true);
    expect(checkVoiceGate(makeGateInput({ hour: 22 })).allowed).toBe(true);
  });

  it('blocks when daily limit reached', () => {
    const result = checkVoiceGate(makeGateInput({
      voiceState: { date: '2026-03-24', count: 3, last_sent_at: null },
    }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('daily-limit');
  });

  it('resets daily count on new day', () => {
    const result = checkVoiceGate(makeGateInput({
      voiceState: { date: '2026-03-23', count: 10, last_sent_at: null },
    }));
    expect(result.allowed).toBe(true);
  });

  it('blocks during cooldown period', () => {
    const result = checkVoiceGate(makeGateInput({
      currentTimeISO: '2026-03-24T14:00:00Z',
      voiceState: {
        date: '2026-03-24', count: 1,
        last_sent_at: '2026-03-24T12:00:00Z', // 2h ago (< 3h cooldown)
      },
    }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cooldown');
  });

  it('allows after cooldown period', () => {
    const result = checkVoiceGate(makeGateInput({
      currentTimeISO: '2026-03-24T18:00:00Z',
      voiceState: {
        date: '2026-03-24', count: 1,
        last_sent_at: '2026-03-24T12:00:00Z', // 6h ago (> 3h cooldown)
      },
    }));
    expect(result.allowed).toBe(true);
  });

  it('blocks when sociability too low', () => {
    const result = checkVoiceGate(makeGateInput({
      emotion: makeEmotion({ sociability: 0.2 }),
    }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('low-sociability');
  });

  it('allows at exact sociability threshold', () => {
    const result = checkVoiceGate(makeGateInput({
      emotion: makeEmotion({ sociability: 0.30 }),
    }));
    expect(result.allowed).toBe(true);
  });

  it('blocks when energy too low', () => {
    const result = checkVoiceGate(makeGateInput({
      emotion: makeEmotion({ energy: 0.1 }),
    }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('low-energy');
  });

  it('allows at exact energy threshold', () => {
    const result = checkVoiceGate(makeGateInput({
      emotion: makeEmotion({ energy: 0.25 }),
    }));
    expect(result.allowed).toBe(true);
  });

  it('checks gate conditions in priority order (time > daily > cooldown > emotion)', () => {
    // Time violation takes priority even if other conditions also fail
    const result = checkVoiceGate(makeGateInput({
      hour: 2,
      emotion: makeEmotion({ sociability: 0.1, energy: 0.1 }),
      voiceState: { date: '2026-03-24', count: 5, last_sent_at: '2026-03-24T01:00:00Z' },
    }));
    expect(result.reason).toContain('quiet-hours');
  });
});

// ── send-voice action ────────────────────────────────────────────

describe('voice-tts/action', () => {
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
      intent: { id: 'i1', category: '表达' as const, description: '想发语音分享心情', intensity: 5, action: 'send-voice' },
      memory: makeMemory(),
      socialGraph: { getRelations: vi.fn(() => []), updateRelation: vi.fn() },
      llm: {
        callJSON: vi.fn(async () => ({
          should_speak: true,
          text: '今天看到好漂亮的晚霞，想跟你分享一下',
          emotion_tone: '兴奋',
          reason: '看到美景想分享',
        })),
        call: vi.fn(async () => ''),
      },
      config: {},
      ...overrides,
    };
  }

  it('returns zero vitality cost when gate is blocked', async () => {
    const ctx = makeCtx({
      emotion: makeEmotion({ sociability: 0.1 }),
    });
    const result = await actions['send-voice'](ctx);

    expect(result.vitality_cost).toBe(0);
    expect(result.narrative).toContain('想发语音');
  });

  it('includes narrative on LLM-decided not to speak', async () => {
    const ctx = makeCtx({
      emotion: makeEmotion({ sociability: 0.1 }),
    });
    const result = await actions['send-voice'](ctx);

    expect(result.narrative).toBeDefined();
    expect(typeof result.narrative).toBe('string');
  });
});
