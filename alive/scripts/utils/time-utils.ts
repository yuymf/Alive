// alive/scripts/utils/time-utils.ts
// Consistent timezone-aware time utilities

let _timeOverride: Date | null = null;
let _timezoneOverride: string | null = null;

export function setTimeOverride(date: Date): void {
  _timeOverride = date;
}

export function clearTimeOverride(): void {
  _timeOverride = null;
}

/**
 * Set the persona timezone for all time operations.
 * When set, getLocalHour/getLocalDate/etc. will return times
 * in this timezone instead of the system timezone.
 */
export function setTimezone(tz: string | null): void {
  _timezoneOverride = tz && tz !== 'system' ? tz : null;
}

export function getTimezone(): string | null {
  return _timezoneOverride;
}

export function now(): Date {
  return _timeOverride ? new Date(_timeOverride.getTime()) : new Date();
}

export function wallNow(): Date {
  return new Date();
}

/**
 * Internal helper: get date parts in the configured timezone.
 * Uses Intl.DateTimeFormat for reliable timezone conversion.
 *
 * When timeOverride is active, the Date is treated as representing
 * the intended local time directly (no timezone conversion), because
 * tests create dates like `new Date(2026, 2, 25, 23, 0)` meaning
 * "23:00 in the persona's timezone".
 */
function getDatePartsInTz(d: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number } {
  if (!_timezoneOverride || _timeOverride) {
    // No timezone override, or time is manually overridden (test mode):
    // use system-local parts directly.
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      second: d.getSeconds(),
      weekday: d.getDay(),
    };
  }

  // Use Intl.DateTimeFormat to get parts in the target timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: _timezoneOverride,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  });

  const parts = formatter.formatToParts(d);
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '0';

  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour: parseInt(get('hour'), 10) % 24, // handle "24" → 0
    minute: parseInt(get('minute'), 10),
    second: parseInt(get('second'), 10),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday').replace(',', '')),
  };
}

export function getLocalDate(d: Date = now()): string {
  const p = getDatePartsInTz(d);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function getLocalHour(d: Date = now()): number {
  return getDatePartsInTz(d).hour;
}

export function getLocalWeekday(d: Date = now()): number {
  const wd = getDatePartsInTz(d).weekday;
  return wd === 0 ? 7 : wd;
}

export function formatLocalTime(d: Date = now()): string {
  if (_timezoneOverride && !_timeOverride) {
    return d.toLocaleString('zh-CN', { timeZone: _timezoneOverride });
  }
  return d.toLocaleString('zh-CN');
}

export function getLocalTimeHHMM(d: Date = now()): string {
  const p = getDatePartsInTz(d);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
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
