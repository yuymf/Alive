// alive/tests/flow.test.ts
// Tests for the generalized flow/drift state machine

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkFlowEntry,
  checkDriftEntry,
  checkFlowExit,
  checkDriftExit,
  tickFlow,
  resetFlow,
  generateFlowDiary,
  generateDriftDiary,
  computeVoiceDirective,
  shouldEvolveFlow,
} from '../scripts/engines/flow';
import { FlowState, IntentPool, DEFAULT_FLOW_STATE, EmotionState, DEFAULT_MOMENTUM, DEFAULT_UNDERTONE } from '../scripts/utils/types';
import { setTimeOverride, createLocalDate } from '../scripts/utils/time-utils';

vi.mock('../scripts/persona/persona-loader', () => ({
  getEmotionBaseline: () => ({ valence: 0.3, arousal: 0.5, energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5 }),
  buildVoiceSignature: () => '\n(test voice)',
}));

function makePool(intents: Array<{ category: string; intensity: number; resistance: number; description?: string }>): IntentPool {
  return {
    intents: intents.map((i, idx) => ({
      id: `i-${idx}`, category: i.category as any, description: i.description ?? i.category,
      intensity: i.intensity, source: 'accumulation' as const, born_at: '', decay_rate: 0.5,
      satisfied_at: null, resistance: i.resistance, skipped_count: 0, last_attempted: null,
    })),
    last_updated: null,
  };
}

function makeEmotion(overrides: Partial<EmotionState> = {}): EmotionState {
  return {
    mood: { valence: 0.3, arousal: 0.5, description: '普通' },
    energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
    last_updated: null, recent_cause: 'test',
    momentum: { ...DEFAULT_MOMENTUM }, undertone: { ...DEFAULT_UNDERTONE },
    impulse_history: [], consecutive_high_stress: 0, threshold_break_cooldown: 0,
    ...overrides,
  };
}

beforeEach(() => {
  setTimeOverride(createLocalDate(2026, 3, 24, 14, 0));
});

// ──── checkFlowEntry ────

describe('checkFlowEntry', () => {
  it('enters flow when last action has a high-intensity matching intent and sufficient energy', () => {
    const pool = makePool([{ category: 'produce', intensity: 8.0, resistance: 2.0 }]);
    const result = checkFlowEntry(
      { ...DEFAULT_FLOW_STATE },
      { category: 'produce', activity: '画COS照' },
      pool,
      0.6, // energy above threshold
      0,   // no cooldown
    );
    expect(result.status).toBe('flow');
    expect(result.category).toBe('produce');
    expect(result.activity).toBe('画COS照');
  });

  it('does not enter flow when already in flow', () => {
    const existing: FlowState = { status: 'flow', activity: '画画', category: 'produce', entered_at: '', duration_ticks: 3, interrupt_chance: 0.2, cooldown_remaining: 0 };
    const pool = makePool([{ category: 'produce', intensity: 8.0, resistance: 2.0 }]);
    const result = checkFlowEntry(existing, { category: 'produce', activity: '画COS照' }, pool, 0.6, 0);
    expect(result).toEqual(existing);
  });

  it('does not enter flow without a matching intent above threshold', () => {
    const pool = makePool([{ category: 'produce', intensity: 4.0, resistance: 2.0 }]); // net 2.0 < 2.5 threshold
    const result = checkFlowEntry(
      { ...DEFAULT_FLOW_STATE },
      { category: 'produce', activity: '画画' },
      pool,
      0.6,
      0,
    );
    expect(result.status).toBe('none');
  });

  it('does not enter flow without last action', () => {
    const pool = makePool([{ category: 'produce', intensity: 8.0, resistance: 2.0 }]);
    const result = checkFlowEntry({ ...DEFAULT_FLOW_STATE }, null, pool, 0.6, 0);
    expect(result.status).toBe('none');
  });

  it('does not enter flow when energy is too low', () => {
    const pool = makePool([{ category: 'produce', intensity: 8.0, resistance: 2.0 }]);
    const result = checkFlowEntry(
      { ...DEFAULT_FLOW_STATE },
      { category: 'produce', activity: '画画' },
      pool,
      0.15, // below FLOW_MIN_ENERGY (0.30)
      0,
    );
    expect(result.status).toBe('none');
  });

  it('does not enter flow during cooldown period', () => {
    const pool = makePool([{ category: 'produce', intensity: 8.0, resistance: 2.0 }]);
    const result = checkFlowEntry(
      { ...DEFAULT_FLOW_STATE, cooldown_remaining: 2 },
      { category: 'produce', activity: '画画' },
      pool,
      0.6,
      2, // cooldown active
    );
    expect(result.status).toBe('none');
  });

  it('does not enter flow for 休息 category', () => {
    const pool = makePool([{ category: 'rest', intensity: 8.0, resistance: 2.0 }]);
    const result = checkFlowEntry(
      { ...DEFAULT_FLOW_STATE },
      { category: 'rest', activity: '午睡' },
      pool,
      0.6,
      0,
    );
    expect(result.status).toBe('none');
  });

  it('does not enter flow for 窥屏 category', () => {
    const pool = makePool([{ category: 'consume', intensity: 8.0, resistance: 2.0 }]);
    const result = checkFlowEntry(
      { ...DEFAULT_FLOW_STATE },
      { category: 'consume', activity: '刷手机' },
      pool,
      0.6,
      0,
    );
    expect(result.status).toBe('none');
  });
});

