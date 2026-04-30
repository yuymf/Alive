# Comprehensive Analysis of alive/scripts/engines/

## Executive Summary
This analysis covers 6 TypeScript engine files totaling ~70KB. The architecture is generally clean with good separation of concerns, but there are several categories of issues: immutability violations, missing error handling, edge cases not handled, type safety gaps, and some architectural smell.

---

# 1. EMOTION.TS (293 lines)

## Architecture Issues

### Issue 1.1: No validation of coupling config values
- **File**: `alive/scripts/engines/emotion.ts`
- **Lines**: 144-163 (computeEmotionIntentCoupling)
- **Problem**: The function assumes `couplingConfig` values are well-formed but doesn't validate:
  - Multiplier could become negative or extremely large (no bounds)
  - If `c.creativity`, `c.stress`, etc. are undefined, they're treated as falsy but could silently fail
  - No clamping of final multiplier value
- **Impact**: HIGH - Could produce invalid multipliers that break intent system
- **Example**: If coupling config contains `{ creativity: 10.0 }` and emotion.creativity = 1.0, multiplier becomes 11.0 instead of clamped reasonable value

### Issue 1.2: God object - EmotionState too large
- **File**: `alive/scripts/engines/emotion.ts`
- **Lines**: Throughout file
- **Problem**: EmotionState contains 11+ properties (mood, energy, stress, creativity, sociability, momentum, undertone, impulse_history, consecutive_high_stress, threshold_break_cooldown, last_updated, recent_cause). Functions couple to entire object instead of just what they need.
- **Impact**: MEDIUM - Makes testing hard, changes to unrelated fields ripple
- **Recommendation**: Extract EmotionMoodState, EmotionResponseState, EmotionHistoryState as separate concerns

## Code Bugs

### Bug 1.1: Missing null check in scaleByCloseness
- **File**: `alive/scripts/engines/emotion.ts`
- **Lines**: 180-190
- **Problem**: `scaleByCloseness` doesn't validate that `delta` properties exist before accessing them
  ```typescript
  if (delta.valence !== undefined) result.valence = delta.valence * scale;
  ```
  This is actually safe (checks !== undefined), but:
  - No validation that delta is not null
  - No bounds checking on `closeness` parameter - could be negative, infinity, NaN

### Bug 1.2: describeMood valence/arousal overlapping ranges
- **File**: `alive/scripts/engines/emotion.ts`
- **Lines**: 23-67
- **Problem**: Valence ranges overlap at boundaries:
  - `valence <= -0.5` (line 24)
  - `valence <= -0.2 && arousal > 0.6` (line 26)
  - But if valence = -0.3, arousal = 0.7, line 26 matches but line 28 also matches
  - Line 30 checks `valence <= 0.2` which overlaps with line 32-33
- **Impact**: MEDIUM - Mood descriptions may be incorrect near boundaries
- **Fix**: Use non-overlapping ranges or return on first match (current order-dependent approach is brittle)

### Bug 1.3: Race condition in decayThreeLayer momentum update
- **File**: `alive/scripts/engines/emotion.ts`
- **Lines**: 200-229
- **Problem**: The momentum direction calculation (lines 211-213) uses `state.momentum.valence` before updating it, then checks against `newMomentum.valence`:
  ```typescript
  const prevSign = Math.sign(state.momentum.valence);
  const newSign = Math.sign(newMomentum.valence);
  newMomentum.duration_ticks = prevSign === newSign ? state.momentum.duration_ticks + 1 : 0;
  ```
  If momentum.valence is exactly 0 or very close to 0:
  - `Math.sign(0) = 0` (neither positive nor negative)
  - Two zeros are equal, so duration_ticks keeps incrementing even during sign transition
- **Impact**: MEDIUM - Momentum duration tracking breaks around zero crossings

## Immutability Violations

### Violation 1.1: applyDelta mutates state implicitly through spread operator
- **File**: `alive/scripts/engines/emotion.ts`
- **Lines**: 106-121
- **Problem**: While using spread operator, the code doesn't guarantee all nested objects are copied:
  ```typescript
  return {
    ...state,
    mood: { valence: rawValence, arousal: coupled.arousal, ... },
    ...  // Other properties spread directly
  };
  ```
  If state contained mutable nested arrays, those would still be shared references. However, looking at types, this seems okay for the current structure.
- **Impact**: LOW - Appears safe for current EmotionState structure, but fragile if new mutable nested objects added

### Violation 1.2: decayThreeLayer creates new array with map then slice
- **File**: `alive/scripts/engines/emotion.ts`
- **Line**: 222
- **Problem**: Good practice (creates new array), but could be optimized. Not a violation, just noting good pattern.

## Error Handling Gaps

### Gap 1.1: No try-catch in applyDelta or functions that compute values
- **File**: `alive/scripts/engines/emotion.ts`
- **Lines**: 106-121, 72-92
- **Problem**: Mathematical operations could fail:
  - `Math.pow` in rollRumination (line 257) could receive invalid arguments
  - `Math.sign` could fail if passed non-finite values
  - No validation that delta values are finite numbers
- **Impact**: MEDIUM - Could crash on invalid data

### Gap 1.2: rollRumination doesn't validate rng function
- **File**: `alive/scripts/engines/emotion.ts`
- **Lines**: 253-268
- **Problem**: `rng()` is called without validation:
  - Could return non-numeric value
  - Could throw exception
  - Could return negative/>1 value
- **Fix**: Add try-catch and validate result: `if (typeof prob !== 'number' || prob < 0 || prob > 1) prob = 0.5`

### Gap 1.3: checkThresholdBreak doesn't validate state values before using them
- **File**: `alive/scripts/engines/emotion.ts`
- **Lines**: 273-292
- **Problem**: Assumes EMOTION_CONFIG constants are valid, state.mood.valence is finite, etc.
- **Impact**: LOW-MEDIUM - Could fail silently if config corrupted

## Edge Cases Not Handled

### Edge Case 1.1: Extreme coupling values creating numeric overflow
- **File**: `alive/scripts/engines/emotion.ts`
- **Lines**: 144-163
- **Problem**: No maximum bound on multiplier
- **Scenario**: If persona config has `{ creativity: 100, stress: 50, ... }` and emotion state is all 1.0:
  ```
  multiplier = 1.0 + 100*1.0 + 50*1.0 + ... = 150+
  ```
- **Fix**: Clamp final multiplier to reasonable range like [0.1, 5.0]

### Edge Case 1.2: Negative arousal from diminishing returns
- **File**: `alive/scripts/engines/emotion.ts`
- **Lines**: 96-102
- **Problem**: `applyDiminishingReturns` is called with `min: 0` for arousal, but dampening could still produce negative intermediate values before clamping
- **Impact**: LOW - clamp() fixes it, but calculation unnecessary

