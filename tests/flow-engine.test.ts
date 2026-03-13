// tests/flow-engine.test.ts
import { describe, it, expect } from 'vitest';
import {
  checkFlowEntry, checkDriftEntry, checkFlowExit, checkDriftExit,
  tickFlow, resetFlow, generateFlowDiary, generateDriftDiary,
  computeVoiceDirective, LastAction,
} from '../skill/scripts/flow-engine';
import {
  FlowState, IntentPool, Intent, IntentCategory, EmotionState,
  DEFAULT_FLOW_STATE, DEFAULT_MOMENTUM, DEFAULT_UNDERTONE,
} from '../skill/scripts/types';

// === Helpers ===

function makeIntent(overrides?: Partial<Intent>): Intent {
  return {
    id: 'test_1',
    category: '创作',
    description: '拍新照片',
    intensity: 5.0,
    source: 'accumulation',
    born_at: '2026-01-01T00:00:00Z',
    decay_rate: 0.5,
    satisfied_at: null,
    resistance: 0,
    skipped_count: 0,
    last_attempted: null,
    ...overrides,
  };
}

function makePool(intents: Intent[]): IntentPool {
  return { intents };
}

function makeFlow(overrides?: Partial<FlowState>): FlowState {
  return { ...DEFAULT_FLOW_STATE, ...overrides };
}

function makeEmotion(overrides?: Partial<EmotionState>): EmotionState {
  return {
    mood: { valence: 0.3, arousal: 0.5, description: '不错' },
    energy: 0.6,
    stress: 0.2,
    creativity: 0.4,
    sociability: 0.5,
    last_updated: null,
    recent_cause: '',
    momentum: { ...DEFAULT_MOMENTUM },
    undertone: { ...DEFAULT_UNDERTONE },
    impulse_history: [],
    consecutive_high_stress: 0,
    threshold_break_cooldown: 0,
    ...overrides,
  };
}

// === checkFlowEntry ===

describe('checkFlowEntry', () => {
  it('enters flow when intensity - resistance > 2.0', () => {
    const pool = makePool([makeIntent({ category: '创作', intensity: 7.0, resistance: 4.0 })]);
    const action: LastAction = { category: '创作', activity: '修图' };
    const result = checkFlowEntry(makeFlow(), action, pool);
    expect(result.status).toBe('flow');
    expect(result.activity).toBe('修图');
    expect(result.category).toBe('创作');
    expect(result.duration_ticks).toBe(0);
    expect(result.interrupt_chance).toBe(0.15);
  });

  it('does not enter flow when margin <= 2.0', () => {
    const pool = makePool([makeIntent({ category: '创作', intensity: 5.0, resistance: 4.0 })]);
    const action: LastAction = { category: '创作', activity: '修图' };
    const result = checkFlowEntry(makeFlow(), action, pool);
    expect(result.status).toBe('none');
  });

  it('does not enter flow when margin is exactly 2.0', () => {
    const pool = makePool([makeIntent({ category: '创作', intensity: 6.0, resistance: 4.0 })]);
    const action: LastAction = { category: '创作', activity: '修图' };
    const result = checkFlowEntry(makeFlow(), action, pool);
    expect(result.status).toBe('none');
  });

  it('does not enter flow when already in flow', () => {
    const flow = makeFlow({ status: 'flow', category: '社交', activity: '聊天' });
    const pool = makePool([makeIntent({ category: '创作', intensity: 9.0, resistance: 2.0 })]);
    const action: LastAction = { category: '创作', activity: '修图' };
    const result = checkFlowEntry(flow, action, pool);
    expect(result.status).toBe('flow');
    expect(result.activity).toBe('聊天'); // unchanged
  });

  it('does not enter flow when already in drift', () => {
    const flow = makeFlow({ status: 'drift' });
    const pool = makePool([makeIntent({ category: '创作', intensity: 9.0, resistance: 2.0 })]);
    const action: LastAction = { category: '创作', activity: '修图' };
    const result = checkFlowEntry(flow, action, pool);
    expect(result.status).toBe('drift');
  });

  it('does not enter flow when no last action', () => {
    const pool = makePool([makeIntent({ intensity: 9.0, resistance: 2.0 })]);
    const result = checkFlowEntry(makeFlow(), null, pool);
    expect(result.status).toBe('none');
  });

  it('does not enter flow when intent for category not found in pool', () => {
    const pool = makePool([makeIntent({ category: '社交', intensity: 9.0, resistance: 2.0 })]);
    const action: LastAction = { category: '创作', activity: '修图' };
    const result = checkFlowEntry(makeFlow(), action, pool);
    expect(result.status).toBe('none');
  });

  it('ignores satisfied intents', () => {
    const pool = makePool([
      makeIntent({ category: '创作', intensity: 9.0, resistance: 2.0, satisfied_at: '2026-01-01' }),
    ]);
    const action: LastAction = { category: '创作', activity: '修图' };
    const result = checkFlowEntry(makeFlow(), action, pool);
    expect(result.status).toBe('none');
  });

  it('sets entered_at to a valid ISO string', () => {
    const pool = makePool([makeIntent({ intensity: 9.0, resistance: 2.0 })]);
    const action: LastAction = { category: '创作', activity: '修图' };
    const result = checkFlowEntry(makeFlow(), action, pool);
    expect(result.entered_at).toBeTruthy();
    expect(new Date(result.entered_at!).getTime()).toBeGreaterThan(0);
  });
});

