// skill/scripts/time-utils.ts
// Consistent local-time utilities.
// All time-based logic uses system local time (no hardcoded timezone).

/**
 * Get today's date as YYYY-MM-DD in local timezone.
 * Unlike toISOString().split('T')[0] which returns UTC date,
 * this returns the local date — correct near midnight.
 */
export function getLocalDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Get current hour (0-23) in local timezone.
 */
export function getLocalHour(now: Date = new Date()): number {
  return now.getHours();
}

/**
 * Get weekday as 1=Mon..7=Sun (ISO convention).
 */
export function getLocalWeekday(now: Date = new Date()): number {
  return now.getDay() === 0 ? 7 : now.getDay();
}

/**
 * Format date+time for display, e.g. "2026/3/12 14:30:00".
 * Uses system locale and local timezone.
 */
export function formatLocalTime(now: Date = new Date()): string {
  return now.toLocaleString('zh-CN');
}

/**
 * Get local time as HH:MM string.
 */
export function getLocalTimeHHMM(now: Date = new Date()): string {
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}