### Edge Case 1.3: impulse_history exceeding MAX_IMPULSE_HISTORY in corner case
- **File**: `alive/scripts/engines/emotion.ts`
- **Lines**: 237, 222, 285-288
- **Problem**: `slice(-MAX_IMPULSE_HISTORY)` used in multiple places but logic isn't consistent:
  - Line 222: `...slice(-MAX_IMPULSE_HISTORY)` after map
  - Line 237: `...slice(-MAX_IMPULSE_HISTORY)` after push
  - Line 288: `...slice(-MAX_IMPULSE_HISTORY)` in impulse array
  - If MAX_IMPULSE_HISTORY = 100 and array is already 100, new entry makes 101 before slice - works but inefficient

## Type Safety Issues

### Type Issue 1.1: EmotionDelta properties are all optional but not validated
- **File**: `alive/scripts/engines/emotion.ts`
- **Lines**: 249-256 (types)
- **Problem**: When using `delta.valence ?? 0`, there's an implicit assumption that undefined means "no change"
- **Risk**: If someone passes `{ valence: NaN }`, it won't be caught

### Type Issue 1.2: scaleByCloseness doesn't handle undefined delta properties properly
- **File**: `alive/scripts/engines/emotion.ts`
- **Lines**: 180-190
- **Problem**: Creates result object but only adds properties that exist in delta
  - If delta = {}, result = {} (empty object)
  - Later code might expect all properties exist
- **Fix**: Initialize all properties or return early if delta empty

---

# 2. INTENT.TS (208 lines)

## Architecture Issues

### Issue 2.1: Tight coupling between IntentPool and external state
- **File**: `alive/scripts/engines/intent.ts`
- **Lines**: Throughout (computeDynamicResistance takes many parameters)
- **Problem**: `computeDynamicResistance` function takes 7 parameters (intent, vitality, confidence, inFlow, flowCategory, rigidSchedule, browseSchedule)
  - Function signature is bloated
  - Parameters have complex nested structures
  - Callers must know all this context
- **Recommendation**: Create IntentContext object: `{ vitality, confidence, inFlow, flowCategory, rigidSchedule, browseSchedule }`

### Issue 2.2: Magic numbers throughout
- **File**: `alive/scripts/engines/intent.ts`
- **Lines**: 37, 38, 40, 42, 43, 86, 127, 149, 153, 158, etc.
- **Problem**: Constants like:
  - `1.0` (line 37)
  - `2.0` (line 38)  
  - `0.5` (line 40)
  - `3.0` (line 41)
  Should be named constants at module top
- **Impact**: LOW-MEDIUM - Makes tuning harder, reduces readability

## Code Bugs

### Bug 2.1: parseFloat without validation in injectScheduleIntents
- **File**: `alive/scripts/engines/intent.ts`
- **Lines**: 82-90
- **Problem**: 
  ```typescript
  const prefHour = parseInt(flex.preferred_time.split(':')[0], 10);
  ```
  If `flex.preferred_time` is malformed (no colon, empty string, etc.):
  - `split(':')` returns array
  - `[0]` might be empty string
  - `parseInt('', 10)` returns `NaN`
  - `Math.abs(NaN - hour)` is always `NaN`
  - `NaN <= 1` is always `false`
- **Impact**: MEDIUM - Silent failure, intent boost won't apply
- **Fix**: Validate format with regex or try-catch

### Bug 2.2: boostOrCreate doesn't check for duplicate before creating
- **File**: `alive/scripts/engines/intent.ts`
- **Lines**: 70-80
- **Problem**: When creating a new intent, doesn't check if identical intent already exists:
  - Two calls with same category might create two intents
  - Function finds "existing" (line 71) but only for unsatisfied intents
  - If intent was recently satisfied, creates duplicate
- **Impact**: MEDIUM - Intent pool bloats with duplicates

### Bug 2.3: applyEventBoosts doesn't validate event.data structure
- **File**: `alive/scripts/engines/intent.ts`
- **Lines**: 53-68
- **Problem**:
  ```typescript
  const boosts = (event.data as { intent_boosts?: ... }).intent_boosts;
  ```
  - `event.data` is cast without validation
  - If `event.data` is not an object, type assertion fails silently
  - `boosts` could be non-array
- **Impact**: MEDIUM - TypeError when iterating if boosts isn't array

### Bug 2.4: checkImpulseBreakthrough has dead code path
- **File**: `alive/scripts/engines/intent.ts`
- **Lines**: 146-160
- **Problem**:
  ```typescript
  if (vitality < 15) { 
    const rest = unsatisfied.find(...); 
    if (rest) return rest; 
  }  // Line 158-159 never executes after line 159 if (rest)
  return null;  // Line 159
  ```
  If rest is found and returned, line 159 never executes. But the function returns null anyway. This is just inefficient, not wrong.

### Bug 2.5: processProcrastination doesn't validate rng return value
- **File**: `alive/scripts/engines/intent.ts`
- **Lines**: 173-206
- **Problem**:
  ```typescript
  if (rng() < abandonProb) {
  ```
  - `rng()` could return NaN, negative, or >1
  - `NaN < 0.5` is always false
  - Probability checks become useless
- **Impact**: MEDIUM - Procrastination logic breaks with bad RNG

### Bug 2.6: computeDynamicResistance allows browseSchedule to be undefined
- **File**: `alive/scripts/engines/intent.ts`
- **Lines**: 120-136
- **Problem**:
  ```typescript
  export function computeDynamicResistance(
    intent, vitality, confidence, inFlow, flowCategory, rigidSchedule,
    browseSchedule?: readonly string[]
  )
  ```
  - browseSchedule is optional
  - Line 132: `if (browseSchedule && browseSchedule.length > 0)` checks correctly
  - But line 132-133: `resistance += 3.0;` could add resistance even when browse_schedule is empty array
  - Wait, checking code again: condition is `(browseSchedule && browseSchedule.length > 0)` - this is correct. **NOT a bug.**

## Immutability Violations

### Violation 2.1: accumulateIntents maps array properly
- **File**: `alive/scripts/engines/intent.ts`
- **Lines**: 29-48
- **Problem**: Code returns new IntentPool with new intents array, but intents are spread:
  ```typescript
  return { ...intent, intensity: cap(intent.intensity + boost) }
  ```
  This creates new intent objects correctly. **NOT a violation.**

### Violation 2.2: decaySatisfied filters correctly
- **File**: `alive/scripts/engines/intent.ts`
- **Lines**: 22-27
- **Problem**: Creates new intent objects via spread. **NOT a violation.**

## Error Handling Gaps

### Gap 2.1: decaySatisfied doesn't validate decay_rate
- **File**: `alive/scripts/engines/intent.ts`
- **Lines**: 22-27
- **Problem**: `intent.decay_rate` could be:
  - Negative (making intensity increase)
  - NaN (making intensity NaN)
  - Infinity (making intensity NaN)
- **Impact**: MEDIUM - Could corrupt intent intensity

### Gap 2.2: generateId doesn't handle edge case where Math.random() === 0
- **File**: `alive/scripts/engines/intent.ts`
- **Lines**: 14-16
- **Problem**:
  ```typescript
  return `int_${now().getTime()}_${Math.random().toString(36).slice(2, 6)}`;
  ```
  If Math.random() === 0:
  - `(0).toString(36) = '0'`
  - `slice(2, 6) = ''` (empty string)
  - ID becomes `int_[timestamp]_`