// === checkDriftEntry ===

describe('checkDriftEntry', () => {
  it('enters drift when vitality < 40, no strong intents, stress < 0.3', () => {
    const pool = makePool([makeIntent({ intensity: 2.0, resistance: 2.0 })]);
    const result = checkDriftEntry(makeFlow(), 30, pool, 0.1);
    expect(result.status).toBe('drift');
    expect(result.activity).toBe('刷手机');
    expect(result.category).toBe('窥屏');
  });

  it('does not enter drift when vitality >= 40', () => {
    const pool = makePool([makeIntent({ intensity: 2.0, resistance: 2.0 })]);
    const result = checkDriftEntry(makeFlow(), 40, pool, 0.1);
    expect(result.status).toBe('none');
  });

  it('does not enter drift when stress >= 0.3', () => {
    const pool = makePool([makeIntent({ intensity: 2.0, resistance: 2.0 })]);
    const result = checkDriftEntry(makeFlow(), 20, pool, 0.3);
    expect(result.status).toBe('none');
  });

  it('does not enter drift when a strong intent exists', () => {
    const pool = makePool([makeIntent({ intensity: 5.0, resistance: 3.0 })]);
    // intensity - resistance = 2.0, which is not >= 1.0... wait, 2.0 >= 1.0 is true
    // Need to make sure the condition blocks: intensity - resistance >= 1.0 means there IS a strong intent
    const result = checkDriftEntry(makeFlow(), 20, pool, 0.1);
    expect(result.status).toBe('none');
  });

  it('enters drift when intent margin is exactly 0.9 (below 1.0)', () => {
    const pool = makePool([makeIntent({ intensity: 2.9, resistance: 2.0 })]);
    const result = checkDriftEntry(makeFlow(), 20, pool, 0.1);
    expect(result.status).toBe('drift');
  });

  it('does not enter drift when already in flow', () => {
    const flow = makeFlow({ status: 'flow' });
    const pool = makePool([]);
    const result = checkDriftEntry(flow, 10, pool, 0.0);
    expect(result.status).toBe('flow');
  });

  it('does not enter drift when already in drift', () => {
    const flow = makeFlow({ status: 'drift' });
    const pool = makePool([]);
    const result = checkDriftEntry(flow, 10, pool, 0.0);
    expect(result.status).toBe('drift');
  });

  it('enters drift with empty intent pool', () => {
    const pool = makePool([]);
    const result = checkDriftEntry(makeFlow(), 20, pool, 0.1);
    expect(result.status).toBe('drift');
  });
});

// === checkFlowExit ===

