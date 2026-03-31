import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setBasePaths, resetBasePaths } from '../../scripts/utils/file-utils';
import { setTimeOverride } from '../../scripts/utils/time-utils';
import {
  buildContentPrompt, selectIdentityMode,
  selectContentTemplate, buildCompetitorBenchmarks,
  buildTemplateConstraint,
} from '../../scripts/ops/topic-generator';
import { FilteredTrend } from '../../scripts/ops/trend-analyzer';
import { ContentTemplate, CompetitorProfile } from '../../scripts/utils/types';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const tmpDir = path.join(os.tmpdir(), 'alive-topic-test-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
  setTimeOverride(new Date('2026-03-30T09:00:00Z'));
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('selectIdentityMode', () => {
  it('returns the identity_mode from filtered trend', () => {
    const trend: FilteredTrend = {
      platform: 'douyin', keyword: '#电竞女孩', current_volume: 500,
      avg_7d: 100, velocity_score: 5.0, rank: 1,
      hook_angle: '从赛车手视角切入', identity_mode: 'racer',
    };
    expect(selectIdentityMode(trend)).toBe('racer');
  });
});

describe('buildContentPrompt', () => {
  it('includes trend keyword and hook angle', () => {
    const trend: FilteredTrend = {
      platform: 'douyin', keyword: '#电竞女孩', current_volume: 500,
      avg_7d: 100, velocity_score: 5.0, rank: 1,
      hook_angle: '用赛车手视角反向解读电竞', identity_mode: 'esports',
    };
    const prompt = buildContentPrompt(trend, 'V姐，21岁电竞解说', 'xhs', '图文为主，克制有力');
    expect(prompt).toContain('#电竞女孩');
    expect(prompt).toContain('用赛车手视角反向解读电竞');
    expect(prompt).toContain('xhs');
  });

  it('appends extraContext when provided', () => {
    const trend: FilteredTrend = {
      platform: 'douyin', keyword: '#赛车', current_volume: 300,
      avg_7d: 100, velocity_score: 3.0, rank: 2,
      hook_angle: '速度与激情', identity_mode: 'racer',
    };
    const prompt = buildContentPrompt(trend, 'V姐', 'douyin', '视频脚本', '参考钩子公式：公式A / 公式B');
    expect(prompt).toContain('参考钩子公式：公式A / 公式B');
  });

  it('returns base prompt only when extraContext is undefined', () => {
    const trend: FilteredTrend = {
      platform: 'xhs', keyword: '#日常', current_volume: 200,
      avg_7d: 100, velocity_score: 2.0, rank: 3,
      hook_angle: '真实日常切入', identity_mode: 'daily',
    };
    const withExtra = buildContentPrompt(trend, 'V姐', 'xhs', '图文', '额外信息');
    const withoutExtra = buildContentPrompt(trend, 'V姐', 'xhs', '图文');
    expect(withExtra).toBe(`${withoutExtra}\n额外信息`);
  });
});

describe('selectContentTemplate', () => {
  const templates: ContentTemplate[] = [
    {
      type: 'MV切片', category: '音乐', priority: 'high',
      identity_mode: 'singer', scene: '多场景叙事MV',
      camera: '慢镜头', styling: '多元造型', highlights: ['强故事感'],
    },
    {
      type: '赛事高光', category: '赛车', priority: 'high',
      identity_mode: 'racer', scene: '专业赛车赛道',
      camera: '冲线瞬间抓拍', styling: '专业赛车服', highlights: ['速度氛围感'],
    },
    {
      type: '服装变装', category: '生活日常', priority: 'high',
      identity_mode: 'daily', scene: '赛道旁、室内换装',
      camera: '变装转场', styling: '赛车服→高定礼服', highlights: ['三重身份反差'],
    },
    {
      type: '日常弹唱', category: '音乐', priority: 'normal',
      identity_mode: 'singer', scene: '居家/私人练习室',
      camera: '弹唱近景', styling: '慵懒私服', highlights: ['即兴创作'],
    },
  ];

  it('returns null for empty templates', () => {
    expect(selectContentTemplate(undefined, 'singer', '音乐')).toBeNull();
    expect(selectContentTemplate([], 'singer', '音乐')).toBeNull();
  });

  it('filters by identity mode and prefers high-priority', () => {
    const result = selectContentTemplate(templates, 'singer', '随便');
    expect(result).not.toBeNull();
    // Should be the high-priority singer template
    expect(result!.type).toBe('MV切片');
  });

  it('returns keyword-matching template when available', () => {
    const result = selectContentTemplate(templates, 'racer', '赛车');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('赛事高光');
  });

  it('returns null when no templates match identity mode', () => {
    const result = selectContentTemplate(templates, 'esports', '随便');
    // No esports-specific templates, but templates without identity_mode should match
    // In this case all have identity_mode set, so fallback to no-mode match
    expect(result).toBeNull();
  });
});

describe('buildCompetitorBenchmarks', () => {
  const profiles: CompetitorProfile[] = [
    {
      name: '天云', platform: 'douyin', tag: '硬核电竞解说', tag_desc: 'KPL解说',
      audience: '理性电竞粉', interaction_style: '耐心解答',
      content_mix: { '赛事解析': 40, '生活日常': 30 },
      reference_type: 'primary', group: '硬核电竞解说',
    },
    {
      name: '谷爱凌', platform: 'xhs', tag: '赛道飒爽女车手', tag_desc: '跨界运动员',
      audience: '14-30岁学生', interaction_style: '夸竞技实力',
      content_mix: { '运动': 40, '时尚': 20 },
      reference_type: 'primary', group: '赛道飒爽女车手',
    },
    {
      name: 'Yuri', platform: 'douyin', tag: 'AI虚拟偶像', tag_desc: '超现实AI歌手',
      reference_type: 'secondary', group: 'AI虚拟偶像',
    },
  ];

  it('returns benchmarks for matching identity mode', () => {
    const benchmarks = buildCompetitorBenchmarks(profiles, 'esports');
    expect(benchmarks).toHaveLength(1);
    expect(benchmarks[0].name).toBe('天云');
    expect(benchmarks[0].content_mix_relevant).toContain('赛事解析40%');
  });

  it('excludes secondary competitors', () => {
    // Even though no group matches, secondary should never appear
    const benchmarks = buildCompetitorBenchmarks(profiles, 'singer');
    expect(benchmarks.every(b => b.name !== 'Yuri')).toBe(true);
  });

  it('returns empty for no profiles', () => {
    expect(buildCompetitorBenchmarks(undefined, 'daily')).toEqual([]);
    expect(buildCompetitorBenchmarks([], 'daily')).toEqual([]);
  });
});

describe('buildTemplateConstraint', () => {
  it('includes all template fields', () => {
    const template: ContentTemplate = {
      type: 'MV切片', category: '音乐', priority: 'high',
      scene: '多场景叙事MV', camera: '慢镜头氛围感特写',
      styling: '多元造型切换', highlights: ['强故事感', '人设多面性'],
      reference_links: ['https://example.com/ref1'],
    };
    const constraint = buildTemplateConstraint(template);
    expect(constraint).toContain('MV切片');
    expect(constraint).toContain('多场景叙事MV');
    expect(constraint).toContain('慢镜头氛围感特写');
    expect(constraint).toContain('多元造型切换');
    expect(constraint).toContain('强故事感、人设多面性');
    expect(constraint).toContain('https://example.com/ref1');
  });

  it('omits reference section when no links', () => {
    const template: ContentTemplate = {
      type: 'test', category: 'test', priority: 'normal',
      scene: 'scene', camera: 'camera', styling: 'styling',
      highlights: ['h1'],
    };
    const constraint = buildTemplateConstraint(template);
    expect(constraint).not.toContain('参考案例');
  });
});
