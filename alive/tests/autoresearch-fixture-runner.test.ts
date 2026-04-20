import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createMockLLMClient } from '../scripts/utils/llm-client';
import {
  renderAutoresearchReport,
  runAutoresearchFixtureScenario,
} from '../../e2e/autoresearch-fixture-runner';

const tmpDirs: string[] = [];

describe('autoresearch fixture runner', () => {
  afterEach(() => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs frozen generation-review-publish loop and returns a scored report', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-autoresearch-runner-'));
    tmpDirs.push(workspaceDir);

    const generationLlm = createMockLLMClient([
      JSON.stringify({
        title: '✨上班前3分钟，通勤别穿太满',
        body: '我最近通勤最明显的感受，是穿得越用力越容易累。\n\n留一点松弛，反而更像自己。',
        tags: ['#通勤穿搭', '#春季穿搭', '#松弛感'],
        cover_description: '浅色西装通勤封面',
      }),
      JSON.stringify({
        hooks: ['通勤不是将就，是节奏问题', '上班前3分钟，决定你今天的气场'],
      }),
      JSON.stringify({
        opening_hook: '你以为通勤只能将就？',
        script: '真正让人有精神的，不是穿多满，而是留一点呼吸感。',
        bgm_suggestion: '轻快电子',
        key_captions: ['别穿太满', '留点呼吸感'],
        total_duration: '20秒',
        pacing: 'medium',
        shots: [],
        cover_description: '抖音封面草图',
      }),
      JSON.stringify({
        action: 'edit',
        field: 'title',
        instruction: '标题更像朋友聊天，别太像命题作文',
        reason_summary: '标题太硬',
      }),
      '✨通勤别太用力，松一点反而更好看',
      JSON.stringify({
        action: 'approve',
        reason_summary: '语气顺了，可以发',
      }),
    ]);

    const judgeLlm = createMockLLMClient([
      JSON.stringify({
        generation_quality: 8.4,
        persona_alignment: 8.1,
        naturalness: 8.6,
        instruction_following: 9.0,
        strengths: ['标题更自然', '修改后语气更像真人运营会通过的版本'],
        issues: ['正文首段仍可再紧一点'],
        improvement_hypotheses: ['继续压缩标题抽象词', '首段第一句更早给出反差感'],
      }),
    ]);

    const result = await runAutoresearchFixtureScenario({
      workspaceDir,
      generationLlm,
      judgeLlm,
      cleanupWorkspace: false,
    });

    expect(result.reviewTranscript).toHaveLength(3);
    expect(result.generatedItems).toHaveLength(1);
    expect(result.finalItem.status).toBe('published');
    expect(result.finalItem.published_urls?.xhs).toContain('xiaohongshu.com');
    expect(result.finalItem.content.xhs.title).toContain('松一点反而更好看');
    expect(result.score.breakdown.generationCompleted).toBe(1);
    expect(result.score.breakdown.editApplied).toBe(1);
    expect(result.score.breakdown.publishRecorded).toBe(1);
    expect(result.opsScore).toBeGreaterThan(80);

    const report = renderAutoresearchReport(result);
    expect(report).toContain('ops_score');
    expect(report).toContain('published');
    expect(report).toContain('继续压缩标题抽象词');
  });
});
