# Comprehensive Code Review: Alive Engine Scripts

## Executive Summary

Analysis of 6 engine files totaling ~1500 lines of TypeScript. Multiple architecture issues, immutability violations, and error handling gaps identified. Several edge cases and potential runtime bugs discovered.

---

## 1. ARCHITECTURE ISSUES

### 1.1 God Object Pattern - EmotionState

**File:** `emotion.ts` (lines 106-249)

**Issue:** The `EmotionState` object is overloaded with concerns:
- Mood dimensions (valence, arousal)
- Energy metabolism tracking
- Stress, creativity, sociability states
- Momentum inertia layer tracking
- Undertone baseline layer
- Impulse history with timestamps
- Threshold break tracking (consecutive_high_stress, cooldown)
- Coupling configuration references

**Lines Affected:** 
- Line 115-120 (applyDelta creates 9-field mutation)
- Line 224-229 (decayThreeLayer creates massive state object)

**Consequences:**
- Functions have too many responsibilities
- State mutations cascade through multiple layers
- Coupling between unrelated concerns (e.g., stress management + impulse history)

**Example - applyDelta:**
```typescript
return {
  ...state,
  mood: { valence: rawValence, arousal: coupled.arousal, description: describeMood(...) },
  energy: coupled.energy, stress: coupled.stress, creativity: coupled.creativity, 
  sociability: coupled.sociability,
  last_updated: now().toISOString(), recent_cause: cause,
};
```

---

### 1.2 Inconsistent Coupling Architecture

**File:** `emotion.ts` (lines 72-92 vs 114-115)

**Issue:** Two different coupling mechanisms that aren't synchronized:

1. **applyCoupling()** - cross-dimensional clamping (lines 72-92)
   - Called inside applyDelta (line 114)
   - Runs before applyImpulse gets momentum

2. **computeEmotionIntentCoupling()** - external intent-emotion mapping (lines 144-163)
   - Called separately from emotion updates
   - Creates two sources of truth for emotion-to-intent relationship

**Problem:** State can be updated via `applyDelta` without triggering intent coupling recalculation. If intent system expects coupled values, it may work with stale multipliers.

---

### 1.3 Missing Abstraction Layer - Intent Pool Mutations

**File:** `intent.ts` (lines 70-80, 108-114)

**Issue:** Intent pool modification is scattered across functions with inconsistent patterns:

```typescript
// Pattern 1: boostOrCreate() - line 70
if (existing) {
  return intents.map(i => i.id === existing.id ? { ...i, intensity: cap(i.intensity + boost) } : i);
}

// Pattern 2: addIntent() - line 108
return { ...pool, intents: [...pool.intents, { id: generateId(), ... }]};

// Pattern 3: applyResistanceToPool() - line 138
return { ...pool, intents: pool.intents.map(intent => ...) };
```

**Missing:** A `IntentPoolMutator` or command pattern to standardize all mutations.

---

### 1.4 Tight Coupling: Flow/Drift State Machine

**File:** `flow.ts` (lines 27-72)

**Issue:** `checkFlowEntry()` and `checkDriftEntry()` are deeply coupled:

- Both read the same IntentPool
- Both check energy, but with different thresholds
- No separation between state machine logic and energy/intent checking
- Creating new flow states directly in these functions (line 37, 44)

**Should separate:**
- Flow machine state (duration, interrupt chance)
- Energy constraints logic
- Intent pool consultation

---

### 1.5 Global Config Dependency - Tight Coupling

**Files:** All engine files import from `../config`

**Issue:** Every engine imports `EMOTION_CONFIG`, `INTENT_CONFIG`, `FLOW_CONFIG`, etc.

```typescript
// emotion.ts lines 8-12
import { EMOTION_CONFIG } from '../config';
const DECAY_RATE = 0.1;
const IMPULSE_DECAY = EMOTION_CONFIG.IMPULSE_DECAY;
const MAX_IMPULSE_HISTORY = EMOTION_CONFIG.MAX_IMPULSE_HISTORY;
```