// ──── checkDriftEntry ────

describe('checkDriftEntry', () => {
  it('enters drift when vitality is low and no strong intents', () => {
    const pool = makePool([{ category: 'consume', intensity: 0.5, resistance: 0.5 }]);
    const result = checkDriftEntry({ ...DEFAULT_FLOW_STATE }, 30, pool, 0.1);
    expect(result.status).toBe('drift');
  });

  it('does not enter drift when vitality is high', () => {
    const pool = makePool([]);
    const result = checkDriftEntry({ ...DEFAULT_FLOW_STATE }, 60, pool, 0.1);
    expect(result.status).toBe('none');
  });

  it('does not enter drift when there is a strong intent', () => {
    const pool = makePool([{ category: 'produce', intensity: 5.0, resistance: 2.0 }]); // net 3.0 > 1.0
    const result = checkDriftEntry({ ...DEFAULT_FLOW_STATE }, 30, pool, 0.1);
    expect(result.status).toBe('none');
  });

  it('does not enter drift when stress is high', () => {
    const pool = makePool([]);
    const result = checkDriftEntry({ ...DEFAULT_FLOW_STATE }, 30, pool, 0.5);
    expect(result.status).toBe('none');
  });
});

// ──── checkFlowExit ────

describe('checkFlowExit', () => {
  it('exits flow when intent drops below resistance', () => {
    const flow: FlowState = { status: 'flow', activity: '画画', category: 'produce', entered_at: '', duration_ticks: 1, interrupt_chance: 0.2, cooldown_remaining: 0 };
    const pool = makePool([{ category: 'produce', intensity: 2.0, resistance: 4.0 }]); // below resistance
    const { shouldExit, reason } = checkFlowExit(flow, pool, 60, null, false, () => 1);
    expect(shouldExit).toBe(true);
    expect(reason).toBe('做够了');
  });

  it('exits flow when vitality is critical', () => {
    const flow: FlowState = { status: 'flow', activity: '画画', category: 'produce', entered_at: '', duration_ticks: 1, interrupt_chance: 0.2, cooldown_remaining: 0 };
    const pool = makePool([{ category: 'produce', intensity: 8.0, resistance: 2.0 }]);
    const { shouldExit, reason } = checkFlowExit(flow, pool, 15, null, false, () => 1);
    expect(shouldExit).toBe(true);
    expect(reason).toBe('累到不行');
  });

  it('exits flow on random interrupt', () => {
    const flow: FlowState = { status: 'flow', activity: '画画', category: 'produce', entered_at: '', duration_ticks: 1, interrupt_chance: 0.5, cooldown_remaining: 0 };
    const pool = makePool([{ category: 'produce', intensity: 8.0, resistance: 2.0 }]);
    const { shouldExit } = checkFlowExit(flow, pool, 60, null, false, () => 0.3); // rng < 0.5
    expect(shouldExit).toBe(true);
  });

  it('does not exit when conditions are fine', () => {
    const flow: FlowState = { status: 'flow', activity: '画画', category: 'produce', entered_at: '', duration_ticks: 1, interrupt_chance: 0.15, cooldown_remaining: 0 };
    const pool = makePool([{ category: 'produce', intensity: 8.0, resistance: 2.0 }]);
    const { shouldExit } = checkFlowExit(flow, pool, 60, null, false, () => 0.99);
    expect(shouldExit).toBe(false);
  });

  it('forces exit when duration_ticks >= MAX_FLOW_TICKS (3)', () => {
    const flow: FlowState = { status: 'flow', activity: '画画', category: 'produce', entered_at: '', duration_ticks: 3, interrupt_chance: 0.5, cooldown_remaining: 0 };
    const pool = makePool([{ category: 'produce', intensity: 8.0, resistance: 2.0 }]);
    // rng returns 1.0 so random interrupt won't trigger — only max_ticks should catch this
    const { shouldExit, reason } = checkFlowExit(flow, pool, 60, null, false, () => 1);
    expect(shouldExit).toBe(true);
    expect(reason).toBe('沉浸太久了，该换换脑子');
  });

  it('does not force exit when duration_ticks < MAX_FLOW_TICKS', () => {
    const flow: FlowState = { status: 'flow', activity: '画画', category: 'produce', entered_at: '', duration_ticks: 0, interrupt_chance: 0.15, cooldown_remaining: 0 };
    const pool = makePool([{ category: 'produce', intensity: 8.0, resistance: 2.0 }]);
    const { shouldExit } = checkFlowExit(flow, pool, 60, null, false, () => 1);
    expect(shouldExit).toBe(false);
  });
});