- **Impact**: LOW - Very rare, but possible edge case

### Gap 2.3: No validation of cap() function bounds
- **File**: `alive/scripts/engines/intent.ts`
- **Lines**: 10-12
- **Problem**: `cap()` clamps to [0, INTENSITY_CAP], but what if INTENSITY_CAP is negative or NaN?
- **Impact**: LOW - Config issue, but no validation

## Edge Cases Not Handled

### Edge Case 2.1: lastActionHoursAgo could be extremely large or negative
- **File**: `alive/scripts/engines/intent.ts`
- **Lines**: 29-48
- **Problem**: 
  ```typescript
  if (lastActionHoursAgo > 48) boost += 1.0;
  ```
  - No upper bound on boost
  - If lastActionHoursAgo = Infinity, still adds 1.0 (seems okay)
  - If lastActionHoursAgo = -1000, never triggers (seems okay)
  - But no validation that lastActionHoursAgo is sensible
- **Impact**: LOW-MEDIUM

### Edge Case 2.2: processProcrastination with empty intents
- **File**: `alive/scripts/engines/intent.ts`
- **Lines**: 173-206
- **Problem**: If pool.intents is empty, function returns { pool, stressDelta: 0, diaryEntries: [] }
  - Works correctly, but is this intended? Should there be warning?
- **Impact**: LOW - Handles correctly, just not obvious from code

### Edge Case 2.3: PROCRASTINATION_TEMPLATES array bounds
- **File**: `alive/scripts/engines/intent.ts`
- **Lines**: 165-171, 200
- **Problem**:
  ```typescript
  const templateFn = PROCRASTINATION_TEMPLATES[Math.floor(rng() * PROCRASTINATION_TEMPLATES.length)];
  ```
  - If rng() returns exactly 1.0: `Math.floor(1.0 * 5) = 5` (index out of bounds for array of length 5)
  - Array indices are 0-4, so index 5 is undefined
- **Impact**: HIGH - Would crash with "templateFn is not a function"
- **Fix**: Use `Math.floor(rng() * length) % length` or validate < length

## Type Safety Issues

### Type Issue 2.1: EventQueue.events might not exist or be undefined
- **File**: `alive/scripts/engines/intent.ts`
- **Lines**: 53-68
- **Problem**:
  ```typescript
  for (const event of events.events) {
  ```
  - No validation that `events.events` exists or is iterable
  - If events is undefined, crashes
- **Impact**: MEDIUM - Type system should catch this but runtime validation missing

### Type Issue 2.2: BASE_RESISTANCE type not enforced
- **File**: `alive/scripts/engines/intent.ts`
- **Lines**: 126, 151
- **Problem**:
  ```typescript
  resistance: BASE_RESISTANCE[category] ?? 0
  ```
  - BASE_RESISTANCE might not have the category key
  - No TypeScript error if BASE_RESISTANCE is missing entries
- **Impact**: MEDIUM - Could silently default to 0 when should be higher

---

# 3. FLOW.TS (184 lines)

## Architecture Issues

### Issue 3.1: String magic constants for FlowState.status
- **File**: `alive/scripts/engines/flow.ts`
- **Lines**: Throughout ('flow', 'drift', 'none')
- **Problem**: Status values are strings without enum or const mapping
  - `flow.status !== 'none'` (multiple places)
  - `flow.status === 'flow'` (multiple places)
  - Typos create silent bugs
- **Recommendation**: Create `enum FlowStatus { NONE = 'none', FLOW = 'flow', DRIFT = 'drift' }`

### Issue 3.2: Template arrays are separate constants instead of centralized
- **File**: `alive/scripts/engines/flow.ts`
- **Lines**: 94-152
- **Problem**: Multiple template arrays (FLOW_DIARY_TEMPLATES_BY_PHASE, FLOW_MICRO_DETAILS, DRIFT_DIARY_TEMPLATES) defined separately
  - If templates need updating, hard to find all of them
  - No version control or audit trail
- **Recommendation**: Load from separate template file with metadata

### Issue 3.3: Inconsistent RNG usage
- **File**: `alive/scripts/engines/flow.ts`
- **Lines**: 134-152
- **Problem**:
  - Some functions take `rng = Math.random` as parameter
  - Others call directly without parameter option
  - Makes testing hard

## Code Bugs

### Bug 3.1: checkFlowEntry doesn't validate pool.intents
- **File**: `alive/scripts/engines/flow.ts`
- **Lines**: 27-38
- **Problem**:
  ```typescript
  const intent = pool.intents.find(i => i.category === lastAction.category && i.satisfied_at === null);
  if (!intent || intent.intensity - intent.resistance <= FLOW_ENTRY_THRESHOLD) return currentFlow;
  ```
  - `pool.intents` could be undefined or not an array
  - `find()` could fail if not iterable
- **Impact**: MEDIUM - Type system helps but no runtime validation

### Bug 3.2: checkDriftExit compares with < instead of <=
- **File**: `alive/scripts/engines/flow.ts`
- **Lines**: 63-71
- **Problem**:
  ```typescript
  if (vitality > 55) return { shouldExit: true, reason: '精神恢复了' };
  ```
  - Boundary is `>` not `>=`
  - If vitality = 55 exactly, won't exit even though probably should
  - Inconsistent with other checks using `>=` elsewhere

### Bug 3.3: generateFlowDiary uses template replacement naively
- **File**: `alive/scripts/engines/flow.ts`
- **Lines**: 134-148
- **Problem**:
  ```typescript
  let diary = template.replace(/{activity}/g, flow.activity ?? '做事');
  ```
  - If `flow.activity` contains special regex characters (., *, etc.), breaks
  - `replace` treats second argument as pattern, not literal
- **Impact**: MEDIUM - Activity names with regex chars produce wrong output
- **Fix**: Use `flow.activity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` or use different approach

### Bug 3.4: computeVoiceDirective doesn't validate voiceSignature
- **File**: `alive/scripts/engines/flow.ts`
- **Lines**: 156-168
- **Problem**:
  ```typescript
  return '...text...' + sig;
  ```
  - If voiceSignature is extremely long or contains newlines, breaks prompt
  - No length validation
- **Impact**: LOW-MEDIUM - Could corrupt LLM prompt

### Bug 3.5: shouldEvolveFlow doesn't validate duration_ticks
- **File**: `alive/scripts/engines/flow.ts`
- **Lines**: 181-183
- **Problem**:
  ```typescript
  export function shouldEvolveFlow(durationTicks: number): boolean {
    return durationTicks > 0 && durationTicks % 2 === 0;
  }
  ```
  - If durationTicks is negative: `(-3) % 2 = -1`, so returns false (correct by accident)
  - If durationTicks is NaN: `NaN % 2 = NaN`, then `NaN === 0` is false (works)
  - If durationTicks is float: `(2.5) % 2 = 0.5`, returns false (works)
  - Actually this is okay!

## Immutability Violations

### Violation 3.1: checkFlowEntry creates new FlowState correctly
- **File**: `alive/scripts/engines/flow.ts`
- **Lines**: 27-38
- **Problem**: Returns new object without mutating input. **NOT a violation.**