**Problem:**
- Configs are not injected; they're globally imported
- Testing requires mocking module imports or monkeypatching
- No way to have different configs for different personas at runtime
- Makes engines unmockable for unit testing

---

## 2. CODE BUGS & LOGIC ERRORS

### 2.1 Race Condition - Timestamp Generation

**File:** `intent.ts` (line 14-16)

```typescript
function generateId(): string {
  return `int_${now().getTime()}_${Math.random().toString(36).slice(2, 6)}`;
}
```

**Bug:** If two intents are created in the same millisecond, they could have:
- Same timestamp: `now().getTime()` only has millisecond precision
- Collision: `Math.random().toString(36).slice(2, 6)` is only 4 hex digits

**Likelihood:** Medium - only happens if heartbeat creates 2+ intents in same tick

**Fix:** Use microseconds or a counter

---

### 2.2 Off-by-One Error - Impulse History Aging

**File:** `emotion.ts` (line 222)

```typescript
const agedHistory = state.impulse_history.map(e => ({ ...e, tick_age: e.tick_age + 1 }))
  .slice(-MAX_IMPULSE_HISTORY);
```

**Bug:** `tick_age` is incremented BEFORE slicing, meaning:
- Entry just added has `tick_age: 1` immediately (should be 0)
- After N decays, oldest entry has `tick_age: N+1` (should be N)
- Affects rumination probability calculation (line 257): `Math.pow(2, -entry.tick_age / 16)`

**Example:**
- Entry added at tick T with `tick_age: 0`
- After decay, `tick_age: 1`
- Rumination probability uses `Math.pow(2, -1/16)` instead of `Math.pow(2, 0/16)` for same-tick entry

**Severity:** High - affects mood rumination timing

---

### 2.3 Logic Error - Sign Comparison Breaks on Zero

**File:** `emotion.ts` (line 211-213)

```typescript
const prevSign = Math.sign(state.momentum.valence);
const newSign = Math.sign(newMomentum.valence);
newMomentum.duration_ticks = prevSign === newSign ? state.momentum.duration_ticks + 1 : 0;
```

**Bug:** `Math.sign(0) === 0`

- If momentum.valence is exactly 0, `prevSign = 0` and `newSign = 0`
- Condition `prevSign === newSign` is true
- `duration_ticks` increments even though valence "flipped" from negative to positive through zero

**Scenario:**
1. momentum.valence = -0.05 (sadness), duration_ticks = 5
2. After decay, momentum.valence = 0.01 (slight positive)
3. `prevSign = -1`, `newSign = 1`, but if valence rounds to 0.0:
4. `prevSign = -1`, `newSign = 0`
5. Condition is false, counter resets

**Impact:** Mood duration tracking becomes unreliable near zero-crossings

---

### 2.4 Integer Truncation Loss - Intent Resistance Dynamics

**File:** `intent.ts` (line 182)

```typescript
const newSkipped = intent.skipped_count + 1;
if (newSkipped >= INTENT_CONFIG.PROCRASTINATION_RESOLVE_AT) { ... }
```

**Issue:** `skipped_count` is always an integer. When stored and retrieved, there's potential for:
- Floating-point intermediate calculations that should be integers
- But this specific code is safe since addition only

**Related - Line 186:** 
```typescript
const newIntensity = Math.min(intent.resistance * 0.8, 0.5);
```

**Better pattern:** `Math.min(intent.resistance * 0.8, 0.5)` should be clamped more explicitly.

---

### 2.5 Missing Null Check - Intent Category Resolution

**File:** `intent.ts` (lines 60-64)

```typescript
const resolved = ALL_META_INTENTS.includes(b.category as MetaIntent) ? b.category as MetaIntent : null;
if (resolved) {
  intents = boostOrCreate(intents, resolved, b.boost, `事件: ${event.type}`, 'event');
}
```

**Issue:** `b.category` is cast to `MetaIntent` without validation
- If event.data is malformed, `b.category` could be undefined
- No type narrowing on event.data