// ──── checkDriftExit ────

describe('checkDriftExit', () => {
  it('exits drift when a strong intent appears', () => {
    const flow: FlowState = { status: 'drift', activity: '刷手机', category: 'consume', entered_at: '', duration_ticks: 1, interrupt_chance: 0.2, cooldown_remaining: 0 };
    const pool = makePool([{ category: 'produce', intensity: 6.0, resistance: 2.0, description: '画画' }]);
    const { shouldExit, reason } = checkDriftExit(flow, pool, 30, false);
    expect(shouldExit).toBe(true);
    expect(reason).toContain('画画');
  });

  it('exits drift on new event', () => {
    const flow: FlowState = { status: 'drift', activity: '刷手机', category: 'consume', entered_at: '', duration_ticks: 1, interrupt_chance: 0.2, cooldown_remaining: 0 };
    const pool = makePool([]);
    const { shouldExit, reason } = checkDriftExit(flow, pool, 30, true);
    expect(shouldExit).toBe(true);
    expect(reason).toBe('有新消息');
  });

  it('exits drift when vitality recovers', () => {
    const flow: FlowState = { status: 'drift', activity: '刷手机', category: 'consume', entered_at: '', duration_ticks: 1, interrupt_chance: 0.2, cooldown_remaining: 0 };
    const pool = makePool([]);
    const { shouldExit, reason } = checkDriftExit(flow, pool, 60, false);
    expect(shouldExit).toBe(true);
    expect(reason).toBe('精神恢复了');
  });

  it('forces exit when duration_ticks >= MAX_DRIFT_TICKS (2)', () => {
    const flow: FlowState = { status: 'drift', activity: '刷手机', category: 'consume', entered_at: '', duration_ticks: 2, interrupt_chance: 0.2, cooldown_remaining: 0 };
    const pool = makePool([]);
    // vitality low, no events, no strong intents — only max_ticks should catch this
    const { shouldExit, reason } = checkDriftExit(flow, pool, 30, false);
    expect(shouldExit).toBe(true);
    expect(reason).toBe('摆烂太久了...该起来动动');
  });

  it('does not force exit when duration_ticks < MAX_DRIFT_TICKS', () => {
    const flow: FlowState = { status: 'drift', activity: '刷手机', category: 'consume', entered_at: '', duration_ticks: 1, interrupt_chance: 0.2, cooldown_remaining: 0 };
    const pool = makePool([]);
    const { shouldExit } = checkDriftExit(flow, pool, 30, false);
    expect(shouldExit).toBe(false);
  });
});