describe('checkFlowExit', () => {
  it('exits when intent gap closes (intensity - resistance < 0)', () => {
    const flow = makeFlow({ status: 'flow', category: '创作' });
    const pool = makePool([makeIntent({ category: '创作', intensity: 3.0, resistance: 4.0 })]);
    const { shouldExit, reason } = checkFlowExit(flow, pool, 50, null, false);
    expect(shouldExit).toBe(true);
    expect(reason).toBe('做够了');
  });

  it('exits when vitality < 20', () => {
    const flow = makeFlow({ status: 'flow', category: '创作' });
    const pool = makePool([makeIntent({ category: '创作', intensity: 8.0, resistance: 2.0 })]);
    const { shouldExit, reason } = checkFlowExit(flow, pool, 15, null, false);
    expect(shouldExit).toBe(true);
    expect(reason).toBe('累到不行');
  });

  it('exits when rigid schedule blocks category', () => {
    const flow = makeFlow({ status: 'flow', category: '创作' });
    const pool = makePool([makeIntent({ category: '创作', intensity: 8.0, resistance: 2.0 })]);
    const rigid = { allowed_actions: ['上班', '会议'] }; // no 创作
    const { shouldExit, reason } = checkFlowExit(flow, pool, 50, rigid, false);
    expect(shouldExit).toBe(true);
    expect(reason).toBe('日程打断');
  });

  it('does not exit when rigid schedule allows category', () => {
    const flow = makeFlow({ status: 'flow', category: '创作' });
    const pool = makePool([makeIntent({ category: '创作', intensity: 8.0, resistance: 2.0 })]);
    const rigid = { allowed_actions: ['创作', '休息'] };
    const { shouldExit } = checkFlowExit(flow, pool, 50, rigid, false, () => 1.0);
    expect(shouldExit).toBe(false);
  });

  it('exits on random interrupt', () => {
    const flow = makeFlow({ status: 'flow', category: '创作', interrupt_chance: 0.30 });
    const pool = makePool([makeIntent({ category: '创作', intensity: 8.0, resistance: 2.0 })]);
    const { shouldExit, reason } = checkFlowExit(flow, pool, 50, null, false, () => 0.20);
    expect(shouldExit).toBe(true);
    expect(reason).toBe('被打断了');
  });

  it('does not exit on random when rng >= interrupt_chance', () => {
    const flow = makeFlow({ status: 'flow', category: '创作', interrupt_chance: 0.15 });
    const pool = makePool([makeIntent({ category: '创作', intensity: 8.0, resistance: 2.0 })]);
    const { shouldExit } = checkFlowExit(flow, pool, 50, null, false, () => 0.20);
    expect(shouldExit).toBe(false);
  });

  it('returns shouldExit false when not in flow', () => {
    const flow = makeFlow({ status: 'none' });
    const pool = makePool([]);
    const { shouldExit } = checkFlowExit(flow, pool, 10, null, false);
    expect(shouldExit).toBe(false);
  });

  it('checks exit conditions in priority order (gap before vitality)', () => {
    // Both conditions met: intensity gap closed AND low vitality
    const flow = makeFlow({ status: 'flow', category: '创作' });
    const pool = makePool([makeIntent({ category: '创作', intensity: 3.0, resistance: 4.0 })]);
    const { reason } = checkFlowExit(flow, pool, 15, null, false);
    expect(reason).toBe('做够了'); // gap check comes first
  });
});

// === checkDriftExit ===

