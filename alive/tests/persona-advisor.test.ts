import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { setBasePaths, resetBasePaths, PATHS, readJSON } from '../scripts/utils/file-utils';
import { setTimeOverride, clearTimeOverride } from '../scripts/utils/time-utils';
import {
  PersonaAlignmentReport,
  PersonaReportLog,
} from '../scripts/utils/types';

// ─── Sandbox setup ───────────────────────────────────────────────────────────

let sandboxDir: string;

beforeEach(() => {
  sandboxDir = fs.mkdtempSync(path.join('/tmp', 'persona-advisor-test-'));
  setBasePaths(sandboxDir, sandboxDir);
  setTimeOverride(new Date('2026-04-02T10:00:00+09:00'));
});

afterEach(() => {
  resetBasePaths();
  clearTimeOverride();
  fs.rmSync(sandboxDir, { recursive: true, force: true });
});

// ─── Import module ───────────────────────────────────────────────────────────

import {
  extractPersonaIdentities,
  buildAlignmentPrompt,
  formatAlignmentCard,
  formatAlignmentBriefSection,
  generatePersonaReport,
} from '../scripts/ops/persona-advisor';
import { FilteredTrend } from '../scripts/ops/trend-analyzer';

// ─── Test helpers ────────────────────────────────────────────────────────────

const missVPersona = {
  meta: { name: 'Miss V', tagline: 'ENTJ三重身份虚拟博主', id: 'miss-v' },
  personality: { mbti: 'ENTJ', core_traits: ['自信', '直率', '多面性', '高执行力'] },
  voice: { language: 'zh-CN', style: '直接有力、偶尔毒舌', sample_lines: ['V姐来了'] },
  ops: {
    enabled: true,
    brief_time: '09:00',
    competitor_accounts: { xhs: [], douyin: [] },
    trend_score_threshold: 1.5,
    topic_count: 3,
    topic_filter_prompt: 'V姐的三重身份',
    platforms: { xhs: { enabled: true, style: '图文' }, douyin: { enabled: true, style: '短视频' } },
    content_templates: [
      { type: '游戏解说', category: '电竞', priority: 'high' as const, scene: '电竞房', camera: '正面', styling: '潮流', highlights: ['专业解说'], identity_mode: 'esports' },
      { type: '翻唱MV', category: '音乐', priority: 'high' as const, scene: '录音棚', camera: '特写', styling: '优雅', highlights: ['音色'], identity_mode: 'singer' },
      { type: '赛车Vlog', category: '赛车', priority: 'normal' as const, scene: '赛道', camera: '跟拍', styling: '赛车服', highlights: ['速度感'], identity_mode: 'racer' },
      { type: '日常分享', category: '生活', priority: 'normal' as const, scene: '家', camera: '自拍', styling: '休闲', highlights: ['真实感'], identity_mode: 'daily' },
    ],
  },
} as any;

const sampleTrends: FilteredTrend[] = [
  {
    platform: 'douyin',
    keyword: 'LOL世界赛',
    current_volume: 5000000,
    avg_7d: 2000000,
    velocity_score: 2.5,
    rank: 1,
    hook_angle: '电竞解说视角分析',
    identity_mode: 'esports',
  },
  {
    platform: 'weibo',
    keyword: '周杰伦新专辑',
    current_volume: 3000000,
    avg_7d: 1500000,
    velocity_score: 2.0,
    rank: 3,
    hook_angle: '翻唱致敬',
    identity_mode: 'singer',
  },
];

// ─── extractPersonaIdentities ────────────────────────────────────────────────

