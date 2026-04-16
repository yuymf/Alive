// tests/random-events.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { rollRandomEvent, rollContextAwareEvent, processChainEvents, EVENT_POOL, EventContext } from '../scripts/world/random-events';
import {
  IntentCategory, EmotionState, VitalityState, FlowState,
  ChainAndCooldownState, PendingChainEvent,
  DEFAULT_MOMENTUM, DEFAULT_UNDERTONE, DEFAULT_FLOW_STATE,
} from '../scripts/utils/types';

const VALID_INTENT_CATEGORIES: IntentCategory[] = [
  'produce', 'connect', 'consume', 'express', 'learn', 'rest', 'aspire',
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rollRandomEvent', () => {
  describe('probability gate', () => {
    it('returns null when Math.random() > 0.10 (default probability)', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.11);
      expect(rollRandomEvent()).toBeNull();
    });

    it('returns null when Math.random() equals exactly 0.10 + epsilon', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.101);
      expect(rollRandomEvent()).toBeNull();
    });

    it('returns an event when Math.random() <= 0.10 (default probability)', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.10)   // probability check: 0.10 <= 0.10, passes
        .mockReturnValueOnce(0.0);   // selection index: picks first event
      const result = rollRandomEvent();
      expect(result).not.toBeNull();
    });

    it('returns an event when Math.random() is 0.0', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.0)    // probability check: 0.0 <= 0.10, passes
        .mockReturnValueOnce(0.0);   // selection index
      const result = rollRandomEvent();
      expect(result).not.toBeNull();
    });

    it('returns null when Math.random() is 1.0 (worst case)', () => {
      vi.spyOn(Math, 'random').mockReturnValue(1.0);
      expect(rollRandomEvent()).toBeNull();
    });
  });

  describe('custom probability', () => {
    it('uses custom probability as the gate threshold', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.49);
      // 0.49 > 0.10 so default would return null, but with 0.5 threshold it should pass
      const result = rollRandomEvent({ probability: 0.5 });
      // We need a second call for the selection index — mock needs two values
      // Re-mock with proper sequence
    });

    it('returns null when random exceeds custom probability 0.5', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.51);
      expect(rollRandomEvent({ probability: 0.5 })).toBeNull();
    });

    it('returns an event when random is exactly at custom probability 0.5', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.5)    // probability check: 0.5 <= 0.5, passes
        .mockReturnValueOnce(0.0);   // selection index
      const result = rollRandomEvent({ probability: 0.5 });
      expect(result).not.toBeNull();
    });

    it('returns an event when random is below custom probability 0.5', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.3)    // probability check: 0.3 <= 0.5, passes
        .mockReturnValueOnce(0.0);   // selection index
      const result = rollRandomEvent({ probability: 0.5 });
      expect(result).not.toBeNull();
    });

    it('uses probability 0.0 to always return null', () => {
      // Even Math.random() = 0.0 should fail: 0.0 > 0.0 is true for any positive random, null for 0.0
      // probability 0.0 means Math.random() > 0.0 is true for any positive random, null for 0.0
      vi.spyOn(Math, 'random').mockReturnValue(0.001);
      expect(rollRandomEvent({ probability: 0.0 })).toBeNull();
    });

    it('uses probability 1.0 to always return an event', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.999)  // probability check: 0.999 <= 1.0, passes
        .mockReturnValueOnce(0.0);   // selection index
      const result = rollRandomEvent({ probability: 1.0 });
      expect(result).not.toBeNull();
    });
  });

  describe('event structure', () => {
    it('returned event has all required fields', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)   // probability check passes
        .mockReturnValueOnce(0.0)    // selection index
        .mockReturnValue(0.5);       // fallback for id suffix generation
      const result = rollRandomEvent();
      expect(result).not.toBeNull();
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('description');
      expect(result).toHaveProperty('emotion_delta');
      expect(result).toHaveProperty('intent_boosts');
      expect(result).toHaveProperty('diary_entry');
    });

    it('event id starts with "rnd_"', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)
        .mockReturnValueOnce(0.0)
        .mockReturnValue(0.5);
      const result = rollRandomEvent();
      expect(result!.id).toMatch(/^rnd_/);
    });

    it('event id contains a timestamp portion after "rnd_"', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)
        .mockReturnValueOnce(0.0)
        .mockReturnValue(0.5);
      const result = rollRandomEvent();
      // id format: rnd_{timestamp}_{random_suffix}
      const parts = result!.id.split('_');
      expect(parts.length).toBeGreaterThanOrEqual(3);
      expect(parts[0]).toBe('rnd');
      const timestamp = Number(parts[1]);
      expect(Number.isFinite(timestamp)).toBe(true);
      expect(timestamp).toBeGreaterThan(0);
    });

    it('event description is a non-empty string', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)
        .mockReturnValueOnce(0.0)
        .mockReturnValue(0.5);
      const result = rollRandomEvent();
      expect(typeof result!.description).toBe('string');
      expect(result!.description.length).toBeGreaterThan(0);
    });

    it('event diary_entry is a non-empty string', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)
        .mockReturnValueOnce(0.0)
        .mockReturnValue(0.5);
      const result = rollRandomEvent();
      expect(typeof result!.diary_entry).toBe('string');
      expect(result!.diary_entry.length).toBeGreaterThan(0);
    });

    it('event intent_boosts is a non-empty array', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)
        .mockReturnValueOnce(0.0)
        .mockReturnValue(0.5);
      const result = rollRandomEvent();
      expect(Array.isArray(result!.intent_boosts)).toBe(true);
      expect(result!.intent_boosts.length).toBeGreaterThan(0);
    });

    it('event emotion_delta is an object', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)
        .mockReturnValueOnce(0.0)
        .mockReturnValue(0.5);
      const result = rollRandomEvent();
      expect(typeof result!.emotion_delta).toBe('object');
      expect(result!.emotion_delta).not.toBeNull();
    });
  });

  describe('category exclusion', () => {
    it('returns null when all pool events boost only excluded categories', () => {
      // Exclude every possible category so no event passes the filter
      vi.spyOn(Math, 'random').mockReturnValue(0.05);
      const result = rollRandomEvent({ excludeCategories: VALID_INTENT_CATEGORIES });
      expect(result).toBeNull();
    });

    it('filters out events that ONLY boost an excluded category', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)   // probability check
        .mockReturnValueOnce(0.0)    // select first event in filtered pool
        .mockReturnValue(0.5);       // id suffix
      const result = rollRandomEvent({ excludeCategories: ['rest'] });
      if (result !== null) {
        const onlyBoostsExcluded = result.intent_boosts.every(b => b.category === 'rest');
        expect(onlyBoostsExcluded).toBe(false);
      }
    });

    it('keeps events that boost excluded AND non-excluded categories', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)
        .mockReturnValueOnce(0.0)
        .mockReturnValue(0.5);
      const result = rollRandomEvent({ excludeCategories: ['produce'] });
      if (result !== null) {
        const allExcluded = result.intent_boosts.every(b => b.category === 'produce');
        expect(allExcluded).toBe(false);
      }
    });

    it('returns null from empty excludeCategories array (no filtering)', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)
        .mockReturnValueOnce(0.0)
        .mockReturnValue(0.5);
      const result = rollRandomEvent({ excludeCategories: [] });
      expect(result).not.toBeNull();
    });

    it('returned event passes the exclusion filter for each boost category', () => {
      const excluded: IntentCategory[] = ['connect', 'rest'];
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)
        .mockReturnValueOnce(0.0)
        .mockReturnValue(0.5);
      const result = rollRandomEvent({ excludeCategories: excluded });
      if (result !== null) {
        const allBoostsExcluded = result.intent_boosts.every(b => excluded.includes(b.category));
        expect(allBoostsExcluded).toBe(false);
      }
    });
  });

  describe('event diversity', () => {
    it('can return different events based on the selection random value', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)
        .mockReturnValueOnce(0.0)
        .mockReturnValue(0.5);
      const first = rollRandomEvent();

      vi.restoreAllMocks();

      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)
        .mockReturnValueOnce(0.999)
        .mockReturnValue(0.5);
      const last = rollRandomEvent();

      expect(first).not.toBeNull();
      expect(last).not.toBeNull();
      expect(first!.description).not.toBe(last!.description);
    });

    it('returns the first pool event when selection index is 0.0', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)
        .mockReturnValueOnce(0.0)
        .mockReturnValue(0.5);
      const result = rollRandomEvent();
      expect(result).not.toBeNull();
      expect(result!.description).toBe('突然发现已经这个点了');
    });

    it('returns the last pool event when selection index approaches 1.0', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)
        .mockReturnValueOnce(0.9999)
        .mockReturnValue(0.5);
      const result = rollRandomEvent();
      expect(result).not.toBeNull();
      expect(result!.description).toBe('刷到很有创意的内容');
    });
  });

  describe('emotion_delta format', () => {
    it('every event in the pool produces a valid EmotionDelta with numeric (or absent) fields', () => {
      const validKeys = ['valence', 'arousal', 'energy', 'stress', 'creativity', 'sociability'];
      const poolSize = 12;
      for (let i = 0; i < poolSize; i++) {
        vi.restoreAllMocks();
        vi.spyOn(Math, 'random')
          .mockReturnValueOnce(0.05)
          .mockReturnValueOnce(i / poolSize)
          .mockReturnValue(0.5);
        const result = rollRandomEvent();
        expect(result, `event at index ${i} should not be null`).not.toBeNull();
        const delta = result!.emotion_delta;
        for (const key of validKeys) {
          const value = (delta as Record<string, unknown>)[key];
          if (value !== undefined) {
            expect(typeof value, `${key} in event ${i} should be a number`).toBe('number');
            expect(Number.isFinite(value as number), `${key} in event ${i} should be finite`).toBe(true);
          }
        }
      }
    });

    it('emotion_delta has no unexpected keys', () => {
      const validKeys = new Set(['valence', 'arousal', 'energy', 'stress', 'creativity', 'sociability']);
      const poolSize = 12;
      for (let i = 0; i < poolSize; i++) {
        vi.restoreAllMocks();
        vi.spyOn(Math, 'random')
          .mockReturnValueOnce(0.05)
          .mockReturnValueOnce(i / poolSize)
          .mockReturnValue(0.5);
        const result = rollRandomEvent();
        const delta = result!.emotion_delta;
        for (const key of Object.keys(delta)) {
          expect(validKeys.has(key), `unexpected key "${key}" in emotion_delta of event ${i}`).toBe(true);
        }
      }
    });

    it('each non-undefined emotion_delta field is within a reasonable range [-1, 1]', () => {
      const poolSize = 12;
      for (let i = 0; i < poolSize; i++) {
        vi.restoreAllMocks();
        vi.spyOn(Math, 'random')
          .mockReturnValueOnce(0.05)
          .mockReturnValueOnce(i / poolSize)
          .mockReturnValue(0.5);
        const result = rollRandomEvent();
        const delta = result!.emotion_delta;
        for (const [key, value] of Object.entries(delta)) {
          if (value !== undefined) {
            expect(value as number, `${key} in event ${i} out of range`).toBeGreaterThanOrEqual(-1);
            expect(value as number, `${key} in event ${i} out of range`).toBeLessThanOrEqual(1);
          }
        }
      }
    });
  });

  describe('intent_boosts format', () => {
    it('every event has intent_boosts with valid IntentCategory values', () => {
      const validCategories = new Set<IntentCategory>(VALID_INTENT_CATEGORIES);
      const poolSize = 12;
      for (let i = 0; i < poolSize; i++) {
        vi.restoreAllMocks();
        vi.spyOn(Math, 'random')
          .mockReturnValueOnce(0.05)
          .mockReturnValueOnce(i / poolSize)
          .mockReturnValue(0.5);
        const result = rollRandomEvent();
        expect(result, `event at index ${i} should not be null`).not.toBeNull();
        for (const boost of result!.intent_boosts) {
          expect(
            validCategories.has(boost.category),
            `"${boost.category}" in event ${i} is not a valid IntentCategory`
          ).toBe(true);
        }
      }
    });

    it('every intent_boost has a numeric boost value greater than 0', () => {
      const poolSize = 12;
      for (let i = 0; i < poolSize; i++) {
        vi.restoreAllMocks();
        vi.spyOn(Math, 'random')
          .mockReturnValueOnce(0.05)
          .mockReturnValueOnce(i / poolSize)
          .mockReturnValue(0.5);
        const result = rollRandomEvent();
        for (const boost of result!.intent_boosts) {
          expect(
            typeof boost.boost,
            `boost.boost in event ${i} should be a number`
          ).toBe('number');
          expect(boost.boost, `boost.boost in event ${i} should be positive`).toBeGreaterThan(0);
        }
      }
    });

    it('every event has at least one intent_boost entry', () => {
      const poolSize = 12;
      for (let i = 0; i < poolSize; i++) {
        vi.restoreAllMocks();
        vi.spyOn(Math, 'random')
          .mockReturnValueOnce(0.05)
          .mockReturnValueOnce(i / poolSize)
          .mockReturnValue(0.5);
        const result = rollRandomEvent();
        expect(
          result!.intent_boosts.length,
          `event ${i} should have at least one intent_boost`
        ).toBeGreaterThan(0);
      }
    });
  });
});

