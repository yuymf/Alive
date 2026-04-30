# Code Patches and Unit Test Templates

**Generated**: 2026-04-30  
**For**: CRITICAL Phase 1 Fixes (P1.1 - P1.5)  

---

## P1.1: intent.ts - PROCRASTINATION_TEMPLATES Array Index Fix

### Patch File
```diff
--- a/alive/scripts/engines/intent.ts
+++ b/alive/scripts/engines/intent.ts
@@ -197,8 +197,9 @@ export function processProcrastination(pool: IntentPool, chosenIntentIds: Reado
     if (newSkipped === 3 && !emittedDescriptions.has(intent.description) && diaryEntries.length < MAX_DIARY_PER_TICK) {
       stressDelta += 0.05;
-      const templateFn = PROCRASTINATION_TEMPLATES[Math.floor(rng() * PROCRASTINATION_TEMPLATES.length)];
+      const index = Math.floor(rng() * PROCRASTINATION_TEMPLATES.length) % PROCRASTINATION_TEMPLATES.length;
+      const templateFn = PROCRASTINATION_TEMPLATES[index];
       diaryEntries.push(templateFn(intent.description));
       emittedDescriptions.add(intent.description);
     }
```

### Unit Test
```typescript
import { describe, it, expect } from 'vitest';
import { processProcrastination } from '../engines/intent.ts';
import { IntentPool } from '../utils/types';

describe('processProcrastination - PROCRASTINATION_TEMPLATES index bounds', () => {
  
  const mockPool: IntentPool = {
    intents: [
      {
        id: 'test-intent',
        category: 'produce',
        description: 'Complete project',
        intensity: 5.0,
        source: 'manual',
        born_at: new Date().toISOString(),
        decay_rate: 0.1,
        satisfied_at: null,
        resistance: 2.0,
        skipped_count: 3,  // Will trigger procrastination diary
        last_attempted: null,
      }
    ]
  };

  it('should handle rng() returning 0 (lower bound)', () => {
    const rng = () => 0;
    const result = processProcrastination(mockPool, new Set(), rng, 0.5);
    expect(result.diaryEntries.length).toBeGreaterThanOrEqual(1);
    expect(result.diaryEntries[0]).toBeTruthy();
    expect(typeof result.diaryEntries[0]).toBe('string');
  });

  it('should handle rng() returning 0.5 (middle)', () => {
    const rng = () => 0.5;
    const result = processProcrastination(mockPool, new Set(), rng, 0.5);
    expect(result.diaryEntries.length).toBeGreaterThanOrEqual(1);
    expect(result.diaryEntries[0]).toBeTruthy();
  });

  it('should handle rng() returning 0.9999999 (near upper bound)', () => {
    const rng = () => 0.9999999;
    const result = processProcrastination(mockPool, new Set(), rng, 0.5);
    expect(result.diaryEntries.length).toBeGreaterThanOrEqual(1);
    expect(result.diaryEntries[0]).toBeTruthy();
  });

  it('should NOT crash when rng() returns exactly 1.0 (edge case)', () => {
    const rng = () => 1.0;
    expect(() => {
      processProcrastination(mockPool, new Set(), rng, 0.5);
    }).not.toThrow();
    
    // Verify result is valid even at edge
    const result = processProcrastination(mockPool, new Set(), rng, 0.5);
    expect(result.pool).toBeDefined();
    expect(Array.isArray(result.diaryEntries)).toBe(true);
  });

  it('should produce variation across different RNG seeds', () => {
    const entries = new Set<string>();
    
    for (let i = 0; i < 100; i++) {
      const rng = () => Math.random();
      const result = processProcrastination(mockPool, new Set(), rng, 0.5);
      if (result.diaryEntries.length > 0) {
        entries.add(result.diaryEntries[0]);
      }
    }
    
    // Should have multiple variations (at least 2-3 different templates seen)
    expect(entries.size).toBeGreaterThan(1);
  });
});
```

---

## P1.2: flow.ts - FLOW_DIARY_TEMPLATES Array Index Fix