// ──── tickFlow ────

describe('tickFlow', () => {
  it('uses early increment for first 2 ticks', () => {
    const flow: FlowState = { status: 'flow', activity: '画画', category: 'produce', entered_at: '', duration_ticks: 1, interrupt_chance: 0.35, cooldown_remaining: 0 };
    const ticked = tickFlow(flow);
    expect(ticked.duration_ticks).toBe(2);
    expect(ticked.interrupt_chance).toBeCloseTo(0.50); // +0.15 early increment
  });

  it('uses late (higher) increment after 2 ticks', () => {
    const flow: FlowState = { status: 'flow', activity: '画画', category: 'produce', entered_at: '', duration_ticks: 2, interrupt_chance: 0.50, cooldown_remaining: 0 };
    const ticked = tickFlow(flow);
    expect(ticked.duration_ticks).toBe(3);
    expect(ticked.interrupt_chance).toBeCloseTo(0.70); // +0.20 late increment
  });

  it('caps interrupt_chance at 0.85', () => {
    const flow: FlowState = { status: 'flow', activity: '画画', category: 'produce', entered_at: '', duration_ticks: 20, interrupt_chance: 0.84, cooldown_remaining: 0 };
    const ticked = tickFlow(flow);
    expect(ticked.interrupt_chance).toBeLessThanOrEqual(0.85);
  });

  it('decrements cooldown when status is none', () => {
    const flow: FlowState = { ...DEFAULT_FLOW_STATE, cooldown_remaining: 2 };
    const ticked = tickFlow(flow);
    expect(ticked.cooldown_remaining).toBe(1);
  });

  it('does nothing when status is none and no cooldown', () => {
    const flow = { ...DEFAULT_FLOW_STATE };
    const ticked = tickFlow(flow);
    expect(ticked).toEqual(flow);
  });
});

// ──── resetFlow ────

describe('resetFlow', () => {
  it('returns default flow state with cooldown', () => {
    const result = resetFlow();
    expect(result.status).toBe('none');
    expect(result.activity).toBeNull();
    expect(result.duration_ticks).toBe(0);
    expect(result.cooldown_remaining).toBe(1); // FLOW_COOLDOWN_TICKS
  });
});

// ──── generateFlowDiary ────

