import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PATHS, resetBasePaths, setBasePaths, writeJSON } from '../../scripts/utils/file-utils';
import { clearTimeOverride, setTimeOverride } from '../../scripts/utils/time-utils';
import type { CompetitorLog } from '../../scripts/utils/types';

// After the async-decoupling refactor:
//   - readCachedCompetitors()  is the sole consumer entry point (pure read)
//   - refreshCompetitors()     is the sole producer (cron only, writes the log)
//   - The in-process TTL cache and the posts-store-derivation fallback
//     were deleted because they only existed to minimise latency under
//     the old synchronous /brief path.
//
// This test therefore validates the new contract only:
//   1. readCachedCompetitors reads entries for today's local date from
//      competitor-log.json.
//   2. Stale entries from previous days are filtered out.
//   3. Missing log file produces an empty array (no fallback fetch).

const { readCachedCompetitors, readCachedCompetitorsWithMeta, resetCompetitorTrackerCache } =
  await import('../../scripts/ops/competitor-tracker');

let sandboxDir = '';

describe('readCachedCompetitors', () => {
  beforeEach(() => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-competitor-cache-'));
    setBasePaths(sandboxDir, sandboxDir);
    resetCompetitorTrackerCache();
  });

  afterEach(() => {
    clearTimeOverride();
    resetCompetitorTrackerCache();
    resetBasePaths();
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  });

  it('returns an empty array when the competitor log file does not exist', () => {
    setTimeOverride(new Date('2026-04-21T12:00:00.000Z'));

    expect(readCachedCompetitors()).toEqual([]);
    expect(readCachedCompetitorsWithMeta().computed_at).toBeNull();
  });

  it('returns today-only entries and surfaces the oldest fetched_at as computed_at', () => {
    // Freeze local time to 2026-04-21 (local).
    setTimeOverride(new Date(2026, 3, 21, 12, 0, 0));

    const log: CompetitorLog = {
      entries: [
        // Yesterday — must be filtered out
        {
          account: 'stale',
          platform: 'douyin',
          latest_post: { time: '2026-04-20T09:00:00Z', content_type: '视频', topic: '昨天', engagement: 1, summary: '' },
          recent_posts: [],
          days_since_last_post: 1,
          fetched_at: new Date(2026, 3, 20, 9, 0, 0).toISOString(),
        },
        // Today — oldest
        {
          account: 'fresh_early',
          platform: 'douyin',
          latest_post: { time: '2026-04-21T08:30:00Z', content_type: '视频', topic: '今天早', engagement: 10, summary: '' },
          recent_posts: [],
          days_since_last_post: 0,
          fetched_at: new Date(2026, 3, 21, 8, 30, 0).toISOString(),
        },
        // Today — latest
        {
          account: 'fresh_late',
          platform: 'xhs',
          latest_post: { time: '2026-04-21T11:45:00Z', content_type: '图文', topic: '今天晚', engagement: 20, summary: '' },
          recent_posts: [],
          days_since_last_post: 0,
          fetched_at: new Date(2026, 3, 21, 11, 45, 0).toISOString(),
        },
      ],
      last_updated: new Date(2026, 3, 21, 11, 45, 0).toISOString(),
    };
    writeJSON(PATHS.competitorLog, log);

    const updates = readCachedCompetitors();
    expect(updates.map(u => u.account).sort()).toEqual(['fresh_early', 'fresh_late']);

    const meta = readCachedCompetitorsWithMeta();
    // computed_at should equal the OLDEST fetched_at among today's entries.
    expect(meta.computed_at).toBe(new Date(2026, 3, 21, 8, 30, 0).toISOString());
  });
});
