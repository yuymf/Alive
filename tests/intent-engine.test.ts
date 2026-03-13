// tests/intent-engine.test.ts
import { describe, it, expect } from 'vitest';
import {
  decaySatisfied,
  accumulateIntents,
  applyEventBoosts,
  injectScheduleIntents,
  getTopIntents,
  getTopIntentsRaw,
  satisfyIntent,
  addIntent,
  computeDynamicResistance,
  applyResistanceToPool,
  checkImpulseBreakthrough,
  processProcrastination,
} from '../skill/scripts/intent-engine';
import { IntentPool, Intent, EventQueue, ScheduleToday, BASE_RESISTANCE } from '../skill/scripts/types';

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    id: 'test_1',
    category: '创作',
    description: 'test intent',
    intensity: 5.0,
    source: 'accumulation',
    born_at: new Date().toISOString(),
    decay_rate: 0.5,
    satisfied_at: null,
    resistance: 0,
    skipped_count: 0,
    last_attempted: null,
    ...overrides,
  };
}

function makePool(intents: Intent[] = []): IntentPool {
  return { intents, last_updated: null };
}

describe('decaySatisfied', () => {
  it('decays satisfied intents by decay_rate', () => {
    const pool = makePool([
      makeIntent({ id: 'a', intensity: 5.0, decay_rate: 0.5, satisfied_at: '2026-01-01T00:00:00Z' }),
    ]);
    const result = decaySatisfied(pool);
    expect(result.intents[0].intensity).toBe(4.5);
  });

  it('removes intents below 0.1 threshold', () => {
    const pool = makePool([
      makeIntent({ id: 'a', intensity: 0.05, decay_rate: 0.5, satisfied_at: '2026-01-01T00:00:00Z' }),
    ]);
    const result = decaySatisfied(pool);
    expect(result.intents).toHaveLength(0);
  });

  it('does not decay unsatisfied intents', () => {
    const pool = makePool([
      makeIntent({ id: 'a', intensity: 5.0, satisfied_at: null }),
    ]);
    const result = decaySatisfied(pool);
    expect(result.intents[0].intensity).toBe(5.0);
  });

  it('does not mutate original pool', () => {
    const pool = makePool([
      makeIntent({ id: 'a', intensity: 5.0, decay_rate: 1.0, satisfied_at: '2026-01-01T00:00:00Z' }),
    ]);
    const result = decaySatisfied(pool);
    expect(pool.intents[0].intensity).toBe(5.0);
    expect(result.intents[0].intensity).toBe(4.0);
  });
});

describe('accumulateIntents', () => {
  it('boosts 创作 intent by 0.3 base', () => {
    const pool = makePool([makeIntent({ category: '创作', intensity: 3.0 })]);
    const result = accumulateIntents(pool, 10, 24, 3, false);
    expect(result.intents[0].intensity).toBe(3.3);
  });

  it('boosts 创作 by extra 1.0 when lastPost > 48h', () => {
    const pool = makePool([makeIntent({ category: '创作', intensity: 3.0 })]);
    const result = accumulateIntents(pool, 10, 72, 3, false);
    expect(result.intents[0].intensity).toBe(4.3);
  });

  it('boosts 社交 by 2.0 when unread events exist', () => {
    const pool = makePool([makeIntent({ category: '社交', intensity: 2.0 })]);
    const result = accumulateIntents(pool, 10, 24, 3, true);
    expect(result.intents[0].intensity).toBe(4.0);
  });

  it('boosts 窥屏 by 1.5 during slack period (lunch)', () => {
    const pool = makePool([makeIntent({ category: '窥屏', intensity: 1.0 })]);
    const result = accumulateIntents(pool, 12, 24, 3, false);
    expect(result.intents[0].intensity).toBe(2.5);
  });

  it('boosts 休息 proportional to consecutive heartbeats', () => {
    const pool = makePool([makeIntent({ category: '休息', intensity: 0.0 })]);
    const result = accumulateIntents(pool, 15, 24, 5, false);
    expect(result.intents[0].intensity).toBe(2.5);
  });

  it('caps intensity at 10', () => {
    const pool = makePool([makeIntent({ category: '社交', intensity: 9.5 })]);
    const result = accumulateIntents(pool, 10, 24, 3, true);
    expect(result.intents[0].intensity).toBe(10);
  });
});

