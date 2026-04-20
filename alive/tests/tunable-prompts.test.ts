import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { setBasePaths, resetBasePaths, readTemplate } from '../scripts/utils/file-utils';
import { buildAlignmentPrompt } from '../scripts/ops/persona-advisor';
import { buildStrategyPrompt, type StrategyPromptInput } from '../scripts/ops/strategy-engine';
import { buildRelevancePrompt } from '../scripts/ops/trend-analyzer';
import { buildContentPrompt, buildRegeneratePrompt } from '../scripts/ops/topic-generator';
import type { FilteredTrend, TrendItem } from '../scripts/ops/trend-analyzer';

let tmpDir: string;
let memoryDir: string;
let skillDir: string;

function writeTunablePrompt(relativePath: string, content: string): void {
  const fullPath = path.join(skillDir, 'tunable', 'prompts', relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function makeTrend(overrides: Partial<TrendItem> = {}): TrendItem {
  return {
    platform: 'xhs',
    keyword: '春季穿搭',
    current_volume: 100,
    avg_7d: 50,
    velocity_score: 2.3,
    rank: 1,
    priority_score: 9.2,
    hook_angle: '反差感穿搭',
    source_bucket: '搜索',
    ...overrides,
  } as TrendItem;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-tunable-prompts-'));
  memoryDir = path.join(tmpDir, 'memory');
  skillDir = path.join(tmpDir, 'skill');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  setBasePaths(memoryDir, skillDir);
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('tunable lifecycle templates', () => {
  it('prefers lifecycle prompt override from tunable directory', () => {
    writeTunablePrompt('lifecycle/morning-plan-prompt.md', 'TUNABLE MORNING {{custom}}');

    const template = readTemplate('morning-plan-prompt.md');

    expect(template).toBe('TUNABLE MORNING {{custom}}');
  });
});

describe('tunable ops prompts', () => {
  it('buildAlignmentPrompt reads persona-advisor prompt from tunable directory', () => {
    writeTunablePrompt(
      'ops/persona-advisor.md',
      'ALIGNMENT\n{{identity_list}}\n{{voice_style}}\n{{trend_list}}\n{{competitor_section}}',
    );

    const prompt = buildAlignmentPrompt(
      [{ key: 'daily', description: '生活日常' }],
      [{ ...makeTrend(), identity_mode: 'daily' } as FilteredTrend],
      '竞品强调真实感',
      '克制但有温度',
    );

    expect(prompt).toContain('ALIGNMENT');
    expect(prompt).toContain('- daily: 生活日常');
    expect(prompt).toContain('克制但有温度');
    expect(prompt).toContain('春季穿搭');
    expect(prompt).toContain('竞品强调真实感');
  });

  it('buildStrategyPrompt reads strategy prompt from tunable directory', () => {
    writeTunablePrompt(
      'ops/strategy-engine.md',
      'STRATEGY\n{{persona_summary}}\n{{tier_distribution}}\n{{current_mix}}\n{{target_mix}}\n{{review_section}}',
    );

    const input: StrategyPromptInput = {
      tierDistribution: { viral: 1, above_avg: 2, normal: 3, below_avg: 1 },
      currentMix: { daily: 60, singer: 40 },
      targetMix: { daily: 50, singer: 50 },
      bestTemplate: '模板A',
      worstTemplate: '模板B',
      topPatterns: [{ type: '反转开头', success_rate: 0.7, times_used: 3 }],
      risingPatterns: ['反转开头'],
      decliningPatterns: [],
      personaAlignmentAvg: 7.8,
      driftAreas: ['过度鸡汤'],
      competitorSummary: '竞品都在抢情绪价值',
      personaSummary: 'V姐：克制、专业、有人味',
      weekOverWeek: 12,
      commentInsights: undefined,
      audiencePerceptionSummary: undefined,
      reviewLearningSummary: '标题别太硬，正文要更像聊天',
      driftScore: 4,
      driftingTraits: [],
    };

    const prompt = buildStrategyPrompt(input);

    expect(prompt).toContain('STRATEGY');
    expect(prompt).toContain('V姐：克制、专业、有人味');
    expect(prompt).toContain('viral: 1');
    expect(prompt).toContain('daily: 60%');
    expect(prompt).toContain('daily: 50%');
    expect(prompt).toContain('标题别太硬');
  });

  it('buildRelevancePrompt reads trend analyzer prompt from tunable directory', () => {
    writeTunablePrompt(
      'ops/trend-analyzer.md',
      'RELEVANCE\n{{trend_list}}\n{{persona_identities}}\n{{velocity_requirement}}\n{{topic_count}}',
    );

    const prompt = buildRelevancePrompt(
      [makeTrend(), makeTrend({ keyword: '电竞耳机', platform: 'douyin', rank: 2, priority_score: 8.5 })],
      '电竞解说 / 生活日常',
      3,
    );

    expect(prompt).toContain('RELEVANCE');
    expect(prompt).toContain('春季穿搭');
    expect(prompt).toContain('电竞耳机');
    expect(prompt).toContain('电竞解说 / 生活日常');
    expect(prompt).toContain('平台正在助推');
    expect(prompt).toContain('3');
  });

  it('buildContentPrompt reads topic content prompt from tunable directory', () => {
    writeTunablePrompt(
      'ops/topic-generator-content.md',
      'CONTENT\n{{persona_block}}\n{{trend_keyword}}\n{{platform_label}}\n{{extra_context}}',
    );

    const prompt = buildContentPrompt(
      { ...makeTrend(), identity_mode: 'daily', hook_angle: '用生活视角切入' } as FilteredTrend,
      'V姐，一个有分寸感的虚拟人',
      'xhs',
      '小红书图文',
      '【补充上下文】保持像聊天',
      { voiceStyle: '克制但松弛', sampleLines: ['别急，先把节奏找回来'], identityMode: 'daily' },
    );

    expect(prompt).toContain('CONTENT');
    expect(prompt).toContain('V姐，一个有分寸感的虚拟人');
    expect(prompt).toContain('春季穿搭');
    expect(prompt).toContain('小红书图文');
    expect(prompt).toContain('【补充上下文】保持像聊天');
  });

  it('buildRegeneratePrompt reads topic regenerate prompt from tunable directory', () => {
    writeTunablePrompt(
      'ops/topic-regenerate.md',
      'REGENERATE\n{{original_content}}\n{{instruction}}\n{{field}}\n{{voice_style}}\n{{platform_style}}\n{{constraint}}\n{{content_patterns}}\n{{json_key}}',
    );

    const prompt = buildRegeneratePrompt(
      '原标题',
      '更抓人一点',
      'xhs.title',
      '冷静专业',
      '小红书图文',
      '反差开头、数字冲击',
    );

    expect(prompt).toContain('REGENERATE');
    expect(prompt).toContain('原标题');
    expect(prompt).toContain('更抓人一点');
    expect(prompt).toContain('xhs.title');
    expect(prompt).toContain('冷静专业');
    expect(prompt).toContain('小红书图文');
    expect(prompt).toContain('11-20字');
    expect(prompt).toContain('反差开头、数字冲击');
    expect(prompt).toContain('title');
  });
});
