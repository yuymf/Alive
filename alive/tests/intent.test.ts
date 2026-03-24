// alive/tests/intent.test.ts
// Tests for the generalized intent pool engine

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
} from '../scripts/engines/intent';
import { Intent, IntentPool, IntentCategory, ScheduleToday, EventQueue, BASE_RESISTANCE } from '../scripts/utils/types';
import { setTimeOverride } from '../scripts/utils/time-utils';

vi.mock('../scripts/persona/persona-loader', () => ({
  getEmotionBaseline: () => ({ valence: 0.3, arousal: 0.5, energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5 }),
  buildVoiceSignature: () => '',
}));

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    id: 'test-1',
    category: '创作' as IntentCategory,
    description: '画画',
    intensity: 5.0,
    source: 'accumulation',
    born_at: '2026-03-24T10:00:00',
    decay_rate: 0.5,
    satisfied_at: null,
    resistance: BASE_RESISTANCE['创作'],
    skipped_count: 0,
    last_attempted: null,
    ...overrides,
  };
}

function makePool(intents: Intent[] = []): IntentPool {
  return { intents, last_updated: null };
}

beforeEach(() => {
  setTimeOverride(new Date('2026-03-24T14:00:00'));
});

// ──── decaySatisfied ────

describe('decaySatisfied', () => {
  it('decays satisfied intents by their decay_rate', () => {
    const pool = makePool([makeIntent({ satisfied_at: '2026-03-24T12:00:00' })]);
    const decayed = decaySatisfied(pool);
    expect(decayed.intents[0].intensity).toBe(4.5); // 5.0 - 0.5
  });

  it('does not decay unsatisfied intents', () => {
    const pool = makePool([makeIntent({ satisfied_at: null })]);
    const decayed = decaySatisfied(pool);
    expect(decayed.intents[0].intensity).toBe(5.0);
  });

  it('removes intents that decay below 0.1', () => {
    const pool = makePool([makeIntent({ satisfied_at: '2026-03-24T12:00:00', intensity: 0.3, decay_rate: 0.5 })]);
    const decayed = decaySatisfied(pool);
    expect(decayed.intents.length).toBe(0);
  });
});

// ──── accumulateIntents ────

describe('accumulateIntents', () => {
  it('boosts 创作 intent normally', () => {
    const pool = makePool([makeIntent({ category: '创作', intensity: 3.0 })]);
    const result = accumulateIntents(pool, 14, 10, 0, false);
    expect(result.intents[0].intensity).toBeGreaterThan(3.0);
  });

  it('boosts 创作 extra when lastActionHoursAgo > 48', () => {
    const pool = makePool([makeIntent({ category: '创作', intensity: 3.0 })]);
    const normal = accumulateIntents(pool, 14, 10, 0, false);
    const longAgo = accumulateIntents(pool, 14, 50, 0, false);
    expect(longAgo.intents[0].intensity).toBeGreaterThan(normal.intents[0].intensity);
  });

  it('boosts 社交 when unread events', () => {
    const pool = makePool([makeIntent({ category: '社交', intensity: 2.0 })]);
    const noEvents = accumulateIntents(pool, 14, 10, 0, false);
    const withEvents = accumulateIntents(pool, 14, 10, 0, true);
    expect(withEvents.intents[0].intensity).toBeGreaterThan(noEvents.intents[0].intensity);
  });

  it('boosts 窥屏 during slack period (12-13)', () => {
    const pool = makePool([makeIntent({ category: '窥屏', intensity: 2.0 })]);
    const slack = accumulateIntents(pool, 12, 10, 0, false);
    const nonSlack = accumulateIntents(pool, 9, 10, 0, false);
    expect(slack.intents[0].intensity).toBeGreaterThan(nonSlack.intents[0].intensity);
  });

  it('boosts 休息 by consecutive active heartbeats', () => {
    const pool = makePool([makeIntent({ category: '休息', intensity: 1.0 })]);
    const few = accumulateIntents(pool, 14, 10, 1, false);
    const many = accumulateIntents(pool, 14, 10, 5, false);
    expect(many.intents[0].intensity).toBeGreaterThan(few.intents[0].intensity);
  });

  it('caps intensity at 10.0', () => {
    const pool = makePool([makeIntent({ category: '社交', intensity: 9.5 })]);
    const result = accumulateIntents(pool, 14, 10, 0, true); // +2.0 boost
    expect(result.intents[0].intensity).toBeLessThanOrEqual(10.0);
  });
});

// ──── applyEventBoosts ────

