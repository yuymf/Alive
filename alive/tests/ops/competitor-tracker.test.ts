import { describe, it, expect } from 'vitest';
import { buildCompetitorSummary } from '../../scripts/ops/competitor-tracker';
import { CompetitorUpdate } from '../../scripts/utils/types';

describe('buildCompetitorSummary', () => {
  it('returns summary string for active accounts', () => {
    const updates: CompetitorUpdate[] = [
      {
        account: '@赛车手小V',
        platform: 'xhs',
        latest_post: {
          time: '2026-03-30T08:00:00Z',
          content_type: '图文',
          topic: '备战日常',
          engagement: 3200,
          summary: '分享备赛训练',
        },
        days_since_last_post: 0,
        fetched_at: '2026-03-30T09:00:00Z',
      },
    ];
    const summary = buildCompetitorSummary(updates);
    expect(summary).toContain('@赛车手小V');
    expect(summary).toContain('3200');
  });

  it('handles empty updates without throwing and returns no-data message', () => {
    expect(() => buildCompetitorSummary([])).not.toThrow();
    expect(buildCompetitorSummary([])).toBe('无竞品数据');
  });

  it('notes accounts with no recent posts', () => {
    const updates: CompetitorUpdate[] = [
      {
        account: '@inactive',
        platform: 'douyin',
        latest_post: null,
        days_since_last_post: 5,
        fetched_at: '2026-03-30T09:00:00Z',
      },
    ];
    const summary = buildCompetitorSummary(updates);
    expect(summary).toContain('5天未更新');
  });
});
