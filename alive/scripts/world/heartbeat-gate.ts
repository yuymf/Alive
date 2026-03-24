// alive/scripts/world/heartbeat-gate.ts
// Heartbeat gate — determines if the current hour is an active heartbeat hour

import type { CronSchedule, CronHeartbeat } from '../utils/types';

/**
 * Check if the given hour is an active heartbeat hour per the cron schedule.
 * Returns the matching heartbeat entry, or null if this hour should be skipped.
 *
 * When schedule has no heartbeats (empty or stale), falls back to defaults:
 * morning=7, regular=8-22, night=23, sleep=0-6.
 */
export function isActiveHeartbeatHour(hour: number, schedule: CronSchedule): CronHeartbeat | null {
  if (schedule.heartbeats.length > 0) {
    return schedule.heartbeats.find(
      h => parseInt(h.time.split(':')[0], 10) === hour,
    ) ?? null;
  }

  // Fallback defaults
  if (hour === 7) return { time: '07:00', type: 'morning' };
  if (hour === 23) return { time: '23:00', type: 'night' };
  if (hour >= 8 && hour <= 22) return { time: `${hour.toString().padStart(2, '0')}:00`, type: 'regular' };
  return null;
}
