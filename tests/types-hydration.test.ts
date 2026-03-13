import { describe, it, expect } from 'vitest';
import {
  hydrateEmotionState,
  hydrateIntent,
  hydrateHeartbeatLogEntry,
  DEFAULT_MOMENTUM,
  DEFAULT_UNDERTONE,
  BASE_RESISTANCE,
  EmotionState,
  Intent,
  HeartbeatLogEntry,
} from '../skill/scripts/types';

describe('hydrateEmotionState', () => {
  it('fills all new fields when reading old-format JSON', () => {
    const oldFormat = {
      mood: { valence: 0.5, arousal: 0.5, description: 'neutral' },
      energy: 0.5,
      stress: 0.5,
      creativity: 0.5,
      sociability: 0.5,
      last_updated: null,
      recent_cause: 'init',
    };
    const result = hydrateEmotionState(oldFormat);
    expect(result.momentum).toEqual(DEFAULT_MOMENTUM);
    expect(result.undertone).toEqual(DEFAULT_UNDERTONE);
    expect(result.impulse_history).toEqual([]);
    expect(result.consecutive_high_stress).toBe(0);
    expect(result.threshold_break_cooldown).toBe(0);
  });

  it('preserves existing new fields if already present', () => {
    const newFormat: EmotionState = {
      mood: { valence: 0.5, arousal: 0.5, description: 'neutral' },
      energy: 0.5,
      stress: 0.5,
      creativity: 0.5,
      sociability: 0.5,
      last_updated: null,
      recent_cause: 'init',
      momentum: { valence: 0.3, arousal: 0.1, energy: 0, stress: 0, creativity: 0, sociability: 0, duration_ticks: 5 },
      undertone: { valence: 0.1, arousal: 0.1, energy: 0.1, stress: 0.1, creativity: 0.1, sociability: 0.1 },
      impulse_history: [{ delta: { valence: 0.2 }, cause: 'test', importance: 5, timestamp: '2026-01-01T00:00:00Z', tick_age: 2 }],
      consecutive_high_stress: 3,
      threshold_break_cooldown: 2,
    };
    const result = hydrateEmotionState(newFormat as unknown as Record<string, unknown>);
    expect(result.momentum.duration_ticks).toBe(5);
    expect(result.undertone.valence).toBe(0.1);
    expect(result.impulse_history).toHaveLength(1);
    expect(result.consecutive_high_stress).toBe(3);
    expect(result.threshold_break_cooldown).toBe(2);
  });

  it('preserves all original fields', () => {
    const oldFormat = {
      mood: { valence: -0.3, arousal: 0.8, description: '焦虑' },
      energy: 0.2,
      stress: 0.9,
      creativity: 0.1,
      sociability: 0.7,
      last_updated: '2026-01-01T00:00:00Z',
      recent_cause: 'test event',
    };
    const result = hydrateEmotionState(oldFormat);
    expect(result.mood.valence).toBe(-0.3);
    expect(result.mood.arousal).toBe(0.8);
    expect(result.energy).toBe(0.2);
    expect(result.stress).toBe(0.9);
    expect(result.creativity).toBe(0.1);
    expect(result.sociability).toBe(0.7);
    expect(result.last_updated).toBe('2026-01-01T00:00:00Z');
    expect(result.recent_cause).toBe('test event');
  });

  it('returns independent momentum/undertone objects (no shared reference)', () => {
    const a = hydrateEmotionState({ mood: { valence: 0, arousal: 0, description: '' }, energy: 0, stress: 0, creativity: 0, sociability: 0, last_updated: null, recent_cause: '' });
    const b = hydrateEmotionState({ mood: { valence: 0, arousal: 0, description: '' }, energy: 0, stress: 0, creativity: 0, sociability: 0, last_updated: null, recent_cause: '' });
    a.momentum.valence = 999;
    expect(b.momentum.valence).toBe(0);
    expect(DEFAULT_MOMENTUM.valence).toBe(0);
  });
});

