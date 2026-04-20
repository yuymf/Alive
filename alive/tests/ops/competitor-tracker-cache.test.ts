import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PATHS, resetBasePaths, setBasePaths, writeJSON } from '../../scripts/utils/file-utils';
import { clearTimeOverride, setTimeOverride } from '../../scripts/utils/time-utils';
import type { OpsConfig } from '../../scripts/utils/types';

vi.mock('../../sub-skills/platform/douyin-bridge/scripts/douyin-client', () => ({
  listDouyinUserPosts: vi.fn(),
}));

const { listDouyinUserPosts } = await import('../../sub-skills/platform/douyin-bridge/scripts/douyin-client');
const { trackCompetitors, resetCompetitorTrackerCache } = await import('../../scripts/ops/competitor-tracker');

let sandboxDir = '';

const ops: OpsConfig = {
  enabled: true,
  brief_time: '08:30',
  competitor_accounts: { xhs: [], douyin: ['sec_uid_1'] },
  trend_score_threshold: 1.8,
  topic_count: 3,
  topic_filter_prompt: '',
  platforms: {},
};

describe('trackCompetitors cache freshness', () => {
  beforeEach(() => {
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-competitor-cache-'));
    setBasePaths(sandboxDir, sandboxDir);
    resetCompetitorTrackerCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearTimeOverride();
    resetCompetitorTrackerCache();
    resetBasePaths();
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  });

  it('does not keep derived competitor cache fresh past the source TTL in the same process', () => {
    setTimeOverride(new Date('2026-04-21T12:00:00.000Z'));

    writeJSON(PATHS.competitorPosts, {
      version: 1,
      last_fetched: '2026-04-21T09:00:00.000Z',
      accounts: {
        'sec_uid_1:douyin': [
          {
            account_name: 'sec_uid_1',
            platform: 'douyin',
            post_id: 'old-post',
            title: '旧竞品动态',
            engagement: 120,
            fetched_at: '2026-04-21T09:00:00.000Z',
            posted_at: '2026-04-21T08:30:00.000Z',
          },
        ],
      },
    });

    const first = trackCompetitors(ops);
    expect(first[0]?.latest_post?.topic).toBe('旧竞品动态');
    expect(vi.mocked(listDouyinUserPosts)).not.toHaveBeenCalled();

    vi.mocked(listDouyinUserPosts).mockReturnValue({
      success: true,
      videos: [
        {
          aweme_id: 'new-post',
          desc: '新竞品动态',
          digg_count: 999,
          create_time: Math.floor(new Date('2026-04-21T13:20:00.000Z').getTime() / 1000),
        },
      ],
    } as any);

    setTimeOverride(new Date('2026-04-21T13:30:00.000Z'));
    const second = trackCompetitors(ops);

    expect(vi.mocked(listDouyinUserPosts)).toHaveBeenCalledTimes(1);
    expect(second[0]?.latest_post?.topic).toBe('新竞品动态');
  });
});
