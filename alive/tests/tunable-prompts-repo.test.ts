import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { readTunablePrompt } from '../scripts/utils/file-utils';
import { buildAlignmentPrompt } from '../scripts/ops/persona-advisor';
import { buildRelevancePrompt, type TrendItem } from '../scripts/ops/trend-analyzer';
import { buildRegeneratePrompt } from '../scripts/ops/topic-generator';

/**
 * These tests verify the repo-level `harness/tunable/prompts/ops/*.md` files
 * are resolvable via the tunable-prompt loader, so that autoresearch agents
 * can rely on them as the default starting point when no skill-install exists.
 */
describe('harness/tunable/prompts/ops/*.md — repo-level tunable resolution', () => {
  const expectedFiles = [
    'ops/persona-advisor.md',
    'ops/strategy-engine.md',
    'ops/trend-analyzer.md',
    'ops/topic-generator-content.md',
    'ops/topic-regenerate.md',
    'ops/topic-hook-generator.md',
  ];

  it('每个声明的 tunable prompt 文件都存在于 repo 里', () => {
    // __dirname 是 alive/tests/，向上两层到达 repo 根
    const repoRoot = path.resolve(__dirname, '..', '..');
    for (const rel of expectedFiles) {
      const full = path.join(repoRoot, 'harness', 'tunable', 'prompts', rel);
      expect(fs.existsSync(full), `missing tunable prompt: ${full}`).toBe(true);
    }
  });

  it('readTunablePrompt 能够读取到每个 ops tunable 文件', () => {
    for (const rel of expectedFiles) {
      const content = readTunablePrompt(rel);
      expect(content, `readTunablePrompt should return content for ${rel}`).toBeTruthy();
      expect(content!.length).toBeGreaterThan(20);
    }
  });

  it('buildAlignmentPrompt 命中 repo tunable 分支（而非 inline fallback）', () => {
    const trend = {
      platform: 'xhs',
      keyword: '春季穿搭',
      current_volume: 100,
      avg_7d: 50,
      velocity_score: 2.3,
      rank: 1,
      priority_score: 9.2,
      hook_angle: '反差感穿搭',
      source_bucket: '搜索',
      identity_mode: 'daily',
    } as unknown as TrendItem & { identity_mode: string };

    const prompt = buildAlignmentPrompt(
      [{ key: 'daily', description: '生活日常' }],
      [trend as any],
      '竞品强调真实感',
      '克制但有温度',
    );

    expect(prompt).toContain('人设×热点契合度诊断报告');
    expect(prompt).toContain('- daily: 生活日常');
    expect(prompt).toContain('克制但有温度');
    expect(prompt).toContain('春季穿搭');
    expect(prompt).toContain('竞品强调真实感');
  });

  it('buildRelevancePrompt 命中 repo tunable 分支', () => {
    const trend: TrendItem = {
      platform: 'xhs',
      keyword: '电竞耳机',
      current_volume: 2000,
      avg_7d: 700,
      velocity_score: 2.5,
      rank: 3,
      priority_score: 8.5,
      hook_angle: '从键鼠说起',
      source_bucket: '搜索',
    } as TrendItem;

    const prompt = buildRelevancePrompt([trend], '电竞解说 / 生活日常', 2);

    expect(prompt).toContain('内容运营分析师');
    expect(prompt).toContain('电竞耳机');
    expect(prompt).toContain('电竞解说 / 生活日常');
  });

  it('buildRegeneratePrompt 命中 repo tunable 分支', () => {
    const prompt = buildRegeneratePrompt(
      '✨原标题太硬了',
      '更像朋友聊天，别抽象',
      'xhs.title',
      '冷静松弛',
      '小红书图文',
      '反差开头、数字冲击',
    );

    expect(prompt).toContain('内容编辑助手');
    expect(prompt).toContain('✨原标题太硬了');
    expect(prompt).toContain('更像朋友聊天，别抽象');
    expect(prompt).toContain('xhs.title');
    expect(prompt).toContain('反差开头、数字冲击');
    // json_key injection
    expect(prompt).toContain('"title"');
  });
});