### Violation 3.2: tickFlow mutates flow in safe way
- **File**: `alive/scripts/engines/flow.ts`
- **Lines**: 74-86
- **Problem**: Spreads flow object and returns new one. **NOT a violation.**

## Error Handling Gaps

### Gap 3.1: No try-catch in generateFlowDiary or generateDriftDiary
- **File**: `alive/scripts/engines/flow.ts`
- **Lines**: 134-152
- **Problem**: If emotion state is undefined or template array is empty:
  - `templates[Math.floor(...)]` could be undefined
  - `.replace()` would crash
- **Impact**: MEDIUM - Could crash if emotion undefined

### Gap 3.2: No validation of INTERRUPT_CHANCE_CAP
- **File**: `alive/scripts/engines/flow.ts`
- **Lines**: 9-17, 85
- **Problem**: 
  ```typescript
  Math.min(INTERRUPT_CHANCE_CAP, flow.interrupt_chance + increment)
  ```
  - If INTERRUPT_CHANCE_CAP is undefined or NaN, fails
  - If increment is NaN, result is NaN

## Edge Cases Not Handled

### Edge Case 3.1: INTERRUPT_CHANCE_CAP exactly 1.0 vs > 1.0
- **File**: `alive/scripts/engines/flow.ts`
- **Lines**: 12, 85
- **Problem**:
  ```typescript
  const INTERRUPT_CHANCE_CAP = 0.85;
  ```
  - Used in `Math.min(INTERRUPT_CHANCE_CAP, ...)` so max is 0.85
  - But if someone changes to 1.5, interrupt chance could exceed 1.0 (>100%)
  - No validation that cap is in [0, 1]

### Edge Case 3.2: FLOW_MICRO_DETAILS array with all empty strings
- **File**: `alive/scripts/engines/flow.ts`
- **Lines**: 113-122
- **Problem**:
  ```typescript
  const detail = FLOW_MICRO_DETAILS[Math.floor(rng() * FLOW_MICRO_DETAILS.length)];
  if (detail) diary += ` ${detail}`;
  ```
  - If detail is empty string, `if (detail)` is false, won't append space
  - But space would be wasted anyway
  - This actually handles empty strings correctly

### Edge Case 3.3: rng() === 1.0 in generateFlowDiary
- **File**: `alive/scripts/engines/flow.ts`
- **Lines**: 137, 141
- **Problem**:
  ```typescript
  const template = templates[Math.floor(rng() * templates.length)];
  const detail = FLOW_MICRO_DETAILS[Math.floor(rng() * FLOW_MICRO_DETAILS.length)];
  ```
  - If rng() returns exactly 1.0:
    - `Math.floor(1.0 * templates.length) = templates.length` (out of bounds)
- **Impact**: HIGH - Same as Intent bug 2.3
- **Fix**: Use `(rng() * length) % length` or validate < length

## Type Safety Issues

### Type Issue 3.1: flow.activity could be null/undefined
- **File**: `alive/scripts/engines/flow.ts`
- **Lines**: 138
- **Problem**:
  ```typescript
  let diary = template.replace(/{activity}/g, flow.activity ?? '做事');
  ```
  - Handles undefined correctly with ??
  - But if activity is null or empty string, still uses it
  - Should validate activity is non-empty

### Type Issue 3.2: emotion parameter not validated in generateFlowDiary
- **File**: `alive/scripts/engines/flow.ts`
- **Lines**: 134-148
- **Problem**:
  ```typescript
  export function generateFlowDiary(flow: FlowState, emotion: EmotionState, rng = Math.random): string {
    ...
    if (emotion.stress > 0.5) diary += '...虽然有点累。';
  ```
  - No check that emotion is defined before accessing properties
  - No check that emotion.stress is finite

---

# 4. VITALITY.TS (117 lines)

## Architecture Issues

### Issue 4.1: ACTION_COSTS and REPLENISHMENT not derived from schema
- **File**: `alive/scripts/engines/vitality.ts`
- **Lines**: 17-34
- **Problem**: Two separate lookup tables that are hardcoded
  - No way to validate consistency
  - No audit trail for changes
  - If action type doesn't have entry, silently defaults to 0
- **Recommendation**: Could use schema to define action types

### Issue 4.2: getVitalityConstraints returns inconsistent types
- **File**: `alive/scripts/engines/vitality.ts`
- **Lines**: 94-109
- **Problem**: Return object has:
  - Boolean fields (canDoHeavyWork, etc.)
  - String field (moodModifier)
  - Number field (intentMultiplier)
  - Mixed types make this hard to work with

## Code Bugs

### Bug 4.1: afternoonRestRecovery checks hour in local time but might be UTC
- **File**: `alive/scripts/engines/vitality.ts`
- **Lines**: 69-83
- **Problem**:
  ```typescript
  export function afternoonRestRecovery(state: VitalityState, hour: number): VitalityState {
    if (hour < 13 || hour > 15) return state;
  ```
  - Caller must pass local hour, but not documented
  - If caller passes UTC hour by mistake, logic breaks
  - No validation that hour is in [0, 23]
- **Impact**: MEDIUM - Silent failure if wrong hour passed
- **Fix**: Validate `hour >= 0 && hour < 24`

### Bug 4.2: getLocalDate() called multiple times inconsistently
- **File**: `alive/scripts/engines/vitality.ts`
- **Lines**: 56-83
- **Problem**:
  ```typescript
  const wasLow = state.vitality < 30;  // Line 57
  ...
  const today = getLocalDate();  // Line 73
  ```
  - What if getLocalDate() returns different value on subsequent calls in same tick?
  - Time-dependent code is hard to test
  - No caching of "today"
- **Impact**: LOW - Race condition unlikely in practice

### Bug 4.3: morningRecovery allows vitality to go above max incorrectly
- **File**: `alive/scripts/engines/vitality.ts`
- **Lines**: 56-63
- **Problem**:
  ```typescript
  const emergency = newConsecutive >= VITALITY_CONFIG.EMERGENCY_LOW_DAYS;
  const base = REPLENISHMENT.sleep_cycle;
  const newVitality = emergency ? Math.max(state.vitality + base, VITALITY_CONFIG.EMERGENCY_MIN_VITALITY) : clampVitality(state.vitality + base);
  ```
  - `Math.max(state.vitality + base, emergency_min)` takes maximum of two values
  - If state.vitality = 90, base = 20, emergency_min = 60:
    - `Math.max(110, 60) = 110` (exceeds VITALITY_MAX)
  - Then clampVitality isn't called in emergency path!
- **Impact**: HIGH - Vitality can exceed max value in emergency path
- **Fix**: Should be `clampVitality(Math.max(state.vitality, EMERGENCY_MIN_VITALITY) + base)`

