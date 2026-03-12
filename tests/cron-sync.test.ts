import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as child_process from 'child_process';
import { findCronJobByName, editCronExpression, buildCronExpression, syncCronSchedule } from '../skill/scripts/cron-sync';
import type { CronSchedule } from '../skill/scripts/types';

vi.mock('child_process');
const mockedCp = vi.mocked(child_process);

beforeEach(() => { vi.clearAllMocks(); });

describe('cron-sync', () => {
  describe('findCronJobByName', () => {
    it('should return job object when name matches', () => {
      const jobs = [
        { id: 'abc123', name: 'minase:tick', cron: '0 8-22 * * *', enabled: true },
        { id: 'def456', name: 'minase:morning', cron: '0 7 * * *', enabled: true },
      ];
      mockedCp.execFileSync.mockReturnValue(JSON.stringify(jobs));
      const result = findCronJobByName('minase:tick');
      expect(result).toEqual({ id: 'abc123', name: 'minase:tick', cron: '0 8-22 * * *', enabled: true });
    });

    it('should return null when no job matches', () => {
      mockedCp.execFileSync.mockReturnValue('[]');
      const result = findCronJobByName('nonexistent');
      expect(result).toBeNull();
    });

    it('should return null when openclaw command fails', () => {
      mockedCp.execFileSync.mockImplementation(() => { throw new Error('gateway down'); });
      const result = findCronJobByName('minase:tick');
      expect(result).toBeNull();
    });
  });

  describe('editCronExpression', () => {
    it('should call openclaw cron edit with correct args', () => {
      mockedCp.execFileSync.mockReturnValue('');
      const result = editCronExpression('abc123', '0 10,12,14,17,20 * * *');
      expect(result).toBe(true);
      expect(mockedCp.execFileSync).toHaveBeenCalledWith(
        'openclaw',
        ['cron', 'edit', 'abc123', '--cron', '0 10,12,14,17,20 * * *', '--exact'],
        expect.objectContaining({ timeout: 10_000 }),
      );
    });

    it('should return false when edit command fails', () => {
      mockedCp.execFileSync.mockImplementation(() => { throw new Error('gateway down'); });
      const result = editCronExpression('abc123', '0 10-20 * * *');
      expect(result).toBe(false);
    });
  });

  describe('buildCronExpression', () => {
    it('should build comma-separated hour expression from heartbeats', () => {
      const schedule: CronSchedule = {
        date: '2026-03-12',
        heartbeats: [
          { time: '09:00', type: 'morning' },
          { time: '10:00', type: 'regular' },
          { time: '12:00', type: 'regular' },
          { time: '14:00', type: 'regular' },
          { time: '17:00', type: 'regular' },
          { time: '20:00', type: 'regular' },
          { time: '23:00', type: 'night' },
        ],
      };
      const result = buildCronExpression(schedule);
      expect(result).toEqual({
        morning: '0 9 * * *',
        tick: '0 10,12,14,17,20 * * *',
        night: '0 23 * * *',
      });
    });

    it('should return null for tick when no regular heartbeats exist', () => {
      const schedule: CronSchedule = {
        date: '2026-03-12',
        heartbeats: [
          { time: '07:00', type: 'morning' },
          { time: '23:00', type: 'night' },
        ],
      };
      const result = buildCronExpression(schedule);
      expect(result.tick).toBeNull();
      expect(result.morning).toBe('0 7 * * *');
      expect(result.night).toBe('0 23 * * *');
    });

    it('should use default expressions when schedule has no heartbeats', () => {
      const schedule: CronSchedule = { date: '2026-03-12', heartbeats: [] };
      const result = buildCronExpression(schedule);
      expect(result).toEqual({
        morning: '0 7 * * *',
        tick: '0 8-22 * * *',
        night: '0 23 * * *',
      });
    });
  });

  describe('syncCronSchedule', () => {
    it('should find each job by name and edit its cron expression', () => {
      const schedule: CronSchedule = {
        date: '2026-03-12',
        heartbeats: [
          { time: '09:00', type: 'morning' },
          { time: '10:00', type: 'regular' },
          { time: '14:00', type: 'regular' },
          { time: '22:00', type: 'night' },
        ],
      };
      mockedCp.execFileSync
        .mockImplementation((cmd, args) => {
          const argsArr = args as string[];
          if (argsArr[1] === 'list') {
            return JSON.stringify([
              { id: 'id-m', name: 'minase:morning', cron: '0 7 * * *', enabled: true },
              { id: 'id-t', name: 'minase:tick', cron: '0 8-22 * * *', enabled: true },
              { id: 'id-n', name: 'minase:night', cron: '0 23 * * *', enabled: true },
            ]);
          }
          return '';
        });
      const result = syncCronSchedule(schedule);
      expect(result.synced).toBe(true);
      expect(result.details.morning).toBe('synced');
      expect(result.details.tick).toBe('synced');
      expect(result.details.night).toBe('synced');
    });

    it('should report skipped when Gateway is offline', () => {
      mockedCp.execFileSync.mockImplementation(() => { throw new Error('gateway down'); });
      const schedule: CronSchedule = {
        date: '2026-03-12',
        heartbeats: [
          { time: '07:00', type: 'morning' },
          { time: '08:00', type: 'regular' },
          { time: '23:00', type: 'night' },
        ],
      };
      const result = syncCronSchedule(schedule);
      expect(result.synced).toBe(false);
      expect(result.details.morning).toBe('job_not_found');
      expect(result.details.tick).toBe('job_not_found');
      expect(result.details.night).toBe('job_not_found');
    });

    it('should skip edit when expressions already match', () => {
      mockedCp.execFileSync
        .mockImplementation((cmd, args) => {
          const argsArr = args as string[];
          if (argsArr[1] === 'list') {
            return JSON.stringify([
              { id: 'id-m', name: 'minase:morning', cron: '0 7 * * *', enabled: true },
              { id: 'id-t', name: 'minase:tick', cron: '0 8 * * *', enabled: true },
              { id: 'id-n', name: 'minase:night', cron: '0 23 * * *', enabled: true },
            ]);
          }
          return '';
        });
      const schedule: CronSchedule = {
        date: '2026-03-12',
        heartbeats: [
          { time: '07:00', type: 'morning' },
          { time: '08:00', type: 'regular' },
          { time: '23:00', type: 'night' },
        ],
      };
      const result = syncCronSchedule(schedule);
      expect(result.synced).toBe(true);
      const editCalls = mockedCp.execFileSync.mock.calls.filter(
        c => (c[1] as string[])[1] === 'edit'
      );
      expect(editCalls).toHaveLength(0);
    });

    it('should list jobs only once (not per job)', () => {
      mockedCp.execFileSync
        .mockImplementation((cmd, args) => {
          const argsArr = args as string[];
          if (argsArr[1] === 'list') {
            return JSON.stringify([
              { id: 'id-m', name: 'minase:morning', cron: '0 7 * * *', enabled: true },
              { id: 'id-t', name: 'minase:tick', cron: '0 8-22 * * *', enabled: true },
              { id: 'id-n', name: 'minase:night', cron: '0 23 * * *', enabled: true },
            ]);
          }
          return '';
        });
      const schedule: CronSchedule = {
        date: '2026-03-12',
        heartbeats: [
          { time: '09:00', type: 'morning' },
          { time: '10:00', type: 'regular' },
          { time: '22:00', type: 'night' },
        ],
      };
      syncCronSchedule(schedule);
      const listCalls = mockedCp.execFileSync.mock.calls.filter(
        c => (c[1] as string[])[1] === 'list'
      );
      expect(listCalls).toHaveLength(1);
    });
  });
});
