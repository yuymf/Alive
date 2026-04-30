# Quick Fixes Guide - Engine Issues

## 4 Critical Fixes Before Next Deploy

### 1. Fix Impulse History Aging (emotion.ts:222)

**Current Code:**
```typescript
const agedHistory = state.impulse_history.map(e => ({ ...e, tick_age: e.tick_age + 1 }))
  .slice(-MAX_IMPULSE_HISTORY);
```

**Problem:** tick_age increments BEFORE slicing, causing off-by-one error in rumination probability

**Fixed Code:**
```typescript
const agedHistory = state.impulse_history
  .slice(-MAX_IMPULSE_HISTORY)  // Slice FIRST
  .map(e => ({ ...e, tick_age: e.tick_age + 1 }));  // Then age
```

**Time to Fix:** 2 minutes

---

### 2. Fix Sign Comparison at Zero (emotion.ts:211-213)

**Current Code:**
```typescript
const prevSign = Math.sign(state.momentum.valence);
const newSign = Math.sign(newMomentum.valence);
newMomentum.duration_ticks = prevSign === newSign ? state.momentum.duration_ticks + 1 : 0;
```

**Problem:** Math.sign(0) === 0, so duration_ticks increments incorrectly when crossing zero

**Fixed Code:**
```typescript
const prevSign = Math.sign(state.momentum.valence);
const newSign = Math.sign(newMomentum.valence);
// Only increment if same sign AND not both zero
const sameSignMood = prevSign !== 0 && newSign !== 0 && prevSign === newSign;
newMomentum.duration_ticks = sameSignMood ? state.momentum.duration_ticks + 1 : 0;
```

**Time to Fix:** 3 minutes

---

### 3. Fix Schedule Hour Parsing (intent.ts:85-86)

**Current Code:**
```typescript
const prefHour = parseInt(flex.preferred_time.split(':')[0], 10);
if (Math.abs(hour - prefHour) <= 1) {
  intents = boostOrCreate(intents, flex.intent_category, flex.intent_boost, flex.activity, 'schedule');
}
```

**Problem:** No validation of split, no NaN check, no error logging

**Fixed Code:**
```typescript
try {
  const parts = (flex.preferred_time || '').split(':');
  const prefHour = parseInt(parts[0] || '', 10);
  
  if (isNaN(prefHour)) {
    console.warn(`Invalid schedule time in flexible item: ${flex.preferred_time}`);
    return intents;
  }
  
  // Handle wrap-around at midnight (23:00 to 00:00)
  const hourDiff = Math.abs(hour - prefHour);
  const wrappedDiff = Math.min(hourDiff, 24 - hourDiff);
  
  if (wrappedDiff <= 1) {
    intents = boostOrCreate(intents, flex.intent_category, flex.intent_boost, flex.activity, 'schedule');
  }
} catch (e) {
  console.warn(`Error processing schedule time: ${flex.preferred_time}`, e);
}
return intents;
```

**Time to Fix:** 5 minutes

---

### 4. Fix Work Impulse State Reset (work-impulse.ts:63-72)

**Current Code:**
```typescript
export function resetImpulseAfterOutput(state: WorkImpulseState): WorkImpulseState {
  const today = getLocalDate();
  const outputsToday = state.outputs_today_date === today ? state.outputs_today : 0;

  return {
    value: 0,
    last_output_at: now().getTime(),
    outputs_today_date: today,
    outputs_today: outputsToday + 1,
  };
}
```

**Problem:** Missing spread operator - any additional fields in WorkImpulseState are lost

**Fixed Code:**
```typescript
export function resetImpulseAfterOutput(state: WorkImpulseState): WorkImpulseState {
  const today = getLocalDate();
  const outputsToday = state.outputs_today_date === today ? state.outputs_today : 0;

  return {
    ...state,  // ← ADD THIS
    value: 0,
    last_output_at: now().getTime(),
    outputs_today_date: today,
    outputs_today: outputsToday + 1,
  };
}
```