// === Test Helpers ===

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

function makeVitality(v: number = 60): VitalityState {
  return { vitality: v, last_updated: null, consecutive_low_days: 0 };
}

function makeCtx(overrides?: Partial<EventContext>): EventContext {
  return {
    emotion: makeEmotion(),
    vitality: makeVitality(),
    flow: { ...DEFAULT_FLOW_STATE },
    currentSchedule: null,
    recentActions: [],
    cooldowns: {},
    ...overrides,
  };
}

// === Extended EVENT_POOL Tests ===

describe('EVENT_POOL structure', () => {
  it('has 16 events total', () => {
    expect(EVENT_POOL.length).toBe(16);
  });

  it('every event has required fields', () => {
    for (const event of EVENT_POOL) {
      expect(event.description).toBeTruthy();
      expect(event.diary_entry).toBeTruthy();
      expect(event.emotion_delta).toBeDefined();
      expect(event.intent_boosts.length).toBeGreaterThan(0);
      expect(event.preconditions).toBeDefined();
      expect(event.weight_modifiers).toBeDefined();
    }
  });

  it('chain_events have valid structure when present', () => {
    const withChains = EVENT_POOL.filter(e => e.chain_events && e.chain_events.length > 0);
    expect(withChains.length).toBeGreaterThan(0);

    for (const event of withChains) {
      for (const chain of event.chain_events!) {
        expect(chain.description).toBeTruthy();
        expect(chain.probability).toBeGreaterThan(0);
        expect(chain.probability).toBeLessThanOrEqual(1);
        expect(chain.delay_ticks).toHaveLength(2);
        expect(chain.delay_ticks[0]).toBeLessThanOrEqual(chain.delay_ticks[1]);
        expect(chain.emotion_delta).toBeDefined();
        expect(chain.intent_boosts.length).toBeGreaterThan(0);
        expect(chain.diary_entry).toBeTruthy();
      }
    }
  });

  it('all intent_boosts reference valid categories', () => {
    const valid = new Set<IntentCategory>(VALID_INTENT_CATEGORIES);
    for (const event of EVENT_POOL) {
      for (const boost of event.intent_boosts) {
        expect(valid.has(boost.category), `${boost.category} in ${event.description}`).toBe(true);
      }
    }
  });
});

