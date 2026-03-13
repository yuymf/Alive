import { describe, it, expect, afterEach } from 'vitest';
import { now, setTimeOverride, clearTimeOverride, getLocalHour, getLocalDate } from '../skill/scripts/time-utils';

describe('time-utils override', () => {
  afterEach(() => clearTimeOverride());

  it('now() returns current time when no override set', () => {
    const before = Date.now();
    const result = now();
    const after = Date.now();
    expect(result.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.getTime()).toBeLessThanOrEqual(after);
  });

  it('now() returns overridden time when set', () => {
    const fixed = new Date('2026-06-15T10:30:00+08:00');
    setTimeOverride(fixed);
    const result = now();
    expect(result.getTime()).toBe(fixed.getTime());
  });

  it('now() returns a copy, not a reference to override', () => {
    const fixed = new Date('2026-06-15T10:30:00+08:00');
    setTimeOverride(fixed);
    const a = now();
    const b = now();
    expect(a).not.toBe(b);
    expect(a.getTime()).toBe(b.getTime());
  });

  it('getLocalHour uses now() as default', () => {
    setTimeOverride(new Date('2026-06-15T14:00:00+08:00'));
    expect(getLocalHour()).toBe(14);
  });

  it('getLocalDate uses now() as default', () => {
    setTimeOverride(new Date('2026-06-15T14:00:00+08:00'));
    expect(getLocalDate()).toBe('2026-06-15');
  });

  it('clearTimeOverride restores real time', () => {
    setTimeOverride(new Date('2000-01-01T00:00:00Z'));
    clearTimeOverride();
    const result = now();
    expect(result.getFullYear()).toBeGreaterThan(2024);
  });
});
