# Implementation Roadmap: Engine Code Fixes

**Project**: Alive Engine Systems Remediation  
**Status**: Analysis Complete → Ready for Implementation  
**Date Created**: 2026-04-30  
**Target Completion**: 2026-05-07  

---

## Executive Summary

Comprehensive analysis of 6 engine modules (982 lines of TypeScript) has identified:
- **5 CRITICAL bugs** that can cause crashes or state corruption
- **8 HIGH priority issues** requiring fixes within this sprint
- **16 MEDIUM priority issues** to address in next sprint
- **18 LOW priority issues** for technical debt cleanup

All issues have been documented with:
- ✅ Exact file paths and line numbers
- ✅ Reproduction cases and test scenarios
- ✅ Complete before/after code examples
- ✅ Time estimates per fix
- ✅ Validation test cases

---

## Analysis Artifacts

| Document | Purpose | Status |
|----------|---------|--------|
| `ENGINE_ANALYSIS_CRITICAL.md` | Critical findings (5 blocking issues) | ✅ Complete |
| `ENGINE_ANALYSIS_DETAILED.md` | Full 47-issue breakdown | ✅ Complete |
| `QUICK_FIXES.md` | 8 actionable fixes with code examples | ✅ Complete |
| `REMEDIATION_PLAN.md` | Phased fix strategy (Phases 1-3) | ✅ Complete |

---

## Implementation Schedule

### Phase 1: CRITICAL (System-Blocking) - Do First
**Estimated Time: 30 minutes**  
**Risk Level: HIGHEST - Do not deploy without these fixes**

| Issue | File | Lines | Time | Blocking |
|-------|------|-------|------|----------|
| P1.1: Array Index OOB | `intent.ts` | 200 | 5m | Yes - crash |
| P1.2: Array Index OOB | `flow.ts` | 137, 141 | 5m | Yes - crash |
| P1.3: Vitality Overflow | `vitality.ts` | 56-63 | 5m | Yes - logic |
| P1.4: Zero-Crossing Bug | `emotion.ts` | 211-213 | 10m | Yes - state |
| P1.5: Incomplete Object | `work-impulse.ts` | 63-73 | 5m | Yes - type |

**Total Time**: 30 minutes  
**Testing Time**: 15 minutes  
**Pre-Deploy Checklist**: All 5 must pass validation tests

### Phase 2: HIGH PRIORITY (Imminent Risk) - This Sprint
**Estimated Time: 20 minutes**  
**Risk Level: HIGH - Deploy after Phase 1**

| Issue | File | Lines | Time |
|-------|------|-------|------|
| P2.1: Delta Validation | `emotion.ts` | 107-112 | 5m |
| P2.2: ID Generation | `intent.ts` | 14-16 | 3m |
| P2.3: Zero Division | `emotion.ts` | 98-100 | 3m |
| P2.4: Config Validation | `emotion.ts` | module | 3m |
| P2.5: Boundary Clarity | `vitality.ts` | 87-92 | 1m |

**Total Time**: 15 minutes  
**Testing Time**: 10 minutes

### Phase 3: MEDIUM PRIORITY (Quality) - Next Sprint
**Estimated Time: 2-3 hours**  
**Risk Level: MEDIUM - Schedule for next sprint**

- Rationalize coupling between emotion/intent systems
- Consolidate state mutation patterns (spread operators)
- Add comprehensive null checks
- Improve error handling and logging
- Add missing edge case handling

---

## Validation Plan

### Unit Tests to Run

```bash
npm test -- emotion.test.ts
npm test -- intent.test.ts
npm test -- vitality.test.ts
npm test -- work-impulse.test.ts
npm test -- flow.test.ts
npm test -- confidence.test.ts
```

### Critical Test Cases

#### Phase 1 Validation

**P1.1 - Procrastination Template Index**
```typescript
it('should not crash when rng returns 1.0', () => {
  const result = processProcrastination(pool, new Set(), () => 1.0);
  expect(result.diaryEntries.length).toBeGreaterThan(0);
});
```

**P1.2 - Flow Template Index**
```typescript
it('should not crash with edge case RNG values', () => {
  const rng = vi.fn()
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(0.5)
    .mockReturnValueOnce(0.9999)
    .mockReturnValueOnce(1.0);
  const flow = processFlow(state, rng);
  expect(flow).toBeDefined();
});
```

**P1.3 - Vitality Emergency Recovery**
```typescript
it('emergency recovery should never exceed VITALITY_MAX', () => {
  const state = { vitality: 90, consecutive_low_days: 10 };
  const recovered = morningRecovery(state);
  expect(recovered.vitality).toBeLessThanOrEqual(100);
});
```