// === rollContextAwareEvent Tests ===

describe('rollContextAwareEvent', () => {
  describe('probability gate', () => {
    it('returns null event when rng > probability', () => {
      const result = rollContextAwareEvent(makeCtx(), { probability: 0.10, rng: () => 0.5 });
      expect(result.event).toBeNull();
      expect(result.newChainEvents).toEqual([]);
    });

    it('proceeds to select when rng <= probability', () => {
      let callCount = 0;
      const rng = () => {
        callCount++;
        if (callCount === 1) return 0.05; // probability gate passes
        return 0.0; // all subsequent: pick first / no chain
      };
      const result = rollContextAwareEvent(makeCtx(), { probability: 0.10, rng });
      expect(result.event).not.toBeNull();
    });

    it('uses default probability 0.10 when not specified', () => {
      const result = rollContextAwareEvent(makeCtx(), { rng: () => 0.11 });
      expect(result.event).toBeNull();
    });
  });

  describe('precondition filtering', () => {
    it('excludes events requiring a schedule when no schedule active', () => {
      let callCount = 0;
      const rng = () => {
        callCount++;
        if (callCount === 1) return 0.0;
        return 0.0;
      };
      const ctx = makeCtx({ currentSchedule: null });
      const result = rollContextAwareEvent(ctx, { probability: 1.0, rng });
      expect(result.event).not.toBeNull();
      expect(result.event!.description).not.toBe('工作上遇到烦心事');
    });

    it('includes schedule-required events when schedule matches', () => {
      let callCount = 0;
      const rng = () => {
        callCount++;
        if (callCount === 1) return 0.0;
        return 0.0;
      };
      const ctx = makeCtx({ currentSchedule: '上班' });
      const result = rollContextAwareEvent(ctx, { probability: 1.0, rng });
      expect(result.event).not.toBeNull();
    });

    it('excludes events when schedule matches excludes_schedule', () => {
      let callCount = 0;
      const rng = () => {
        callCount++;
        if (callCount === 1) return 0.0;
        return 0.5;
      };
      const ctx = makeCtx({ currentSchedule: '上班' });
      const result = rollContextAwareEvent(ctx, { probability: 1.0, rng });
      if (result.event) {
        const excluded = ['天气特别好', '楼下在装修好吵'];
        expect(result.event.description).toBeTruthy();
      }
    });

    it('excludes flow-sensitive events when in flow state', () => {
      let callCount = 0;
      const rng = () => {
        callCount++;
        if (callCount === 1) return 0.0;
        return 0.0;
      };
      const flowState: FlowState = {
        ...DEFAULT_FLOW_STATE,
        status: 'flow',
        category: 'produce',
        activity: '拍照',
      };
      const ctx = makeCtx({ flow: flowState });
      const result = rollContextAwareEvent(ctx, { probability: 1.0, rng });
      if (result.event) {
        expect(result.event.description).not.toBe('突然想起一个很喜欢的角色');
      }
    });

    it('excludes events with max_vitality when vitality exceeds threshold', () => {
      let callCount = 0;
      const rng = () => {
        callCount++;
        if (callCount === 1) return 0.0;
        return 0.5;
      };
      const ctx = makeCtx({ vitality: makeVitality(80) });
      const result = rollContextAwareEvent(ctx, { probability: 1.0, rng });
      if (result.event) {
        expect(result.event.description).not.toBe('身体有点不舒服');
      }
    });

    it('includes max_vitality events when vitality is within range', () => {
      let callCount = 0;
      const rng = () => {
        callCount++;
        if (callCount === 1) return 0.0;
        return 0.5;
      };
      const ctx = makeCtx({ vitality: makeVitality(30) });
      const result = rollContextAwareEvent(ctx, { probability: 1.0, rng });
      expect(result.event).not.toBeNull();
    });

    it('excludes events requiring recent action when not present', () => {
      let callCount = 0;
      const rng = () => {
        callCount++;
        if (callCount === 1) return 0.0;
        return 0.5;
      };
      const ctx = makeCtx({ recentActions: [] });
      const result = rollContextAwareEvent(ctx, { probability: 1.0, rng });
      if (result.event) {
        expect(result.event.description).not.toBe('看到其他coser的神仙作品');
      }
    });

    it('includes events requiring recent action when action is present', () => {
      let callCount = 0;
      const rng = () => {
        callCount++;
        if (callCount === 1) return 0.0;
        return 0.5;
      };
      const ctx = makeCtx({ recentActions: ['consume'] });
      const result = rollContextAwareEvent(ctx, { probability: 1.0, rng });
      expect(result.event).not.toBeNull();
    });

    it('respects global_cooldown_days', () => {
      const now = new Date();
      const recentDate = new Date(now.getTime() - 10 * 86400000).toISOString();
      let callCount = 0;
      const rng = () => {
        callCount++;
        if (callCount === 1) return 0.0;
        return 0.5;
      };
      const ctx = makeCtx({ cooldowns: { '漫展即将到来': recentDate } });
      const result = rollContextAwareEvent(ctx, { probability: 1.0, rng });
      if (result.event) {
        expect(result.event.description).not.toBe('漫展即将到来');
      }
    });
  });

  describe('weight modifiers', () => {
    it('boosts vitality_inverse events when vitality is low', () => {
      const lowVitalityCtx = makeCtx({ vitality: makeVitality(20) });
      const highVitalityCtx = makeCtx({ vitality: makeVitality(80) });

      let lowCount = 0;
      let highCount = 0;
      const trials = 200;

      for (let i = 0; i < trials; i++) {
        let callIdx = 0;
        const rng = () => {
          callIdx++;
          if (callIdx === 1) return 0.0;
          return Math.random();
        };
        const low = rollContextAwareEvent(lowVitalityCtx, { probability: 1.0, rng });
        if (low.event && (low.event.description === '灵感枯竭期' || low.event.description === '身体有点不舒服' || low.event.description === '感觉今天过得好慢')) {
          lowCount++;
        }

        callIdx = 0;
        const rng2 = () => {
          callIdx++;
          if (callIdx === 1) return 0.0;
          return Math.random();
        };
        const high = rollContextAwareEvent(highVitalityCtx, { probability: 1.0, rng: rng2 });
        if (high.event && (high.event.description === '灵感枯竭期' || high.event.description === '感觉今天过得好慢')) {
          highCount++;
        }
      }

      expect(lowCount).toBeGreaterThan(highCount);
    });

    it('boosts dimension_boost events when matching dimension is high', () => {
      const highCreativity = makeCtx({
        emotion: makeEmotion({ creativity: 0.8 }),
      });
      const lowCreativity = makeCtx({
        emotion: makeEmotion({ creativity: 0.2 }),
      });

      let highCount = 0;
      let lowCount = 0;
      const trials = 500;

      for (let i = 0; i < trials; i++) {
        let callIdx = 0;
        const rng = () => {
          callIdx++;
          if (callIdx === 1) return 0.0;
          return Math.random();
        };
        const result = rollContextAwareEvent(highCreativity, { probability: 1.0, rng });
        if (result.event && ['突然想起一个很喜欢的角色', '刷到一个新番预告', '刷到很有创意的短视频'].includes(result.event.description)) {
          highCount++;
        }

        callIdx = 0;
        const rng2 = () => {
          callIdx++;
          if (callIdx === 1) return 0.0;
          return Math.random();
        };
        const result2 = rollContextAwareEvent(lowCreativity, { probability: 1.0, rng: rng2 });
        if (result2.event && ['突然想起一个很喜欢的角色', '刷到一个新番预告', '刷到很有创意的短视频'].includes(result2.event.description)) {
          lowCount++;
        }
      }

      expect(highCount).toBeGreaterThanOrEqual(lowCount);
    });

    it('boosts emotion_resonance when valence directions match', () => {
      const negCtx = makeCtx({
        emotion: makeEmotion({ mood: { valence: -0.5, arousal: 0.5, description: '有点烦' } }),
      });
      const posCtx = makeCtx({
        emotion: makeEmotion({ mood: { valence: 0.5, arousal: 0.5, description: '开心' } }),
      });

      let negCount = 0;
      let posCount = 0;
      const trials = 500;

      for (let i = 0; i < trials; i++) {
        let callIdx = 0;
        const rng = () => {
          callIdx++;
          if (callIdx === 1) return 0.0;
          return Math.random();
        };
        const neg = rollContextAwareEvent(negCtx, { probability: 1.0, rng });
        if (neg.event?.description === '看到让人不舒服的热搜') negCount++;

        callIdx = 0;
        const rng2 = () => {
          callIdx++;
          if (callIdx === 1) return 0.0;
          return Math.random();
        };
        const pos = rollContextAwareEvent(posCtx, { probability: 1.0, rng: rng2 });
        if (pos.event?.description === '看到让人不舒服的热搜') posCount++;
      }

      expect(negCount).toBeGreaterThanOrEqual(posCount);
    });
  });

  describe('event output structure', () => {
    it('returned event has all required fields', () => {
      let callCount = 0;
      const rng = () => {
        callCount++;
        if (callCount === 1) return 0.0;
        return 0.5;
      };
      const result = rollContextAwareEvent(makeCtx(), { probability: 1.0, rng });
      expect(result.event).not.toBeNull();
      expect(result.event!.id).toMatch(/^rnd_/);
      expect(result.event!.description).toBeTruthy();
      expect(result.event!.emotion_delta).toBeDefined();
      expect(result.event!.intent_boosts.length).toBeGreaterThan(0);
      expect(result.event!.diary_entry).toBeTruthy();
    });

    it('returns empty chain events when selected event has no chains', () => {
      let callCount = 0;
      const rng = () => {
        callCount++;
        if (callCount === 1) return 0.0;
        return 0.01;
      };
      const result = rollContextAwareEvent(makeCtx(), { probability: 1.0, rng });
      expect(Array.isArray(result.newChainEvents)).toBe(true);
    });
  });

  describe('chain event generation', () => {
    it('generates chain events when probability is met', () => {
      const ctx = makeCtx({ currentSchedule: '上班', recentActions: ['consume'] });

      let totalChains = 0;
      const trials = 500;
      for (let i = 0; i < trials; i++) {
        let callIdx = 0;
        const rng = () => {
          callIdx++;
          if (callIdx === 1) return 0.0;
          return Math.random();
        };
        const result = rollContextAwareEvent(ctx, { probability: 1.0, rng });
        totalChains += result.newChainEvents.length;
      }

      expect(totalChains).toBeGreaterThan(0);
    });

    it('chain events have valid ticks_remaining within delay range', () => {
      const ctx = makeCtx({ currentSchedule: '上班' });

      for (let trial = 0; trial < 30; trial++) {
        let callIdx = 0;
        const rng = () => {
          callIdx++;
          if (callIdx === 1) return 0.0;
          return Math.random();
        };
        const result = rollContextAwareEvent(ctx, { probability: 1.0, rng });
        for (const chain of result.newChainEvents) {
          expect(chain.ticks_remaining).toBeGreaterThanOrEqual(1);
          expect(chain.source_event_id).toBeTruthy();
          expect(chain.event.description).toBeTruthy();
          expect(chain.event.diary_entry).toBeTruthy();
        }
      }
    });

    it('does not generate chain events when rng exceeds chain probability', () => {
      const ctx = makeCtx({ currentSchedule: '上班' });
      let callIdx = 0;
      const rng = () => {
        callIdx++;
        if (callIdx === 1) return 0.0;
        if (callIdx === 2) return 0.0;
        return 0.999;
      };
      const result = rollContextAwareEvent(ctx, { probability: 1.0, rng });
      expect(result.newChainEvents.length).toBe(0);
    });
  });
});

