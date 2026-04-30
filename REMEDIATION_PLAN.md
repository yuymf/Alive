# Engine Code Remediation Plan

**Generated**: 2026-04-30  
**Analysis Source**: ENGINE_ANALYSIS_DETAILED.md, ENGINE_ANALYSIS_CRITICAL.md  
**Total Issues**: 47 across 6 engine files  
**Priority**: CRITICAL (5 blocking issues) → HIGH (8) → MEDIUM (16) → LOW (18)

---

## Phase 1: CRITICAL - System-Blocking Fixes (Do First)

### P1.1: intent.ts - PROCRASTINATION_TEMPLATES Array Index (Line 200)
**Severity**: CRITICAL - Runtime crash  
**Impact**: When `rng()` returns exactly 1.0, causes "templateFn is not a function" error  
**Estimated Effort**: 5 minutes

**Current Code**:
```typescript
const templateFn = PROCRASTINATION_TEMPLATES[Math.floor(rng() * PROCRASTINATION_TEMPLATES.length)];
```

**Fix**:
```typescript
const index = Math.floor(rng() * PROCRASTINATION_TEMPLATES.length) % PROCRASTINATION_TEMPLATES.length;
const templateFn = PROCRASTINATION_TEMPLATES[index];
```

**Testing**: 
- Test with `rng = () => 1.0` (edge case)
- Test with `rng = () => 0.9999999`
- Verify all template variations generate correct diary text

---

### P1.2: flow.ts - FLOW_DIARY_TEMPLATES Array Index (Lines 137, 141)
**Severity**: CRITICAL - Runtime crash  
**Impact**: When `rng()` returns exactly 1.0, crashes during flow diary generation  
**Estimated Effort**: 5 minutes

**Current Code**:
```typescript
const template = templates[Math.floor(rng() * templates.length)];
const detail = FLOW_MICRO_DETAILS[Math.floor(rng() * FLOW_MICRO_DETAILS.length)];
```

**Fix** (both locations):
```typescript
const templateIdx = Math.floor(rng() * templates.length) % templates.length;
const template = templates[templateIdx];
const detailIdx = Math.floor(rng() * FLOW_MICRO_DETAILS.length) % FLOW_MICRO_DETAILS.length;
const detail = FLOW_MICRO_DETAILS[detailIdx];
```

**Testing**: 
- Unit test with mocked RNG at boundary values (0, 0.5, 0.9999999, 1.0)
- Ensure diary text generates without errors

---

### P1.3: vitality.ts - Emergency Vitality Recovery Exceeds Maximum (Lines 56-63)
**Severity**: CRITICAL - State corruption  
**Impact**: Vitality can exceed VITALITY_MAX (100), breaking all downstream vitality logic  
**Estimated Effort**: 5 minutes

**Current Code**:
```typescript
const newVitality = emergency ? Math.max(state.vitality + base, VITALITY_CONFIG.EMERGENCY_MIN_VITALITY) : clampVitality(state.vitality + base);
```

**Problem**: Emergency branch doesn't clamp result. If `state.vitality = 90`, `base = 20`, `emergency_min = 60`:
- Result = `Math.max(110, 60) = 110` (exceeds max!)

**Fix**:
```typescript
const newVitality = emergency 
  ? clampVitality(Math.max(state.vitality, VITALITY_CONFIG.EMERGENCY_MIN_VITALITY) + base)
  : clampVitality(state.vitality + base);
```

**Testing**:
- Test with high starting vitality (80-100) + emergency recovery
- Verify result never exceeds VITALITY_MAX
- Test edge cases: vitality at 0, at max, at emergency threshold

---

### P1.4: emotion.ts - Momentum Duration Zero-Crossing Bug (Lines 211-213)
**Severity**: CRITICAL - Logic error  
**Impact**: Momentum duration tracking breaks when transitioning through zero  
**Estimated Effort**: 10 minutes (requires rethinking zero-crossing logic)

**Current Code**:
```typescript
const prevSign = Math.sign(state.momentum.valence);
const newSign = Math.sign(newMomentum.valence);
newMomentum.duration_ticks = prevSign === newSign ? state.momentum.duration_ticks + 1 : 0;
```

**Problem**: 
- `Math.sign(0) = 0`, `Math.sign(0.0001) = 1`, `Math.sign(-0.0001) = -1`
- When crossing through zero: both signs are 0, so `prevSign === newSign` incorrectly continues incrementing

**Options**:

*Option A* (Strict sign change): Reset on ANY sign flip including through 0
```typescript
const prevSign = state.momentum.valence < 0 ? -1 : state.momentum.valence > 0 ? 1 : 0;
const newSign = newMomentum.valence < 0 ? -1 : newMomentum.valence > 0 ? 1 : 0;
if (prevSign !== 0 && newSign !== 0 && prevSign !== newSign) {
  newMomentum.duration_ticks = 0;
} else if (prevSign === 0 && newSign !== 0) {
  newMomentum.duration_ticks = 0; // Starting from neutral
} else {
  newMomentum.duration_ticks = state.momentum.duration_ticks + 1;
}
```

*Option B* (Hysteresis): Use threshold to avoid zero-crossing oscillation
```typescript
const MOMENTUM_THRESHOLD = 0.05;
const prevSign = Math.abs(state.momentum.valence) < MOMENTUM_THRESHOLD 
  ? 0 
  : state.momentum.valence < 0 ? -1 : 1;
const newSign = Math.abs(newMomentum.valence) < MOMENTUM_THRESHOLD 
  ? 0 
  : newMomentum.valence < 0 ? -1 : 1;
newMomentum.duration_ticks = prevSign === newSign ? state.momentum.duration_ticks + 1 : 0;
```