### Bug 4.4: drainVitality applies stressMultiplier but clamp comes after
- **File**: `alive/scripts/engines/vitality.ts`
- **Lines**: 36-42
- **Problem**: 
  ```typescript
  const modifier = flowModifier ?? 1.0;
  const drain = BASE_DRAIN_PER_TICK * stressMultiplier * arousalDiscount * modifier;
  return { ...state, vitality: clampVitality(state.vitality - drain), ... };
  ```
  - If stress = 1.0 (maximum), stressMultiplier = 1.5
  - If arousalDiscount = 0.8, modifier = 1.0
  - drain = 2 * 1.5 * 0.8 * 1.0 = 2.4
  - This seems okay, but no validation that drain is positive
  - If drain = NaN, vitality becomes NaN
- **Impact**: MEDIUM

## Immutability Violations

### Violation 4.1: Functions use spread operator correctly
- **File**: `alive/scripts/engines/vitality.ts`
- **Lines**: Throughout
- **Problem**: All functions return new state object without mutating input. **NOT a violation.**

## Error Handling Gaps

### Gap 4.1: No validation of VITALITY_CONFIG values
- **File**: `alive/scripts/engines/vitality.ts`
- **Lines**: 8-10, 59-61
- **Problem**: Assumes VITALITY_CONFIG.VITALITY_MAX, VITALITY_MIN, BASE_DRAIN_PER_TICK are valid
  - If VITALITY_MAX < VITALITY_MIN, clampVitality breaks
  - If BASE_DRAIN_PER_TICK is negative, vitality increases instead
- **Impact**: MEDIUM - Config error becomes silent runtime bug

### Gap 4.2: No try-catch in getVitalityConstraints
- **File**: `alive/scripts/engines/vitality.ts`
- **Lines**: 94-109
- **Problem**: If vitality is NaN, getVitalityZone() could fail
- **Impact**: LOW - Switch statement would hit default case

### Gap 4.3: No bounds check for custom costs/gains
- **File**: `alive/scripts/engines/vitality.ts`
- **Lines**: 44-54
- **Problem**:
  ```typescript
  export function applyActionCost(state: VitalityState, actionType: string, customCost?: number): VitalityState {
    const cost = customCost ?? ACTION_COSTS[actionType] ?? 0;
  ```
  - `customCost` could be negative (adds vitality)
  - `customCost` could be Infinity (subtracts Infinity = NaN)
  - No validation of value
- **Impact**: MEDIUM - Could corrupt vitality state

## Edge Cases Not Handled

### Edge Case 4.1: Negative hour parameter
- **File**: `alive/scripts/engines/vitality.ts`
- **Lines**: 69-83
- **Problem**: 
  ```typescript
  if (hour < 13 || hour > 15) return state;
  ```
  - If hour = -5: `-5 < 13` is true, returns state (works by accident)
  - If hour = 25: `25 > 15` is true, returns state (works)
  - But no validation that hour is sensible

### Edge Case 4.2: Very large or very small vitality values
- **File**: `alive/scripts/engines/vitality.ts`
- **Lines**: Throughout
- **Problem**: No overflow checks
  - If vitality = 999999 and gain = 1, clamp works
  - If gain = Infinity, clamp still works (returns VITALITY_MAX)
  - Seems okay actually

---

# 5. CONFIDENCE.TS (90 lines)

## Architecture Issues

### Issue 5.1: No context about what feedback represents
- **File**: `alive/scripts/engines/confidence.ts`
- **Lines**: 23-43
- **Problem**: `updateConfidenceFromFeedback` takes abstract FeedbackEvent but:
  - Doesn't validate feedback.metric and feedback.baseline are numbers
  - Doesn't validate they're finite or in expected range
  - No documentation on what ranges are valid
- **Recommendation**: Create FeedbackValidator interface

### Issue 5.2: Confidence score is completely unbounded
- **File**: `alive/scripts/engines/confidence.ts`
- **Lines**: 10-11, 39
- **Problem**: While clampConfidence() bounds final value, intermediate calculations can produce large values
  - No check that streak is in reasonable range
  - If streak = 1000, streakBonus = 60 * 0.02 = 1.2, final value could spike
- **Recommendation**: Validate streak is reasonable range too

## Code Bugs

### Bug 5.1: updateConfidenceFromFeedback doesn't handle metric === baseline
- **File**: `alive/scripts/engines/confidence.ts`
- **Lines**: 27-34
- **Problem**:
  ```typescript
  const isPositive = feedback.metric > feedback.baseline;
  const isNegative = feedback.metric < feedback.baseline;
  const delta = isPositive ? FEEDBACK_DELTA : (isNegative ? -FEEDBACK_DELTA : 0);
  const newStreak = isPositive ? (...) : (isNegative ? (...) : 0);
  ```
  - If metric === baseline: delta = 0, newStreak = 0
  - This resets streak even though nothing changed
  - Should probably be unchanged, not reset
- **Impact**: MEDIUM - Streak tracking breaks on ties
- **Fix**: Should check metric !== baseline before modifying streak

### Bug 5.2: Batch update doesn't preserve state between iterations
- **File**: `alive/scripts/engines/confidence.ts`
- **Lines**: 48-57
- **Problem**:
  ```typescript
  export function updateConfidenceFromBatch(state, feedbacks) {
    let current = state;
    for (const fb of feedbacks) {
      current = updateConfidenceFromFeedback(current, fb);
    }
    return current;
  ```
  - This is actually correct! Each feedback updates the streak
  - So batch processing produces different result than individual calls
  - This might be intentional, but is it documented?

### Bug 5.3: decayConfidence doesn't validate CONFIDENCE_NEUTRAL
- **File**: `alive/scripts/engines/confidence.ts`
- **Lines**: 62-65
- **Problem**:
  ```typescript
  const decayed = state.confidence + (CONFIDENCE_NEUTRAL - state.confidence) * DECAY_RATE;
  ```
  - If CONFIDENCE_NEUTRAL is not between CONFIDENCE_MIN and CONFIDENCE_MAX, decay pulls wrong direction
  - If CONFIDENCE_NEUTRAL = 2.0 and confidence = 0.5:
    - decayed = 0.5 + (2.0 - 0.5) * 0.1 = 0.65 (increases)
    - But clamp might force to 1.2 max
  - If DECAY_RATE = NaN, decayed = NaN
- **Impact**: MEDIUM - Silent failure with bad config

### Bug 5.4: getProduceRateMultiplier doesn't validate input
- **File**: `alive/scripts/engines/confidence.ts`
- **Lines**: 70-72
- **Problem**:
  ```typescript
  export function getProduceRateMultiplier(confidence: number): number {
    return confidence;
  ```
  - If confidence is NaN, returns NaN
  - If confidence > CONFIDENCE_MAX, should clamp
  - This is just a pass-through, which seems wrong
- **Impact**: MEDIUM - Doesn't enforce bounds on caller side

## Immutability Violations

### Violation 5.1: Functions use spread correctly
- **File**: `alive/scripts/engines/confidence.ts`
- **Lines**: Throughout
- **Problem**: All functions create new state objects. **NOT a violation.**

## Error Handling Gaps

### Gap 5.1: No validation that FeedbackEvent has required properties
- **File**: `alive/scripts/engines/confidence.ts`
- **Lines**: 23-43
- **Problem**:
  ```typescript
  const isPositive = feedback.metric > feedback.baseline;
  ```
  - No check that feedback.metric exists
  - No check that feedback.baseline exists
  - No check that they're finite numbers
