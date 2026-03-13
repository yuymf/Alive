// skill/scripts/time-utils.ts
// Consistent local-time utilities.
// All time-based logic uses system local time (no hardcoded timezone).

let _timeOverride: Date | null = null;

/** Override the global clock for testing. */
export function setTimeOverride(date: Date): void {
  _timeOverride = date;
}

/** Clear the time override, restoring real system time. */
export function clearTimeOverride(): void {
  _timeOverride = null;
}

/** Use instead of `new Date()` everywhere. Returns a fresh copy each call. */
export function now(): Date {
  return _timeOverride ? new Date(_timeOverride.getTime()) : new Date();
}

/**
 * Get today's date as YYYY-MM-DD in local timezone.
 * Unlike toISOString().split('T')[0] which returns UTC date,
 * this returns the local date — correct near midnight.
 */
export function getLocalDate(d: Date = now()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Get current hour (0-23) in local timezone.
 */
export function getLocalHour(d: Date = now()): number {
  return d.getHours();
}

/**
 * Get weekday as 1=Mon..7=Sun (ISO convention).
 */
export function getLocalWeekday(d: Date = now()): number {
  return d.getDay() === 0 ? 7 : d.getDay();
}

/**
 * Format date+time for display, e.g. "2026/3/12 14:30:00".
 * Uses system locale and local timezone.
 */
export function formatLocalTime(d: Date = now()): string {
  return d.toLocaleString('zh-CN');
}

/**
 * Get local time as HH:MM string.
 */
export function getLocalTimeHHMM(d: Date = now()): string {
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${min}`;
}
