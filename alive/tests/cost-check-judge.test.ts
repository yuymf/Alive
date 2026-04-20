import { describe, expect, it } from 'vitest';
import { computeCostCheck } from '../../e2e/harness/judges/cost-check';

function usage(calls: number, failedCalls = 0): any {
  return {
    calls,
    successfulCalls: calls - failedCalls,
    failedCalls,
    promptChars: calls * 200,
    responseChars: calls * 100,
    elapsedMs: calls * 80,
  };
}

describe('cost-check judge', () => {
  it('100 within 80% of budget', () => {
    const r = computeCostCheck({ usage: usage(4), budget: 10 });
    expect(r.score).toBe(100);
    expect(r.calls).toBe(4);
    expect(r.budget).toBe(10);
    expect(r.budgetRatio).toBeCloseTo(0.4, 3);
  });

  it('90 between 80%-100% of budget', () => {
    const r = computeCostCheck({ usage: usage(9), budget: 10 });
    expect(r.score).toBe(90);
  });

  it('linearly interpolates 90→40 over 1x-2x', () => {
    // ratio 1.5 → 90 - 0.5*50 = 65
    const r = computeCostCheck({ usage: usage(15), budget: 10 });
    expect(r.score).toBe(65);
  });

  it('0 for ≥ 2x budget', () => {
    const r = computeCostCheck({ usage: usage(25), budget: 10 });
    expect(r.score).toBe(0);
  });

  it('penalizes -10 for failed calls', () => {
    const r = computeCostCheck({ usage: usage(5, 2), budget: 10 });
    expect(r.score).toBe(90); // 100 - 10 penalty
    expect(r.notes.some(n => n.includes('失败'))).toBe(true);
  });

  it('treats budget=0 as 1 (guards division)', () => {
    const r = computeCostCheck({ usage: usage(1), budget: 0 });
    expect(r.budget).toBe(1);
    expect(Number.isFinite(r.score)).toBe(true);
  });
});