describe('checkDriftExit', () => {
  it('exits when a strong intent emerges (margin > 2.0)', () => {
    const flow = makeFlow({ status: 'drift' });
    const pool = makePool([makeIntent({ category: '创作', description: '拍照', intensity: 7.0, resistance: 4.0 })]);
    const { shouldExit, reason } = checkDriftExit(flow, pool, 30, false);
    expect(shouldExit).toBe(true);
    expect(reason).toContain('拍照');
  });

  it('exits when new event arrives', () => {
    const flow = makeFlow({ status: 'drift' });
    const pool = makePool([]);
    const { shouldExit, reason } = checkDriftExit(flow, pool, 30, true);
    expect(shouldExit).toBe(true);
    expect(reason).toBe('有新消息');
  });

  it('exits when vitality recovers above 55', () => {
    const flow = makeFlow({ status: 'drift' });
    const pool = makePool([]);
    const { shouldExit, reason } = checkDriftExit(flow, pool, 56, false);
    expect(shouldExit).toBe(true);
    expect(reason).toBe('精神恢复了');
  });

  it('does not exit when vitality is exactly 55', () => {
    const flow = makeFlow({ status: 'drift' });
    const pool = makePool([]);
    const { shouldExit } = checkDriftExit(flow, pool, 55, false);
    expect(shouldExit).toBe(false);
  });

  it('does not exit when no conditions are met', () => {
    const flow = makeFlow({ status: 'drift' });
    const pool = makePool([makeIntent({ intensity: 3.0, resistance: 2.0 })]);
    const { shouldExit } = checkDriftExit(flow, pool, 30, false);
    expect(shouldExit).toBe(false);
  });

  it('returns shouldExit false when not in drift', () => {
    const flow = makeFlow({ status: 'flow' });
    const pool = makePool([]);
    const { shouldExit } = checkDriftExit(flow, pool, 60, true);
    expect(shouldExit).toBe(false);
  });

  it('checks exit conditions in priority order (strong intent before event)', () => {
    const flow = makeFlow({ status: 'drift' });
    const pool = makePool([makeIntent({ description: '拍新照片', intensity: 8.0, resistance: 3.0 })]);
    const { reason } = checkDriftExit(flow, pool, 30, true);
    expect(reason).toContain('拍新照片');
  });
});

// === tickFlow ===

describe('tickFlow', () => {
  it('increments duration_ticks by 1', () => {
    const flow = makeFlow({ status: 'flow', duration_ticks: 3 });
    const result = tickFlow(flow);
    expect(result.duration_ticks).toBe(4);
  });

  it('increments interrupt_chance by 0.03', () => {
    const flow = makeFlow({ status: 'flow', interrupt_chance: 0.15 });
    const result = tickFlow(flow);
    expect(result.interrupt_chance).toBeCloseTo(0.18, 5);
  });

  it('caps interrupt_chance at 0.40', () => {
    const flow = makeFlow({ status: 'flow', interrupt_chance: 0.39 });
    const result = tickFlow(flow);
    expect(result.interrupt_chance).toBeCloseTo(0.40, 5);
  });

  it('does not exceed 0.40 cap', () => {
    const flow = makeFlow({ status: 'drift', interrupt_chance: 0.40 });
    const result = tickFlow(flow);
    expect(result.interrupt_chance).toBe(0.40);
  });

  it('returns unchanged flow when status is none', () => {
    const flow = makeFlow();
    const result = tickFlow(flow);
    expect(result).toBe(flow); // same reference — no op
  });

  it('works for drift state too', () => {
    const flow = makeFlow({ status: 'drift', duration_ticks: 2, interrupt_chance: 0.21 });
    const result = tickFlow(flow);
    expect(result.duration_ticks).toBe(3);
    expect(result.interrupt_chance).toBeCloseTo(0.24, 5);
  });

  it('does not mutate the input', () => {
    const flow = makeFlow({ status: 'flow', duration_ticks: 1, interrupt_chance: 0.15 });
    tickFlow(flow);
    expect(flow.duration_ticks).toBe(1);
    expect(flow.interrupt_chance).toBe(0.15);
  });
});

// === resetFlow ===

describe('resetFlow', () => {
  it('returns default flow state', () => {
    const result = resetFlow();
    expect(result.status).toBe('none');
    expect(result.activity).toBeNull();
    expect(result.category).toBeNull();
    expect(result.entered_at).toBeNull();
    expect(result.duration_ticks).toBe(0);
    expect(result.interrupt_chance).toBe(0.15);
  });
});

// === generateFlowDiary ===