describe('extractPersonaIdentities', () => {
  it('should extract identities from content_templates identity_modes', () => {
    const identities = extractPersonaIdentities(missVPersona);
    expect(identities.length).toBeGreaterThanOrEqual(4);
    const keys = identities.map(i => i.key);
    expect(keys).toContain('esports');
    expect(keys).toContain('singer');
    expect(keys).toContain('racer');
    expect(keys).toContain('daily');
  });

  it('should extract from identities field if present', () => {
    const persona = {
      ...missVPersona,
      identities: {
        esports: { tagline: '硬核电竞解说' },
        singer: { tagline: '实力翻唱歌手' },
      },
    } as any;
    const identities = extractPersonaIdentities(persona);
    const esportsId = identities.find(i => i.key === 'esports');
    expect(esportsId?.description).toBe('硬核电竞解说');
  });

  it('should fallback to core_traits when no identities', () => {
    const minimalPersona = {
      meta: { name: 'Test', tagline: '测试', id: 'test' },
      personality: { mbti: 'INFP', core_traits: ['温柔', '敏感'] },
      voice: { language: 'zh-CN', style: '', sample_lines: [] },
    } as any;
    const identities = extractPersonaIdentities(minimalPersona);
    expect(identities).toHaveLength(2);
    expect(identities[0].key).toBe('温柔');
  });
});

// ─── buildAlignmentPrompt ────────────────────────────────────────────────────

describe('buildAlignmentPrompt', () => {
  it('should include identities, trends, competitor context, and voice style', () => {
    const identities = [
      { key: 'esports', description: '电竞解说' },
      { key: 'singer', description: '翻唱歌手' },
    ];
    const competitorCtx = '【硬核电竞解说】\n  @竞品A（xhs）';

    const prompt = buildAlignmentPrompt(identities, sampleTrends, competitorCtx, '直接有力');

    expect(prompt).toContain('esports: 电竞解说');
    expect(prompt).toContain('singer: 翻唱歌手');
    expect(prompt).toContain('LOL世界赛');
    expect(prompt).toContain('周杰伦新专辑');
    expect(prompt).toContain('竞品参考');
    expect(prompt).toContain('竞品A');
    expect(prompt).toContain('直接有力');
    expect(prompt).toContain('恰好 3 条选题');
  });

  it('should handle empty trends gracefully', () => {
    const prompt = buildAlignmentPrompt(
      [{ key: 'test', description: 'test' }],
      [],
      '',
      '',
    );
    expect(prompt).toContain('暂无今日热点数据');
  });
});

// ─── formatAlignmentCard ─────────────────────────────────────────────────────

describe('formatAlignmentCard', () => {
  const mockReport: PersonaAlignmentReport = {
    alignment_score: 8,
    identity_analysis: [
      { identity: 'esports', fit_score: 9, reasoning: '今日LOL世界赛热度高' },
      { identity: 'singer', fit_score: 7, reasoning: '周杰伦新专辑可借势' },
    ],
    topic_suggestions: [
      { direction: 'LOL决赛解说', identity_mode: 'esports', hook: '谁能夺冠？', reasoning: '热度最高' },
      { direction: '周杰伦新歌翻唱', identity_mode: 'singer', hook: '翻唱挑战', reasoning: '粉丝基础大' },
      { direction: '电竞x音乐联动', identity_mode: 'daily', hook: '破圈尝试', reasoning: '跨界新鲜感' },
    ],
    warnings: ['注意版权问题'],
    generated_at: '2026-04-02T10:00:00+09:00',
  };

  it('should include all sections', () => {
    const card = formatAlignmentCard(mockReport);
    expect(card).toContain('💡 人设建议');
    expect(card).toContain('8/10');
    expect(card).toContain('身份契合度');
    expect(card).toContain('esports');
    expect(card).toContain('9/10');
    expect(card).toContain('推荐选题');
    expect(card).toContain('LOL决赛解说');
    expect(card).toContain('注意事项');
    expect(card).toContain('版权问题');
  });

  it('should render progress bars', () => {
    const card = formatAlignmentCard(mockReport);
    // 9/10 should have 9 filled + 1 empty
    expect(card).toContain('█████████░');
    // 7/10 should have 7 filled + 3 empty
    expect(card).toContain('███████░░░');
  });
});

// ─── formatAlignmentBriefSection ─────────────────────────────────────────────

