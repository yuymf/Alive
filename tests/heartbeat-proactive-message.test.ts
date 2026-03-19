import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setBasePaths, resetBasePaths } from '../skill/scripts/file-utils';
import { setTimeOverride, clearTimeOverride } from '../skill/scripts/time-utils';
import {
  checkOutreachGate,
  DEFAULT_OUTREACH,
  type OutreachGateInput,
  type OutreachState,
} from '../skill/scripts/heartbeat-outreach';
import type { EmotionState } from '../skill/scripts/types';

let tmpDir: string;

function makeEmotion(overrides: Partial<EmotionState> = {}): EmotionState {
  return {
    mood: { valence: 0.4, arousal: 0.5, description: '还行' },
    energy: 0.6,
    stress: 0.2,
    creativity: 0.4,
    sociability: 0.6,
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

function makeGateInput(overrides: Partial<OutreachGateInput> = {}): OutreachGateInput {
  return {
    hour: 14,
    emotion: makeEmotion(),
    outreachState: { ...DEFAULT_OUTREACH },
    todayStr: '2026-03-19',
    currentTimeISO: '2026-03-19T14:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minase-outreach-'));
  setBasePaths(tmpDir, tmpDir);
  fs.mkdirSync(path.join(tmpDir, 'relations', 'social', 'instagram'), { recursive: true });
});

afterEach(() => {
  clearTimeOverride();
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Gate tests ────────────────────────────────────────────────────

describe('checkOutreachGate', () => {
  it('allows when all conditions met', () => {
    const result = checkOutreachGate(makeGateInput());
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('ok');
  });

  describe('quiet hours', () => {
    it('blocks before active hours', () => {
      const result = checkOutreachGate(makeGateInput({ hour: 8 }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('quiet-hours');
    });

    it('blocks after active hours', () => {
      const result = checkOutreachGate(makeGateInput({ hour: 23 }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('quiet-hours');
    });

    it('allows at boundary start (10)', () => {
      const result = checkOutreachGate(makeGateInput({ hour: 10 }));
      expect(result.allowed).toBe(true);
    });

    it('allows at boundary end (21)', () => {
      const result = checkOutreachGate(makeGateInput({ hour: 21 }));
      expect(result.allowed).toBe(true);
    });
  });

  describe('daily limit', () => {
    it('blocks when daily limit reached', () => {
      const state: OutreachState = {
        date: '2026-03-19',
        count: 2,
        last_sent_at: '2026-03-19T10:00:00.000Z',
        last_message: 'test',
      };
      const result = checkOutreachGate(makeGateInput({ outreachState: state }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('daily-limit');
    });

    it('resets count on new day', () => {
      const state: OutreachState = {
        date: '2026-03-18', // yesterday
        count: 5,
        last_sent_at: '2026-03-18T10:00:00.000Z',
        last_message: 'test',
      };
      // Cooldown check: 28 hours elapsed, which exceeds 4h
      const result = checkOutreachGate(makeGateInput({ outreachState: state }));
      expect(result.allowed).toBe(true);
    });
  });

  describe('cooldown', () => {
    it('blocks within cooldown period', () => {
      const state: OutreachState = {
        date: '2026-03-19',
        count: 1,
        last_sent_at: '2026-03-19T12:00:00.000Z', // 2h ago
        last_message: 'test',
      };
      const result = checkOutreachGate(makeGateInput({ outreachState: state }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('cooldown');
    });

    it('allows after cooldown expires', () => {
      const state: OutreachState = {
        date: '2026-03-19',
        count: 1,
        last_sent_at: '2026-03-19T09:00:00.000Z', // 5h ago
        last_message: 'test',
      };
      const result = checkOutreachGate(makeGateInput({ outreachState: state }));
      expect(result.allowed).toBe(true);
    });
  });

  describe('emotion gates', () => {
    it('blocks on low sociability', () => {
      const emotion = makeEmotion({ sociability: 0.2 });
      const result = checkOutreachGate(makeGateInput({ emotion }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('low-sociability');
    });

    it('blocks on very low valence', () => {
      const emotion = makeEmotion({
        mood: { valence: -0.4, arousal: 0.5, description: '很低落' },
      });
      const result = checkOutreachGate(makeGateInput({ emotion }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('low-valence');
    });

    it('allows with moderate negative valence', () => {
      const emotion = makeEmotion({
        mood: { valence: -0.1, arousal: 0.5, description: '有点低' },
      });
      const result = checkOutreachGate(makeGateInput({ emotion }));
      expect(result.allowed).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles fresh state (no prior sends)', () => {
      const result = checkOutreachGate(makeGateInput({
        outreachState: DEFAULT_OUTREACH,
      }));
      expect(result.allowed).toBe(true);
    });

    it('priority: quiet hours checked before daily limit', () => {
      // Even with fresh state, quiet hours should block
      const state: OutreachState = { date: '', count: 0, last_sent_at: null, last_message: null };
      const result = checkOutreachGate(makeGateInput({ hour: 6, outreachState: state }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('quiet-hours');
    });
  });
});

// ── Routing regex test ────────────────────────────────────────────

describe('send-message routing regex', () => {
  const regex = /send.message|发消息|聊天|分享|找.+说/;

  it('matches "send-message"', () => {
    expect(regex.test('send-message')).toBe(true);
  });

  it('matches "send_message"', () => {
    expect(regex.test('send_message')).toBe(true);
  });

  it('matches "发消息"', () => {
    expect(regex.test('发消息')).toBe(true);
  });

  it('matches "想找人聊天"', () => {
    expect(regex.test('想找人聊天')).toBe(true);
  });

  it('matches "想分享"', () => {
    expect(regex.test('想分享给朋友')).toBe(true);
  });

  it('matches "找朋友说"', () => {
    expect(regex.test('找朋友说说')).toBe(true);
  });

  it('does not match "post-pipeline"', () => {
    expect(regex.test('post-pipeline')).toBe(false);
  });

  it('does not match "search-pipeline"', () => {
    expect(regex.test('search-pipeline')).toBe(false);
  });

  it('does not match "social-engagement"', () => {
    expect(regex.test('social-engagement')).toBe(false);
  });
});
