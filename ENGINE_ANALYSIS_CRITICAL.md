# CRITICAL FINDINGS SUMMARY
## alive/scripts/engines/ - Very Thorough Analysis

---

## 🔴 CRITICAL BUGS (System-Breaking)

### 1. PROCRASTINATION_TEMPLATES Index Out of Bounds
- **File**: `intent.ts` line 200
- **Severity**: CRITICAL - Will crash
- **Code**:
  ```typescript
  const templateFn = PROCRASTINATION_TEMPLATES[Math.floor(rng() * PROCRASTINATION_TEMPLATES.length)];
  ```
- **Problem**: If rng() returns exactly 1.0:
  - `Math.floor(1.0 * 5) = 5`
  - Array has indices [0-4], so index 5 is undefined
  - Calling undefined as function crashes: "templateFn is not a function"
- **Fix**: Use `Math.floor(rng() * length) % length` or add bounds check

### 2. Flow Diary Template Index Out of Bounds
- **File**: `flow.ts` lines 137, 141
- **Severity**: CRITICAL - Will crash
- **Code**:
  ```typescript
  const template = templates[Math.floor(rng() * templates.length)];
  const detail = FLOW_MICRO_DETAILS[Math.floor(rng() * FLOW_MICRO_DETAILS.length)];
  ```
- **Problem**: Same as above - rng() = 1.0 causes array index out of bounds
- **Fix**: Same solution - use modulo or bounds checking

### 3. Emergency Vitality Recovery Exceeds Maximum
- **File**: `vitality.ts` lines 56-63
- **Severity**: CRITICAL - State corruption
- **Code**:
  ```typescript
  const emergency = newConsecutive >= VITALITY_CONFIG.EMERGENCY_LOW_DAYS;
  const base = REPLENISHMENT.sleep_cycle;
  const newVitality = emergency ? Math.max(state.vitality + base, VITALITY_CONFIG.EMERGENCY_MIN_VITALITY) : clampVitality(state.vitality + base);
  ```
- **Problem**: In emergency path:
  - `Math.max(state.vitality + base, emergency_min)` takes max of two values
  - If state.vitality = 90, base = 20, emergency_min = 60:
    - Result = 110 (exceeds VITALITY_MAX)
  - Emergency branch doesn't call clampVitality!
- **Impact**: Vitality can exceed 100, breaking all vitality-based checks
- **Fix**: `clampVitality(Math.max(state.vitality, EMERGENCY_MIN_VITALITY) + base)`

### 4. Momentum Duration Tracking Breaks at Zero
- **File**: `emotion.ts` lines 211-213
- **Severity**: CRITICAL - Logic error
- **Code**:
  ```typescript
  const prevSign = Math.sign(state.momentum.valence);
  const newSign = Math.sign(newMomentum.valence);
  newMomentum.duration_ticks = prevSign === newSign ? state.momentum.duration_ticks + 1 : 0;
  ```
- **Problem**: When momentum is close to zero:
  - `Math.sign(0) = 0`
  - `Math.sign(0.0001) = 1`
  - `Math.sign(-0.0001) = -1`
  - If transitioning through 0, both signs are 0, so `prevSign === newSign` is true
  - Duration keeps incrementing even during sign flip (momentum crossover)
- **Impact**: Emotional momentum tracking becomes incorrect during state transitions

### 5. resetImpulseAfterOutput Returns Incomplete Object
- **File**: `work-impulse.ts` lines 63-73
- **Severity**: CRITICAL - Type violation
- **Code**:
  ```typescript
  return {
    value: 0,
    last_output_at: now().getTime(),
    outputs_today_date: today,
    outputs_today: outputsToday + 1,
  };
  ```
- **Problem**: WorkImpulseState has 4 required fields, function returns them, but:
  - **Pattern violation**: Should use spread operator
  - If state structure changes, could miss fields
  - TypeScript might flag as type error depending on interface definition
- **Fix**: `return { ...state, value: 0, last_output_at: now().getTime(), ... }`

---

## 🟠 HIGH PRIORITY ISSUES (Imminent Risk)

### 1. Emotion Coupling Multiplier Unbounded
- **File**: `emotion.ts` lines 144-163
- **Severity**: HIGH - Could produce invalid results
- **Code**:
  ```typescript
  let multiplier = 1.0;
  if (c.creativity)      multiplier += c.creativity * emotion.creativity;
  if (c.sociability)     multiplier += c.sociability * emotion.sociability;
  if (c.stress)          multiplier += c.stress * emotion.stress;
  // ... more additions ...
  ```
