import { describe, it, expect } from 'vitest';
import {
  buildCompetitorSummary, buildCompetitorContext, resolveCompetitorAccounts, deriveUpdatesFromPosts,
} from '../../scripts/ops/competitor-tracker';
import { CompetitorUpdate, CompetitorProfile, CompetitorPostsStore, OpsConfig } from '../../scripts/utils/types';

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
        recent_posts: [{
          time: '2026-03-30T08:00:00Z',
          content_type: '图文',
          topic: '备战日常',
          engagement: 3200,
          summary: '分享备赛训练',
        }],
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
        recent_posts: [],
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
      recent_posts: [{ time: '2026-03-30T08:00:00Z', content_type: '视频', topic: '赛事回顾', engagement: 5000, summary: '' }],
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
    expect(result.xhsUserIds.size).toBe(0);
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

  it('extracts xhs user_id from url for precise fetch', () => {
    const ops: OpsConfig = {
      enabled: true,
      brief_time: '08:30',
      competitor_accounts: { xhs: [], douyin: [] },
      competitors: [
        {
          name: '碳酸饮料拜拜',
          platform: 'xhs',
          url: 'https://www.xiaohongshu.com/user/profile/5bc9d2fa636c170001715db8',
          tag: '低调轻奢',
          tag_desc: 'd',
          reference_type: 'primary',
        },
        {
          name: '谷爱凌',
          platform: 'xhs',
          url: 'https://www.xiaohongshu.com/user/profile/61a81710000000001000a823',
          tag: '赛道飒爽',
          tag_desc: 'd',
          reference_type: 'primary',
        },
      ],
      trend_score_threshold: 1.8,
      topic_count: 3,
      topic_filter_prompt: '',
      platforms: {},
    };
    const result = resolveCompetitorAccounts(ops);
    // Accounts with url should NOT be in xhs search list
    expect(result.xhs).toEqual([]);
    // They should be in xhsUserIds map
    expect(result.xhsUserIds.size).toBe(2);
    expect(result.xhsUserIds.get('5bc9d2fa636c170001715db8')).toBe('碳酸饮料拜拜');
    expect(result.xhsUserIds.get('61a81710000000001000a823')).toBe('谷爱凌');
  });

  it('uses external_id over url for xhs', () => {
    const ops: OpsConfig = {
      enabled: true,
      brief_time: '08:30',
      competitor_accounts: { xhs: [], douyin: [] },
      competitors: [
        {
          name: '测试账号',
          platform: 'xhs',
          external_id: 'custom_external_id',
          url: 'https://www.xiaohongshu.com/user/profile/5bc9d2fa636c170001715db8',
          tag: 't',
          tag_desc: 'd',
          reference_type: 'primary',
        },
      ],
      trend_score_threshold: 1.8,
      topic_count: 3,
      topic_filter_prompt: '',
      platforms: {},
    };
    const result = resolveCompetitorAccounts(ops);
    expect(result.xhsUserIds.get('custom_external_id')).toBe('测试账号');
    expect(result.xhsUserIds.has('5bc9d2fa636c170001715db8')).toBe(false);
  });

  it('falls back to name search for xhs without url', () => {
    const ops: OpsConfig = {
      enabled: true,
      brief_time: '08:30',
      competitor_accounts: { xhs: [], douyin: [] },
      competitors: [
        { name: 'annie（文徐允）', platform: 'xhs', tag: '低调轻奢', tag_desc: 'd', reference_type: 'primary' },
        { name: '张元英', platform: 'xhs', tag: '低调轻奢', tag_desc: 'd', reference_type: 'primary' },
      ],
      trend_score_threshold: 1.8,
      topic_count: 3,
      topic_filter_prompt: '',
      platforms: {},
    };
    const result = resolveCompetitorAccounts(ops);
    expect(result.xhs).toContain('annie（文徐允）');
    expect(result.xhs).toContain('张元英');
    expect(result.xhsUserIds.size).toBe(0);
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

describe('bilibili platform contract', () => {
  it('buildCompetitorSummary handles bilibili platform entries', () => {
    const updates: CompetitorUpdate[] = [
      {
        account: '林离Olivia',
        platform: 'bilibili',
        latest_post: {
          time: '2026-04-01T10:00:00Z',
          content_type: '视频',
          topic: '都市弹琴片段',
          engagement: 8500,
          summary: '写实弹琴',
        },
        recent_posts: [{
          time: '2026-04-01T10:00:00Z',
          content_type: '视频',
          topic: '都市弹琴片段',
          engagement: 8500,
          summary: '写实弹琴',
        }],
        days_since_last_post: 1,
        fetched_at: '2026-04-02T06:00:00Z',
      },
    ];
    const summary = buildCompetitorSummary(updates);
    expect(summary).toContain('林离Olivia');
    expect(summary).toContain('8500');
  });

  it('buildCompetitorContext includes bilibili competitors from profiles', () => {
    const profiles: CompetitorProfile[] = [
      {
        name: '林离Olivia',
        platform: 'bilibili',
        url: 'https://space.bilibili.com/3546934956526060',
        tag: 'AI虚拟偶像',
        tag_desc: '都市写实风文艺AI数字人',
        followers: '13w',
        reference_type: 'secondary',
        group: 'AI虚拟偶像',
      },
    ];
    const ctx = buildCompetitorContext(profiles, []);
    expect(ctx).toContain('林离Olivia');
    expect(ctx).toContain('bilibili');
    expect(ctx).toContain('粉丝13w');
  });
});

// ─── deriveUpdatesFromPosts tests ────────────────────────────────────────────

describe('deriveUpdatesFromPosts', () => {
  const ops: OpsConfig = {
    enabled: true,
    brief_time: '08:30',
    competitor_accounts: { xhs: [], douyin: [] },
    competitors: [
      { name: '测试XHS', platform: 'xhs', tag: 't', tag_desc: 'd', reference_type: 'primary' },
      { name: '测试抖音', platform: 'douyin', tag: 't', tag_desc: 'd', reference_type: 'primary' },
      { name: '测试B站', platform: 'bilibili', tag: 't', tag_desc: 'd', reference_type: 'secondary' },
    ],
    trend_score_threshold: 1.8,
    topic_count: 3,
    topic_filter_prompt: '',
    platforms: {},
  };

  it('derives CompetitorUpdate[] from CompetitorPostsStore', () => {
    const store: CompetitorPostsStore = {
      version: 1,
      last_fetched: '2026-04-02T10:00:00Z',
      accounts: {
        '测试XHS:xhs': [
          { account_name: '测试XHS', platform: 'xhs', post_id: 'p1', title: '测试帖子', engagement: 100, fetched_at: '2026-04-02T09:00:00Z', posted_at: '2026-04-01T08:00:00Z' },
        ],
        '测试抖音:douyin': [
          { account_name: '测试抖音', platform: 'douyin', post_id: 'p2', title: '抖音帖子', engagement: 200, fetched_at: '2026-04-02T09:00:00Z', posted_at: '2026-04-02T06:00:00Z' },
        ],
      },
    };

    const updates = deriveUpdatesFromPosts(store, ops);

    expect(updates).toHaveLength(2);
    const xhs = updates.find(u => u.platform === 'xhs');
    expect(xhs).toBeDefined();
    expect(xhs!.account).toBe('测试XHS');
    expect(xhs!.latest_post?.topic).toBe('测试帖子');
    expect(xhs!.latest_post?.engagement).toBe(100);

    const douyin = updates.find(u => u.platform === 'douyin');
    expect(douyin).toBeDefined();
    expect(douyin!.account).toBe('测试抖音');
  });

  it('returns empty array when store has no accounts', () => {
    const store: CompetitorPostsStore = {
      version: 1,
      last_fetched: '',
      accounts: {},
    };

    const updates = deriveUpdatesFromPosts(store, ops);
    expect(updates).toHaveLength(0);
  });

  it('skips accounts with empty posts array', () => {
    const store: CompetitorPostsStore = {
      version: 1,
      last_fetched: '2026-04-02T10:00:00Z',
      accounts: {
        '空账号:xhs': [],
      },
    };

    const updates = deriveUpdatesFromPosts(store, ops);
    expect(updates).toHaveLength(0);
  });

  it('handles bilibili platform posts', () => {
    const store: CompetitorPostsStore = {
      version: 1,
      last_fetched: '2026-04-02T10:00:00Z',
      accounts: {
        '测试B站:bilibili': [
          { account_name: '测试B站', platform: 'bilibili', post_id: 'bv123', title: 'B站视频', engagement: 5000, fetched_at: '2026-04-02T09:00:00Z', posted_at: '2026-04-01T12:00:00Z' },
        ],
      },
    };

    const updates = deriveUpdatesFromPosts(store, ops);
    expect(updates).toHaveLength(1);
    expect(updates[0].platform).toBe('bilibili');
    expect(updates[0].latest_post?.content_type).toBe('图文'); // bilili maps to 图文 in postToRecentPost (only douyin gets 视频)
  });

  it('sets content_type correctly for douyin (视频) vs xhs (图文)', () => {
    const store: CompetitorPostsStore = {
      version: 1,
      last_fetched: '2026-04-02T10:00:00Z',
      accounts: {
        '测试抖音:douyin': [
          { account_name: '测试抖音', platform: 'douyin', post_id: 'p1', title: '抖音视频', engagement: 300, fetched_at: '2026-04-02T09:00:00Z' },
        ],
        '测试XHS:xhs': [
          { account_name: '测试XHS', platform: 'xhs', post_id: 'p2', title: '小红书图文', engagement: 100, fetched_at: '2026-04-02T09:00:00Z' },
        ],
      },
    };

    const updates = deriveUpdatesFromPosts(store, ops);
    const douyin = updates.find(u => u.platform === 'douyin');
    const xhs = updates.find(u => u.platform === 'xhs');
    expect(douyin!.latest_post?.content_type).toBe('视频');
    expect(xhs!.latest_post?.content_type).toBe('图文');
  });
});
