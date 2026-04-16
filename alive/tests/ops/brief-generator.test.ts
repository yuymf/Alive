import { describe, it, expect } from 'vitest';
import { formatBriefCard } from '../../scripts/ops/brief-generator';
import { FilteredTrend } from '../../scripts/ops/trend-analyzer';
import { CompetitorUpdate, QueueItem } from '../../scripts/utils/types';

// Helper: create a recent timestamp for pending items so they pass the 48h active filter
const recentTimestamp = new Date().toISOString();

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
        identity_mode: 'esports', created_at: recentTimestamp, updated_at: '',
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

  it('shows inactive competitor in collapsed group', () => {
    const trends: FilteredTrend[] = [];
    const competitors: CompetitorUpdate[] = [
      { account: '@inactive', platform: 'xhs',
        latest_post: null,
        days_since_last_post: 3, fetched_at: '' },
    ];
    const card = formatBriefCard('2026-03-30', trends, competitors, []);
    expect(card).toContain('@inactive');
    // New behavior: inactive competitors are collapsed into a summary line
    expect(card).toContain('未更新');
  });

  it('excludes non-pending items from the count', () => {
    const items: QueueItem[] = [
      {
        id: 'q1', status: 'pending', topic: '蹭#电竞', trend_hook: 'hook',
        identity_mode: 'esports', created_at: recentTimestamp, updated_at: '',
        content: { xhs: { title: '', body: '', tags: [], cover_images: [] },
                   douyin: { script: '', bgm_suggestion: '', key_captions: [], cover_images: [] } },
        edit_history: [],
      },
      {
        id: 'q2', status: 'published', topic: 'old post', trend_hook: 'hook',
        identity_mode: 'daily', created_at: recentTimestamp, updated_at: '',
        content: { xhs: { title: '', body: '', tags: [], cover_images: [] },
                   douyin: { script: '', bgm_suggestion: '', key_captions: [], cover_images: [] } },
        edit_history: [],
      },
    ] as QueueItem[];
    const card = formatBriefCard('2026-03-30', [], [], items);
    expect(card).toContain('AI 今日推荐选题（1个）');
  });

  it('filters out expired items (>48h) from enrichment context', () => {
    const oldTimestamp = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(); // 72h ago
    const items: QueueItem[] = [
      {
        id: 'q_stale', status: 'pending', topic: '过期选题', trend_hook: 'old hook',
        identity_mode: 'daily', created_at: oldTimestamp, updated_at: '',
        content: { xhs: { title: '旧标题', body: '', tags: [], cover_images: ['old-prompt'] },
                   douyin: { script: '', bgm_suggestion: '', key_captions: ['旧字幕'], cover_images: [] } },
        edit_history: [],
      },
      {
        id: 'q_fresh', status: 'pending', topic: '新鲜选题', trend_hook: 'fresh hook',
        identity_mode: 'daily', created_at: recentTimestamp, updated_at: '',
        content: { xhs: { title: '新标题', body: '', tags: [], cover_images: ['new-prompt'] },
                   douyin: { script: '', bgm_suggestion: '', key_captions: [], cover_images: [] } },
        edit_history: [],
      },
    ] as QueueItem[];
    const card = formatBriefCard('2026-03-30', [], [], items);
    // Fresh item should appear in enrichment (生图 Prompt)
    expect(card).toContain('new-prompt');
    // Stale item's image prompt should NOT appear
    expect(card).not.toContain('old-prompt');
    // Stale item should be counted in "旧选题" summary
    expect(card).toContain('旧选题已超');
  });

  it('shows review consensus when queue items have review feedback', () => {
    const items: QueueItem[] = [
      {
        id: 'q1', status: 'approved', topic: '蹭#电竞', trend_hook: 'hook',
        identity_mode: 'esports', created_at: recentTimestamp, updated_at: '',
        content: { xhs: { title: '', body: '', tags: [], cover_images: [] },
                   douyin: { script: '', bgm_suggestion: '', key_captions: [], cover_images: [] } },
        edit_history: [],
        review_feedback: [{
          decision: 'approved',
          created_at: recentTimestamp,
          source: 'chat',
          reason_summary: '人设一致，语气到位',
          persona_deviation_tags: [],
          risk_tags: [],
        }],
      },
    ] as QueueItem[];
    const card = formatBriefCard('2026-03-30', [], [], items);
    expect(card).toContain('审核共识');
    expect(card).toContain('人设一致');
  });
});