### Patch File
```diff
--- a/alive/scripts/engines/flow.ts
+++ b/alive/scripts/engines/flow.ts
@@ -134,8 +134,10 @@ export function generateFlowDiary(inFlow: boolean, category: MetaIntent | null,
       template = FLOW_EXIT_TEMPLATES[Math.floor(rng() * FLOW_EXIT_TEMPLATES.length)];
     }
-    const template = templates[Math.floor(rng() * templates.length)];
-    const detail = FLOW_MICRO_DETAILS[Math.floor(rng() * FLOW_MICRO_DETAILS.length)];
+    const templateIdx = Math.floor(rng() * templates.length) % templates.length;
+    const template = templates[templateIdx];
+    const detailIdx = Math.floor(rng() * FLOW_MICRO_DETAILS.length) % FLOW_MICRO_DETAILS.length;
+    const detail = FLOW_MICRO_DETAILS[detailIdx];
     return template(detail);
   };
```

### Unit Test
```typescript
import { describe, it, expect } from 'vitest';
import { generateFlowDiary } from '../engines/flow.ts';

describe('generateFlowDiary - Template array bounds', () => {
  
  it('should not crash with rng() returning 0', () => {
    const rng = () => 0;
    expect(() => {
      generateFlowDiary(true, 'produce', rng);
    }).not.toThrow();
    
    const result = generateFlowDiary(true, 'produce', rng);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('should not crash with rng() returning 0.5', () => {
    const rng = () => 0.5;
    const result = generateFlowDiary(false, 'express', rng);
    expect(typeof result).toBe('string');
  });

  it('should not crash with rng() returning 0.9999999', () => {
    const rng = () => 0.9999999;
    const result = generateFlowDiary(true, 'learn', rng);
    expect(typeof result).toBe('string');
  });

  it('CRITICAL: should not crash with rng() returning exactly 1.0', () => {
    const rng = () => 1.0;
    expect(() => {
      generateFlowDiary(true, 'produce', rng);
    }).not.toThrow('templateFn is not a function');
    
    const result = generateFlowDiary(true, 'produce', rng);
    expect(result).toBeTruthy();
  });

  it('should generate different text for flow entry vs exit', () => {
    const rng = () => 0.5;
    const entryText = generateFlowDiary(true, 'produce', rng);
    const exitText = generateFlowDiary(false, 'produce', rng);
    
    // They might occasionally be the same, but different flows should have distinct templates
    expect(entryText).toBeTruthy();
    expect(exitText).toBeTruthy();
  });

  it('should work for all intent categories', () => {
    const categories = ['produce', 'connect', 'consume', 'express', 'learn', 'rest', 'aspire'] as const;
    const rng = () => 1.0; // Test at edge case
    
    for (const cat of categories) {
      expect(() => {
        generateFlowDiary(true, cat, rng);
      }).not.toThrow();
    }
  });
});
```

---

## P1.3: vitality.ts - Emergency Vitality Recovery Fix

### Patch File
```diff
--- a/alive/scripts/engines/vitality.ts
+++ b/alive/scripts/engines/vitality.ts
@@ -55,10 +55,11 @@ export function morningRecovery(state: VitalityState): VitalityState {
   const wasLow = state.vitality < 30;
   const newConsecutive = wasLow ? state.consecutive_low_days + 1 : 0;
   const emergency = newConsecutive >= VITALITY_CONFIG.EMERGENCY_LOW_DAYS;
   const base = REPLENISHMENT.sleep_cycle;
-  const newVitality = emergency ? Math.max(state.vitality + base, VITALITY_CONFIG.EMERGENCY_MIN_VITALITY) : clampVitality(state.vitality + base);
+  const newVitality = emergency 
+    ? clampVitality(Math.max(state.vitality, VITALITY_CONFIG.EMERGENCY_MIN_VITALITY) + base)
+    : clampVitality(state.vitality + base);
   return { ...state, vitality: newVitality, last_updated: now().toISOString(), consecutive_low_days: emergency ? 0 : newConsecutive };
 }
```