describe('applyEventBoosts', () => {
  it('boosts 社交 for instagram_comment event', () => {
    const pool = makePool([makeIntent({ category: '社交', intensity: 2.0 })]);
    const events: EventQueue = {
      events: [{ type: 'instagram_comment', data: {}, timestamp: '', processed: false }],
      max_size: 50,
    };
    const result = applyEventBoosts(pool, events);
    expect(result.intents[0].intensity).toBe(5.0);
  });

  it('creates new intent if category not in pool', () => {
    const pool = makePool([]);
    const events: EventQueue = {
      events: [{ type: 'instagram_follower', data: {}, timestamp: '', processed: false }],
      max_size: 50,
    };
    const result = applyEventBoosts(pool, events);
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0].category).toBe('社交');
    expect(result.intents[0].intensity).toBe(3.0);
  });

  it('ignores processed events', () => {
    const pool = makePool([]);
    const events: EventQueue = {
      events: [{ type: 'instagram_comment', data: {}, timestamp: '', processed: true }],
      max_size: 50,
    };
    const result = applyEventBoosts(pool, events);
    expect(result.intents).toHaveLength(0);
  });

  it('boosts both 创作 and 窥屏 for trend_discovered', () => {
    const pool = makePool([]);
    const events: EventQueue = {
      events: [{ type: 'trend_discovered', data: {}, timestamp: '', processed: false }],
      max_size: 50,
    };
    const result = applyEventBoosts(pool, events);
    const categories = result.intents.map(i => i.category);
    expect(categories).toContain('创作');
    expect(categories).toContain('窥屏');
  });
});

describe('getTopIntents', () => {
  it('returns top N unsatisfied intents sorted by net intensity', () => {
    const pool = makePool([
      makeIntent({ id: 'a', intensity: 3.0, resistance: 0 }),
      makeIntent({ id: 'b', intensity: 8.0, resistance: 0 }),
      makeIntent({ id: 'c', intensity: 5.0, satisfied_at: '2026-01-01T00:00:00Z' }),
      makeIntent({ id: 'd', intensity: 6.0, resistance: 0 }),
    ]);
    const top = getTopIntents(pool, 2);
    expect(top).toHaveLength(2);
    expect(top[0].id).toBe('b');
    expect(top[1].id).toBe('d');
  });

  it('filters out intents where intensity <= resistance', () => {
    const pool = makePool([
      makeIntent({ id: 'a', intensity: 5.0, resistance: 6.0 }),
      makeIntent({ id: 'b', intensity: 8.0, resistance: 3.0 }),
    ]);
    const top = getTopIntents(pool, 5);
    expect(top).toHaveLength(1);
    expect(top[0].id).toBe('b');
  });

  it('sorts by net intensity (intensity - resistance)', () => {
    const pool = makePool([
      makeIntent({ id: 'a', intensity: 8.0, resistance: 5.0 }), // net = 3.0
      makeIntent({ id: 'b', intensity: 6.0, resistance: 1.0 }), // net = 5.0
    ]);
    const top = getTopIntents(pool, 2);
    expect(top[0].id).toBe('b'); // higher net intensity
    expect(top[1].id).toBe('a');
  });
});

describe('satisfyIntent', () => {
  it('marks intent as satisfied with timestamp', () => {
    const pool = makePool([makeIntent({ id: 'a' })]);
    const result = satisfyIntent(pool, 'a');
    expect(result.intents[0].satisfied_at).not.toBeNull();
  });

  it('does not mutate original pool', () => {
    const pool = makePool([makeIntent({ id: 'a' })]);
    satisfyIntent(pool, 'a');
    expect(pool.intents[0].satisfied_at).toBeNull();
  });
});

