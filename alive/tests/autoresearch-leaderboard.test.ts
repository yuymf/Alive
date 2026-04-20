import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createMockLLMClient } from '../scripts/utils/llm-client';
import {
  runAutoresearchLeaderboard,
  buildAutoresearchAdvisorPrompt,
  parseAdvisorSuggestions,
  renderLeaderboardReport,
} from '../../e2e/autoresearch-leaderboard';
import {
  AUTORESEARCH_DEFAULT_FIXTURE,
  AUTORESEARCH_ESPORTS_FIXTURE,
} from '../../e2e/fixtures/autoresearch-fixtures';

const tmpDirs: string[] = [];

function makeGenerationScript(titleV1: string, titleV2: string): string[] {
  return [
    JSON.stringify({
      title: titleV1,
      body: '通勤这种事，用力过猛反而累。\n\n松一点，反而更像现在上班的自己。',
      tags: ['#通勤穿搭', '#松弛感'],
      cover_description: '浅色西装通勤封面',
    }),
    JSON.stringify({ hooks: ['钩子1', '钩子2'] }),
    JSON.stringify({
      opening_hook: '你以为通勤只能将就？',
      script: '真正让人精神，是留一点呼吸感。',
      bgm_suggestion: '轻快电子',
      key_captions: ['别穿太满'],
      total_duration: '20秒',
      pacing: 'medium',
      shots: [],
      cover_description: '抖音封面草图',
    }),
    JSON.stringify({
      action: 'edit',
      field: 'title',
      instruction: '标题更像朋友聊天',
      reason_summary: '标题太硬',
    }),
    titleV2,
    JSON.stringify({ action: 'approve', reason_summary: '可以发' }),
  ];
}