**Recommendation**: Option B (hysteresis) is cleaner—prevents jitter near zero  
**Testing**:
- Test with momentum values: -0.5, -0.01, 0, 0.01, 0.5
- Verify duration increments correctly within each region
- Verify resets when crossing threshold

---

### P1.5: work-impulse.ts - resetImpulseAfterOutput Incomplete Object (Lines 63-73)
**Severity**: CRITICAL - Type violation (implicit any)  
**Impact**: If WorkImpulseState structure changes, could silently miss fields  
**Estimated Effort**: 5 minutes

**Current Code**:
```typescript
return {
  value: 0,
  last_output_at: now().getTime(),
  outputs_today_date: today,
  outputs_today: outputsToday + 1,
};
```

**Fix** (explicit spread pattern):
```typescript
return {
  ...state,
  value: 0,
  last_output_at: now().getTime(),
  outputs_today_date: today,
  outputs_today: outputsToday + 1,
};
```

**Testing**:
- Add unit test to verify all fields present
- If WorkImpulseState changes in future, TypeScript will catch missing fields

---

## Phase 2: HIGH Priority Fixes (Next Week)

### P2.1: intent.ts - Schedule Time parseInt Validation
**Severity**: HIGH - Silent failures on malformed data  
**File**: intent.ts, line 85  
**Issue**: `parseInt(flex.preferred_time.split(':')[0], 10)` doesn't validate format

### P2.2: intent.ts - RNG Validation Before Probability
**Severity**: HIGH - Logic error if RNG returns invalid values  
**File**: intent.ts, lines 148, 154, 158, 184-185  
**Issue**: No validation that `rng()` returns [0, 1)

### P2.3: flow.ts - Regex Special Character Replacement
**Severity**: HIGH - Injection risk  
**File**: flow.ts, line 143  
**Issue**: User input in regex replacement without escaping

### P2.4: emotion.ts - Unbounded Coupling Multiplier
**Severity**: HIGH - State explosion  
**File**: emotion.ts, line 107  
**Issue**: Coupling multiplier can grow unbounded

### P2.5: personality-drift.ts - Unhandled Exception in detectDrift
**Severity**: HIGH - Silent crashes  
**File**: personality-drift.ts, line 164  
**Issue**: No try/catch if loadPersona() throws

---

## Phase 3: MEDIUM Priority (Code Quality)

- **Intent/Flow/Confidence**: Missing null/undefined checks on loaded state
- **All engines**: No validation of loaded configuration objects
- **Emotion**: Rumination logic missing edge case documentation
- **Vitality**: ACTION_COSTS/REPLENISHMENT lookup could use defensive code

---

## Phase 4: LOW Priority (Optimization/Style)

- Consider extracting array index selection to utility function
- Consider extracting decay/cap patterns to shared utility
- Consider immutability enforcement with Readonly<T> types
- Consider adding JSDoc examples for complex functions

---

## Testing Strategy

### Unit Tests Needed
1. **intent.ts**: Test PROCRASTINATION_TEMPLATES with rng() at [0, 0.5, 0.9999, 1.0]
2. **flow.ts**: Test FLOW_DIARY_TEMPLATES selection with boundary RNG values
3. **vitality.ts**: Test emergency recovery with vitality at [0, 30, 80, 100]
4. **emotion.ts**: Test momentum zero-crossing with valence at [-0.5, -0.01, 0, 0.01, 0.5]
5. **work-impulse.ts**: Test resetImpulseAfterOutput returns complete state

### Integration Tests
- Full heartbeat cycle with low/normal/high vitality states
- Procrastination path → satisfaction → decay cycle
- Flow entry/exit state transitions
- Personality drift decay over days

### Property Tests (Optional)
- RNG functions always return valid array indices
- Vitality never exceeds VITALITY_MAX after any operation
- Confidence always in [CONFIDENCE_MIN, CONFIDENCE_MAX]
- Intent intensity always in [0, INTENSITY_CAP]

---

## Rollout Plan

**Week 1**: Phase 1 (Critical fixes)
- Fixes: PROCRASTINATION_TEMPLATES, FLOW_DIARY_TEMPLATES, Emergency Vitality, Momentum Zero-Crossing, RImpulse Reset
- Testing: Unit tests for each fix
- QA: Manual testing in heartbeat cycle

**Week 2**: Phase 2 (High priority)
- Fixes: Input validation, RNG validation, Regex escaping, Coupling bounds, Error handling
- Testing: Unit + integration tests
- QA: Extended heartbeat simulations

**Ongoing**: Phase 3 + 4 (Code quality, optimization)

---

## Risk Assessment

| Fix | Risk | Mitigation |
|-----|------|-----------|
| PROCRASTINATION_TEMPLATES modulo | Low | Tested with rng() = 1.0 edge case |
| Emergency Vitality clamp | Medium | Must test with high starting vitality |
| Momentum zero-crossing | Medium | Requires domain knowledge of intended behavior |
| RImpulse spread operator | Low | TypeScript already validates |
| Input validation | Low | Defensive only, no behavior change |

---

## Files Modified Summary

- `alive/scripts/engines/intent.ts`: 3 fixes
- `alive/scripts/engines/flow.ts`: 2 fixes  
- `alive/scripts/engines/vitality.ts`: 1 fix
- `alive/scripts/engines/emotion.ts`: 2 fixes
- `alive/scripts/engines/work-impulse.ts`: 1 fix
- `alive/scripts/engines/personality-drift.ts`: 1 fix

**Total changes**: ~200 lines across 6 files
**Estimated total effort**: 12-16 hours (including testing)