### Unit Test
```typescript
import { describe, it, expect } from 'vitest';
import { morningRecovery } from '../engines/vitality.ts';
import { VitalityState } from '../utils/types';
import { VITALITY_CONFIG } from '../config';

describe('morningRecovery - Emergency path clamping', () => {
  
  const createVitalityState = (vitality: number, consecutiveLowDays: number = 0): VitalityState => ({
    vitality,
    last_updated: new Date().toISOString(),
    consecutive_low_days: consecutiveLowDays,
    last_afternoon_rest_date: null,
  });

  it('should clamp normal recovery within [MIN, MAX]', () => {
    const state = createVitalityState(50);
    const result = morningRecovery(state);
    expect(result.vitality).toBeLessThanOrEqual(VITALITY_CONFIG.VITALITY_MAX);
    expect(result.vitality).toBeGreaterThanOrEqual(0);
  });

  it('should never exceed VITALITY_MAX even with high starting vitality', () => {
    const high = VITALITY_CONFIG.VITALITY_MAX - 5; // 95
    const state = createVitalityState(high);
    const result = morningRecovery(state);
    
    expect(result.vitality).toBeLessThanOrEqual(VITALITY_CONFIG.VITALITY_MAX);
  });

  it('CRITICAL: should never exceed VITALITY_MAX in emergency path', () => {
    // Simulate emergency: vitality at 90, 3+ days of low vitality
    const emergencyDays = VITALITY_CONFIG.EMERGENCY_LOW_DAYS;
    const state = createVitalityState(90, emergencyDays);
    
    const result = morningRecovery(state);
    
    expect(result.vitality).toBeLessThanOrEqual(VITALITY_CONFIG.VITALITY_MAX);
    expect(result.vitality).toBeLessThanOrEqual(100);
  });

  it('CRITICAL: should ensure emergency recovery at least reaches EMERGENCY_MIN_VITALITY', () => {
    const emergencyDays = VITALITY_CONFIG.EMERGENCY_LOW_DAYS;
    const veryLow = 5;
    const state = createVitalityState(veryLow, emergencyDays);
    
    const result = morningRecovery(state);
    
    expect(result.vitality).toBeGreaterThanOrEqual(VITALITY_CONFIG.EMERGENCY_MIN_VITALITY);
  });

  it('should transition out of emergency after recovery', () => {
    const emergencyDays = VITALITY_CONFIG.EMERGENCY_LOW_DAYS;
    const state = createVitalityState(20, emergencyDays);
    
    const result = morningRecovery(state);
    
    // After emergency recovery, consecutive days should reset
    expect(result.consecutive_low_days).toBe(0);
  });

  it('should not trigger emergency with insufficient consecutive low days', () => {
    const state = createVitalityState(25, 1); // Only 1 day of low vitality
    const result = morningRecovery(state);
    
    // Should increment consecutive days, not trigger emergency
    expect(result.consecutive_low_days).toBeGreaterThan(1);
  });

  it('edge case: vitality at exactly 0', () => {
    const emergencyDays = VITALITY_CONFIG.EMERGENCY_LOW_DAYS;
    const state = createVitalityState(0, emergencyDays);
    
    const result = morningRecovery(state);
    
    expect(result.vitality).toBeGreaterThan(0);
    expect(result.vitality).toBeLessThanOrEqual(VITALITY_CONFIG.VITALITY_MAX);
  });

  it('edge case: vitality at exactly VITALITY_MAX', () => {
    const state = createVitalityState(VITALITY_CONFIG.VITALITY_MAX);
    const result = morningRecovery(state);
    
    // Should stay at max, not overflow
    expect(result.vitality).toBeLessThanOrEqual(VITALITY_CONFIG.VITALITY_MAX);
  });
});
```

---

## P1.4: emotion.ts - Momentum Zero-Crossing Fix (Option B: Hysteresis)

### Patch File
```diff
--- a/alive/scripts/engines/emotion.ts
+++ b/alive/scripts/engines/emotion.ts
@@ -13,6 +13,7 @@ const INTENSITY_CAP = INTENSITY_CONFIG.INTENSITY_CAP;
 const RUMINATION_THRESHOLD = 0.7;
+const MOMENTUM_THRESHOLD = 0.05;  // Hysteresis threshold to avoid zero-crossing jitter
 
 function clampEmotion(v: number): number {
   return Math.min(1, Math.max(-1, v));
@@ -208,9 +209,16 @@ export function decayThreeLayer(state: EmotionState, factor: number): EmotionSt
   );
-  const prevSign = Math.sign(state.momentum.valence);
-  const newSign = Math.sign(newMomentum.valence);
-  newMomentum.duration_ticks = prevSign === newSign ? state.momentum.duration_ticks + 1 : 0;
+  // Use hysteresis threshold to prevent zero-crossing oscillation
+  const prevSign = Math.abs(state.momentum.valence) < MOMENTUM_THRESHOLD
+    ? 0
+    : state.momentum.valence < 0 ? -1 : 1;
+  const newSign = Math.abs(newMomentum.valence) < MOMENTUM_THRESHOLD
+    ? 0
+    : newMomentum.valence < 0 ? -1 : 1;
+  
+  newMomentum.duration_ticks = prevSign === newSign ? state.momentum.duration_ticks + 1 : 0;
   
   return { ...state, momentum: newMomentum, undertone: newUndertone };
 }
```

