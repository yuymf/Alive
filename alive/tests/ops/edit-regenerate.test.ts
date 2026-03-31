import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setBasePaths, resetBasePaths } from '../../scripts/utils/file-utils';
import { setTimeOverride } from '../../scripts/utils/time-utils';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { addItem } from '../../scripts/ops/review-queue';
import { regenerateContent, buildRegeneratePrompt } from '../../scripts/ops/topic-generator';
import { createMockLLMClient } from '../../scripts/utils/llm-client';
import { QueueItem } from '../../scripts/utils/types';

const tmpDir = path.join(os.tmpdir(), 'alive-edit-regen-test-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
  setTimeOverride(new Date('2026-03-31T10:00:00Z'));
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildRegeneratePrompt', () => {
  it('includes original content and instruction', () => {
    const prompt = buildRegeneratePrompt(
      '原标题',
      '用反问句',
      'xhs.title',
      '简练有力',
      '图文为主',
    );
    expect(prompt).toContain('原标题');
    expect(prompt).toContain('用反问句');
    expect(prompt).toContain('xhs.title');
  });

  it('includes content patterns when provided', () => {
    const prompt = buildRegeneratePrompt(
      '原标题',
      '用反问句',
      'xhs.title',
      '简练有力',
      '图文为主',
      '反问句标题公式：以"有人说"开头',
    );
    expect(prompt).toContain('反问句标题公式');
  });
});

describe('regenerateContent', () => {
  it('regenerates xhs.title and updates queue item', async () => {
    const item = await addItem({
      topic: '蹭 电竞',
      trend_hook: '电竞 (douyin, 2.0x)',
      identity_mode: 'esports',
      content: {
        xhs: { title: '原标题', body: '原文', tags: ['#电竞'], cover_images: [] },
        douyin: { script: '脚本', bgm_suggestion: 'BGM', key_captions: [], cover_images: [] },
      },
    });

    const mockLLM = createMockLLMClient([
      JSON.stringify({ title: '有人说女生不懂电竞？排位赛不说谎。' }),
    ]);

    const updated = await regenerateContent(
      item.id,
      'xhs.title',
      '用反问句',
      mockLLM,
      '简练有力',
      '图文为主',
    );

    expect(updated).not.toBeNull();
    expect(updated!.content.xhs.title).toBe('有人说女生不懂电竞？排位赛不说谎。');
    expect(updated!.content.douyin.script).toBe('脚本'); // unchanged
    expect(updated!.edit_history.length).toBeGreaterThanOrEqual(1);
    expect(updated!.edit_history[updated!.edit_history.length - 1].instruction).toBe('用反问句');
  });

  it('regenerates xhs.body field', async () => {
    const item = await addItem({
      topic: 'test',
      trend_hook: 'hook',
      identity_mode: 'daily',
      content: {
        xhs: { title: 'title', body: '原文300字', tags: [], cover_images: [] },
        douyin: { script: '', bgm_suggestion: '', key_captions: [], cover_images: [] },
      },
    });

    const mockLLM = createMockLLMClient([
      JSON.stringify({ body: '新文案500字' }),
    ]);

    const updated = await regenerateContent(
      item.id,
      'xhs.body',
      '更口语化',
      mockLLM,
      '简练有力',
      '图文为主',
    );

    expect(updated!.content.xhs.body).toBe('新文案500字');
  });

  it('regenerates douyin.opening_hook field', async () => {
    const item = await addItem({
      topic: 'test',
      trend_hook: 'hook',
      identity_mode: 'esports',
      content: {
        xhs: { title: '', body: '', tags: [], cover_images: [] },
        douyin: { script: '脚本', bgm_suggestion: 'BGM', key_captions: ['字幕'], cover_images: [] },
      },
    });

    const mockLLM = createMockLLMClient([
      JSON.stringify({ opening_hook: '新hook' }),
    ]);

    const updated = await regenerateContent(
      item.id,
      'douyin.opening_hook',
      '更有冲击力',
      mockLLM,
      '简练有力',
      '视频脚本',
    );

    expect(updated!.content.douyin.script).toBe('脚本'); // unchanged
  });

  it('returns null for unknown item id', async () => {
    const mockLLM = createMockLLMClient([]);
    const result = await regenerateContent('nonexistent', 'xhs.title', 'x', mockLLM, '', '');
    expect(result).toBeNull();
  });
});