describe('formatAlignmentBriefSection', () => {
  it('should produce compact output with best identity and suggestions', () => {
    const report: PersonaAlignmentReport = {
      alignment_score: 7,
      identity_analysis: [
        { identity: 'esports', fit_score: 9, reasoning: '...' },
        { identity: 'singer', fit_score: 6, reasoning: '...' },
      ],
      topic_suggestions: [
        { direction: '方向A', identity_mode: 'esports', hook: '钩子A', reasoning: '' },
        { direction: '方向B', identity_mode: 'singer', hook: '钩子B', reasoning: '' },
        { direction: '方向C', identity_mode: 'daily', hook: '钩子C', reasoning: '' },
      ],
      warnings: [],
      generated_at: '2026-04-02T10:00:00+09:00',
    };

    const section = formatAlignmentBriefSection(report);
    expect(section).toContain('💡人设建议');
    expect(section).toContain('esports');
    expect(section).toContain('9/10');
    expect(section).toContain('方向A');
    expect(section).toContain('方向B');
    expect(section).toContain('方向C');
  });
});

// ─── generatePersonaReport integration ───────────────────────────────────────

describe('generatePersonaReport', () => {
  it('should produce a valid report with mocked LLM', async () => {
    const mockLlm = {
      call: vi.fn(),
      callJSON: vi.fn().mockResolvedValue({
        alignment_score: 8,
        identity_analysis: [
          { identity: 'esports', fit_score: 9, reasoning: '今日LOL热度高' },
          { identity: 'singer', fit_score: 7, reasoning: '周杰伦借势' },
        ],
        topic_suggestions: [
          { direction: '方向1', identity_mode: 'esports', hook: '钩子1', reasoning: '理由1' },
          { direction: '方向2', identity_mode: 'singer', hook: '钩子2', reasoning: '理由2' },
          { direction: '方向3', identity_mode: 'daily', hook: '钩子3', reasoning: '理由3' },
        ],
        warnings: ['注意版权'],
      }),
    };

    const report = await generatePersonaReport(missVPersona, sampleTrends, [], mockLlm);

    expect(report.alignment_score).toBe(8);
    expect(report.identity_analysis).toHaveLength(2);
    expect(report.topic_suggestions).toHaveLength(3);
    expect(report.warnings).toContain('注意版权');
    expect(report.generated_at).toBeTruthy();
  });

  it('should clamp alignment_score to 0-10', async () => {
    const mockLlm = {
      call: vi.fn(),
      callJSON: vi.fn().mockResolvedValue({
        alignment_score: 15,
        identity_analysis: [],
        topic_suggestions: [
          { direction: '1', identity_mode: 'x', hook: 'h', reasoning: 'r' },
        ],
        warnings: [],
      }),
    };

    const report = await generatePersonaReport(missVPersona, sampleTrends, [], mockLlm);
    expect(report.alignment_score).toBe(10);
  });

  it('should pad to exactly 3 suggestions when LLM returns fewer', async () => {
    const mockLlm = {
      call: vi.fn(),
      callJSON: vi.fn().mockResolvedValue({
        alignment_score: 5,
        identity_analysis: [],
        topic_suggestions: [
          { direction: '唯一方向', identity_mode: 'esports', hook: '钩子', reasoning: '理由' },
        ],
        warnings: [],
      }),
    };

    const report = await generatePersonaReport(missVPersona, sampleTrends, [], mockLlm);
    expect(report.topic_suggestions).toHaveLength(3);
    expect(report.topic_suggestions[0].direction).toBe('唯一方向');
    expect(report.topic_suggestions[1].direction).toBe('待补充');
  });

  it('should persist report to log', async () => {
    const mockLlm = {
      call: vi.fn(),
      callJSON: vi.fn().mockResolvedValue({
        alignment_score: 7,
        identity_analysis: [],
        topic_suggestions: [
          { direction: '1', identity_mode: 'a', hook: 'h', reasoning: 'r' },
          { direction: '2', identity_mode: 'b', hook: 'h', reasoning: 'r' },
          { direction: '3', identity_mode: 'c', hook: 'h', reasoning: 'r' },
        ],
        warnings: [],
      }),
    };

    await generatePersonaReport(missVPersona, sampleTrends, [], mockLlm);

    const log = readJSON<PersonaReportLog>(PATHS.personaReportLog, { entries: [] });
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].alignment_score).toBe(7);
  });
});