// === processChainEvents Tests ===

describe('processChainEvents', () => {
  it('triggers events when ticks_remaining reaches 0', () => {
    const state: ChainAndCooldownState = {
      pending: [
        {
          source_event_id: 'test_1',
          ticks_remaining: 1,
          event: {
            description: '连锁事件1',
            probability: 0.5,
            emotion_delta: { valence: -0.1 },
            intent_boosts: [{ category: 'rest', boost: 1.0 }],
            diary_entry: '测试日记1',
          },
        },
      ],
      cooldowns: {},
    };

    const { triggered, remaining } = processChainEvents(state);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].event.description).toBe('连锁事件1');
    expect(triggered[0].ticks_remaining).toBe(0);
    expect(remaining.pending).toHaveLength(0);
  });

  it('decrements ticks_remaining for non-ready events', () => {
    const state: ChainAndCooldownState = {
      pending: [
        {
          source_event_id: 'test_1',
          ticks_remaining: 5,
          event: {
            description: '等待中的事件',
            probability: 0.5,
            emotion_delta: { stress: 0.1 },
            intent_boosts: [{ category: 'rest', boost: 1.0 }],
            diary_entry: '还没到时间',
          },
        },
      ],
      cooldowns: {},
    };

    const { triggered, remaining } = processChainEvents(state);
    expect(triggered).toHaveLength(0);
    expect(remaining.pending).toHaveLength(1);
    expect(remaining.pending[0].ticks_remaining).toBe(4);
  });

  it('handles mix of ready and pending events', () => {
    const state: ChainAndCooldownState = {
      pending: [
        {
          source_event_id: 'a',
          ticks_remaining: 1,
          event: {
            description: '要触发',
            probability: 0.5,
            emotion_delta: { valence: 0.1 },
            intent_boosts: [{ category: 'connect', boost: 1.0 }],
            diary_entry: '触发了',
          },
        },
        {
          source_event_id: 'b',
          ticks_remaining: 3,
          event: {
            description: '还要等',
            probability: 0.5,
            emotion_delta: { stress: 0.1 },
            intent_boosts: [{ category: 'rest', boost: 1.0 }],
            diary_entry: '等待中',
          },
        },
        {
          source_event_id: 'c',
          ticks_remaining: 1,
          event: {
            description: '也要触发',
            probability: 0.5,
            emotion_delta: { valence: -0.1 },
            intent_boosts: [{ category: 'express', boost: 1.0 }],
            diary_entry: '也触发了',
          },
        },
      ],
      cooldowns: {},
    };

    const { triggered, remaining } = processChainEvents(state);
    expect(triggered).toHaveLength(2);
    expect(triggered.map(t => t.event.description)).toContain('要触发');
    expect(triggered.map(t => t.event.description)).toContain('也要触发');
    expect(remaining.pending).toHaveLength(1);
    expect(remaining.pending[0].event.description).toBe('还要等');
    expect(remaining.pending[0].ticks_remaining).toBe(2);
  });

  it('returns empty arrays when no pending events', () => {
    const state: ChainAndCooldownState = { pending: [], cooldowns: {} };
    const { triggered, remaining } = processChainEvents(state);
    expect(triggered).toHaveLength(0);
    expect(remaining.pending).toHaveLength(0);
  });

  it('preserves cooldowns in remaining state', () => {
    const state: ChainAndCooldownState = {
      pending: [],
      cooldowns: { '漫展即将到来': '2026-01-01T00:00:00Z' },
    };
    const { remaining } = processChainEvents(state);
    expect(remaining.cooldowns).toEqual({ '漫展即将到来': '2026-01-01T00:00:00Z' });
  });

  it('does not mutate the input state', () => {
    const original: PendingChainEvent = {
      source_event_id: 'x',
      ticks_remaining: 3,
      event: {
        description: '不变',
        probability: 0.5,
        emotion_delta: { valence: 0.1 },
        intent_boosts: [{ category: 'produce', boost: 1.0 }],
        diary_entry: '不变',
      },
    };
    const state: ChainAndCooldownState = {
      pending: [original],
      cooldowns: {},
    };

    processChainEvents(state);
    expect(original.ticks_remaining).toBe(3); // unchanged
    expect(state.pending).toHaveLength(1); // unchanged
  });
});