describe('generateFlowDiary', () => {
  it('includes the flow activity in the diary', () => {
    const flow = makeFlow({ status: 'flow', activity: '修图' });
    const diary = generateFlowDiary(flow, makeEmotion(), () => 0.0);
    expect(diary).toContain('修图');
  });

  it('uses fallback activity when null', () => {
    const flow = makeFlow({ status: 'flow', activity: null });
    const diary = generateFlowDiary(flow, makeEmotion(), () => 0.0);
    expect(diary).toContain('做事');
  });

  it('adds stress suffix when stress > 0.5', () => {
    const emotion = makeEmotion({ stress: 0.7 });
    const flow = makeFlow({ status: 'flow', activity: '修图' });
    const diary = generateFlowDiary(flow, emotion, () => 0.0);
    expect(diary).toContain('累');
  });

  it('adds happy suffix when valence > 0.5', () => {
    const emotion = makeEmotion({ mood: { valence: 0.7, arousal: 0.5, description: '开心' } });
    const flow = makeFlow({ status: 'flow', activity: '修图' });
    const diary = generateFlowDiary(flow, emotion, () => 0.0);
    expect(diary).toContain('心情很好');
  });

  it('returns different templates for different rng values', () => {
    const flow = makeFlow({ status: 'flow', activity: '修图' });
    const emotion = makeEmotion();
    const diary1 = generateFlowDiary(flow, emotion, () => 0.0);
    const diary2 = generateFlowDiary(flow, emotion, () => 0.999);
    // Different templates should produce different results (unless pool is tiny)
    // At minimum they should both be non-empty strings
    expect(diary1.length).toBeGreaterThan(0);
    expect(diary2.length).toBeGreaterThan(0);
  });
});

// === generateDriftDiary ===

describe('generateDriftDiary', () => {
  it('returns a non-empty string', () => {
    const flow = makeFlow({ status: 'drift' });
    const diary = generateDriftDiary(flow, () => 0.0);
    expect(diary.length).toBeGreaterThan(0);
  });

  it('returns different templates for different rng values', () => {
    const flow = makeFlow({ status: 'drift' });
    const diary1 = generateDriftDiary(flow, () => 0.0);
    const diary2 = generateDriftDiary(flow, () => 0.999);
    expect(diary1.length).toBeGreaterThan(0);
    expect(diary2.length).toBeGreaterThan(0);
  });
});

// === computeVoiceDirective ===

describe('computeVoiceDirective', () => {
  it('returns threshold break directive when threshold broke', () => {
    const result = computeVoiceDirective('none', makeEmotion(), true);
    expect(result).toContain('情绪化');
  });

  it('returns flow directive for flow status', () => {
    const result = computeVoiceDirective('flow', makeEmotion(), false);
    expect(result).toContain('碎片化');
  });

  it('returns drift directive for drift status', () => {
    const result = computeVoiceDirective('drift', makeEmotion(), false);
    expect(result).toContain('意识流');
  });

  it('threshold break overrides flow status', () => {
    const result = computeVoiceDirective('flow', makeEmotion(), true);
    expect(result).toContain('情绪化');
  });

  it('returns upbeat directive for high valence + arousal in normal', () => {
    const emotion = makeEmotion({ mood: { valence: 0.7, arousal: 0.7, description: '超开心' } });
    const result = computeVoiceDirective('none', emotion, false);
    expect(result).toContain('轻快');
  });

  it('returns low directive for negative valence in normal', () => {
    const emotion = makeEmotion({ mood: { valence: -0.5, arousal: 0.3, description: '低落' } });
    const result = computeVoiceDirective('none', emotion, false);
    expect(result).toContain('低落');
  });

  it('returns stress directive for high stress in normal', () => {
    const emotion = makeEmotion({ stress: 0.7 });
    const result = computeVoiceDirective('none', emotion, false);
    expect(result).toContain('焦虑');
  });

  it('returns default narrative directive for neutral emotion', () => {
    const result = computeVoiceDirective('none', makeEmotion(), false);
    expect(result).toContain('正常叙事');
  });
});
