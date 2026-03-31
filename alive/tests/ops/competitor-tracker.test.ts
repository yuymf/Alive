import { describe, it, expect } from 'vitest';
import {
  buildCompetitorSummary, buildCompetitorContext, resolveCompetitorAccounts,
} from '../../scripts/ops/competitor-tracker';
import { CompetitorUpdate, CompetitorProfile, OpsConfig } from '../../scripts/utils/types';

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

describe('buildCompetitorContext', () => {
  const profiles: CompetitorProfile[] = [
    {
      name: '天云',
      platform: 'douyin',
      tag: '硬核电竞解说',
      tag_desc: 'KPL官方双语解说',
      audience: '理性电竞粉',
      interaction_style: '耐心解答粉丝',
      content_mix: { '赛事解析': 40, '生活日常': 30, '个人感悟': 30 },
      reference_type: 'primary',
      group: '硬核电竞解说',
      takeaways: ['专业解说功底', '双语能力'],
    },
    {
      name: 'Yuri尤栗',
      platform: 'douyin',
      tag: 'AI虚拟偶像',
      tag_desc: '超现实AI歌手',
      followers: '3.7w',
      reference_type: 'secondary',
      group: 'AI虚拟偶像',
      avoid: ['人设同质化', '流量依赖单条技术奇观'],
    },
  ];

  it('groups competitors and includes content mix', () => {
    const ctx = buildCompetitorContext(profiles, []);
    expect(ctx).toContain('【硬核电竞解说】');
    expect(ctx).toContain('【AI虚拟偶像】');
    expect(ctx).toContain('赛事解析40%');
    expect(ctx).toContain('粉丝3.7w');
  });

  it('includes takeaways from primary competitors', () => {
    const ctx = buildCompetitorContext(profiles, []);
    expect(ctx).toContain('【借鉴要点】');
    expect(ctx).toContain('天云：专业解说功底');
  });

  it('includes avoid points', () => {
    const ctx = buildCompetitorContext(profiles, []);
    expect(ctx).toContain('【避坑提醒】');
    expect(ctx).toContain('人设同质化');
  });

  it('merges live tracking data when available', () => {
    const updates: CompetitorUpdate[] = [{
      account: '天云',
      platform: 'douyin',
      latest_post: { time: '2026-03-30T08:00:00Z', content_type: '视频', topic: '赛事回顾', engagement: 5000, summary: '' },
      days_since_last_post: 0,
      fetched_at: '2026-03-30T09:00:00Z',
    }];
    const ctx = buildCompetitorContext(profiles, updates);
    expect(ctx).toContain('最新：「赛事回顾」互动5000');
  });

  it('returns empty string for empty profiles', () => {
    expect(buildCompetitorContext([], [])).toBe('');
  });
});

describe('resolveCompetitorAccounts', () => {
  it('merges legacy accounts with new competitor profiles', () => {
    const ops: OpsConfig = {
      enabled: true,
      brief_time: '08:30',
      competitor_accounts: { xhs: ['老账号'], douyin: [] },
      competitors: [
        { name: '新账号', platform: 'xhs', tag: 't', tag_desc: 'd', reference_type: 'primary' },
        { name: '抖音号', platform: 'douyin', tag: 't', tag_desc: 'd', reference_type: 'primary' },
      ],
      trend_score_threshold: 1.8,
      topic_count: 3,
      topic_filter_prompt: '',
      platforms: {},
    };
    const result = resolveCompetitorAccounts(ops);
    expect(result.xhs).toContain('老账号');
    expect(result.xhs).toContain('新账号');
    expect(result.douyin).toContain('抖音号');
  });

  it('deduplicates accounts', () => {
    const ops: OpsConfig = {
      enabled: true,
      brief_time: '08:30',
      competitor_accounts: { xhs: ['same'], douyin: [] },
      competitors: [
        { name: 'same', platform: 'xhs', tag: 't', tag_desc: 'd', reference_type: 'primary' },
      ],
      trend_score_threshold: 1.8,
      topic_count: 3,
      topic_filter_prompt: '',
      platforms: {},
    };
    const result = resolveCompetitorAccounts(ops);
    expect(result.xhs).toEqual(['same']);
  });

  it('works without competitors field', () => {
    const ops: OpsConfig = {
      enabled: true,
      brief_time: '08:30',
      competitor_accounts: { xhs: ['a'], douyin: ['b'] },
      trend_score_threshold: 1.8,
      topic_count: 3,
      topic_filter_prompt: '',
      platforms: {},
    };
    const result = resolveCompetitorAccounts(ops);
    expect(result.xhs).toEqual(['a']);
    expect(result.douyin).toEqual(['b']);
  });
});
