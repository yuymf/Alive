import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  PATHS,
  resetBasePaths,
  setBasePaths,
  readJSON,
  writeJSON,
} from '../../scripts/utils/file-utils';
import { clearTimeOverride, setTimeOverride } from '../../scripts/utils/time-utils';
import {
  listFreshDirections,
  loadActiveDirections,
  recordActiveDirection,
  type ActiveDirectionsLog,
} from '../../scripts/ops/active-directions';

let sandboxDir = '';

describe('active-directions log', () => {
  beforeEach(() => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-active-directions-'));
    setBasePaths(sandboxDir, sandboxDir);
  });

  afterEach(() => {
    clearTimeOverride();
    resetBasePaths();
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  });

  it('returns an empty log when the file does not exist', () => {
    expect(loadActiveDirections().entries).toEqual([]);
    expect(listFreshDirections()).toEqual([]);
  });

  it('records a new direction with query_count=1 and a timestamp', () => {
    setTimeOverride(new Date('2026-04-21T10:00:00.000Z'));
    recordActiveDirection('美食');

    const log = readJSON<ActiveDirectionsLog>(PATHS.activeDirections, { entries: [] });
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].direction).toBe('美食');
    expect(log.entries[0].query_count).toBe(1);
    expect(log.entries[0].last_queried_at).toBe('2026-04-21T10:00:00.000Z');
  });

  it('increments query_count and refreshes last_queried_at on repeat queries', () => {
    setTimeOverride(new Date('2026-04-21T10:00:00.000Z'));
    recordActiveDirection('美食');

    setTimeOverride(new Date('2026-04-21T12:30:00.000Z'));
    recordActiveDirection('美食');

    const log = loadActiveDirections();
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].query_count).toBe(2);
    expect(log.entries[0].last_queried_at).toBe('2026-04-21T12:30:00.000Z');
  });

  it('trims leading/trailing whitespace but preserves inner casing', () => {
    setTimeOverride(new Date('2026-04-21T10:00:00.000Z'));
    recordActiveDirection('  电竞  ');
    expect(loadActiveDirections().entries[0].direction).toBe('电竞');
  });

  it('ignores empty direction strings', () => {
    setTimeOverride(new Date('2026-04-21T10:00:00.000Z'));
    recordActiveDirection('   ');
    expect(loadActiveDirections().entries).toHaveLength(0);
  });

  it('listFreshDirections drops entries older than 30 days and returns newest first', () => {
    // Seed old entry directly via the file — simulates a historical run
    // outside the TTL window.
    setTimeOverride(new Date('2026-04-21T10:00:00.000Z'));
    recordActiveDirection('电竞');
    recordActiveDirection('美食');

    // Simulate "美食" as a 40-day-old entry.
    const log = loadActiveDirections();
    const staleIdx = log.entries.findIndex(e => e.direction === '美食');
    log.entries[staleIdx].last_queried_at = '2026-03-01T10:00:00.000Z';
    writeJSON(PATHS.activeDirections, log);

    const fresh = listFreshDirections();
    expect(fresh).toEqual(['电竞']);
  });
});
