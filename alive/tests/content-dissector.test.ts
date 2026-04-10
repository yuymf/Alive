/**
 * content-dissector.test.ts
 * Unit tests for content-dissector.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setBasePaths, resetBasePaths } from '../scripts/utils/file-utils';
import { createMockLLMClient } from '../scripts/utils/llm-client';
import { dissectBatch } from '../scripts/ops/content-dissector';
import { DissectQueueItem } from '../scripts/utils/types';

// ─── Sandbox setup ────────────────────────────────────────────────────────────

let sandboxDir: string;

beforeEach(() => {
  sandboxDir = fs.mkdtempSync(path.join('/tmp', 'content-dissector-test-'));
  setBasePaths(sandboxDir, sandboxDir);
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(sandboxDir, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeQueueItem(overrides: Partial<DissectQueueItem> = {}): DissectQueueItem {
  return {
    id: 'q-001',
    platform: 'xhs',
    source_id: 'src-001',
    source_type: 'trending_feed',
    title: 'Test viral post',
    description: 'Some description here',
    likes: 12000,
    comments: 500,
    shares: 300,
    queued_at: new Date().toISOString(),
    ...overrides,
  };
}

const validDissectionJSON = JSON.stringify({
  hook_type: '数字冲击',
  content_type: '种草类',
  identity_mode: null,
  emotion_arc: '焦虑→共鸣→解脱',
  interaction_design: '评论区问答',
  visual_style: '简约白',
  cta_type: '关注解锁',
  summary: '用数字引发共鸣达到爆款效果',
});

// ─── dissectBatch tests ───────────────────────────────────────────────────────

describe('dissectBatch', () => {
  it('returns [] for empty input', async () => {
    const llm = createMockLLMClient([]);
    const result = await dissectBatch([], llm, 'miss-v');
    expect(result).toEqual([]);
  });

  it('correctly maps 6-dimensional LLM output to ViralEntry', async () => {
    const llm = createMockLLMClient([validDissectionJSON]);
    const item = makeQueueItem();
    const results = await dissectBatch([item], llm, 'miss-v');

    expect(results).toHaveLength(1);
    const entry = results[0];

    expect(entry.dissection_status).toBe('done');
    expect(entry.dissection.hook_type).toBe('数字冲击');
    expect(entry.dissection.content_type).toBe('种草类');
    expect(entry.dissection.identity_mode).toBeNull();
    expect(entry.dissection.emotion_arc).toBe('焦虑→共鸣→解脱');
    expect(entry.dissection.interaction_design).toBe('评论区问答');
    expect(entry.dissection.visual_style).toBe('简约白');
    expect(entry.dissection.cta_type).toBe('关注解锁');
    expect(entry.dissection.summary).toBe('用数字引发共鸣达到爆款效果');
  });

  it('identity_mode null → kb_tier = "universal"', async () => {
    const llm = createMockLLMClient([validDissectionJSON]);
    const item = makeQueueItem();
    const results = await dissectBatch([item], llm, 'miss-v');
    expect(results[0].kb_tier).toBe('universal');
  });

  it('identity_mode non-null → kb_tier = "track"', async () => {
    const trackDissection = JSON.stringify({
      hook_type: '悬念留白',
      content_type: '赛事解读',
      identity_mode: 'esports',
      emotion_arc: '紧张→释放',
      interaction_design: '投票互动',
      visual_style: '动感暗调',
      cta_type: '评论区预测',
      summary: '电竞赛事悬念引爆互动',
    });
    const llm = createMockLLMClient([trackDissection]);
    const item = makeQueueItem({ id: 'q-esports', source_id: 'src-esports' });
    const results = await dissectBatch([item], llm, 'miss-v');
    expect(results[0].kb_tier).toBe('track');
    expect(results[0].dissection.identity_mode).toBe('esports');
  });

  it('LLM returns invalid JSON → status = "failed", no throw', async () => {
    const llm = createMockLLMClient(['this is definitely not json !!!']);
    const item = makeQueueItem({ id: 'q-fail', source_id: 'src-fail' });
    const results = await dissectBatch([item], llm, 'miss-v');
    expect(results).toHaveLength(1);
    expect(results[0].dissection_status).toBe('failed');
    expect(results[0].id).toBeDefined();
  });

  it('processes multiple items sequentially', async () => {
    const json1 = JSON.stringify({ hook_type: 'A', content_type: 'X', identity_mode: null, emotion_arc: '', interaction_design: '', visual_style: '', cta_type: '', summary: 's1' });
    const json2 = JSON.stringify({ hook_type: 'B', content_type: 'Y', identity_mode: 'racer', emotion_arc: '', interaction_design: '', visual_style: '', cta_type: '', summary: 's2' });
    const llm = createMockLLMClient([json1, json2]);

    const items = [
      makeQueueItem({ id: 'q1', source_id: 's1' }),
      makeQueueItem({ id: 'q2', source_id: 's2' }),
    ];
    const results = await dissectBatch(items, llm, 'miss-v');
    expect(results).toHaveLength(2);
    expect(results[0].dissection.summary).toBe('s1');
    expect(results[1].dissection.summary).toBe('s2');
    expect(results[1].kb_tier).toBe('track');
  });

  it('preserves source metadata on returned entry', async () => {
    const llm = createMockLLMClient([validDissectionJSON]);
    const item = makeQueueItem({
      id: 'q-meta',
      source_id: 'src-meta',
      platform: 'douyin',
      source_type: 'competitor',
      title: 'My title',
      description: 'My description',
      likes: 15000,
      comments: 700,
      shares: 400,
    });
    const results = await dissectBatch([item], llm, 'persona-x');
    const entry = results[0];
    expect(entry.platform).toBe('douyin');
    expect(entry.source_type).toBe('competitor');
    expect(entry.title).toBe('My title');
    expect(entry.likes).toBe(15000);
    expect(entry.persona_id).toBe('persona-x');
  });

  it('有评论时返回 audience_response', async () => {
    const dissectionWithAudience = JSON.stringify({
      hook_type: '反问式',
      content_type: '种草类',
      identity_mode: null,
      emotion_arc: '好奇→满足',
      interaction_design: '评论区讨论',
      visual_style: '清新',
      cta_type: '收藏',
      summary: '种草引发讨论',
      audience_response: {
        top_keywords: ['好用', '推荐', '回购'],
        emotional_triggers: ['心动', '焦虑解决'],
        desire_signals: ['求链接', '想要同款', '教程在哪'],
      },
    });
    const llm = createMockLLMClient([dissectionWithAudience]);
    const item = makeQueueItem({
      id: 'q-comments',
      source_id: 'src-comments',
      comment_texts: ['好用到哭', '求链接！', '回购第三次了'],
    });
    const results = await dissectBatch([item], llm, 'miss-v');
    expect(results[0].dissection.audience_response).toBeDefined();
    expect(results[0].dissection.audience_response!.desire_signals).toContain('求链接');
    expect(results[0].dissection.audience_response!.top_keywords).toContain('好用');
  });

  it('无评论时不包含 audience_response', async () => {
    const llm = createMockLLMClient([validDissectionJSON]);
    const item = makeQueueItem(); // no comment_texts
    const results = await dissectBatch([item], llm, 'miss-v');
    expect(results[0].dissection.audience_response).toBeUndefined();
  });
});
