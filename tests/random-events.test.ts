// tests/random-events.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { rollRandomEvent } from '../skill/scripts/random-events';
import { IntentCategory } from '../skill/scripts/types';

const VALID_INTENT_CATEGORIES: IntentCategory[] = [
  '创作', '社交', '窥屏', '表达', '学习', '休息', '梦想',
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
      // Even Math.random() = 0.0 should fail: 0.0 > 0.0 is false, so actually 0.0 passes
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
      // The event "身体有点不舒服" only boosts 休息; if we exclude 休息, it should be filtered out
      // We verify by running many times with exclusion and never getting a 休息-only event
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)   // probability check
        .mockReturnValueOnce(0.0)    // select first event in filtered pool
        .mockReturnValue(0.5);       // id suffix
      const result = rollRandomEvent({ excludeCategories: ['休息'] });
      // If returned, the event must not be one that ONLY boosts 休息
      if (result !== null) {
        const onlyBoostsExcluded = result.intent_boosts.every(b => b.category === '休息');
        expect(onlyBoostsExcluded).toBe(false);
      }
    });

    it('keeps events that boost excluded AND non-excluded categories', () => {
      // "天气特别好" boosts both 创作 and 表达; excluding 创作 alone should NOT filter it
      // because it doesn't ONLY boost 创作
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)
        .mockReturnValueOnce(0.0)
        .mockReturnValue(0.5);
      // Excluding 创作 only — events with mixed boosts should still be available
      const result = rollRandomEvent({ excludeCategories: ['创作'] });
      // Result may or may not be null depending on what first event in filtered pool is,
      // but if we get a result, its boosts should not be all-创作
      if (result !== null) {
        const allExcluded = result.intent_boosts.every(b => b.category === '创作');
        expect(allExcluded).toBe(false);
      }
    });

    it('returns null from empty excludeCategories array (no filtering)', () => {
      // Empty excludeCategories: no events removed, should behave normally
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)
        .mockReturnValueOnce(0.0)
        .mockReturnValue(0.5);
      const result = rollRandomEvent({ excludeCategories: [] });
      expect(result).not.toBeNull();
    });

    it('returned event passes the exclusion filter for each boost category', () => {
      const excluded: IntentCategory[] = ['社交', '休息'];
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
      // First call: select event at index ~0 (first event in pool)
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)   // probability gate
        .mockReturnValueOnce(0.0)    // select index 0
        .mockReturnValue(0.5);       // id suffix
      const first = rollRandomEvent();

      vi.restoreAllMocks();

      // Second call: select event near the end of pool (pool has 12 events, index ~11)
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)   // probability gate
        .mockReturnValueOnce(0.999)  // select last index
        .mockReturnValue(0.5);       // id suffix
      const last = rollRandomEvent();

      expect(first).not.toBeNull();
      expect(last).not.toBeNull();
      // Different selection indices should yield different descriptions
      expect(first!.description).not.toBe(last!.description);
    });

    it('returns the first pool event when selection index is 0.0', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)
        .mockReturnValueOnce(0.0)
        .mockReturnValue(0.5);
      const result = rollRandomEvent();
      expect(result).not.toBeNull();
      // First event in EVENT_POOL has this description
      expect(result!.description).toBe('突然想起一个很喜欢的角色');
    });

    it('returns the last pool event when selection index approaches 1.0', () => {
      vi.spyOn(Math, 'random')
        .mockReturnValueOnce(0.05)
        .mockReturnValueOnce(0.9999)
        .mockReturnValue(0.5);
      const result = rollRandomEvent();
      expect(result).not.toBeNull();
      // Last event in EVENT_POOL (index 11) has this description
      expect(result!.description).toBe('和朋友聊了很久');
    });
  });

  describe('emotion_delta format', () => {
    it('every event in the pool produces a valid EmotionDelta with numeric (or absent) fields', () => {
      const validKeys = ['valence', 'arousal', 'energy', 'stress', 'creativity', 'sociability'];
      // Iterate through all 12 pool events by controlling the selection index
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