**Better:**
```typescript
const b = boosts?.[i];
if (!b || typeof b.category !== 'string') continue;
const resolved = ALL_META_INTENTS.find(m => m === b.category);
```

---

### 2.6 Missing Null Check - Optional Schedule Hour Parsing

**File:** `intent.ts` (lines 85-86)

```typescript
const prefHour = parseInt(flex.preferred_time.split(':')[0], 10);
if (Math.abs(hour - prefHour) <= 1) { ... }
```

**Bugs:**
1. No validation that `split(':')` produces non-empty array
2. No validation that parseInt succeeded (could be NaN)
3. If `preferred_time` is malformed (e.g., "invalid"), NaN === NaN is false but comparison still runs
4. No radix 10 base protection against octal interpretation

**Consequence:** If schedule is corrupted, silently skips intent injection without logging

---

## 3. IMMUTABILITY VIOLATIONS

### 3.1 Array Mutation Inside Object Spread - Intent History

**File:** `emotion.ts` (line 285-288)

```typescript
impulse_history: [...updated.impulse_history, {
  delta: { valence: dir * 0.4, arousal: 0.3, stress: -(state.stress - 0.2) },
  cause: '情绪爆发', importance: 8, timestamp: now().toISOString(), tick_age: 0,
}].slice(-MAX_IMPULSE_HISTORY),
```

**Issue:** While this uses spread operator (immutable), the pattern is repeated and inconsistent:

- Line 222 (decayThreeLayer): `state.impulse_history.map(...).slice(...)`
- Line 237 (applyImpulse): `[...afterDelta.impulse_history, entry].slice(...)`
- Line 285-288 (checkThresholdBreak): Same pattern again

**Better:** Deduplicate into helper:
```typescript
function appendToHistoryWithMaxSize(
  history: ImpulseHistoryEntry[], 
  entry: ImpulseHistoryEntry
): ImpulseHistoryEntry[] {
  return [...history, entry].slice(-MAX_IMPULSE_HISTORY);
}
```

---

### 3.2 State Object Modified In-Place Pattern

**File:** `work-impulse.ts` (lines 63-72)

```typescript
export function resetImpulseAfterOutput(state: WorkImpulseState): WorkImpulseState {
  const today = getLocalDate();
  const outputsToday = state.outputs_today_date === today ? state.outputs_today : 0;

  return {
    value: 0,
    last_output_at: now().getTime(),
    outputs_today_date: today,
    outputs_today: outputsToday + 1,
  };  // ← PROBLEM: Missing spread operator for other fields!
}
```

**BUG:** This function doesn't preserve all fields from the input state!

If `WorkImpulseState` has other fields (check types), they're lost:

```typescript
export interface WorkImpulseState {
  value: number;
  last_output_at: number; // timestamp in ms
  outputs_today: number;
  outputs_today_date: string | null;
}
```

**Current code loses all unnamed fields.** This is actually safe because WorkImpulseState only has these 4 fields, but it's fragile - if someone adds a field later, it breaks silently.

**Fix:**
```typescript
return {
  ...state,
  value: 0,
  last_output_at: now().getTime(),
  outputs_today_date: today,
  outputs_today: outputsToday + 1,
};
```

---

### 3.3 Spread Operator Inconsistency - Confidence State

**File:** `confidence.ts` (lines 38-42 vs 64)

```typescript
// Line 38-42: updateConfidenceFromFeedback
return {
  confidence: clampConfidence(state.confidence + delta + streakBonus),
  streak: newStreak,
  last_updated: now().toISOString(),
};

// Line 64: decayConfidence
return { ...state, confidence: clampConfidence(decayed) };
```

**Issue:** Inconsistent patterns
- `updateConfidenceFromFeedback` doesn't use `...state` (OK because it rebuilds all fields)
- `decayConfidence` uses `...state` (safer for adding new fields)

**Better:** Standardize on one pattern

---

## 4. ERROR HANDLING GAPS

### 4.1 Missing Try-Catch - Now() Function

**File:** All files call `now()` without error handling

