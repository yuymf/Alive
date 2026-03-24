import { describe, it, expect } from 'vitest';
import { isActiveHeartbeatHour } from '../scripts/world/heartbeat-gate';
import type { CronSchedule } from '../scripts/utils/types';

describe('heartbeat-gate', () => {
  const schedule: CronSchedule = {
    date: '2026-03-12',
    heartbeats: [
      { time: '09:00', type: 'morning' },
      { time: '10:00', type: 'regular' },
      { time: '14:00', type: 'regular' },
      { time: '20:00', type: 'regular' },
      { time: '23:00', type: 'night' },
    ],
  };

  it('should return matching heartbeat for an active hour', () => {
    expect(isActiveHeartbeatHour(10, schedule)).toEqual({ time: '10:00', type: 'regular' });
  });

  it('should return matching heartbeat for morning hour', () => {
    expect(isActiveHeartbeatHour(9, schedule)).toEqual({ time: '09:00', type: 'morning' });
  });

  it('should return null for an inactive hour', () => {
    expect(isActiveHeartbeatHour(15, schedule)).toBeNull();
  });

  it('should return null for sleep hours with no schedule', () => {
    const empty: CronSchedule = { date: '2026-03-12', heartbeats: [] };
    expect(isActiveHeartbeatHour(3, empty)).toBeNull();
  });

  it('should fall back to default ranges when schedule has no heartbeats', () => {
    const empty: CronSchedule = { date: '2026-03-12', heartbeats: [] };
    expect(isActiveHeartbeatHour(7, empty)).toEqual({ time: '07:00', type: 'morning' });
    expect(isActiveHeartbeatHour(12, empty)).toEqual({ time: '12:00', type: 'regular' });
    expect(isActiveHeartbeatHour(23, empty)).toEqual({ time: '23:00', type: 'night' });
  });
});