describe('addIntent', () => {
  it('adds a new intent to the pool', () => {
    const pool = makePool([]);
    const result = addIntent(pool, '学习', 'learn something', 4.0, 'llm');
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0].category).toBe('学习');
    expect(result.intents[0].intensity).toBe(4.0);
    expect(result.intents[0].source).toBe('llm');
  });

  it('caps intensity at 10', () => {
    const result = addIntent(makePool([]), '创作', 'test', 15.0, 'llm');
    expect(result.intents[0].intensity).toBe(10);
  });
});

describe('injectScheduleIntents', () => {
  it('injects flexible schedule items when time matches', () => {
    const pool = makePool([]);
    const schedule: ScheduleToday = {
      date: '2026-03-10',
      rigid: [],
      flexible: [
        { type: 'flexible', activity: '拍照', preferred_time: '14:00', intent_boost: 3.0, intent_category: '创作' },
      ],
      generated_by: 'test',
    };
    const result = injectScheduleIntents(pool, schedule, 14);
    expect(result.intents).toHaveLength(1);
    expect(result.intents[0].category).toBe('创作');
  });

  it('does not inject when time does not match', () => {
    const pool = makePool([]);
    const schedule: ScheduleToday = {
      date: '2026-03-10',
      rigid: [],
      flexible: [
        { type: 'flexible', activity: '拍照', preferred_time: '14:00', intent_boost: 3.0, intent_category: '创作' },
      ],
      generated_by: 'test',
    };
    const result = injectScheduleIntents(pool, schedule, 10);
    expect(result.intents).toHaveLength(0);
  });
});

// === Verisimilitude §3: Resistance, Impulse Breakthrough, Procrastination ===

describe('computeDynamicResistance', () => {
  it('returns base resistance for normal conditions', () => {
    const intent = makeIntent({ category: '创作' });
    const r = computeDynamicResistance(intent, 70, 1.0, false, null, null);
    expect(r).toBe(BASE_RESISTANCE['创作']);
  });

  it('multiplies resistance 1.5x for high-energy categories when vitality < 30', () => {
    const intent = makeIntent({ category: '学习' });
    const r = computeDynamicResistance(intent, 20, 1.0, false, null, null);
    expect(r).toBe(BASE_RESISTANCE['学习'] * 1.5);
  });

  it('does not multiply low-energy categories for low vitality', () => {
    const intent = makeIntent({ category: '窥屏' });
    const r = computeDynamicResistance(intent, 20, 1.0, false, null, null);
    expect(r).toBe(BASE_RESISTANCE['窥屏']);
  });

  it('adds +3 resistance for non-flow categories when in flow', () => {
    const intent = makeIntent({ category: '社交' });
    const r = computeDynamicResistance(intent, 70, 1.0, true, '创作', null);
    expect(r).toBe(BASE_RESISTANCE['社交'] + 3.0);
  });

  it('does not add flow penalty for the flow category itself', () => {
    const intent = makeIntent({ category: '创作' });
    const r = computeDynamicResistance(intent, 70, 1.0, true, '创作', null);
    expect(r).toBe(BASE_RESISTANCE['创作']);
  });

  it('adds +5 for non-allowed actions during rigid schedule', () => {
    const intent = makeIntent({ category: '梦想' });
    const r = computeDynamicResistance(intent, 70, 1.0, false, null, { allowed_actions: ['内心活动', '偷看手机'] });
    expect(r).toBe(BASE_RESISTANCE['梦想'] + 5.0);
  });

  it('adds +2 for creation when confidence < 0.8', () => {
    const intent = makeIntent({ category: '创作' });
    const r = computeDynamicResistance(intent, 70, 0.5, false, null, null);
    expect(r).toBe(BASE_RESISTANCE['创作'] + 2.0);
  });

  it('does not add confidence penalty for non-creation categories', () => {
    const intent = makeIntent({ category: '学习' });
    const r = computeDynamicResistance(intent, 70, 0.5, false, null, null);
    expect(r).toBe(BASE_RESISTANCE['学习']);
  });

  it('accumulates multiple modifiers', () => {
    const intent = makeIntent({ category: '创作' });
    // low vitality (1.5x) + low confidence (+2) + rigid schedule (+5)
    const r = computeDynamicResistance(intent, 20, 0.5, false, null, { allowed_actions: ['回消息'] });
    expect(r).toBe(BASE_RESISTANCE['创作'] * 1.5 + 2.0 + 5.0);
  });
});