```typescript
// emotion.ts line 119
last_updated: now().toISOString(),

// intent.ts line 77
born_at: now().toISOString(),

// flow.ts line 37
entered_at: now().toISOString(),
```

**Issue:** If `now()` throws (unlikely but possible if time-utils has bugs), entire heartbeat crashes

**Better:**
```typescript
function safeNow(): string {
  try {
    return now().toISOString();
  } catch (e) {
    console.error('Time function failed:', e);
    return new Date().toISOString(); // fallback
  }
}
```

---

### 4.2 Missing Validation - RNG Parameter

**File:** `emotion.ts` (line 253, 273-292), `flow.ts` (line 47), `intent.ts` (line 173)

```typescript
export function rollRumination(state: EmotionState, rng: () => number = Math.random): ...
```

**Issue:** RNG function is never validated
- Could be undefined (TypeScript allows despite default)
- Could throw
- Could return values outside [0, 1]

**Usage:**
```typescript
// Line 258
if (rng() < prob) {  // If rng() throws, entire function fails
```

**Better:**
```typescript
function safeRng(rng?: () => number): number {
  const fn = rng ?? Math.random;
  try {
    const val = fn();
    if (typeof val !== 'number' || val < 0 || val > 1) return 0;
    return val;
  } catch {
    return 0;
  }
}
```

---

### 4.3 Swallowed Error - Schedule Parsing

**File:** `intent.ts` (lines 85-86)

```typescript
const prefHour = parseInt(flex.preferred_time.split(':')[0], 10);
if (Math.abs(hour - prefHour) <= 1) {
  intents = boostOrCreate(intents, flex.intent_category, flex.intent_boost, flex.activity, 'schedule');
}
```

