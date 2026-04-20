import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PATHS, resetBasePaths, setBasePaths, writeJSON } from '../scripts/utils/file-utils';
import { clearTimeOverride, setTimeOverride } from '../scripts/utils/time-utils';
import { getOpsTrendsCacheStatus } from '../scripts/lifecycle/ops-trends-cache';
import { TREND_SCORING_VERSION } from '../scripts/ops/trend-analyzer';

let sandboxDir = '';

describe('getOpsTrendsCacheStatus', () => {
  beforeEach(() => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-ops-trends-cache-'));
    setBasePaths(sandboxDir, sandboxDir);
    setTimeOverride(new Date('2026-04-21T12:00:00.000Z'));
  });

  afterEach(() => {
    clearTimeOverride();
    resetBasePaths();
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  });

  it('treats empty trend results older than 30 minutes as stale even within 4 hours', () => {
    writeJSON(PATHS.trendsCache, {
      computed_at: '2026-04-21T11:29:00.000Z',
      persona_identities: '电竞解说',
      scoring_version: TREND_SCORING_VERSION,
      results: [],
    });

    writeJSON(PATHS.competitorLog, {
      entries: [
        {
          account: 'test',
          platform: 'douyin',
          latest_post: null,
          recent_posts: [],
          days_since_last_post: 0,
          fetched_at: '2026-04-21T11:50:00.000Z',
        },
      ],
      last_updated: '2026-04-21T11:50:00.000Z',
    });

    const status = getOpsTrendsCacheStatus('电竞解说');

    expect(status.trendsAgeMin).toBe(31);
    expect(status.trendsFromCache).toBe(false);
    expect(status.competitorsFromCache).toBe(true);
  });
});