describe('applyResistanceToPool', () => {
  it('updates resistance for all unsatisfied intents', () => {
    const pool = makePool([
      makeIntent({ id: 'a', category: '创作', resistance: 0 }),
      makeIntent({ id: 'b', category: '窥屏', resistance: 0 }),
    ]);
    const result = applyResistanceToPool(pool, 70, 1.0, false, null, null);
    expect(result.intents[0].resistance).toBe(BASE_RESISTANCE['创作']);
    expect(result.intents[1].resistance).toBe(BASE_RESISTANCE['窥屏']);
  });

  it('does not update satisfied intents', () => {
    const pool = makePool([
      makeIntent({ id: 'a', category: '创作', resistance: 0, satisfied_at: '2026-01-01T00:00:00Z' }),
    ]);
    const result = applyResistanceToPool(pool, 70, 1.0, false, null, null);
    expect(result.intents[0].resistance).toBe(0);
  });

  it('does not mutate original pool', () => {
    const pool = makePool([makeIntent({ id: 'a', category: '创作', resistance: 0 })]);
    applyResistanceToPool(pool, 70, 1.0, false, null, null);
    expect(pool.intents[0].resistance).toBe(0);
  });
});

describe('checkImpulseBreakthrough', () => {
  it('returns high-intensity event intent as breakthrough', () => {
    const pool = makePool([
      makeIntent({ id: 'a', category: '社交', intensity: 9.0, source: 'event' }),
    ]);
    const result = checkImpulseBreakthrough(pool, 70, false);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('a');
  });

  it('does not return non-event intents even if high intensity', () => {
    const pool = makePool([
      makeIntent({ id: 'a', category: '社交', intensity: 9.0, source: 'accumulation' }),
    ]);
    const result = checkImpulseBreakthrough(pool, 70, false);
    // No event breakthrough, and vitality is normal, no browsing breakthrough
    expect(result).toBeNull();
  });

  it('returns browsing intent when not in flow and vitality < 50', () => {
    const pool = makePool([
      makeIntent({ id: 'a', category: '窥屏', intensity: 2.0 }),
    ]);
    const result = checkImpulseBreakthrough(pool, 40, false);
    expect(result).not.toBeNull();
    expect(result!.category).toBe('窥屏');
  });

  it('does not return browsing breakthrough when in flow', () => {
    const pool = makePool([
      makeIntent({ id: 'a', category: '窥屏', intensity: 2.0 }),
    ]);
    const result = checkImpulseBreakthrough(pool, 40, true);
    expect(result).toBeNull();
  });

  it('returns rest intent when vitality < 15', () => {
    const pool = makePool([
      makeIntent({ id: 'a', category: '休息', intensity: 1.0 }),
    ]);
    const result = checkImpulseBreakthrough(pool, 10, true); // even in flow
    expect(result).not.toBeNull();
    expect(result!.category).toBe('休息');
  });

  it('prioritizes event breakthrough over browsing/rest', () => {
    const pool = makePool([
      makeIntent({ id: 'event', category: '社交', intensity: 9.0, source: 'event' }),
      makeIntent({ id: 'browse', category: '窥屏', intensity: 2.0 }),
    ]);
    const result = checkImpulseBreakthrough(pool, 10, false);
    expect(result!.id).toBe('event');
  });

  it('returns null when no breakthrough conditions met', () => {
    const pool = makePool([
      makeIntent({ id: 'a', category: '创作', intensity: 5.0, source: 'accumulation' }),
    ]);
    const result = checkImpulseBreakthrough(pool, 70, false);
    expect(result).toBeNull();
  });
});

