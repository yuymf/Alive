// tests/intent-engine.test.ts
import { describe, it, expect } from 'vitest';
import {
  decaySatisfied,
  accumulateIntents,
  applyEventBoosts,
  injectScheduleIntents,
  getTopIntents,
  satisfyIntent,
  addIntent,
} from '../skill/scripts/intent-engine';
import { IntentPool, Intent, EventQueue, ScheduleToday } from '../skill/scripts/types';

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
  it('returns top N unsatisfied intents sorted by intensity', () => {
    const pool = makePool([
      makeIntent({ id: 'a', intensity: 3.0 }),
      makeIntent({ id: 'b', intensity: 8.0 }),
      makeIntent({ id: 'c', intensity: 5.0, satisfied_at: '2026-01-01T00:00:00Z' }),
      makeIntent({ id: 'd', intensity: 6.0 }),
    ]);
    const top = getTopIntents(pool, 2);
    expect(top).toHaveLength(2);
    expect(top[0].id).toBe('b');
    expect(top[1].id).toBe('d');
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
