// alive/tests/time-utils.test.ts
// Tests for time utility functions — especially createLocalDate to avoid UTC traps

import { describe, it, expect, afterEach } from 'vitest';
import {
  createLocalDate, createLocalDateFromString,
  getLocalHour, setTimeOverride, clearTimeOverride, now,
  getLocalDate, getLocalTimeHHMM,
} from '../scripts/utils/time-utils';

afterEach(() => {
  clearTimeOverride();
});

describe('createLocalDate', () => {
  it('creates a date at the specified local hour', () => {
    const d = createLocalDate(2026, 3, 24, 7, 0);
    expect(d.getHours()).toBe(7);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2); // 0-indexed
    expect(d.getDate()).toBe(24);
  });

  it('defaults to midnight when hour not specified', () => {
    const d = createLocalDate(2026, 1, 1);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it('handles all time components', () => {
    const d = createLocalDate(2026, 12, 31, 23, 59, 58);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    expect(d.getSeconds()).toBe(58);
  });
});

describe('createLocalDateFromString', () => {
  it('parses date string and hour correctly', () => {
    const d = createLocalDateFromString('2026-03-24', 9);
    expect(d.getHours()).toBe(9);
    expect(d.getDate()).toBe(24);
    expect(d.getMonth()).toBe(2);
  });

  it('defaults to midnight', () => {
    const d = createLocalDateFromString('2026-06-15');
    expect(d.getHours()).toBe(0);
  });
});

describe('setTimeOverride with createLocalDate', () => {
  it('getLocalHour returns the expected local hour', () => {
    setTimeOverride(createLocalDate(2026, 3, 24, 7, 0));
    expect(getLocalHour(now())).toBe(7);
  });

  it('getLocalDate returns correct formatted date', () => {
    setTimeOverride(createLocalDate(2026, 3, 24, 7, 0));
    expect(getLocalDate(now())).toBe('2026-03-24');
  });

  it('getLocalTimeHHMM returns correct time', () => {
    setTimeOverride(createLocalDate(2026, 3, 24, 14, 30));
    expect(getLocalTimeHHMM(now())).toBe('14:30');
  });

  it('avoids the UTC trap that ISO string parsing causes', () => {
    // This is the bug we're fixing: new Date("2026-03-24T07:00:00") is UTC
    // In a timezone like JST (+9), getHours() would return 16, not 7
    // createLocalDate always gives local time
    const localDate = createLocalDate(2026, 3, 24, 7, 0);
    setTimeOverride(localDate);
    expect(getLocalHour(now())).toBe(7); // Always 7, regardless of timezone
  });
});
