import { describe, expect, it } from 'vitest';

import type { AdvisorSuggestion, LeaderboardAggregate } from '../../e2e/autoresearch-leaderboard';
import {
  appendMetaLog,
  chooseSuggestion,
  runAutoresearchLoop,
  type AutoresearchLoopDependencies,
  type LoopIterationEvaluation,
} from '../../e2e/autoresearch-loop';

function makeAggregate(score: number): LeaderboardAggregate {
  return {
    averageOpsScore: score,
    bestRun: { fixtureName: 'fixture-a', seed: 0, opsScore: score + 1 },
    worstRun: { fixtureName: 'fixture-b', seed: 0, opsScore: score - 1 },
    issueFrequency: [{ keyword: '标题偏抽象', count: 2 }],
    hypothesisFrequency: [{ keyword: '压缩标题抽象词', count: 2 }],
    fixtureSeedAggregates: [],
  };
}

function makeSuggestion(file: string, change = '加一条规则：标题更口语化'): AdvisorSuggestion {
  return {
    file,
    rationale: '标题偏抽象反复出现',
    change,
    priority: 'high',
  };
}

describe('autoresearch loop orchestration', () => {
  it('chooses the first valid suggestion that maps to a tunable prompt file', () => {
    const picked = chooseSuggestion(
      [
        makeSuggestion('ops/missing.md'),
        makeSuggestion('ops/topic-generator-content.md'),
        makeSuggestion('ops/topic-regenerate.md'),
      ],
      ['ops/topic-generator-content.md', 'ops/topic-regenerate.md'],
      new Set(['ops/topic-regenerate.md']),
    );

    expect(picked?.file).toBe('ops/topic-generator-content.md');
  });

  it('appends dated sections to meta log content', () => {
    const result = appendMetaLog('# Existing', {
      heading: 'Round 3 回退',
      lines: ['- file: `ops/topic-generator-content.md`', '- reason: score dropped'],
      now: new Date('2026-04-21T02:00:00Z'),
    });

    expect(result).toContain('# Existing');
    expect(result).toContain('## 2026-04-21 — Round 3 回退');
    expect(result).toContain('- reason: score dropped');
  });

  it('re-evaluates once when all current suggestions are excluded by recent reverts', async () => {
    const promptState = new Map<string, string>([
      ['ops/topic-generator-content.md', 'v1'],
      ['ops/topic-regenerate.md', 'regen-v1'],
    ]);
    const smokeCalls: string[] = [];
    const evaluationCalls: string[] = [];
    const evaluations: LoopIterationEvaluation[] = [
      {
        aggregate: makeAggregate(80),
        suggestions: [makeSuggestion('ops/topic-generator-content.md')],
        reportPath: '/tmp/baseline.md',
      },
      {
        aggregate: makeAggregate(84),
        suggestions: [makeSuggestion('ops/topic-generator-content.md')],
        reportPath: '/tmp/round-1.md',
      },
      {
        aggregate: makeAggregate(82),
        suggestions: [makeSuggestion('ops/topic-generator-content.md')],
        reportPath: '/tmp/round-2.md',
      },
      {
        aggregate: makeAggregate(84),
        suggestions: [makeSuggestion('ops/topic-regenerate.md', '补一条重写标题的兜底规则')],
        reportPath: '/tmp/refresh.md',
      },
      {
        aggregate: makeAggregate(86),
        suggestions: [makeSuggestion('ops/topic-regenerate.md', '补一条重写标题的兜底规则')],
        reportPath: '/tmp/round-3.md',
      },
    ];

    const deps: AutoresearchLoopDependencies = {
      async evaluateCurrentState() {
        evaluationCalls.push(`call-${evaluationCalls.length + 1}`);
        const next = evaluations.shift();
        if (!next) throw new Error('No more evaluations');
        return next;
      },
      listTunableFiles() {
        return Array.from(promptState.keys());
      },
      readPrompt(file) {
        const content = promptState.get(file);
        if (!content) throw new Error(`Missing prompt: ${file}`);
        return content;
      },
      async applySuggestion(suggestion, currentContent) {
        const updated = `${currentContent}\n${suggestion.change}`;
        promptState.set(suggestion.file, updated);
        return {
          file: suggestion.file,
          before: currentContent,
          after: updated,
          summary: suggestion.change,
        };
      },
      writePrompt(file, content) {
        promptState.set(file, content);
      },
      async runSmokeTest(changedFile) {
        smokeCalls.push(changedFile);
      },
      readMetaLog() {
        return '';
      },
      writeMetaLog() {},
      now() {
        return new Date('2026-04-21T02:00:00Z');
      },
    };

    const result = await runAutoresearchLoop({
      maxRounds: 3,
      failureLimit: 3,
      summaryEvery: 10,
    }, deps);

    expect(result.stopReason).toBe('max_rounds');
    expect(result.bestScore).toBe(86);
    expect(result.rounds).toHaveLength(3);
    expect(result.rounds.map((round) => round.file)).toEqual([
      'ops/topic-generator-content.md',
      'ops/topic-generator-content.md',
      'ops/topic-regenerate.md',
    ]);
    expect(smokeCalls).toEqual([
      'ops/topic-generator-content.md',
      'ops/topic-generator-content.md',
      'ops/topic-regenerate.md',
    ]);
    expect(evaluationCalls).toHaveLength(5);
  });

  it('reverts and continues when applySuggestion throws (e.g. editor LLM returns invalid JSON)', async () => {
    const promptState = new Map<string, string>([
      ['ops/topic-generator-content.md', 'v1'],
      ['ops/topic-regenerate.md', 'regen-v1'],
    ]);
    const metaLogWrites: string[] = [];
    const revertedFiles: string[] = [];
    let applyCallCount = 0;
    const evaluations: LoopIterationEvaluation[] = [
      {
        aggregate: makeAggregate(80),
        suggestions: [makeSuggestion('ops/topic-generator-content.md')],
        reportPath: '/tmp/baseline.md',
      },
      {
        aggregate: makeAggregate(82),
        suggestions: [makeSuggestion('ops/topic-regenerate.md', '补一条规则')],
        reportPath: '/tmp/round-2.md',
      },
      {
        aggregate: makeAggregate(85),
        suggestions: [makeSuggestion('ops/topic-regenerate.md', '补一条规则')],
        reportPath: '/tmp/round-3.md',
      },
      {
        aggregate: makeAggregate(87),
        suggestions: [makeSuggestion('ops/topic-regenerate.md', '补一条规则')],
        reportPath: '/tmp/round-4.md',
      },
    ];

    const deps: AutoresearchLoopDependencies = {
      async evaluateCurrentState() {
        const next = evaluations.shift();
        if (!next) throw new Error('No more evaluations');
        return next;
      },
      listTunableFiles() {
        return Array.from(promptState.keys());
      },
      readPrompt(file) {
        const content = promptState.get(file);
        if (!content) throw new Error(`Missing prompt: ${file}`);
        return content;
      },
      async applySuggestion(suggestion, currentContent) {
        applyCallCount++;
        if (applyCallCount === 1) {
          throw new SyntaxError('Unexpected token, "\\n{{json_schema}}\\n" is not valid JSON');
        }
        const updated = `${currentContent}\n${suggestion.change}`;
        promptState.set(suggestion.file, updated);
        return {
          file: suggestion.file,
          before: currentContent,
          after: updated,
          summary: suggestion.change,
        };
      },
      writePrompt(file, content) {
        promptState.set(file, content);
      },
      async runSmokeTest() {},
      async recordRejectedRound(round) {
        revertedFiles.push(round.file);
      },
      readMetaLog() {
        return metaLogWrites.at(-1) ?? '';
      },
      writeMetaLog(content) {
        metaLogWrites.push(content);
      },
      now() {
        return new Date('2026-04-21T02:00:00Z');
      },
    };

    const result = await runAutoresearchLoop({
      maxRounds: 3,
      failureLimit: 3,
      summaryEvery: 10,
    }, deps);

    expect(result.stopReason).toBe('max_rounds');
    expect(result.rounds).toHaveLength(3);
    expect(result.rounds[0].outcome).toBe('reverted');
    expect(result.rounds[0].file).toBe('ops/topic-generator-content.md');
    expect(result.rounds[0].reason).toContain('{{json_schema}}');
    expect(result.bestScore).toBe(87);
    expect(promptState.get('ops/topic-generator-content.md')).toBe('v1');
    expect(promptState.get('ops/topic-regenerate.md')).toContain('补一条规则');
    expect(revertedFiles).toEqual(['ops/topic-generator-content.md']);
  });

  it('keeps improved edits, reverts regressions, and stops after failure limit', async () => {
    const promptState = new Map<string, string>([
      ['ops/topic-generator-content.md', 'v1'],
      ['ops/topic-regenerate.md', 'regen-v1'],
      ['ops/topic-hook-generator.md', 'hook-v1'],
    ]);
    const metaLogWrites: string[] = [];
    const acceptedFiles: string[] = [];
    const revertedFiles: string[] = [];
    const smokeCalls: string[] = [];
    const evaluations: LoopIterationEvaluation[] = [
      {
        aggregate: makeAggregate(80),
        suggestions: [makeSuggestion('ops/topic-generator-content.md')],
        reportPath: '/tmp/baseline.md',
      },
      {
        aggregate: makeAggregate(84),
        suggestions: [
          makeSuggestion('ops/topic-regenerate.md', '严格按 instruction 字面修改'),
          makeSuggestion('ops/topic-hook-generator.md', '增加钩子多样性'),
        ],
        reportPath: '/tmp/round-1.md',
      },
      {
        aggregate: makeAggregate(79),
        suggestions: [
          makeSuggestion('ops/topic-regenerate.md', '严格按 instruction 字面修改'),
          makeSuggestion('ops/topic-hook-generator.md', '增加钩子多样性'),
        ],
        reportPath: '/tmp/round-2.md',
      },
      {
        aggregate: makeAggregate(78),
        suggestions: [
          makeSuggestion('ops/topic-regenerate.md', '严格按 instruction 字面修改'),
          makeSuggestion('ops/topic-hook-generator.md', '增加钩子多样性'),
        ],
        reportPath: '/tmp/round-3.md',
      },
    ];

    const deps: AutoresearchLoopDependencies = {
      async evaluateCurrentState() {
        const next = evaluations.shift();
        if (!next) throw new Error('No more evaluations');
        return next;
      },
      listTunableFiles() {
        return Array.from(promptState.keys());
      },
      readPrompt(file) {
        const content = promptState.get(file);
        if (!content) throw new Error(`Missing prompt: ${file}`);
        return content;
      },
      async applySuggestion(suggestion, currentContent) {
        const updated = `${currentContent}\n${suggestion.change}`;
        promptState.set(suggestion.file, updated);
        return {
          file: suggestion.file,
          before: currentContent,
          after: updated,
          summary: suggestion.change,
        };
      },
      writePrompt(file, content) {
        promptState.set(file, content);
      },
      async runSmokeTest(changedFile) {
        smokeCalls.push(changedFile);
      },
      async recordAcceptedRound(round) {
        acceptedFiles.push(round.file);
      },
      async recordRejectedRound(round) {
        revertedFiles.push(round.file);
      },
      readMetaLog() {
        return metaLogWrites.at(-1) ?? '';
      },
      writeMetaLog(content) {
        metaLogWrites.push(content);
      },
      now() {
        return new Date('2026-04-21T02:00:00Z');
      },
    };

    const result = await runAutoresearchLoop({
      maxRounds: 5,
      failureLimit: 2,
      summaryEvery: 2,
    }, deps);

    expect(result.baselineScore).toBe(80);
    expect(result.bestScore).toBe(84);
    expect(result.rounds).toHaveLength(3);
    expect(result.rounds[0].outcome).toBe('accepted');
    expect(result.rounds[1].outcome).toBe('reverted');
    expect(result.rounds[2].outcome).toBe('reverted');
    expect(result.stopReason).toBe('failure_limit');
    expect(promptState.get('ops/topic-generator-content.md')).toContain('加一条规则');
    expect(promptState.get('ops/topic-regenerate.md')).toBe('regen-v1');
    expect(promptState.get('ops/topic-hook-generator.md')).toBe('hook-v1');
    expect(smokeCalls).toEqual([
      'ops/topic-generator-content.md',
      'ops/topic-regenerate.md',
      'ops/topic-hook-generator.md',
    ]);
    expect(acceptedFiles).toEqual(['ops/topic-generator-content.md']);
    expect(revertedFiles).toEqual(['ops/topic-regenerate.md', 'ops/topic-hook-generator.md']);
    expect(metaLogWrites.at(-1)).toContain('连续 2 次被回退');
  });
});