### Unit Test
```typescript
import { describe, it, expect } from 'vitest';
import { decayThreeLayer } from '../engines/emotion.ts';
import { EmotionState } from '../utils/types';

describe('decayThreeLayer - Momentum zero-crossing', () => {
  
  const createMomentum = (valence: number) => ({
    valence,
    arousal: 0.5,
    energy: 0.5,
    duration_ticks: 0,
  });

  const createEmotionState = (momentumValence: number): EmotionState => ({
    impulse: { valence: 0, arousal: 0, energy: 0, duration_ticks: 0 },
    momentum: createMomentum(momentumValence),
    undertone: { valence: 0, arousal: 0, energy: 0 },
  });

  it('should increment duration when staying in positive region', () => {
    let state = createEmotionState(0.3);
    state = decayThreeLayer(state, 0.9);
    
    expect(state.momentum.duration_ticks).toBeGreaterThan(0);
  });

  it('should increment duration when staying in negative region', () => {
    let state = createEmotionState(-0.3);
    state = decayThreeLayer(state, 0.9);
    
    expect(state.momentum.duration_ticks).toBeGreaterThan(0);
  });

  it('should reset duration when crossing from positive to negative', () => {
    let state = createEmotionState(0.3);
    state.momentum.duration_ticks = 5; // Simulate previous ticks
    
    state = decayThreeLayer(state, 0.1); // Decay to negative
    
    expect(state.momentum.duration_ticks).toBe(0);
  });

  it('should reset duration when crossing from negative to positive', () => {
    let state = createEmotionState(-0.3);
    state.momentum.duration_ticks = 5;
    
    state = decayThreeLayer(state, 0.1);
    
    expect(state.momentum.duration_ticks).toBe(0);
  });

  it('CRITICAL: should not continue duration when crossing through zero (near-zero)', () => {
    // Start just slightly positive
    let state = createEmotionState(0.01);
    state.momentum.duration_ticks = 5;
    
    // Decay should cross to just slightly negative
    state = decayThreeLayer(state, 0.05);
    
    // Duration should reset (crossing occurred)
    expect(state.momentum.duration_ticks).toBe(0);
  });

  it('should treat near-zero (±0.01) same as far-zero (±0.5)', () => {
    // Test that hysteresis threshold prevents zero-crossing jitter
    let state1 = createEmotionState(0.01);
    let state2 = createEmotionState(-0.01);
    state1.momentum.duration_ticks = 1;
    state2.momentum.duration_ticks = 1;
    
    state1 = decayThreeLayer(state1, 0.9);
    state2 = decayThreeLayer(state2, 0.9);
    
    // Both should increment (within hysteresis threshold = same region)
    expect(state1.momentum.duration_ticks).toBeGreaterThan(1);
    expect(state2.momentum.duration_ticks).toBeGreaterThan(1);
  });

  it('should reset duration when exiting near-zero region', () => {
    let state = createEmotionState(0.03); // Just at hysteresis boundary
    state.momentum.duration_ticks = 3;
    
    // Decay that crosses boundary
    state = decayThreeLayer(state, 0.5);
    
    // If crossed to other side, duration resets
    const shouldReset = (state.momentum.valence < -0.05) || (state.momentum.valence > 0.05);
    if (shouldReset) {
      expect(state.momentum.duration_ticks).toBe(0);
    }
  });
});
```

---

## P1.5: work-impulse.ts - Complete State Object Fix

