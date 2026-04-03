import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setBasePaths, resetBasePaths } from '../../scripts/utils/file-utils';
import { setTimeOverride } from '../../scripts/utils/time-utils';
import { createMockLLMClient } from '../../scripts/utils/llm-client';
import { addItem } from '../../scripts/ops/review-queue';
import { getItem } from '../../scripts/ops/review-queue';
import { setActiveReviewItem, getActiveReviewItem } from '../../scripts/ops/review-session';
import { handleReviewMessage } from '../../scripts/ops/ops-review-handler';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const tmpDir = path.join(os.tmpdir(), 'alive-review-handler-test-' + Date.now());
const seedContent = {
  xhs: { title: 'test title', body: 'body', tags: ['#tag'], cover_images: [] as string[] },
  douyin: { script: 'script', bgm_suggestion: '', key_captions: [] as string[], cover_images: [] as string[] },
};

const mockLLM = createMockLLMClient({
  default: '{"action":"unknown","raw":"?"}',
});

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
  setTimeOverride(new Date('2026-04-03T10:00:00Z'));
});

afterEach(() => {
  resetBasePaths();
  setActiveReviewItem(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleReviewMessage — publish flow', () => {
  it('handles publish confirmation with URL for the active item', async () => {
    const item = await addItem({ topic: '电竞女孩', trend_hook: 'hook', identity_mode: 'esports', content: seedContent });
    setActiveReviewItem(item.id);

    const reply = await handleReviewMessage('已发 https://www.xiaohongshu.com/explore/abc', mockLLM);

    expect(reply).toContain('已记录发布链接');
    expect(reply).toContain('电竞女孩');

    const updated = await getItem(item.id);
    expect(updated?.status).toBe('published');
    expect(updated?.published_urls?.xhs).toBe('https://www.xiaohongshu.com/explore/abc');
    expect(updated?.published_at).toBeTruthy();
  });

  it('handles publish without active item — uses most recent pending', async () => {
    await addItem({ topic: 'old', trend_hook: 'h', identity_mode: 'daily', content: seedContent });
    const newer = await addItem({ topic: 'newer', trend_hook: 'h', identity_mode: 'daily', content: seedContent });

    const reply = await handleReviewMessage('已发 https://www.xiaohongshu.com/explore/xyz', mockLLM);

    expect(reply).toContain('已记录发布链接');
    const updated = await getItem(newer.id);
    expect(updated?.status).toBe('published');
  });

  it('handles douyin URL publish', async () => {
    const item = await addItem({ topic: '赛车', trend_hook: 'h', identity_mode: 'racer', content: seedContent });
    setActiveReviewItem(item.id);

    const reply = await handleReviewMessage('发了 https://www.douyin.com/video/123', mockLLM);

    expect(reply).toContain('已记录发布链接');
    const updated = await getItem(item.id);
    expect(updated?.published_urls?.douyin).toBe('https://www.douyin.com/video/123');
  });
});

describe('handleReviewMessage — approve / discard', () => {
  it('returns unknown hint when no active item for approve-like text', async () => {
    const reply = await handleReviewMessage('好，发吧', mockLLM);
    expect(reply).toContain('没有理解');
  });

  it('approves the active item when NLU returns approve', async () => {
    const item = await addItem({ topic: '测试', trend_hook: 'h', identity_mode: 'daily', content: seedContent });
    setActiveReviewItem(item.id);

    const approveLLM = createMockLLMClient({
      default: `{"action":"approve","item_id":"${item.id}"}`,
    });

    const reply = await handleReviewMessage('好，发吧', approveLLM);
    expect(reply).toContain('已审批通过');

    const updated = await getItem(item.id);
    expect(updated?.status).toBe('approved');
  });

  it('discards the active item', async () => {
    const item = await addItem({ topic: '不要的', trend_hook: 'h', identity_mode: 'daily', content: seedContent });
    setActiveReviewItem(item.id);

    const discardLLM = createMockLLMClient({
      default: `{"action":"discard","item_id":"${item.id}"}`,
    });

    const reply = await handleReviewMessage('算了不要了', discardLLM);
    expect(reply).toContain('已弃置');

    const updated = await getItem(item.id);
    expect(updated?.status).toBe('discarded');
  });
});

describe('handleReviewMessage — unknown', () => {
  it('returns help hint when active item exists but intent unknown', async () => {
    const item = await addItem({ topic: '当前选题', trend_hook: 'h', identity_mode: 'daily', content: seedContent });
    setActiveReviewItem(item.id);

    const reply = await handleReviewMessage('今天天气不错', mockLLM);
    expect(reply).toContain('没有理解');
    expect(reply).toContain('当前选题');
  });

  it('returns generic help when no active item', async () => {
    const reply = await handleReviewMessage('随便说说', mockLLM);
    expect(reply).toContain('没有理解');
    expect(reply).toContain('/alive help');
  });
});

describe('review-session', () => {
  it('persists and retrieves active item id', () => {
    setActiveReviewItem('q_123');
    expect(getActiveReviewItem()).toBe('q_123');
  });

  it('clears active item', () => {
    setActiveReviewItem('q_123');
    setActiveReviewItem(null);
    expect(getActiveReviewItem()).toBeNull();
  });
});