describe('processProcrastination', () => {
  it('increments skipped_count for executable but unchosen intents', () => {
    const pool = makePool([
      makeIntent({ id: 'a', intensity: 5.0, resistance: 2.0, skipped_count: 0 }),
    ]);
    const { pool: result } = processProcrastination(pool, new Set());
    expect(result.intents[0].skipped_count).toBe(1);
  });

  it('resets skipped_count for chosen intents', () => {
    const pool = makePool([
      makeIntent({ id: 'a', intensity: 5.0, resistance: 2.0, skipped_count: 3 }),
    ]);
    const { pool: result } = processProcrastination(pool, new Set(['a']));
    expect(result.intents[0].skipped_count).toBe(0);
  });

  it('does not increment for intents below resistance', () => {
    const pool = makePool([
      makeIntent({ id: 'a', intensity: 2.0, resistance: 5.0, skipped_count: 0 }),
    ]);
    const { pool: result } = processProcrastination(pool, new Set());
    expect(result.intents[0].skipped_count).toBe(0);
  });

  it('accumulates stress after 3+ skips', () => {
    const pool = makePool([
      makeIntent({ id: 'a', intensity: 5.0, resistance: 2.0, skipped_count: 2 }),
    ]);
    const { stressDelta, diaryEntries } = processProcrastination(pool, new Set());
    expect(stressDelta).toBe(0.05);
    expect(diaryEntries.length).toBeGreaterThan(0);
  });

  it('triggers guilt burst (intensity +3) at 5+ skips when rng > abandonProb', () => {
    const pool = makePool([
      makeIntent({ id: 'a', intensity: 5.0, resistance: 2.0, skipped_count: 4, description: '拍新照片' }),
    ]);
    // Low stress → abandon prob = 0.3, rng=0.5 > 0.3 → guilt burst
    const { pool: result, diaryEntries } = processProcrastination(pool, new Set(), () => 0.5, 0.1);
    expect(result.intents[0].intensity).toBe(8.0); // 5 + 3
    expect(result.intents[0].skipped_count).toBe(0);
    expect(diaryEntries.some(d => d.includes('不行'))).toBe(true);
  });

  it('triggers abandonment (intensity → 1) at 5+ skips when rng < abandonProb', () => {
    const pool = makePool([
      makeIntent({ id: 'a', intensity: 5.0, resistance: 2.0, skipped_count: 4, description: '拍新照片' }),
    ]);
    // High stress → abandon prob = 0.8, rng=0.1 < 0.8 → abandon
    const { pool: result, diaryEntries } = processProcrastination(pool, new Set(), () => 0.1, 0.7);
    expect(result.intents[0].intensity).toBe(1.0);
    expect(result.intents[0].skipped_count).toBe(0);
    expect(diaryEntries.some(d => d.includes('算了'))).toBe(true);
  });

  it('does not modify satisfied intents', () => {
    const pool = makePool([
      makeIntent({ id: 'a', intensity: 5.0, resistance: 2.0, skipped_count: 0, satisfied_at: '2026-01-01T00:00:00Z' }),
    ]);
    const { pool: result } = processProcrastination(pool, new Set());
    expect(result.intents[0].skipped_count).toBe(0);
  });

  it('does not mutate original pool', () => {
    const pool = makePool([
      makeIntent({ id: 'a', intensity: 5.0, resistance: 2.0, skipped_count: 0 }),
    ]);
    processProcrastination(pool, new Set());
    expect(pool.intents[0].skipped_count).toBe(0);
  });

  it('handles multiple intents with different skip states', () => {
    const pool = makePool([
      makeIntent({ id: 'a', intensity: 5.0, resistance: 2.0, skipped_count: 4, description: 'A' }),
      makeIntent({ id: 'b', intensity: 3.0, resistance: 1.0, skipped_count: 1, description: 'B' }),
    ]);
    const { pool: result, stressDelta } = processProcrastination(pool, new Set(), () => 0.5, 0.1);
    // 'a' at 5 skips → guilt burst
    // 'b' at 2 skips → just increment (no stress yet)
    expect(result.intents[0].skipped_count).toBe(0); // reset after burst
    expect(result.intents[1].skipped_count).toBe(2);
    expect(stressDelta).toBe(0); // 'b' is only at count 2, no stress yet
  });
});