**Time to Fix:** 1 minute

---

## Total Time to Fix All 4: **~11 minutes**

---

## 4 High Priority Fixes (Do This Sprint)

### 5. Add Delta Validation (emotion.ts:107-112)

Create helper before line 107:
```typescript
function validDelta(v: number | undefined): number {
  if (v === undefined) return 0;
  if (!Number.isFinite(v)) {
    console.warn(`Invalid emotion delta: ${v}, using 0`);
    return 0;
  }
  return v;
}
```

Then replace:
```typescript
// OLD
const rawValence = applyDiminishingReturns(state.mood.valence, delta.valence ?? 0, -1.0, 1.0);

// NEW
const rawValence = applyDiminishingReturns(state.mood.valence, validDelta(delta.valence), -1.0, 1.0);
```

Repeat for all delta fields.

**Time to Fix:** 5 minutes

---

### 6. Fix ID Generation Collision Risk (intent.ts:14-16)

**Current Code:**
```typescript
function generateId(): string {
  return `int_${now().getTime()}_${Math.random().toString(36).slice(2, 6)}`;
}
```

**Better Code:**
```typescript
let idCounter = 0;

function generateId(): string {
  const timestamp = now().getTime();
  const counter = (idCounter++).toString(36).padStart(4, '0');
  const random = Math.random().toString(36).slice(2, 6);
  return `int_${timestamp}_${counter}_${random}`;
}
```

**Time to Fix:** 3 minutes

---

### 7. Fix Zero Division (emotion.ts:98-100)

Add check at line 99:
```typescript
function applyDiminishingReturns(current: number, delta: number, min: number, max: number): number {
  if (delta === 0) return current;
  const halfRange = (max - min) / 2;
  
  // NEW: Prevent division by zero
  if (halfRange === 0) {
    console.warn(`Invalid range: min=${min}, max=${max}`);
    return current;
  }
  
  const headroom = delta > 0 ? max - current : current - min;
  const dampening = Math.max(0.1, Math.min(1.0, headroom / halfRange));
  return clamp(current + delta * dampening, min, max);
}
```

**Time to Fix:** 3 minutes

---

### 8. Validate Config at Boot (emotion.ts)

Add to module init:
```typescript
if (MAX_IMPULSE_HISTORY <= 0) {
  throw new Error('CONFIG ERROR: MAX_IMPULSE_HISTORY must be > 0, got ' + MAX_IMPULSE_HISTORY);
}
if (INTENSITY_CAP <= 0) {
  throw new Error('CONFIG ERROR: INTENSITY_CAP must be > 0, got ' + INTENSITY_CAP);
}
```

**Time to Fix:** 3 minutes

---

## Quick Boundary Fixes

### Vitality Zone Boundary (vitality.ts:87-92)

Replace > with >= for clarity:
```typescript
export function getVitalityZone(vitality: number): VitalityZone {
  if (vitality >= 70) return 'high';
  if (vitality >= 30) return 'normal';
  if (vitality >= 10) return 'low';
  return 'critical';
}
```

**Time to Fix:** 1 minute

---

## Testing Checklist After Fixes

- [ ] Run all engine unit tests
- [ ] Verify impulse history aging in rumination tests
- [ ] Test schedule intent injection at midnight (23:00, 23:30, 00:00, 00:30)
- [ ] Test work impulse reset preserves all state fields
- [ ] Test emotion delta with NaN/Infinity values
- [ ] Verify sign comparison with zero-crossing scenarios
- [ ] Check ID generation uniqueness (1000 IDs in same millisecond)

---

## Files Changed
- `emotion.ts` (4 fixes)
- `intent.ts` (3 fixes)
- `work-impulse.ts` (1 fix)
- `vitality.ts` (1 fix)

**Total Implementation Time: ~30 minutes**
**Total Testing Time: ~20 minutes**

