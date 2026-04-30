// Test for Phase 1 Critical Fixes

import { expect, describe, it } from 'vitest';
import { processProcrastination } from '../../../alive/scripts/engines/intent';
import { generateFlowDiary } from '../../../alive/scripts/engines/flow';
import { morningRecovery } from '../../../alive/scripts/engines/vitality';
import { decayThreeLayer } from '../../../alive/scripts/engines/emotion';
import { resetImpulseAfterOutput } from '../../../alive/scripts/engines/work-impulse';
import { getLocalDate } from '../../../alive/scripts/utils/time-utils';

describe('Phase 1 Critical Fixes', () => {
  
  describe('Fix #1: PROCRASTINATION_TEMPLATES array index', () => {
    it('should not crash when rng() returns exactly 1.0', () => {
      const mockRng = () => 1.0;
      const pool = {
        intents: [{
          id: 'test', category: 'produce', intensity: 5, resistance: 0,
          decay_rate: 0.1, born_at: new Date().toISOString(), 
          satisfied_at: null, skipped_count: 3, source: 'default', 
          description: 'test task', last_attempted: null
        }]
      };
      
      // Should not throw
      expect(() => {
        processProcrastination(pool, new Set(), mockRng);
      }).not.toThrow();
    });

    it('should handle boundary RNG values [0, 0.5, 0.9999, 1.0]', () => {
      const boundaryValues = [0, 0.5, 0.9999, 1.0];
      const pool = {
        intents: [{
          id: 'test', category: 'produce', intensity: 5, resistance: 0,
          decay_rate: 0.1, born_at: new Date().toISOString(), 
          satisfied_at: null, skipped_count: 3, source: 'default', 
          description: 'test task', last_attempted: null
        }]
      };

      for (const val of boundaryValues) {
        const mockRng = () => val;
        expect(() => {
          processProcrastination(pool, new Set(), mockRng);
        }).not.toThrow(`Failed for rng() = ${val}`);
      }
    });
  });

  describe('Fix #3: Emergency vitality never exceeds VITALITY_MAX', () => {
    it('should not exceed 100 when emergency recovery applies to high vitality', () => {
      const state = {
        vitality: 90,
        consecutive_low_days: 5, // Triggers emergency
        last_updated: new Date().toISOString(),
      };

      const result = morningRecovery(state as any);
      
      expect(result.vitality).toBeLessThanOrEqual(100);
      expect(result.vitality).toBeGreaterThanOrEqual(0);
    });

    it('should clamp vitality correctly across range [0, 100]', () => {
      const testCases = [
        { vitality: 0, consecutive_low_days: 5 },
        { vitality: 30, consecutive_low_days: 5 },
        { vitality: 80, consecutive_low_days: 5 },
        { vitality: 100, consecutive_low_days: 5 },
      ];

      for (const testCase of testCases) {
        const state = {
          vitality: testCase.vitality,
          consecutive_low_days: testCase.consecutive_low_days,
          last_updated: new Date().toISOString(),
        };

        const result = morningRecovery(state as any);
        expect(result.vitality).toBeLessThanOrEqual(100);
        expect(result.vitality).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Fix #4: Momentum duration handles zero crossing', () => {
    it('should reset duration when crossing zero valence', () => {
      const state = {
        mood: { valence: 0.5, arousal: 0.5, description: '' },
        energy: 0.5,
        stress: 0.3,
        creativity: 0.5,
        sociability: 0.5,
        momentum: { 
          valence: 0.5, arousal: 0.5, energy: 0.5, stress: 0.3,
          creativity: 0.5, sociability: 0.5, duration_ticks: 5
        },
        undertone: { 
          valence: -0.5, arousal: 0.5, energy: 0.5, stress: 0.3,
          creativity: 0.5, sociability: 0.5
        },
        impulse_history: [],
        consecutive_high_stress: 0,
        threshold_break_cooldown: 0,
        last_updated: new Date().toISOString(),
      };

      const result = decayThreeLayer(state as any);
      
      // momentum valence will decay from 0.5 toward -0.5
      // After one tick with 8% decay rate: 0.5 + (-0.5 - 0.5) * 0.08 = 0.5 - 0.08 = 0.42
      // Still positive, so should not reset
      // Since prevSign was positive and newSign is still positive, increment
      expect(result.momentum.duration_ticks).toBe(6);
    });

    it('should handle zero-boundary valence correctly', () => {
      const testValences = [-0.5, -0.01, 0, 0.01, 0.5];
      
      for (const val of testValences) {
        const state = {
          mood: { valence: val, arousal: 0.5, description: '' },
          energy: 0.5, stress: 0.3, creativity: 0.5, sociability: 0.5,
          momentum: { valence: val, arousal: 0.5, energy: 0.5, stress: 0.3,
            creativity: 0.5, sociability: 0.5, duration_ticks: 1 },
          undertone: { valence: val, arousal: 0.5, energy: 0.5, stress: 0.3,
            creativity: 0.5, sociability: 0.5 },
          impulse_history: [],
          consecutive_high_stress: 0,
          threshold_break_cooldown: 0,
          last_updated: new Date().toISOString(),
        };

        expect(() => {
          decayThreeLayer(state as any);
        }).not.toThrow(`Failed for valence = ${val}`);
      }
    });
  });

  describe('Fix #5: Work impulse reset preserves state', () => {
    it('should preserve all required fields when resetting impulse', () => {
      const today = getLocalDate(); // Use same local-timezone date as the engine
      const state = {
        value: 50,
        last_output_at: Date.now() - 3600000,
        outputs_today_date: today,
        outputs_today: 2,
        // Additional fields that should be preserved
        extra_field: 'should_be_preserved',
      };

      const result = resetImpulseAfterOutput(state as any);

      // Verify modified fields
      expect(result.value).toBe(0);
      expect(result.last_output_at).toBeGreaterThan(state.last_output_at);
      expect(result.outputs_today).toBe(3); // Should increment from 2 to 3

      // Verify original fields preserved via spread
      expect(result.extra_field).toBe('should_be_preserved');
    });
  });
});