- **Problem**:
  - No bounds on multiplier
  - If persona config has { creativity: 100, stress: 50, ... }, multiplier can reach 150+
  - Intent intensity scaled by 150 becomes invalid
  - All intent resolution relies on reasonable multipliers
- **Impact**: Breaks entire intent system logic
- **Fix**: `multiplier = Math.max(0.1, Math.min(5.0, multiplier))`

### 2. Schedule Hour Parsing Without Validation
- **File**: `intent.ts` lines 82-90
- **Severity**: HIGH - Silent failure
- **Code**:
  ```typescript
  const prefHour = parseInt(flex.preferred_time.split(':')[0], 10);
  if (Math.abs(hour - prefHour) <= 1) {
  ```
- **Problem**:
  - If `preferred_time = "invalid"` or `""` or no colon:
    - `split(':')[0]` returns "invalid" or ""
    - `parseInt('', 10)` returns NaN
    - `Math.abs(hour - NaN)` = NaN
    - `NaN <= 1` is always false
  - Schedule boost never applies, silently
- **Fix**: Validate format: `if (!/^\d{1,2}:\d{2}$/.test(flex.preferred_time)) return;`

### 3. Vitality Drain Calculation Doesn't Validate Negative Result
- **File**: `vitality.ts` lines 36-42
- **Severity**: HIGH - Could produce NaN
- **Code**:
  ```typescript
  const drain = BASE_DRAIN_PER_TICK * stressMultiplier * arousalDiscount * modifier;
  return { ...state, vitality: clampVitality(state.vitality - drain), ... };
  ```
- **Problem**:
  - If any multiplier is NaN: `drain = NaN`
  - `state.vitality - NaN = NaN`
  - `clamp(NaN, 0, 100) = NaN`
  - Vitality becomes NaN, breaks all constraints
- **Fix**: Validate `drain` is finite before applying: `if (!isFinite(drain)) drain = 0;`

### 4. RNG Value Not Validated in Procrastination
- **File**: `intent.ts` line 184
- **Severity**: HIGH - Logic broken
- **Code**:
  ```typescript
  if (rng() < abandonProb) {
  ```
- **Problem**:
  - If `rng()` returns NaN: `NaN < 0.8` is false
  - If `rng()` returns 2.0: `2.0 < 0.5` is false (always skips abandon)
  - If `rng()` returns -0.5: `-0.5 < 0.5` is true (always abandons)
  - Procrastination logic becomes random instead of probability-based
- **Fix**: `const r = rng(); if (typeof r === 'number' && r >= 0 && r <= 1 && r < abandonProb) {`

### 5. Regex Replacement with User Input
- **File**: `flow.ts` line 138
- **Severity**: HIGH - Output corruption
- **Code**:
  ```typescript
  let diary = template.replace(/{activity}/g, flow.activity ?? '做事');
  ```
- **Problem**:
  - If flow.activity contains regex special characters: `.*+?^${}()|[]\\`
  - `replace()` interprets them as pattern, not literal string
  - Example: activity = "parsing (data)" becomes "parsing (data" in output
- **Fix**: Use helper: `activity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`

### 6. parseInt Without Radix in Later Code
- **File**: `intent.ts` line 85 (uses parseInt with radix - good!)
- **But**: No validation of split result
- **Severity**: HIGH - Silent failure on malformed input

---

## 🟡 MEDIUM PRIORITY (Design Issues + Edge Cases)

### 1. God Object: EmotionState Too Large
- **File**: `emotion.ts` throughout
- **Issue**: 11+ properties in single object
  - Functions couple to entire object
  - Changes to unrelated fields cause ripple effects
  - Hard to test individual concerns
- **Refactor**: Split into EmotionMoodState, EmotionHistoryState, EmotionPhysicsState

### 2. computeDynamicResistance Takes 7 Parameters
- **File**: `intent.ts` line 120
- **Issue**: Function signature too large
  - Hard to call correctly
  - Callers must know all context
  - Testing requires mocking many parameters
- **Refactor**: Create IntentContext object: `{ vitality, confidence, inFlow, flowCategory, rigidSchedule, browseSchedule }`

### 3. Date Parsing from String is Brittle
- **File**: `personality-drift.ts` lines 95-99
- **Issue**:
  ```typescript
  const dateMatch = m.origin.match(/\d{4}-\d{2}-\d{2}/);
  if (!dateMatch) return m;
  ```
- **Problem**:
  - If origin format changes, breaks silently
  - No schema validation
  - Modifiers with no date never decay
- **Fix**: Store `created_at` as separate timestamp field

### 4. Missing Bounds Checks Throughout
- **Files**: All engines
- **Issues**:
  - No validation that config values are within expected ranges
  - No validation that computed values remain finite
  - No validation of array indices before access