describe('autoresearch leaderboard', () => {
  afterEach(() => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs multiple fixtures, aggregates ops_score and diagnostics', async () => {
    const workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-leaderboard-a-'));
    const workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-leaderboard-b-'));
    tmpDirs.push(workspaceA, workspaceB);

    const llmA = createMockLLMClient([
      ...makeGenerationScript('✨上班前3分钟', '✨通勤别太用力'),
      JSON.stringify({
        generation_quality: 8.5,
        persona_alignment: 8.0,
        naturalness: 8.2,
        instruction_following: 9.0,
        strengths: ['标题修改到位'],
        issues: ['正文开头仍偏抽象', '标题首版过硬'],
        improvement_hypotheses: ['压缩标题抽象词', '首段第一句给出反差感'],
      }),
    ]);

    const llmB = createMockLLMClient([
      ...makeGenerationScript('电竞女孩也能带节奏', '电竞节奏感这件事我是认真的'),
      JSON.stringify({
        generation_quality: 7.0,
        persona_alignment: 6.5,
        naturalness: 7.2,
        instruction_following: 8.0,
        strengths: ['切入身份清晰'],
        issues: ['正文信息密度不够', '标题仍偏抽象'],
        improvement_hypotheses: ['首段增加一个具体场景', '标题避免抽象词'],
      }),
    ]);

    const result = await runAutoresearchLeaderboard({
      runs: [
        {
          fixture: AUTORESEARCH_DEFAULT_FIXTURE,
          workspaceDir: workspaceA,
          generationLlm: llmA,
          judgeLlm: llmA,
        },
        {
          fixture: AUTORESEARCH_ESPORTS_FIXTURE,
          workspaceDir: workspaceB,
          generationLlm: llmB,
          judgeLlm: llmB,
        },
      ],
    });

    expect(result.runs).toHaveLength(2);
    expect(result.runs[0].fixtureName).toBe(AUTORESEARCH_DEFAULT_FIXTURE.name);
    expect(result.runs[1].fixtureName).toBe(AUTORESEARCH_ESPORTS_FIXTURE.name);

    expect(result.aggregate.averageOpsScore).toBeGreaterThan(0);
    expect(result.aggregate.bestRun.fixtureName).toBe(AUTORESEARCH_DEFAULT_FIXTURE.name);
    expect(result.aggregate.worstRun.fixtureName).toBe(AUTORESEARCH_ESPORTS_FIXTURE.name);

    expect(result.aggregate.issueFrequency.length).toBeGreaterThan(0);
    const abstractIssue = result.aggregate.issueFrequency.find(e => e.keyword.includes('抽象'));
    expect(abstractIssue).toBeTruthy();
    expect(abstractIssue!.count).toBeGreaterThanOrEqual(2);
  });

  it('advisor prompt references tunable prompt files and aggregated issues', () => {
    const prompt = buildAutoresearchAdvisorPrompt({
      aggregate: {
        averageOpsScore: 72.5,
        bestRun: { fixtureName: 'a', seed: 0, opsScore: 82 },
        worstRun: { fixtureName: 'b', seed: 0, opsScore: 63 },
        issueFrequency: [
          { keyword: '标题偏抽象', count: 2 },
          { keyword: '正文信息密度不够', count: 1 },
        ],
        hypothesisFrequency: [
          { keyword: '压缩标题抽象词', count: 2 },
          { keyword: '首段第一句给出反差感', count: 1 },
        ],
        fixtureSeedAggregates: [],
      },
      tunableFiles: [
        'ops/persona-advisor.md',
        'ops/strategy-engine.md',
        'ops/trend-analyzer.md',
        'ops/topic-generator-content.md',
        'ops/topic-regenerate.md',
        'ops/topic-hook-generator.md',
      ],
    });

    expect(prompt).toContain('ops/topic-generator-content.md');
    expect(prompt).toContain('ops/topic-regenerate.md');
    expect(prompt).toContain('标题偏抽象');
    expect(prompt).toContain('averageOpsScore');
  });

  it('parses advisor suggestions into structured edits', () => {
    const raw = JSON.stringify({
      suggestions: [
        {
          file: 'ops/topic-generator-content.md',
          rationale: '标题偏抽象反复出现',
          change: '在 prompt 中加入"标题禁止抽象词，必须含具体动作或数字"',
          priority: 'high',
        },
        {
          file: 'ops/topic-regenerate.md',
          rationale: '改写后正文密度不够',
          change: '补充"每句都必须带信息"规则',
          priority: 'medium',
        },
      ],
    });

    const parsed = parseAdvisorSuggestions(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].file).toBe('ops/topic-generator-content.md');
    expect(parsed[0].priority).toBe('high');
    expect(parsed[1].change).toContain('每句都必须带信息');
  });

  it('renders a leaderboard markdown report including ranking, diagnostics and suggestions', () => {
    const report = renderLeaderboardReport({
      runs: [
        {
          fixtureName: 'a',
          seed: 0,
          opsScore: 82,
          finalStatus: 'published',
          publishedUrl: 'https://example.com/a',
          judge: {
            generation_quality: 8.5,
            persona_alignment: 8,
            naturalness: 8.2,
            instruction_following: 9,
            strengths: ['自然'],
            issues: ['标题偏抽象'],
            improvement_hypotheses: ['压缩标题抽象词'],
          },
          editConvergenceScore: 75,
          costCheckScore: 100,
          llmCalls: 5,
        },
        {
          fixtureName: 'b',
          seed: 0,
          opsScore: 63,
          finalStatus: 'published',
          publishedUrl: 'https://example.com/b',
          judge: {
            generation_quality: 7,
            persona_alignment: 6.5,
            naturalness: 7.2,
            instruction_following: 8,
            strengths: ['身份清晰'],
            issues: ['正文信息密度不够', '标题偏抽象'],
            improvement_hypotheses: ['增加具体场景'],
          },
          editConvergenceScore: 60,
          costCheckScore: 90,
          llmCalls: 6,
        },
      ],
      aggregate: {
        averageOpsScore: 72.5,
        bestRun: { fixtureName: 'a', seed: 0, opsScore: 82 },
        worstRun: { fixtureName: 'b', seed: 0, opsScore: 63 },
        issueFrequency: [{ keyword: '标题偏抽象', count: 2 }],
        hypothesisFrequency: [{ keyword: '压缩标题抽象词', count: 1 }],
        fixtureSeedAggregates: [],
      },
      suggestions: [
        {
          file: 'ops/topic-generator-content.md',
          rationale: '标题偏抽象反复出现',
          change: '要求具体动作',
          priority: 'high',
        },
      ],
    });

    expect(report).toContain('# Autoresearch Leaderboard Report');
    expect(report).toContain('averageOpsScore');
    expect(report).toContain('ops/topic-generator-content.md');
    expect(report).toContain('要求具体动作');
    expect(report).toContain('## Ranking');
  });

  it('runs multiple seeds per fixture and aggregates stddev/best/worst seeds', async () => {
    const workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-leaderboard-multiseed-'));
    tmpDirs.push(workspaceA);

    // Three distinct judge scores across 3 seeds → non-zero stddev
    const scripts = [
      makeGenerationScript('v0-a', 'v0-b'),
      makeGenerationScript('v1-a', 'v1-b'),
      makeGenerationScript('v2-a', 'v2-b'),
    ];
    const judgeScores = [
      { gq: 8.0, pa: 8.0, nt: 8.0, ifl: 8.0 },
      { gq: 9.0, pa: 9.0, nt: 9.0, ifl: 9.0 },
      { gq: 7.0, pa: 7.0, nt: 7.0, ifl: 7.0 },
    ];

    // Single LLM that serves all 3 seeds sequentially (each seed = script + 1 judge response)
    const allScripts: string[] = [];
    scripts.forEach((s, i) => {
      allScripts.push(...s);
      allScripts.push(JSON.stringify({
        generation_quality: judgeScores[i].gq,
        persona_alignment: judgeScores[i].pa,
        naturalness: judgeScores[i].nt,
        instruction_following: judgeScores[i].ifl,
        strengths: [],
        issues: [],
        improvement_hypotheses: [],
      }));
    });
    const llm = createMockLLMClient(allScripts);

    const result = await runAutoresearchLeaderboard({
      runs: [
        {
          fixture: AUTORESEARCH_DEFAULT_FIXTURE,
          workspaceDir: workspaceA,
          generationLlm: llm,
          judgeLlm: llm,
        },
      ],
      seedsPerFixture: 3,
    });

    expect(result.runs).toHaveLength(3);
    expect(result.runs.map(r => r.seed).sort()).toEqual([0, 1, 2]);
    expect(result.aggregate.fixtureSeedAggregates).toHaveLength(1);
    const agg = result.aggregate.fixtureSeedAggregates[0];
    expect(agg.seedCount).toBe(3);
    expect(agg.fixtureName).toBe(AUTORESEARCH_DEFAULT_FIXTURE.name);
    expect(agg.stddevOpsScore).toBeGreaterThan(0);
    expect(agg.maxOpsScore).toBeGreaterThanOrEqual(agg.minOpsScore);
    expect(agg.bestSeed).not.toBe(agg.worstSeed);
    // bestRun should point at seed=1 (highest judge scores)
    expect(result.aggregate.bestRun.seed).toBe(1);
    expect(result.aggregate.worstRun.seed).toBe(2);
  });
});
