import { describe, it, expect } from 'vitest';
import { formatBriefCard } from '../../scripts/ops/brief-generator';
import { FilteredTrend } from '../../scripts/ops/trend-analyzer';
import { CompetitorUpdate, QueueItem } from '../../scripts/utils/types';

describe('formatBriefCard', () => {
  it('includes trending keywords', () => {
    const trends: FilteredTrend[] = [
      { platform: 'douyin', keyword: '#电竞女孩', current_volume: 500, avg_7d: 100,
        velocity_score: 5.0, rank: 1, hook_angle: '用赛车手反向切入', identity_mode: 'racer' },
    ];
    const competitors: CompetitorUpdate[] = [];
    const items: QueueItem[] = [];
    const card = formatBriefCard('2026-03-30', trends, competitors, items);
    expect(card).toContain('#电竞女孩');
    expect(card).not.toContain('##');
    expect(card).toContain('5.0x');
  });

  it('shows topic count in operations section', () => {
    const trends: FilteredTrend[] = [];
    const competitors: CompetitorUpdate[] = [];
    const items: QueueItem[] = [
      {
        id: 'q1', status: 'pending', topic: '蹭#电竞', trend_hook: 'hook',
        identity_mode: 'esports', created_at: '', updated_at: '',
        content: { xhs: { title: 'T', body: '', tags: [], cover_images: [] },
                   douyin: { script: '', bgm_suggestion: '', key_captions: [], cover_images: [] } },
        edit_history: [],
      },
    ] as QueueItem[];
    const card = formatBriefCard('2026-03-30', trends, competitors, items);
    expect(card).toContain('AI 今日推荐选题（1个）');
  });

  it('includes competitor summary when data present', () => {
    const trends: FilteredTrend[] = [];
    const competitors: CompetitorUpdate[] = [
      { account: '@testAccount', platform: 'xhs',
        latest_post: { time: '', content_type: '图文', topic: '备战', engagement: 1200, summary: '' },
        days_since_last_post: 0, fetched_at: '' },
    ];
    const card = formatBriefCard('2026-03-30', trends, competitors, []);
    expect(card).toContain('@testAccount');
  });

  it('shows days since last post for inactive competitor', () => {
    const trends: FilteredTrend[] = [];
    const competitors: CompetitorUpdate[] = [
      { account: '@inactive', platform: 'xhs',
        latest_post: null,
        days_since_last_post: 3, fetched_at: '' },
    ];
    const card = formatBriefCard('2026-03-30', trends, competitors, []);
    expect(card).toContain('@inactive');
    expect(card).toContain('3天未更新');
  });

  it('excludes non-pending items from the count', () => {
    const items: QueueItem[] = [
      {
        id: 'q1', status: 'pending', topic: '蹭#电竞', trend_hook: 'hook',
        identity_mode: 'esports', created_at: '', updated_at: '',
        content: { xhs: { title: '', body: '', tags: [], cover_images: [] },
                   douyin: { script: '', bgm_suggestion: '', key_captions: [], cover_images: [] } },
        edit_history: [],
      },
      {
        id: 'q2', status: 'published', topic: 'old post', trend_hook: 'hook',
        identity_mode: 'daily', created_at: '', updated_at: '',
        content: { xhs: { title: '', body: '', tags: [], cover_images: [] },
                   douyin: { script: '', bgm_suggestion: '', key_captions: [], cover_images: [] } },
        edit_history: [],
      },
    ] as QueueItem[];
    const card = formatBriefCard('2026-03-30', [], [], items);
    expect(card).toContain('AI 今日推荐选题（1个）');
  });
});