**Issue:**
- If split fails (shouldn't but...), undefined[0] = undefined
- parseInt(undefined) = NaN
- Math.abs(NaN) = NaN
- Math.abs(NaN) <= 1 = false, so silently skips
- **No error logged, no warning**

**Better:**
```typescript
try {
  const parts = flex.preferred_time?.split(':') ?? [];
  const hour = parseInt(parts[0] ?? '', 10);
  if (isNaN(hour)) {
    console.warn(`Invalid preferred_time: ${flex.preferred_time}`);
    return;
  }
  if (Math.abs(hour - hour) <= 1) { ... }
} catch (e) {
  console.warn(`Failed to parse schedule time`, e);
}
```

---

### 4.4 Missing Validation - Emotion Delta Application

**File:** `emotion.ts` (lines 107-112)

```typescript
const rawValence = applyDiminishingReturns(state.mood.valence, delta.valence ?? 0, -1.0, 1.0);
const rawArousal = applyDiminishingReturns(state.mood.arousal, delta.arousal ?? 0, 0, 1.0);
// ...
```

**Issue:** No validation that delta values are reasonable
- Could be NaN
- Could be Infinity
- Could be strings coerced to numbers

**Better:**
```typescript
function validDelta(v: number | undefined): number {
  if (v === undefined) return 0;
  if (!Number.isFinite(v)) {
    console.warn(`Invalid delta: ${v}`);
    return 0;
  }
  return v;
}

const rawValence = applyDiminishingReturns(
  state.mood.valence, 
  validDelta(delta.valence), 
  -1.0, 1.0
);
```

---

### 4.5 Missing Error Handling - Pool Operations Return New Objects

**File:** `intent.ts` (lines 22-27, 53-68, 138-144)

```typescript
export function decaySatisfied(pool: IntentPool): IntentPool {
  const intents = pool.intents
    .map(intent => intent.satisfied_at === null ? intent : { ...intent, intensity: cap(intent.intensity - intent.decay_rate) })
    .filter(intent => intent.intensity >= 0.1);
  return { ...pool, intents };
}
```

**Issue:** No null checks on pool.intents
- If pool.intents is null/undefined, .map() throws
- If any intent is malformed, spread creates broken object

**Better:**
```typescript
export function decaySatisfied(pool: IntentPool): IntentPool {
  if (!pool?.intents) {
    console.error('Received invalid pool');
    return pool ?? { intents: [] };
  }
  const intents = pool.intents
    .map(intent => { ... })
    .filter(intent => intent.intensity >= 0.1);
  return { ...pool, intents };
}
```

---

## 5. EDGE CASES & BOUNDARY CONDITIONS

### 5.1 Division by Zero Risk - Impulse History Size

**File:** `emotion.ts` (line 98-100)

```typescript
function applyDiminishingReturns(current: number, delta: number, min: number, max: number): number {
  if (delta === 0) return current;
  const halfRange = (max - min) / 2;
  const headroom = delta > 0 ? max - current : current - min;
  const dampening = Math.max(0.1, Math.min(1.0, headroom / halfRange));
  return clamp(current + delta * dampening, min, max);
}
```

**Edge Case:** If `max === min` (empty range):
- `halfRange = 0`
- `dampening = 0 / 0 = NaN` (line 100)
- Return value = `NaN`

**Example:** If called with `-1.0, 1.0` as bounds, halfRange = 1.0, safe. But:
- Bug in caller passes `min=max=0`
- `halfRange = 0`, `dampening = NaN`, propagates

**Better:**
```typescript
const halfRange = (max - min) / 2;
if (halfRange === 0) return current; // No range to work with
```

---

### 5.2 Overflow Risk - Intensity Accumulation

**File:** `intent.ts` (lines 35-45)

```typescript
let boost = 0;
switch (intent.category) {
  case 'produce': boost = 0.3; if (lastActionHoursAgo > 48) boost += 1.0; break;
  case 'connect': boost = hasUnreadEvents ? 2.0 : 0.2; break;
  // ...
}
return { ...intent, intensity: cap(intent.intensity + boost) };
```

**Issue:** If intensity already at INTENSITY_CAP:
- Line 45: `cap(INTENSITY_CAP + boost)` = INTENSITY_CAP (clamped)
- But if boost is 2.0 and INTENSITY_CAP is 10, it adds then clamps
- Over multiple ticks with high boost, intention can get "stuck" at cap

**Not necessarily a bug**, but behavior after cap is reached is unclear.

**Better:** Document that intensities plateau and add logging when capped:
```typescript
const newIntensity = cap(intent.intensity + boost);
if (newIntensity === INTENSITY_CAP && newIntensity > intent.intensity) {
  console.debug(`Intent ${intent.id} hit intensity cap`);
}
```

---

### 5.3 Underflow Risk - Consecutive Stress Counter

**File:** `emotion.ts` (line 228)

```typescript
threshold_break_cooldown: Math.max(0, state.threshold_break_cooldown - 1),
```

**Edge Case:** If `threshold_break_cooldown` starts negative (shouldn't happen):
- `Math.max(0, -5 - 1)` = 0
- Correctly prevents negative, but indicates upstream bug

**Better:** Validate at state creation:
```typescript
if (state.threshold_break_cooldown < 0) {
  console.warn('Negative threshold_break_cooldown detected');
  state.threshold_break_cooldown = 0;
}
```

---

### 5.4 Off-by-One - Time Zone Boundary (Schedule Hour Check)

**File:** `intent.ts` (lines 85-86)

```typescript
const prefHour = parseInt(flex.preferred_time.split(':')[0], 10);
if (Math.abs(hour - prefHour) <= 1) { ... }
```

**Edge Case:** Hour 23 (11 PM):
- If prefHour = 0 (midnight)
- `Math.abs(23 - 0) = 23`, NOT <= 1, so doesn't trigger
- Should schedule around midnight handle wrap-around?

**Example:**
- System time: 23:00, prefHour = 0
- Condition: 23 - 0 = 23, not <= 1, skips
- Intent not boosted when it should be

**Missing:** Hour wrap-around logic:
```typescript
const hourDiff = Math.abs(hour - prefHour);
const wrappedDiff = Math.min(hourDiff, 24 - hourDiff);
if (wrappedDiff <= 1) { ... }
```

---

### 5.5 Boundary - Max History Size

**File:** `emotion.ts` (lines 222, 237, 285-288)

```typescript
const agedHistory = state.impulse_history.map(...).slice(-MAX_IMPULSE_HISTORY);
const newHistory = [...afterDelta.impulse_history, entry].slice(-MAX_IMPULSE_HISTORY);
```

**Issue:** If MAX_IMPULSE_HISTORY = 0:
- `.slice(-0)` returns empty array (silently!)
- Impulse history is lost immediately
- Rumination never triggers

**Better:** Validate config:
```typescript
if (MAX_IMPULSE_HISTORY <= 0) {
  throw new Error('MAX_IMPULSE_HISTORY must be > 0');
}
```

---

### 5.6 Floating Point Precision - Momentum Dampening

**File:** `emotion.ts` (lines 204-209)

```typescript
const newMomentum: EmotionMomentum = {
  valence: state.momentum.valence + (state.undertone.valence - state.momentum.valence) * momentumRate,
  arousal: state.momentum.arousal + (state.undertone.arousal - state.momentum.arousal) * momentumRate,
  // ...
};
```

**Edge Case:** Over many iterations with very small momentumRate (0.03):
- Momentum slowly converges to undertone
- Due to floating-point precision, might never reach exact value
- After 1000 ticks: `0.5 + (0.6 - 0.5) * 0.03^1000` ≈ 0.5000...

**Not a bug**, but document the convergence behavior.

---

### 5.7 Type Safety - Event Boost Category Resolution

**File:** `intent.ts` (lines 57-64)

```typescript
const boosts = (event.data as { intent_boosts?: Array<{ category: string; boost: number }> }).intent_boosts;
if (boosts) {
  for (const b of boosts) {
    const resolved = ALL_META_INTENTS.includes(b.category as MetaIntent) ? b.category as MetaIntent : null;
```

**Issue:** Unsafe type cast `as MetaIntent` after checking
- The check `ALL_META_INTENTS.includes(b.category as MetaIntent)` still casts first
- Better to check the string and then cast

**Better:**
```typescript
if (ALL_META_INTENTS.includes(b.category as any)) {
  const resolved = b.category as MetaIntent;
  intents = boostOrCreate(intents, resolved, b.boost, ...);
}
```

---

### 5.8 Boundary - Confidence Multiplier Range

**File:** `confidence.ts` (line 71)

```typescript
export function getProduceRateMultiplier(confidence: number): number {
  return confidence;
}
```

**Edge Case:** If confidence is 0 (minimum):
- Multiplier = 0
- Producer can't produce anything
- Is this intended? No documentation

**Possible issues:**
- If confidence decays to 0, producer stuck forever
- Expected range is [CONFIDENCE_MIN, CONFIDENCE_MAX], likely [0.5, 1.5]
- But getProduceRateMultiplier doesn't clamp/validate input

**Better:**
```typescript
export function getProduceRateMultiplier(confidence: number): number {
  const clamped = clampConfidence(confidence);
  return Math.max(0.1, clamped); // Never go below 10% multiplier
}
```

---

### 5.9 Boundary - Vitality Afternoon Rest Hour Check

**File:** `vitality.ts` (lines 70-71)

```typescript
export function afternoonRestRecovery(state: VitalityState, hour: number): VitalityState {
  if (hour < 13 || hour > 15) return state;
```

**Edge Case:** What if hour = 15.5 (15:30)?
- Condition: `15.5 < 13` is false, `15.5 > 15` is true
- Returns state unchanged (correct behavior)
- But if hour is ever a float due to timezone conversion, should handle explicitly

**Note:** This is actually safe since hour is normally an integer (0-23).

---

### 5.10 Boundary - Vitality Zone Boundary Values

**File:** `vitality.ts` (lines 87-92)

```typescript
export function getVitalityZone(vitality: number): VitalityZone {
  if (vitality > 70) return 'high';
  if (vitality > 30) return 'normal';
  if (vitality > 10) return 'low';
  return 'critical';
}
```

**Edge Case:** Boundary values (10, 30, 70):
- vitality = 30: `> 30` is false, `> 10` is true, returns 'low'
- vitality = 30.1: returns 'normal'
- **Off-by-one gap:** vitality = 30 exactly is 'low', but 30.1 is 'normal'

**Better:** Use >= for clarity:
```typescript
if (vitality >= 70) return 'high';
if (vitality >= 30) return 'normal';
if (vitality >= 10) return 'low';
return 'critical';
```

---

## 6. TYPE SAFETY ISSUES

### 6.1 Optional Chaining Missing - Schedule Access

**File:** `intent.ts` (line 84-86)

```typescript
for (const flex of schedule.flexible) {  // No check that schedule.flexible exists
  const prefHour = parseInt(flex.preferred_time.split(':')[0], 10);
```

**Issue:** If ScheduleToday.flexible is undefined:
- Loop doesn't iterate (safe)
- But better to validate

---

### 6.2 Type Assertion Without Validation

**File:** `intent.ts` (line 60)

```typescript
const resolved = ALL_META_INTENTS.includes(b.category as MetaIntent) ? b.category as MetaIntent : null;
```

**Issue:** `b.category as MetaIntent` is dangerous:
- No type guard
- If b.category is string, TypeScript allows
- But if b.category is object or undefined, cast still succeeds at runtime

---

### 6.3 Unsafe Record Access - EmotionCouplingConfig

**File:** `emotion.ts` (lines 150-162)

```typescript
for (const intent of ALL_META_INTENTS) {
  const c = config[intent] ?? {};  // Could be undefined or wrong type
  let multiplier = 1.0;
  if (c.creativity)      multiplier += c.creativity * emotion.creativity;
  if (c.sociability)     multiplier += c.sociability * emotion.sociability;
  // ...
}
```

**Issue:** If config[intent] is malformed (has wrong types):
- `c.creativity * emotion.creativity` could be NaN
- No validation of number types

**Better:**
```typescript
const c = config[intent];
if (!c) continue;
const creativity = (typeof c.creativity === 'number') ? c.creativity : 0;
```

---

## SUMMARY TABLE

| Category | Count | Severity | Files |
|----------|-------|----------|-------|
| Immutability Violations | 3 | Medium | emotion.ts, work-impulse.ts, confidence.ts |
| Missing Null Checks | 4 | High | intent.ts (2x), emotion.ts, flow.ts |
| Boundary Condition Errors | 6 | Medium | emotion.ts (2x), intent.ts, vitality.ts (2x), confidence.ts |
| God Object Patterns | 2 | High | emotion.ts, intent.ts |
| Tight Coupling | 3 | High | flow.ts, emotion.ts, all (config) |
| Type Safety Issues | 4 | Medium | intent.ts (2x), emotion.ts |
| Off-by-One Errors | 3 | High | emotion.ts, intent.ts, vitality.ts |
| Missing Error Handling | 5 | Medium | emotion.ts (3x), intent.ts (2x) |
| **TOTAL** | **30** | - | - |

---

## RECOMMENDED FIXES (Priority Order)

### P0 - Critical (Fix Immediately)
1. **emotion.ts line 222** - Impulse history off-by-one aging
2. **emotion.ts line 211-213** - Sign comparison breaks on zero
3. **intent.ts line 14-16** - Timestamp collision risk
4. **work-impulse.ts line 63-72** - Missing spread operator

### P1 - High (Fix This Sprint)
1. **intent.ts lines 85-86** - Schedule hour parsing without validation
2. **emotion.ts lines 107-112** - Delta validation missing
3. **flow.ts lines 27-72** - Tight coupling, needs refactoring
4. **emotion.ts lines 72-92** - Coupling architecture inconsistency

### P2 - Medium (Fix Next Sprint)
1. **intent.ts line 70-80** - Missing abstraction for pool mutations
2. **emotion.ts lines 115-120** - God object, consider splitting
3. **All files** - Global config dependency, inject instead