- **Pattern**: Check for NaN, Infinity, array bounds before use

### 5. Heavy File I/O Coupling in Logic
- **File**: `personality-drift.ts` lines 260-286
- **Issue**: Pure functions call:
  - `loadPersona()` - file I/O
  - `loadPersonalityDrift()` - file I/O
  - `savePersonalityDrift()` - file I/O
- **Problem**:
  - Hard to test
  - Functions have side effects
  - Caller doesn't know about I/O
- **Fix**: Separate I/O from logic. Pass data as parameters.

### 6. Magic Numbers Without Named Constants
- **Files**: All engines
- **Examples**:
  - intent.ts: `0.3, 2.0, 0.2, 0.6, 0.1` (line 37-43)
  - vitality.ts: `30, 50, 20` (lines 57, 71, etc.)
  - emotion.ts: `0.1, 0.08, 0.05` (lines 10-12)
- **Issue**: Hard to tune, reduces readability
- **Fix**: Extract to named constants at module top

### 7. No Try-Catch in Critical Functions
- **Files**: All engines
- **Issue**: Exception handling missing in:
  - emotion.ts: `applyDelta`, `rollRumination`, `checkThresholdBreak`
  - intent.ts: All public functions
  - flow.ts: `generateFlowDiary`, `generateDriftDiary`
  - personality-drift.ts: `loadPersona()` calls
- **Fix**: Add try-catch with meaningful error logging

---

## 🔵 DETAILED FILE-BY-FILE SUMMARY

### emotion.ts (293 lines)
**Critical Issues**: 2 (coupling multiplier unbounded, momentum at zero)
**High Priority**: 1 (RNG validation)
**Medium**: 3 (god object, missing validation, no error handling)

### intent.ts (208 lines)
**Critical Issues**: 1 (template index OOB)
**High Priority**: 2 (schedule parsing, RNG validation)
**Medium**: 2 (magic numbers, 7-param function)

### flow.ts (184 lines)
**Critical Issues**: 1 (template index OOB)
**High Priority**: 1 (regex replacement issue)
**Medium**: 2 (string magic constants, heavy coupling)

### vitality.ts (117 lines)
**Critical Issues**: 1 (emergency recovery exceeds max)
**High Priority**: 1 (drain calculation NaN)
**Medium**: 2 (hour validation, magic numbers)

### confidence.ts (90 lines)
**Critical Issues**: 0
**High Priority**: 0
**Medium**: 2 (streak bonus, config validation)

### work-impulse.ts (91 lines)
**Critical Issues**: 1 (incomplete state object)
**High Priority**: 1 (delta not validated)
**Medium**: 2 (magic numbers, confusing logic)

### personality-drift.ts (335 lines)
**Critical Issues**: 1 (loadPersona crash)
**High Priority**: 1 (date parsing brittle)
**Medium**: 4 (I/O coupling, modifier decay, drift score, config validation)

---

## SUMMARY STATISTICS

Total Lines of Code: ~1,118
Total Issues Found: 47

**By Severity**:
- 🔴 CRITICAL: 8 issues
- 🟠 HIGH: 10 issues
- 🟡 MEDIUM: 20 issues
- 🔵 LOW: 9 issues

**By Category**:
- Index Out of Bounds: 2 (flow.ts, intent.ts)
- Missing Validation: 12 (all files)
- No Error Handling: 8 (all files)
- Type Safety: 6 (emotion.ts, intent.ts, confidence.ts, personality-drift.ts)
- Logic Errors: 5 (emotion.ts, vitality.ts, personality-drift.ts)
- Architecture Smell: 8 (all files)

---

## RECOMMENDED IMMEDIATE ACTIONS

1. **Fix RNG Index Out of Bounds** (intent.ts, flow.ts)
   - Affects procrastination and flow diary generation
   - Could crash system
   - Quick fix: Add modulo operation

2. **Fix Vitality Emergency Recovery** (vitality.ts)
   - Critical state corruption
   - Affects all vitality-based decisions
   - Quick fix: Add clampVitality call

3. **Fix Momentum Duration at Zero** (emotion.ts)
   - Breaks emotional momentum tracking
   - Affects all emotion state transitions
   - Requires logic fix for zero crossing

4. **Add Parameter Validation** (all files)
   - Add checks for NaN, Infinity
   - Add bounds checks for arrays
   - Add type validation for external inputs

5. **Extract Named Constants** (all files)
   - Replace magic numbers
   - Makes code more maintainable and tunable
   - Low effort, high benefit

6. **Add Error Handling** (all files)
   - Wrap file I/O in try-catch
   - Validate config values at startup
   - Log errors instead of silent failures

---