- **Impact**: MEDIUM - Could crash if feedback malformed

### Gap 5.2: No try-catch in any function
- **File**: `alive/scripts/engines/confidence.ts`
- **Lines**: Throughout
- **Problem**: No error handling for:
  - NaN values
  - Infinity values
  - undefined properties
- **Impact**: MEDIUM - Silent failures possible

## Edge Cases Not Handled

### Edge Case 5.1: Extreme streak values
- **File**: `alive/scripts/engines/confidence.ts`
- **Lines**: 36
- **Problem**:
  ```typescript
  const streakBonus = Math.min(Math.abs(newStreak), 3) * 0.02 * Math.sign(newStreak);
  ```
  - If streak = 1000: `Math.min(1000, 3) = 3`, bonus = 0.06 or -0.06 (capped correctly)
  - If streak = -1000: bonus = -0.06 (correct)
  - Actually handles well! Max bonus is ±0.06 regardless of streak

### Edge Case 5.2: Metric and baseline both negative
- **File**: `alive/scripts/engines/confidence.ts`
- **Lines**: 27-34
- **Problem**:
  ```typescript
  const isPositive = feedback.metric > feedback.baseline;
  ```
  - If metric = -5, baseline = -10: isPositive = true (metric > baseline)
  - This correctly treats higher as better, even if both negative
  - Works correctly!

### Edge Case 5.3: CONFIDENCE_NEUTRAL outside [MIN, MAX]
- **File**: `alive/scripts/engines/confidence.ts`
- **Lines**: 62-65
- **Problem**: If CONFIDENCE_NEUTRAL = 2.0 but CONFIDENCE_MAX = 1.2:
  - Decay always pulls toward 2.0 but clamp prevents reaching it
  - Confidence gets stuck at 1.2 and doesn't move
- **Impact**: MEDIUM - Config error becomes silent bug

## Type Safety Issues

### Type Issue 5.1: FeedbackEvent.metric/baseline not validated as numbers
- **File**: `alive/scripts/engines/confidence.ts`
- **Lines**: 23-43
- **Problem**: TypeScript interface says they're numbers, but no runtime check
  - If API returns strings, comparison fails silently
  - `"10" > "5"` is string comparison (false), not numeric

---

# 6. WORK-IMPULSE.TS (91 lines)

## Architecture Issues

### Issue 6.1: Hardcoded extra decay values
- **File**: `alive/scripts/engines/work-impulse.ts`
- **Lines**: 11-12
- **Problem**:
  ```typescript
  const EXTRA_DECAY_1_OUTPUT = 5;
  const EXTRA_DECAY_2_OUTPUTS = 15;
  ```
  - These are magic numbers without documentation
  - No way to configure per-persona
  - Ratio doesn't match up: 1 output = 5 extra, 2 outputs = 15 extra (not 2x)
    - Should be 1 output = 5, 2 outputs = 10? Or is the jump intentional?
- **Recommendation**: Make configurable or document the intent

### Issue 6.2: outputs_today counter mixes date tracking with counter
- **File**: `alive/scripts/engines/work-impulse.ts`
- **Lines**: Throughout
- **Problem**: 
  - `outputs_today_date` tracks date
  - `outputs_today` tracks count
  - These must stay in sync manually
  - If date changes but outputs_today_date not updated, count persists to new date
- **Recommendation**: Combine into single tracked value or use hydration function

## Code Bugs

### Bug 6.1: decayImpulse logic is confusing
- **File**: `alive/scripts/engines/work-impulse.ts`
- **Lines**: 38-56
- **Problem**:
  ```typescript
  const today = getLocalDate();
  const outputsToday = state.outputs_today_date === today ? state.outputs_today : 0;
  const todayDate = state.outputs_today_date === today ? state.outputs_today_date : today;
  ...
  return {
    ...state,
    value: clamp(state.value - totalDecay, 0, 100),
    outputs_today: outputsToday,
    outputs_today_date: todayDate,
  };
  ```
  - `todayDate` is set to either old date or new date
  - But state.outputs_today is also reset when date changes
  - Function doesn't actually reset count to 0, just passes through old value
  - If date changed, outputsToday = 0, but outputs_today_date = today
  - Next call will see `outputs_today_date === today` and use 0 correctly
  - **Actually this is correct logic**, just hard to follow
- **Impact**: LOW - Code works but is confusing

### Bug 6.2: resetImpulseAfterOutput creates incomplete state
- **File**: `alive/scripts/engines/work-impulse.ts`
- **Lines**: 63-73
- **Problem**:
  ```typescript
  return {
    value: 0,
    last_output_at: now().getTime(),
    outputs_today_date: today,
    outputs_today: outputsToday + 1,
  };
  ```
  - Returns WorkImpulseState but only sets 4 fields
  - WorkImpulseState might have other fields not set here
  - Type system might not catch this if other fields are optional
- **Impact**: MEDIUM - If WorkImpulseState has required fields, returns incomplete object
- **Fix**: Should be `{ ...state, value: 0, last_output_at: now().getTime(), ... }`

### Bug 6.3: accumulateImpulse doesn't validate delta range
- **File**: `alive/scripts/engines/work-impulse.ts`
- **Lines**: 25-30
- **Problem**:
  ```typescript
  export function accumulateImpulse(state: WorkImpulseState, delta: number): WorkImpulseState {
    return {
      ...state,
      value: clamp(state.value + delta, 0, 100),
    };
  ```
  - `delta` could be negative (subtracts impulse)
  - `delta` could be Infinity (results in Infinity before clamp)
  - `delta` could be NaN (results in NaN before clamp)
  - No validation of delta
- **Impact**: MEDIUM - Invalid delta corrupts impulse

### Bug 6.4: checkDormancy doesn't validate last_output_at
- **File**: `alive/scripts/engines/work-impulse.ts`
- **Lines**: 86-90
- **Problem**:
  ```typescript
  export function checkDormancy(state: WorkImpulseState): number {
    if (state.last_output_at === 0) return 0;
    const daysSinceOutput = (now().getTime() - state.last_output_at) / (24 * 60 * 60 * 1000);
    return daysSinceOutput >= DORMANCY_DAYS ? DORMANCY_BOOST : 0;
  ```
  - If last_output_at is in future (clock skew): daysSinceOutput is negative
  - `negative >= positive` is false, so returns 0 (correct behavior by accident)
  - But if last_output_at is NaN: `NaN - now() = NaN`, `NaN >= x` is false (works)
  - If last_output_at is string: `string - number = NaN` (works)
  - Actually handles edge cases okay!

## Immutability Violations

### Violation 6.1: accumulateImpulse spreads state correctly
- **File**: `alive/scripts/engines/work-impulse.ts`
- **Lines**: 25-30
- **Problem**: Uses spread operator. **NOT a violation.**

### Violation 6.2: decayImpulse spreads state correctly
- **File**: `alive/scripts/engines/work-impulse.ts`
- **Lines**: 50-55
- **Problem**: Returns new object. **NOT a violation.**

## Error Handling Gaps

