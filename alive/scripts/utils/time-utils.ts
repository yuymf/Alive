// alive/scripts/utils/time-utils.ts
// Consistent local-time utilities (unchanged from MizuSan)

let _timeOverride: Date | null = null;

export function setTimeOverride(date: Date): void {
  _timeOverride = date;
}

export function clearTimeOverride(): void {
  _timeOverride = null;
}

export function now(): Date {
  return _timeOverride ? new Date(_timeOverride.getTime()) : new Date();
}

export function wallNow(): Date {
  return new Date();
}

export function getLocalDate(d: Date = now()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getLocalHour(d: Date = now()): number {
  return d.getHours();
}

export function getLocalWeekday(d: Date = now()): number {
  return d.getDay() === 0 ? 7 : d.getDay();
}

export function formatLocalTime(d: Date = now()): string {
  return d.toLocaleString('zh-CN');
}

export function getLocalTimeHHMM(d: Date = now()): string {
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${min}`;
}

/**
 * 创建一个代表本地时间的 Date 对象。
 * 使用 new Date(year, month-1, day, hour, min) 避免 ISO 字符串的 UTC 陷阱。
 */
export function createLocalDate(
  year: number, month: number, day: number,
  hour = 0, minute = 0, second = 0
): Date {
  return new Date(year, month - 1, day, hour, minute, second);
}

/**
 * 从 "YYYY-MM-DD" 和 hour 创建本地时间（用于 E2E 和测试）。
 */
export function createLocalDateFromString(dateStr: string, hour = 0): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, hour, 0, 0);
}
