import { describe, it, expect } from 'vitest';
import { getLocalDate, getLocalHour, getLocalWeekday, formatLocalTime, getLocalTimeHHMM } from '../skill/scripts/time-utils';

describe('time-utils', () => {
  it('getLocalDate returns YYYY-MM-DD format', () => {
    const result = getLocalDate(new Date(2026, 2, 12)); // March 12, 2026
    expect(result).toBe('2026-03-12');
  });

  it('getLocalDate pads single-digit months and days', () => {
    const result = getLocalDate(new Date(2026, 0, 5)); // Jan 5, 2026
    expect(result).toBe('2026-01-05');
  });

  it('getLocalDate returns local date (not UTC) near midnight', () => {
    // Create a date that is March 12 locally but could be March 11 in UTC
    // depending on timezone offset
    const localDate = new Date(2026, 2, 12, 0, 30, 0); // March 12 00:30 local
    expect(getLocalDate(localDate)).toBe('2026-03-12');
  });

  it('getLocalHour returns hour from Date', () => {
    const d = new Date(2026, 2, 12, 14, 30, 0); // 14:30
    expect(getLocalHour(d)).toBe(14);
  });

  it('getLocalWeekday returns 1-7 (Mon-Sun)', () => {
    // March 12, 2026 is a Thursday
    const thu = new Date(2026, 2, 12);
    expect(getLocalWeekday(thu)).toBe(4);

    // Sunday should return 7 (not 0)
    const sun = new Date(2026, 2, 15);
    expect(getLocalWeekday(sun)).toBe(7);
  });

  it('formatLocalTime returns a non-empty string', () => {
    const result = formatLocalTime(new Date(2026, 2, 12, 14, 30, 0));
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });

  it('getLocalTimeHHMM returns HH:MM format', () => {
    const d = new Date(2026, 2, 12, 9, 5, 0);
    expect(getLocalTimeHHMM(d)).toBe('09:05');
  });

  it('getLocalTimeHHMM pads hours and minutes', () => {
    const d = new Date(2026, 2, 12, 7, 0, 0);
    expect(getLocalTimeHHMM(d)).toBe('07:00');
  });
});
