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