**P1.4 - Zero Crossing**
```typescript
it('momentum duration should reset on zero crossing', () => {
  let state = makeState({ momentum: { valence: -0.1, duration_ticks: 5 } });
  state = applyImpulse(state, { valence: 0.1 }); // Cross through 0
  expect(state.momentum.duration_ticks).toBe(0);
});
```

**P1.5 - State Preservation**
```typescript
it('reset impulse should preserve all state fields', () => {
  const state = { ...DEFAULT_IMPULSE, custom_field: 'test' };
  const reset = resetImpulseAfterOutput(state);
  expect(reset).toHaveProperty('custom_field');
});
```

---

## Deployment Steps

### Pre-Deployment
1. ✅ Create feature branch: `fix/engine-critical-issues`
2. ✅ Run full test suite (ensure >80% pass before)
3. ✅ Implement Phase 1 fixes
4. ✅ Run Phase 1 validation tests
5. ✅ Get code review approval

### Deployment
1. Merge to `develop` branch
2. Run integration tests
3. Deploy to staging
4. Monitor for errors in logs
5. Merge to `main` after 24h validation

### Post-Deployment
1. Monitor error logs for exceptions
2. Check vitality/intent state distributions
3. Verify no performance regression
4. Schedule Phase 2 for next sprint

---

## Risk Assessment

| Phase | Risk Level | Mitigation | Rollback Plan |
|-------|-----------|-----------|--------------|
| Phase 1 | **CRITICAL** | Thorough unit tests, code review | Revert commit, redeploy previous |
| Phase 2 | **HIGH** | Integration tests, staging validation | Revert commit, monitor for 12h |
| Phase 3 | **MEDIUM** | Refactoring tests, no logic changes | Revert commit |

---

## Success Criteria

✅ **Phase 1 Complete When**:
- All 5 critical issues fixed
- All validation tests passing
- No new warnings in TypeScript compilation
- Code review approved

✅ **Phase 2 Complete When**:
- All 8 high-priority issues fixed
- High-priority tests passing
- No performance regression detected
- Logic consistency verified

✅ **Phase 3 Complete When**:
- All 16 medium-priority issues addressed
- 90%+ test coverage on engines
- Coupling reduced measurably
- Architecture review approved

---

## Team Responsibilities

| Role | Task | Duration |
|------|------|----------|
| **Developer** | Implement Phase 1 fixes | 30m |
| **Developer** | Add validation tests | 20m |
| **Reviewer** | Code review Phase 1 | 15m |
| **QA** | Integration testing | 1h |
| **DevOps** | Staging deployment | 15m |

---

## Knowledge Base

### Key Files
- `/Users/halyu/Documents/Code/Alive/alive/scripts/engines/emotion.ts` (293 lines)
- `/Users/halyu/Documents/Code/Alive/alive/scripts/engines/intent.ts` (207 lines)
- `/Users/halyu/Documents/Code/Alive/alive/scripts/engines/flow.ts` (184 lines)
- `/Users/halyu/Documents/Code/Alive/alive/scripts/engines/vitality.ts` (117 lines)
- `/Users/halyu/Documents/Code/Alive/alive/scripts/engines/confidence.ts` (90 lines)
- `/Users/halyu/Documents/Code/Alive/alive/scripts/engines/work-impulse.ts` (91 lines)

### Reference Documents
- Analysis: `/Users/halyu/Documents/Code/Alive/ENGINE_ANALYSIS_CRITICAL.md`
- Implementation Guide: `/Users/halyu/Documents/Code/Alive/QUICK_FIXES.md`
- Detailed Plan: `/Users/halyu/Documents/Code/Alive/REMEDIATION_PLAN.md`

---

## Next Steps

1. ✅ Review QUICK_FIXES.md for 4 fastest wins (11 minutes total)
2. ✅ Review REMEDIATION_PLAN.md for complete Phase 1-3 strategy
3. ⏳ Create git branch: `git checkout -b fix/engine-critical-issues`
4. ⏳ Implement fixes in order: intention.ts → flow.ts → vitality.ts → emotion.ts → work-impulse.ts
5. ⏳ Run tests after each file: `npm test -- <file>.test.ts`
6. ⏳ Create pull request with fixes and test results

---

**Generated By**: Comprehensive Engine Analysis  
**Last Updated**: 2026-04-30  
**Review Schedule**: Weekly during fix implementation  