describe('hydrateIntent', () => {
  it('fills resistance from BASE_RESISTANCE when missing', () => {
    const oldIntent = {
      id: 'test_1',
      category: '创作' as const,
      description: 'test',
      intensity: 5.0,
      source: 'accumulation' as const,
      born_at: '2026-01-01T00:00:00Z',
      decay_rate: 0.5,
      satisfied_at: null,
    };
    const result = hydrateIntent(oldIntent as unknown as Record<string, unknown>);
    expect(result.resistance).toBe(BASE_RESISTANCE['创作']);
    expect(result.skipped_count).toBe(0);
    expect(result.last_attempted).toBeNull();
  });

  it('uses correct BASE_RESISTANCE per category', () => {
    const categories = ['创作', '社交', '窥屏', '表达', '学习', '休息', '梦想'] as const;
    for (const cat of categories) {
      const intent = hydrateIntent({
        id: `test_${cat}`, category: cat, description: 'x', intensity: 1,
        source: 'accumulation', born_at: '', decay_rate: 0.5, satisfied_at: null,
      } as unknown as Record<string, unknown>);
      expect(intent.resistance).toBe(BASE_RESISTANCE[cat]);
    }
  });

  it('preserves existing new fields if present', () => {
    const intent: Intent = {
      id: 'test_1', category: '学习', description: 'x', intensity: 3,
      source: 'llm', born_at: '', decay_rate: 0.5, satisfied_at: null,
      resistance: 10.0, skipped_count: 3, last_attempted: '2026-01-01T00:00:00Z',
    };
    const result = hydrateIntent(intent as unknown as Record<string, unknown>);
    expect(result.resistance).toBe(10.0);
    expect(result.skipped_count).toBe(3);
    expect(result.last_attempted).toBe('2026-01-01T00:00:00Z');
  });

  it('preserves all original fields', () => {
    const old = {
      id: 'int_abc', category: '梦想' as const, description: 'dream big',
      intensity: 7.5, source: 'event' as const, born_at: '2026-01-01T12:00:00Z',
      decay_rate: 1.0, satisfied_at: '2026-01-01T13:00:00Z',
    };
    const result = hydrateIntent(old as unknown as Record<string, unknown>);
    expect(result.id).toBe('int_abc');
    expect(result.category).toBe('梦想');
    expect(result.intensity).toBe(7.5);
    expect(result.satisfied_at).toBe('2026-01-01T13:00:00Z');
  });
});

describe('hydrateHeartbeatLogEntry', () => {
  it('fills all new fields when reading old-format JSON', () => {
    const oldEntry = {
      timestamp: '2026-01-01T10:00:00Z',
      type: 'regular' as const,
      status: 'completed' as const,
      perception_summary: 'test',
      chosen_actions: ['browsing'],
    };
    const result = hydrateHeartbeatLogEntry(oldEntry as unknown as Record<string, unknown>);
    expect(result.tick_summary).toBe('');
    expect(result.inner_monologue).toBeNull();
    expect(result.flow_state).toBe('none');
    expect(result.voice_directive).toBe('');
  });

  it('preserves existing new fields if present', () => {
    const entry: HeartbeatLogEntry = {
      timestamp: '2026-01-01T10:00:00Z',
      type: 'regular',
      status: 'completed',
      tick_summary: '在看手机',
      inner_monologue: '好无聊',
      flow_state: 'drift',
      voice_directive: '意识流散漫',
    };
    const result = hydrateHeartbeatLogEntry(entry as unknown as Record<string, unknown>);
    expect(result.tick_summary).toBe('在看手机');
    expect(result.inner_monologue).toBe('好无聊');
    expect(result.flow_state).toBe('drift');
    expect(result.voice_directive).toBe('意识流散漫');
  });

  it('preserves all original fields', () => {
    const old = {
      timestamp: '2026-01-01T10:00:00Z',
      type: 'morning' as const,
      status: 'skipped' as const,
      error: 'LLM timeout',
    };
    const result = hydrateHeartbeatLogEntry(old as unknown as Record<string, unknown>);
    expect(result.timestamp).toBe('2026-01-01T10:00:00Z');
    expect(result.type).toBe('morning');
    expect(result.status).toBe('skipped');
    expect(result.error).toBe('LLM timeout');
  });
});