### Gap 6.1: No validation of WORK_IMPULSE_CONFIG values
- **File**: `alive/scripts/engines/work-impulse.ts`
- **Lines**: 10, 13-15
- **Problem**: Assumes config values are valid numbers
  - If IMPULSE_THRESHOLD = NaN, shouldInjectProduceDesire always false
  - If DORMANCY_DAYS = negative, checkDormancy never triggers
  - If DORMANCY_BOOST = negative (removes impulse), contradicts function name
- **Impact**: MEDIUM - Config errors become silent bugs

### Gap 6.2: No validation of clamp bounds
- **File**: `alive/scripts/engines/work-impulse.ts`
- **Lines**: 17-19
- **Problem**:
  ```typescript
  function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  ```
  - No validation that min <= max
  - If min > max: clamping produces wrong results
- **Impact**: LOW - Would only happen with bad caller, but no error message

## Edge Cases Not Handled

### Edge Case 6.1: Clock skew - last_output_at in future
- **File**: `alive/scripts/engines/work-impulse.ts`
- **Lines**: 88
- **Problem**: If system clock goes backward after output:
  - `now().getTime() - future_time = negative`
  - `negative >= DORMANCY_DAYS` is false
  - Dormancy boost won't trigger (correct)
  - But should this be logged?

### Edge Case 6.2: Multiple outputs in same millisecond
- **File**: `alive/scripts/engines/work-impulse.ts`
- **Lines**: 69
- **Problem**:
  ```typescript
  last_output_at: now().getTime(),
  ```
  - If two outputs happen in same millisecond, timestamp is identical
  - checkDormancy can't distinguish them
  - Probably okay in practice (unlikely to have exact same timestamp)

### Edge Case 6.3: outputs_today overflow
- **File**: `alive/scripts/engines/work-impulse.ts`
- **Lines**: 71
- **Problem**:
  ```typescript
  outputs_today: outputsToday + 1,
  ```
  - No upper bound on outputs_today
  - If someone produces output 1000 times in a day, totalDecay = BASE_DECAY + EXTRA_DECAY_2_OUTPUTS
  - But only applies once per decay call, so shouldn't accumulate
  - Actually okay!

## Type Safety Issues

### Type Issue 6.1: WorkImpulseState fields might not be optional
- **File**: `alive/scripts/engines/work-impulse.ts`
- **Lines**: 68
- **Problem**: `resetImpulseAfterOutput` only returns 4 fields:
  ```typescript
  return {
    value: 0,
    last_output_at: now().getTime(),
    outputs_today_date: today,
    outputs_today: outputsToday + 1,
  };
  ```
  - If WorkImpulseState has other required fields, TypeScript error
  - But at runtime, other fields are undefined
- **Impact**: MEDIUM - Type safety issue

### Type Issue 6.2: getLocalDate() type not validated
- **File**: `alive/scripts/engines/work-impulse.ts`
- **Lines**: 39, 64
- **Problem**: Function assumes getLocalDate() returns string in YYYY-MM-DD format
  - No validation that returned value matches expected format
  - If returns null or different format, equality checks fail silently
- **Impact**: MEDIUM - Silent failure if getLocalDate() changes

---

# 7. PERSONALITY-DRIFT.TS (335 lines)

## Architecture Issues

### Issue 7.1: Heavy file I/O coupling in detection logic
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 162-209, 260-286
- **Problem**: Functions that should be pure (detectDrift, runDriftAnalysis) call:
  - `loadPersona()` - file I/O
  - `loadPersonalityDrift()` - file I/O
  - `savePersonalityDrift()` - file I/O
  - Makes testing hard, functions have side effects
- **Recommendation**: Separate I/O from logic. Functions should take data as parameters.

### Issue 7.2: Multiple conversion between modifier and string representation
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 95-106
- **Problem**:
  ```typescript
  const dateMatch = m.origin.match(/\d{4}-\d{2}-\d{2}/);
  if (!dateMatch) return m;
  const originTime = new Date(dateMatch[0]).getTime();
  ```
  - Parsing date from string field is brittle
  - If origin format changes, breaks silently
  - No schema validation of origin field
- **Recommendation**: Store origin as structured object instead of string

### Issue 7.3: Magic values for trait-level drift thresholds
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 24-31, 25, 148, 181, 310
- **Problem**:
  - WARNING_THRESHOLD = 6.0 (hardcoded)
  - MIN_STRENGTH = 0.1 (hardcoded)
  - RECENT_DIARY_LINES = 50 (defined but not used)
  - Score scale logic at line 148 not explained
- **Recommendation**: Add comments explaining scoring scale and thresholds

## Code Bugs

### Bug 7.1: decayModifiers regex assumes date always present
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 89-115
- **Problem**:
  ```typescript
  const dateMatch = m.origin.match(/\d{4}-\d{2}-\d{2}/);
  if (!dateMatch) return m;  // No decay if no date found
  ```
  - If origin = "night-reflect" (no date), modifier never decays
  - Over time, old modifiers with no date accumulate at full strength
- **Impact**: MEDIUM - Stale modifiers persist indefinitely
- **Fix**: Should use created_at or similar timestamp, not extract from string

### Bug 7.2: decayModifiers doesn't validate elapsed time calculation
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 99-106
- **Problem**:
  ```typescript
  const elapsed = currentTime.getTime() - originTime;
  if (elapsed <= 0) return m;
  ```
  - If originTime > currentTime (future date), elapsed is negative
  - Function returns original modifier unchanged
  - Clock skew silently breaks decay
- **Impact**: MEDIUM - System time manipulation breaks consistency

### Bug 7.3: capModifiers loses modification order
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 126-134
- **Problem**:
  ```typescript
  const sorted = [...modifiers].sort((a, b) => Math.abs(b.strength) - Math.abs(a.strength));
  const kept = sorted.slice(0, MAX_MODIFIERS);
  ```
  - Sorts by absolute strength, then slices
  - Loses information about which modifiers were stronger
  - If two modifiers have same absolute strength but opposite direction, one is arbitrarily removed
- **Impact**: LOW - Deterministic by JavaScript sort, but order-dependent

### Bug 7.4: computeDriftScore doesn't distinguish positive vs negative drift
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 142-150
- **Problem**:
  ```typescript
  const totalStrength = modifiers.reduce((sum, m) => sum + Math.abs(m.strength), 0);
  const score = Math.min(10, totalStrength);
  ```
  - Uses absolute value, so +0.5 and -0.5 both count as 0.5
  - Score can't distinguish "drifted positive" from "drifted negative"
  - Warning at score 6.0 doesn't tell which direction
- **Impact**: MEDIUM - Warning is vague, doesn't explain direction

### Bug 7.5: detectDrift doesn't validate persona parameter
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 163-209
- **Problem**:
  ```typescript
  export function detectDrift(persona?: PersonaConfig, modifiers?: PersonalityModifier[]): DriftAnalysis {
    const p = persona ?? loadPersona();
    const mods = modifiers ?? loadPersonalityDrift().modifiers;
  ```
  - If loadPersona() throws exception, detectDrift crashes
  - No try-catch to handle missing persona file
