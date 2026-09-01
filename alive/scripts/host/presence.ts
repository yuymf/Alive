import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import type { ScheduleToday } from '../utils/types';

export interface Presence {
  updated_at: string;
  activity: string;
  inner: string;
  schedule: Array<{ time: string; activity: string }>;
}

export const EMPTY_PRESENCE: Presence = {
  updated_at: '',
  activity: '',
  inner: '',
  schedule: [],
};

export function readPresence(): Presence {
  return readJSON<Presence>(PATHS.presence, EMPTY_PRESENCE);
}

export function writePresence(partial: Partial<Presence>): Presence {
  const next: Presence = {
    ...readPresence(),
    ...partial,
    updated_at: new Date().toISOString(),
  };
  writeJSON(PATHS.presence, next);
  return next;
}

export function scheduleFromToday(today: ScheduleToday): Array<{ time: string; activity: string }> {
  const items: Array<{ time: string; activity: string }> = [];
  for (const r of today.rigid ?? []) {
    items.push({ time: `${r.start}-${r.end}`, activity: r.activity });
  }
  for (const f of today.flexible ?? []) {
    items.push({ time: f.preferred_time, activity: f.activity });
  }
  return items;
}

export function persistTickPresence(opts: {
  activity: string;
  inner?: string | null;
  schedule?: ScheduleToday | null;
}): Presence {
  const schedule = opts.schedule ? scheduleFromToday(opts.schedule) : readPresence().schedule;
  return writePresence({
    activity: opts.activity,
    inner: opts.inner ?? '',
    schedule,
  });
}

export function formatPresenceBlock(presence = readPresence()): string {
  if (!presence.activity && !presence.schedule.length) {
    return '(还没开始过自己的一天 — 跑一次 alive tick / morning)';
  }
  const lines = [
    presence.activity ? `正在做: ${presence.activity}` : '正在做: 还没定',
    presence.inner ? `心里: ${presence.inner}` : '',
  ].filter(Boolean);
  if (presence.schedule.length) {
    lines.push('今天的安排:');
    for (const item of presence.schedule.slice(0, 8)) {
      lines.push(`- ${item.time} ${item.activity}`);
    }
  }
  return lines.join('\n');
}
