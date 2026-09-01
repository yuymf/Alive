import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dispatch } from '../scripts/admin/command-handler';
import { loadChatContext } from '../scripts/host/chat';
import { consumeOutbox, listOutbox } from '../scripts/host/outbox';
import { clearPersonaCache } from '../scripts/persona/persona-loader';
import { resetBasePaths, setPersonaName } from '../scripts/utils/file-utils';
import { clearTimeOverride, setTimeOverride } from '../scripts/utils/time-utils';
import type { EmotionState, MemoryAccessor, SubSkillContext } from '../scripts/router/sub-skill-sdk';
import {
  actions,
  checkCallGate,
  DEFAULT_CALL_STATE,
  defaultTalkToFenggeUrl,
  type CallGateInput,
} from '../sub-skills/voice-call/scripts/index';

function makeEmotion(overrides: Partial<EmotionState> = {}): EmotionState {
  return {
    mood: { valence: 0.4, arousal: 0.5, description: '还行' },
    energy: 0.7,
    stress: 0.2,
    creativity: 0.4,
    sociability: 0.7,
    last_updated: null,
    recent_cause: 'test',
    momentum: { valence: 0, arousal: 0, energy: 0, stress: 0, creativity: 0, sociability: 0, duration_ticks: 0 },
    undertone: { valence: 0.3, arousal: 0.5, energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5 },
    impulse_history: [],
    consecutive_high_stress: 0,
    threshold_break_cooldown: 0,
    ...overrides,
  };
}

function makeGateInput(overrides: Partial<CallGateInput> = {}): CallGateInput {
  return {
    hour: 15,
    emotion: makeEmotion(),
    callState: { ...DEFAULT_CALL_STATE },
    todayStr: '2026-08-31',
    currentTimeISO: '2026-08-31T15:00:00.000Z',
    ...overrides,
  };
}

describe('checkCallGate', () => {
  it('allows when sociable, energized, and in hours', () => {
    const result = checkCallGate(makeGateInput());
    expect(result.allowed).toBe(true);
  });

  it('blocks quiet hours and daily limit', () => {
    expect(checkCallGate(makeGateInput({ hour: 9 })).allowed).toBe(false);
    expect(checkCallGate(makeGateInput({
      callState: { date: '2026-08-31', count: 1, last_sent_at: '2026-08-31T12:00:00.000Z' },
    })).reason).toContain('daily-limit');
  });

  it('blocks low sociability and low energy', () => {
    expect(checkCallGate(makeGateInput({ emotion: makeEmotion({ sociability: 0.1 }) })).allowed).toBe(false);
    expect(checkCallGate(makeGateInput({ emotion: makeEmotion({ energy: 0.1 }) })).allowed).toBe(false);
  });
});

describe('voice-call action', () => {
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
        meta: { name: '峰哥', tagline: '街头社会学家' },
        personality: { mbti: 'ENTP', core_traits: ['直白'] },
        voice: { language: 'zh', style: '短句，先判断', sample_lines: ['这是个好事儿啊'] },
      } as SubSkillContext['persona'],
      emotion: makeEmotion(),
      vitality: 80,
      confidence: 1,
      intent: { id: 'i1', category: 'connect', description: '想听听对方最近怎么样', intensity: 6, action: 'call-owner' },
      memory: makeMemory(),
      socialGraph: { getRelations: vi.fn(() => []), updateRelation: vi.fn() },
      llm: {
        callJSON: vi.fn(async () => ({ should_call: true, invitation: '有空接个电话吗？这不好事吗。', reason: '想听人声' })),
        call: vi.fn(async () => ''),
      },
      config: {},
      ...overrides,
    };
  }

  const prevHome = process.env.ALIVE_HOME;
  let tmp = '';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-call-'));
    process.env.ALIVE_HOME = tmp;
    resetBasePaths();
    setTimeOverride(new Date('2026-08-31T15:00:00'));
  });

  afterEach(() => {
    clearTimeOverride();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.ALIVE_HOME;
    else process.env.ALIVE_HOME = prevHome;
    resetBasePaths();
  });

  it('writes a call outbox item when LLM wants to call', async () => {
    const result = await actions['call-owner'](makeCtx());
    expect(result.narrative).toContain('发起通话');
    const items = listOutbox();
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('call');
    expect(items[0].joinUrl).toBe(defaultTalkToFenggeUrl());
    expect(items[0].text).toContain('接个电话');
  });

  it('skips outbox when gate blocks', async () => {
    const result = await actions['call-owner'](makeCtx({ emotion: makeEmotion({ sociability: 0.1 }) }));
    expect(result.vitality_cost).toBe(0);
    expect(listOutbox()).toHaveLength(0);
  });
});

describe('/alive call', () => {
  const prevHome = process.env.ALIVE_HOME;
  const prevPersona = process.env.ALIVE_PERSONA;
  let tmp = '';

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.ALIVE_HOME;
    else process.env.ALIVE_HOME = prevHome;
    if (prevPersona === undefined) delete process.env.ALIVE_PERSONA;
    else process.env.ALIVE_PERSONA = prevPersona;
    resetBasePaths();
    clearPersonaCache();
    consumeOutbox();
  });

  it('admin call writes invitation; chat load shows join URL', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-call-admin-'));
    process.env.ALIVE_HOME = tmp;
    delete process.env.ALIVE_PERSONA;
    resetBasePaths();
    setPersonaName('minase');
    clearPersonaCache();
    const { initMemory, repoRootFromHere } = await import('../scripts/host/install');
    initMemory(tmp, 'minase', repoRootFromHere());

    const result = await dispatch('/alive call');
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('通话');
    expect(result.output).toContain('127.0.0.1:8766');
    expect(result.output).toContain('通话页');
    expect(result.output).not.toContain('不跑 LiveKit');

    const ctx = loadChatContext();
    expect(ctx.outbox[0].kind).toBe('call');
    expect(ctx.markdown).toContain('join:');
    expect(ctx.markdown).toContain('127.0.0.1:8766');
  });
});