- **Impact**: HIGH - Could crash system

### Bug 7.6: buildDriftContext loads personality twice
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 294-313
- **Problem**:
  ```typescript
  export function buildDriftContext(persona?: PersonaConfig): string {
    const p = persona ?? loadPersona();
    const drift = loadPersonalityDrift();
  ```
  - If persona not provided, loads from disk
  - Line 326 calls `loadPersona()` again in buildDriftBriefSection
  - Could be expensive if called frequently
- **Impact**: LOW - Performance issue, not correctness

### Bug 7.7: drifting_traits evidence join uses Chinese semicolon
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 185
- **Problem**:
  ```typescript
  evidence: data.effects.slice(0, 3).join('；'),
  ```
  - Uses Chinese semicolon (；) not ASCII (;)
  - Inconsistent with rest of codebase
  - Might cause encoding issues in some systems
- **Impact**: LOW - Chinese context so probably intentional

## Immutability Violations

### Violation 7.1: decayModifiers returns filtered array correctly
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 94-115
- **Problem**: Maps and filters to create new array. **NOT a violation.**

### Violation 7.2: capModifiers returns sliced array
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 126-134
- **Problem**: Returns slice of sorted array. **NOT a violation.**

## Error Handling Gaps

### Gap 7.1: runDriftAnalysis catches no exceptions
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 260-286
- **Problem**: Calls:
  - `loadPersona()` - could throw
  - `loadPersonalityDrift()` - could throw
  - `savePersonalityDrift()` - could throw
  - No try-catch blocks
- **Impact**: HIGH - Exceptions crash caller

### Gap 7.2: No validation of PersonalityModifier fields
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: Throughout
- **Problem**: Functions assume modifiers have valid fields:
  - `m.origin` - could be undefined
  - `m.strength` - could be NaN
  - `m.trait` - could be empty string
  - `m.effect` - could be undefined
- **Impact**: MEDIUM - Silent failures if data malformed

### Gap 7.3: buildDriftBriefSection catches exception but returns empty string
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 319-334
- **Problem**:
  ```typescript
  try {
    ...
  } catch {
    return '';
  ```
  - Silently swallows all exceptions
  - No logging of what failed
  - Caller doesn't know if empty string means "no warning" or "error occurred"
- **Impact**: MEDIUM - Hides errors

## Edge Cases Not Handled

### Edge Case 7.1: Modifier with empty string trait
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 178-188
- **Problem**:
  ```typescript
  drifting_traits.push({
    trait,  // Could be empty string
    deviation: ...,
  ```
  - If trait is empty string, warning says "trait: ;" (confusing)
- **Impact**: LOW - Input validation issue

### Edge Case 7.2: All modifiers have strength < MIN_STRENGTH
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 89-115
- **Problem**: If all modifiers decay below MIN_STRENGTH:
  - decayModifiers returns empty array
  - computeDriftScore returns 0
  - No warning generated
  - This is correct behavior, but worth noting
- **Impact**: LOW - Works as intended

### Edge Case 7.3: Score exactly at WARNING_THRESHOLD
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 198
- **Problem**:
  ```typescript
  const warning = score >= WARNING_THRESHOLD ? ... : null;
  ```
  - If score = 6.0 exactly and WARNING_THRESHOLD = 6.0, warning generated
  - If score = 5.9999..., no warning
  - Boundary condition is correct with >=

### Edge Case 7.4: More than 3 drifting traits
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 227-229
- **Problem**:
  ```typescript
  for (const t of traits.slice(0, 3)) {
  ```
  - Only shows first 3 traits in warning
  - If many traits drifted, information is hidden
  - Might be intentional to keep warning short

### Edge Case 7.5: ModifierEffects array too long
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 303-307
- **Problem**:
  ```typescript
  const modifierEffects = drift.modifiers
    .sort(...)
    .slice(0, 5)
    .map(m => m.effect)
    .join('；');
  ```
  - Joins 5 effects with semicolons - could be very long string
  - No truncation if final string exceeds reasonable length
- **Impact**: LOW - Could produce very long output

## Type Safety Issues

### Type Issue 7.1: origin field assumed to be string with date
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 95-99
- **Problem**: Assumes origin is string containing date, but:
  - Type definition might allow any string
  - If origin = null, `.match()` throws
  - If origin = 123 (number), `.match()` throws
- **Impact**: MEDIUM - No runtime validation

### Type Issue 7.2: PersonaConfig not validated after loading
- **File**: `alive/scripts/engines/personality-drift.ts`
- **Lines**: 164, 295
- **Problem**:
  ```typescript
  const p = persona ?? loadPersona();
  ```
  - loadPersona() could return incomplete object
  - Code assumes p.personality, p.personality.mbti, p.personality.core_traits exist
  - No validation of structure
- **Impact**: MEDIUM - Could crash accessing undefined properties

---

# SUMMARY BY CATEGORY

## Critical Bugs (Could crash system or corrupt data)

1. **emotion.ts, line 256**: `Math.pow(2, -entry.tick_age / 16)` - no validation that tick_age is finite
2. **emotion.ts, line 283**: `describeMood` returns wrong mood at boundary values
3. **intent.ts, line 200**: PROCRASTINATION_TEMPLATES index out of bounds when rng() = 1.0
4. **flow.ts, line 137, 141**: Template/detail array index out of bounds when rng() = 1.0
5. **vitality.ts, line 61**: Emergency recovery sets vitality > VITALITY_MAX
6. **work-impulse.ts, line 68**: resetImpulseAfterOutput returns incomplete state object
7. **personality-drift.ts, line 209**: detectDrift could crash if loadPersona() throws

## High Priority Issues (Imminent risk of bugs)

1. **emotion.ts, line 156**: Multiplier can become negative or extremely large (no bounds)
2. **emotion.ts, line 211-213**: Momentum duration tracking breaks at zero crossing
3. **intent.ts, line 85**: parseInt without validation of format - silent failure
4. **intent.ts, line 200**: RNG value not validated (could be NaN, negative, >1)
5. **flow.ts, line 138**: Regex replacement with user input breaks with special chars
6. **vitality.ts, line 61**: Branch uses Math.max before clamp (wrong logic)
7. **confidence.ts, line 36**: Confidence streak/bonus calculations have boundary issues
8. **personality-drift.ts, line 95**: Date parsing from string is brittle

## Medium Priority Issues (Code smell, edge case handling)

1. **emotion.ts**: EmotionState is too large (god object)
2. **intent.ts**: computeDynamicResistance has too many parameters (7)
3. **all files**: Extensive magic numbers without named constants
4. **personality-drift.ts**: Heavy file I/O coupling in detection logic
5. **all files**: Missing validation of function parameters
6. **all files**: No try-catch blocks in critical functions

## Low Priority Issues (Code quality)

1. **flow.ts**: String magic constants instead of enum
2. **vitality.ts**: getVitalityConstraints returns mixed types (booleans + string + number)
3. **intent.ts**: Dead code path in checkImpulseBreakthrough
4. **personality-drift.ts**: Loads persona twice in related functions
5. **work-impulse.ts**: confusing date/counter tracking logic