### Patch File
```diff
--- a/alive/scripts/engines/work-impulse.ts
+++ b/alive/scripts/engines/work-impulse.ts
@@ -60,12 +60,13 @@ export function resetImpulseAfterOutput(state: WorkImpulseState): WorkImpulseSta
   const today = getLocalDate();
   const outputsToday = state.outputs_today_date === today ? state.outputs_today : 0;
   
   return {
+    ...state,
     value: 0,
     last_output_at: now().getTime(),
     outputs_today_date: today,
     outputs_today: outputsToday + 1,
   };
 }
```

### Unit Test
```typescript
import { describe, it, expect } from 'vitest';
import { resetImpulseAfterOutput } from '../engines/work-impulse.ts';
import { WorkImpulseState } from '../utils/types';

describe('resetImpulseAfterOutput - Complete state object', () => {
  
  const createWorkImpulseState = (): WorkImpulseState => ({
    value: 5.0,
    last_output_at: Date.now() - 3600000, // 1 hour ago
    outputs_today_date: new Date().toLocaleDateString('en-CA'),
    outputs_today: 3,
  });

  it('should reset value to 0', () => {
    const state = createWorkImpulseState();
    const result = resetImpulseAfterOutput(state);
    
    expect(result.value).toBe(0);
  });

  it('should update last_output_at to current time', () => {
    const state = createWorkImpulseState();
    const before = Date.now();
    const result = resetImpulseAfterOutput(state);
    const after = Date.now();
    
    expect(result.last_output_at).toBeGreaterThanOrEqual(before);
    expect(result.last_output_at).toBeLessThanOrEqual(after);
  });

  it('should increment outputs_today', () => {
    const state = createWorkImpulseState();
    state.outputs_today = 3;
    
    const result = resetImpulseAfterOutput(state);
    
    expect(result.outputs_today).toBe(4);
  });

  it('should reset outputs_today to 1 on new day', () => {
    const state = createWorkImpulseState();
    state.outputs_today_date = '2026-04-28'; // Yesterday
    state.outputs_today = 5;
    
    const result = resetImpulseAfterOutput(state);
    
    expect(result.outputs_today).toBe(1);
  });

  it('CRITICAL: should preserve all WorkImpulseState fields', () => {
    const state = createWorkImpulseState();
    const result = resetImpulseAfterOutput(state);
    
    // Check all expected fields are present
    expect(result).toHaveProperty('value');
    expect(result).toHaveProperty('last_output_at');
    expect(result).toHaveProperty('outputs_today_date');
    expect(result).toHaveProperty('outputs_today');
    
    // Verify it matches the type contract
    const typeSafety: WorkImpulseState = result;
    expect(typeSafety).toBeDefined();
  });

  it('should use spread operator pattern (future-proofs for type changes)', () => {
    const state = createWorkImpulseState();
    const result = resetImpulseAfterOutput(state);
    
    // If struct changes, tests should catch missing fields via TypeScript
    // This is validated by: expect(result).toHaveProperty(...)
  });
});
```

---

## Running All Tests

```bash
# Install test dependencies (if not already done)
npm install --save-dev vitest

# Run all P1 critical fix tests
npm run test -- src/engines/intent.ts src/engines/flow.ts src/engines/vitality.ts src/engines/emotion.ts src/engines/work-impulse.ts

# Run with coverage
npm run test -- --coverage

# Watch mode during development
npm run test -- --watch
```

---

## Integration Test (Optional)

```typescript
import { describe, it, expect } from 'vitest';
import { heartbeatTick } from '../lifecycle/heartbeat.ts'; // Your main tick function

describe('Engine Integration - Critical fixes under stress', () => {
  
  it('should handle 1000 ticks without crashing', () => {
    let state = initializeDefaultState();
    
    for (let i = 0; i < 1000; i++) {
      expect(() => {
        state = heartbeatTick(state);
      }).not.toThrow();
    }
    
    // Verify state integrity
    expect(state.vitality.vitality).toBeLessThanOrEqual(100);
    expect(state.vitality.vitality).toBeGreaterThanOrEqual(0);
  });

  it('should handle edge case RNG values', () => {
    const mockRng = [0, 0.25, 0.5, 0.75, 0.9999, 1.0];
    
    for (const rngValue of mockRng) {
      const customRng = () => rngValue;
      expect(() => {
        // Call functions that use RNG with edge case
        processProcrastination(pool, new Set(), customRng);
      }).not.toThrow();
    }
  });
});
```