describe('applyEventBoosts', () => {
  it('boosts existing intents from event data', () => {
    const pool = makePool([makeIntent({ category: '创作', intensity: 3.0 })]);
    const events: EventQueue = {
      events: [{
        type: 'inspiration', processed: false, timestamp: '',
        data: { intent_boosts: [{ category: '创作', boost: 2.0 }] },
      }],
      max_size: 50,
    };
    const result = applyEventBoosts(pool, events);
    expect(result.intents[0].intensity).toBe(5.0);
  });

  it('creates new intent if category not in pool', () => {
    const pool = makePool([]);
    const events: EventQueue = {
      events: [{
        type: 'social-ping', processed: false, timestamp: '',
        data: { intent_boosts: [{ category: '社交', boost: 3.0 }] },
      }],
      max_size: 50,
    };
    const result = applyEventBoosts(pool, events);
    expect(result.intents.length).toBe(1);
    expect(result.intents[0].category).toBe('社交');
  });

  it('skips processed events', () => {
    const pool = makePool([]);
    const events: EventQueue = {
      events: [{
        type: 'test', processed: true, timestamp: '',
        data: { intent_boosts: [{ category: '创作', boost: 5.0 }] },
      }],
      max_size: 50,
    };
    const result = applyEventBoosts(pool, events);
    expect(result.intents.length).toBe(0);
  });
});

// ──── getTopIntents ────

describe('getTopIntents', () => {
  it('returns intents sorted by (intensity - resistance)', () => {
    const pool = makePool([
      makeIntent({ id: 'a', category: '窥屏', intensity: 3.0, resistance: 0.5 }),    // net 2.5
      makeIntent({ id: 'b', category: '创作', intensity: 7.0, resistance: 4.0 }),     // net 3.0
      makeIntent({ id: 'c', category: '社交', intensity: 4.0, resistance: 1.5 }),     // net 2.5
    ]);
    const top = getTopIntents(pool, 2);
    expect(top.length).toBe(2);
    expect(top[0].id).toBe('b');
  });

  it('excludes satisfied intents', () => {
    const pool = makePool([
      makeIntent({ id: 'a', intensity: 9.0, satisfied_at: '2026-03-24T12:00:00' }),
      makeIntent({ id: 'b', intensity: 5.0, resistance: 1.0 }),
    ]);
    const top = getTopIntents(pool, 5);
    expect(top.length).toBe(1);
    expect(top[0].id).toBe('b');
  });

  it('excludes intents below resistance', () => {
    const pool = makePool([
      makeIntent({ id: 'a', intensity: 3.0, resistance: 5.0 }),
    ]);
    const top = getTopIntents(pool, 5);
    expect(top.length).toBe(0);
  });
});

// ──── satisfyIntent ────

describe('satisfyIntent', () => {
  it('marks intent as satisfied', () => {
    const pool = makePool([makeIntent({ id: 'x' })]);
    const result = satisfyIntent(pool, 'x');
    expect(result.intents[0].satisfied_at).toBeTruthy();
  });

  it('does not change other intents', () => {
    const pool = makePool([makeIntent({ id: 'x' }), makeIntent({ id: 'y' })]);
    const result = satisfyIntent(pool, 'x');
    expect(result.intents[1].satisfied_at).toBeNull();
  });
});

// ──── addIntent ────

describe('addIntent', () => {
  it('adds a new intent to the pool', () => {
    const pool = makePool([]);
    const result = addIntent(pool, '学习', '读论文', 3.0, 'llm');
    expect(result.intents.length).toBe(1);
    expect(result.intents[0].category).toBe('学习');
    expect(result.intents[0].description).toBe('读论文');
    expect(result.intents[0].source).toBe('llm');
  });

  it('caps intensity at 10.0', () => {
    const pool = makePool([]);
    const result = addIntent(pool, '创作', '画大作', 15.0, 'event');
    expect(result.intents[0].intensity).toBe(10.0);
  });
});

// ──── computeDynamicResistance ────