describe('generateFlowDiary', () => {
  it('generates an early-phase diary for low tick count', () => {
    const flow: FlowState = { status: 'flow', activity: '画COS照', category: 'produce', entered_at: '', duration_ticks: 1, interrupt_chance: 0.2, cooldown_remaining: 0 };
    const diary = generateFlowDiary(flow, makeEmotion(), () => 0);
    expect(diary).toContain('画COS照');
  });

  it('generates a deep-phase diary for high tick count', () => {
    const flow: FlowState = { status: 'flow', activity: '画COS照', category: 'produce', entered_at: '', duration_ticks: 3, interrupt_chance: 0.2, cooldown_remaining: 0 };
    const diary = generateFlowDiary(flow, makeEmotion(), () => 0);
    expect(diary).toContain('画COS照');
  });

  it('adds stress note when stressed', () => {
    const flow: FlowState = { status: 'flow', activity: '画画', category: 'produce', entered_at: '', duration_ticks: 3, interrupt_chance: 0.2, cooldown_remaining: 0 };
    const diary = generateFlowDiary(flow, makeEmotion({ stress: 0.6 }), () => 0);
    expect(diary).toContain('累');
  });

  it('adds happy note when mood is good', () => {
    const flow: FlowState = { status: 'flow', activity: '画画', category: 'produce', entered_at: '', duration_ticks: 1, interrupt_chance: 0.2, cooldown_remaining: 0 };
    const diary = generateFlowDiary(flow, makeEmotion({ mood: { valence: 0.6, arousal: 0.5, description: '开心' } }), () => 0);
    expect(diary).toContain('心情很好');
  });

  it('early and deep templates produce different outputs', () => {
    const earlyFlow: FlowState = { status: 'flow', activity: '画画', category: 'produce', entered_at: '', duration_ticks: 1, interrupt_chance: 0.2, cooldown_remaining: 0 };
    const deepFlow: FlowState = { status: 'flow', activity: '画画', category: 'produce', entered_at: '', duration_ticks: 3, interrupt_chance: 0.2, cooldown_remaining: 0 };
    const earlyDiary = generateFlowDiary(earlyFlow, makeEmotion(), () => 0);
    const deepDiary = generateFlowDiary(deepFlow, makeEmotion(), () => 0);
    // Both contain activity but come from different template sets
    expect(earlyDiary).toContain('画画');
    expect(deepDiary).toContain('画画');
    // The first template from early is different from the first template from deep
    expect(earlyDiary).not.toBe(deepDiary);
  });

  it('preserves activity text containing replacement metacharacters literally', () => {
    const flow: FlowState = { status: 'flow', activity: '$& cosplay (draft)', category: 'produce', entered_at: '', duration_ticks: 1, interrupt_chance: 0.2, cooldown_remaining: 0 };
    const diary = generateFlowDiary(flow, makeEmotion(), () => 0);
    expect(diary).toContain('$& cosplay (draft)');
    expect(diary).not.toContain('{activity}');
  });
});

// ──── generateDriftDiary ────

describe('generateDriftDiary', () => {
  it('generates a drift diary entry', () => {
    const flow: FlowState = { status: 'drift', activity: '刷手机', category: 'consume', entered_at: '', duration_ticks: 5, interrupt_chance: 0.2, cooldown_remaining: 0 };
    const diary = generateDriftDiary(flow, () => 0);
    expect(diary).toBeTruthy();
    expect(diary.length).toBeGreaterThan(0);
  });
});

// ──── computeVoiceDirective ────

describe('computeVoiceDirective', () => {
  it('returns emotional burst voice for threshold break', () => {
    const directive = computeVoiceDirective('none', makeEmotion(), true);
    expect(directive).toContain('情绪化');
  });

  it('returns fragmented voice for flow state', () => {
    const directive = computeVoiceDirective('flow', makeEmotion(), false);
    expect(directive).toContain('碎片化');
  });

  it('returns stream-of-consciousness voice for drift', () => {
    const directive = computeVoiceDirective('drift', makeEmotion(), false);
    expect(directive).toContain('意识流');
  });

  it('returns happy voice for positive mood', () => {
    const directive = computeVoiceDirective('none', makeEmotion({
      mood: { valence: 0.6, arousal: 0.6, description: '开心' },
    }), false);
    expect(directive).toContain('轻快');
  });

  it('returns sad voice for negative mood', () => {
    const directive = computeVoiceDirective('none', makeEmotion({
      mood: { valence: -0.4, arousal: 0.3, description: '低落' },
    }), false);
    expect(directive).toContain('低落');
  });
});

// ──── shouldEvolveFlow ────

describe('shouldEvolveFlow', () => {
  it('returns true for even ticks > 0', () => {
    expect(shouldEvolveFlow(2)).toBe(true);
    expect(shouldEvolveFlow(4)).toBe(true);
  });

  it('returns false for odd ticks and tick 0', () => {
    expect(shouldEvolveFlow(0)).toBe(false);
    expect(shouldEvolveFlow(1)).toBe(false);
    expect(shouldEvolveFlow(3)).toBe(false);
  });
});
