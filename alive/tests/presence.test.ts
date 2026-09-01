import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PATHS, resetBasePaths, setBasePaths } from '../scripts/utils/file-utils';
import {
  EMPTY_PRESENCE,
  formatPresenceBlock,
  persistTickPresence,
  readPresence,
  scheduleFromToday,
  writePresence,
} from '../scripts/host/presence';
import type { ScheduleToday } from '../scripts/utils/types';

describe('presence', () => {
  let tmp = '';

  afterEach(() => {
    resetBasePaths();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  function boot() {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-presence-'));
    setBasePaths(tmp, tmp);
  }

  it('starts empty and formats a placeholder', () => {
    boot();
    expect(readPresence()).toEqual(EMPTY_PRESENCE);
    expect(formatPresenceBlock()).toContain('还没开始过自己的一天');
  });

  it('writePresence persists activity and schedule', () => {
    boot();
    writePresence({
      activity: '在改本子',
      inner: '包袱还差点',
      schedule: [{ time: '14:00', activity: '喝茶' }],
    });
    const next = readPresence();
    expect(next.activity).toBe('在改本子');
    expect(next.inner).toBe('包袱还差点');
    expect(fs.existsSync(PATHS.presence)).toBe(true);
    const block = formatPresenceBlock();
    expect(block).toContain('正在做: 在改本子');
    expect(block).toContain('14:00 喝茶');
  });

  it('scheduleFromToday flattens rigid and flexible items', () => {
    const today: ScheduleToday = {
      date: '2026-08-31',
      rigid: [{
        type: 'rigid',
        activity: '演出',
        start: '20:00',
        end: '22:00',
        weekdays: [1],
        allowed_actions: [],
      }],
      flexible: [{
        type: 'flexible',
        activity: '喝茶',
        preferred_time: '15:00',
        intent_boost: 2,
        intent_category: 'rest',
      }],
      generated_by: 'test',
    };
    expect(scheduleFromToday(today)).toEqual([
      { time: '20:00-22:00', activity: '演出' },
      { time: '15:00', activity: '喝茶' },
    ]);
  });

  it('persistTickPresence writes heartbeat activity', () => {
    boot();
    persistTickPresence({
      activity: '在刷小红书找构图',
      inner: '这光不错',
      schedule: {
        date: '2026-08-31',
        rigid: [],
        flexible: [{
          type: 'flexible',
          activity: '拍照',
          preferred_time: '16:00',
          intent_boost: 3,
          intent_category: 'produce',
        }],
        generated_by: 'morning-plan',
      },
    });
    expect(readPresence().activity).toBe('在刷小红书找构图');
    expect(readPresence().schedule[0].activity).toBe('拍照');
  });
});