describe('computeDynamicResistance', () => {
  it('increases resistance for high-energy categories when vitality is low', () => {
    const intent = makeIntent({ category: '创作' });
    const normal = computeDynamicResistance(intent, 60, 1.0, false, null, null);
    const tired = computeDynamicResistance(intent, 20, 1.0, false, null, null);
    expect(tired).toBeGreaterThan(normal);
  });

  it('increases resistance when in flow on a different category', () => {
    const intent = makeIntent({ category: '社交' });
    const noFlow = computeDynamicResistance(intent, 60, 1.0, false, null, null);
    const inFlow = computeDynamicResistance(intent, 60, 1.0, true, '创作', null);
    expect(inFlow).toBeGreaterThan(noFlow);
  });

  it('same flow category does not add resistance', () => {
    const intent = makeIntent({ category: '创作' });
    const inFlow = computeDynamicResistance(intent, 60, 1.0, true, '创作', null);
    const noFlow = computeDynamicResistance(intent, 60, 1.0, false, null, null);
    expect(inFlow).toBe(noFlow);
  });

  it('rigid schedule adds resistance for non-matching intents', () => {
    const intent = makeIntent({ category: '创作' });
    const noSchedule = computeDynamicResistance(intent, 60, 1.0, false, null, null);
    const withSchedule = computeDynamicResistance(intent, 60, 1.0, false, null, { allowed_actions: ['社交'] });
    expect(withSchedule).toBeGreaterThan(noSchedule);
  });

  it('low confidence increases 创作 resistance', () => {
    const intent = makeIntent({ category: '创作' });
    const confident = computeDynamicResistance(intent, 60, 1.0, false, null, null);
    const notConfident = computeDynamicResistance(intent, 60, 0.5, false, null, null);
    expect(notConfident).toBeGreaterThan(confident);
  });
});

// ──── checkImpulseBreakthrough ────

describe('checkImpulseBreakthrough', () => {
  it('returns high-intensity event-sourced intent', () => {
    const pool = makePool([makeIntent({ id: 'e1', intensity: 9.0, source: 'event' })]);
    const result = checkImpulseBreakthrough(pool, 60, false);
    expect(result).toBeTruthy();
    expect(result!.id).toBe('e1');
  });

  it('returns 窥屏 when not in flow and vitality is low', () => {
    const pool = makePool([makeIntent({ id: 'b1', category: '窥屏', intensity: 3.0 })]);
    const result = checkImpulseBreakthrough(pool, 40, false);
    expect(result).toBeTruthy();
    expect(result!.category).toBe('窥屏');
  });

  it('returns 休息 when vitality is critical', () => {
    const pool = makePool([makeIntent({ id: 'r1', category: '休息', intensity: 1.0 })]);
    const result = checkImpulseBreakthrough(pool, 10, false);
    expect(result).toBeTruthy();
    expect(result!.category).toBe('休息');
  });

  it('returns null when no conditions met', () => {
    const pool = makePool([makeIntent({ intensity: 3.0, source: 'accumulation' })]);
    const result = checkImpulseBreakthrough(pool, 60, false);
    expect(result).toBeNull();
  });
});

// ──── processProcrastination ────

describe('processProcrastination', () => {
  it('increments skipped_count for unchosen intents above resistance', () => {
    const intent = makeIntent({ id: 'a', intensity: 6.0, resistance: 2.0 });
    const pool = makePool([intent]);
    const { pool: result } = processProcrastination(pool, new Set(), () => 0.99);
    expect(result.intents[0].skipped_count).toBe(1);
  });

  it('resets skipped_count for chosen intents', () => {
    const intent = makeIntent({ id: 'a', intensity: 6.0, resistance: 2.0, skipped_count: 3 });
    const pool = makePool([intent]);
    const { pool: result } = processProcrastination(pool, new Set(['a']));
    expect(result.intents[0].skipped_count).toBe(0);
  });

  it('generates stress after 3 skips', () => {
    const intent = makeIntent({ id: 'a', intensity: 6.0, resistance: 2.0, skipped_count: 2 });
    const pool = makePool([intent]);
    const { stressDelta, diaryEntries } = processProcrastination(pool, new Set(), () => 0.99);
    expect(stressDelta).toBeGreaterThan(0);
    expect(diaryEntries.length).toBeGreaterThan(0);
  });

  it('can abandon intent after 4 skips (high stress)', () => {
    const intent = makeIntent({ id: 'a', intensity: 6.0, resistance: 2.0, skipped_count: 3 });
    const pool = makePool([intent]);
    const { pool: result, diaryEntries } = processProcrastination(pool, new Set(), () => 0.1, 0.6);
    // High stress → 80% abandon prob, rng=0.1 → should abandon
    // Abandon sets intensity = min(resistance * 0.8, 0.5) = min(1.6, 0.5) = 0.5
    expect(result.intents[0].intensity).toBeLessThanOrEqual(0.5);
    expect(diaryEntries.some(d => d.includes('不想做了'))).toBe(true);
  });

  it('can surge intent after 4 skips (low rng, low stress)', () => {
    const intent = makeIntent({ id: 'a', intensity: 6.0, resistance: 2.0, skipped_count: 3 });
    const pool = makePool([intent]);
    const { pool: result, diaryEntries } = processProcrastination(pool, new Set(), () => 0.9, 0.1);
    // Low stress → 50% abandon prob, rng=0.9 → should surge
    expect(result.intents[0].intensity).toBe(9.0); // 6.0 + 3.0
    expect(diaryEntries.some(d => d.includes('不行'))).toBe(true);
  });
});
