import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { vi } from 'vitest';
import * as bridgeClient from '../skill/scripts/instagram-bridge-client';
import * as llmClient from '../skill/scripts/llm-client';
import { setBasePaths, resetBasePaths, PATHS } from '../skill/scripts/file-utils';
import {
  getPendingReplies,
  scheduleCommentCheck,
  markReplied,
  getTodayOutboundCount,
  appendOutboundHistory,
  pruneOutboundHistory,
  isAlreadyCommented,
  replyToComments,
} from '../skill/scripts/comment-engine';
import { engageOutbound } from '../skill/scripts/comment-engine';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minase-test-'));
  setBasePaths(tmpDir, tmpDir);
  fs.mkdirSync(path.join(tmpDir, 'relations', 'social', 'instagram'), { recursive: true });
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scheduleCommentCheck', () => {
  it('writes a pending entry to pending-engagement.json', () => {
    scheduleCommentCheck({ media_pk: '111', scheduled_after: 9999999999, post_context: { caption: 'hello', hashtags: [] } });
    const data = JSON.parse(fs.readFileSync(PATHS.pendingEngagement, 'utf8'));
    expect(data.pending_replies).toHaveLength(1);
    expect(data.pending_replies[0].media_pk).toBe('111');
  });

  it('appends to existing entries', () => {
    scheduleCommentCheck({ media_pk: '111', scheduled_after: 9999999999, post_context: { caption: 'a', hashtags: [] } });
    scheduleCommentCheck({ media_pk: '222', scheduled_after: 9999999999, post_context: { caption: 'b', hashtags: [] } });
    const data = JSON.parse(fs.readFileSync(PATHS.pendingEngagement, 'utf8'));
    expect(data.pending_replies).toHaveLength(2);
  });
});

describe('getPendingReplies', () => {
  it('returns only entries past scheduled_after', () => {
    scheduleCommentCheck({ media_pk: '111', scheduled_after: Date.now() - 1000, post_context: { caption: 'old', hashtags: [] } });
    scheduleCommentCheck({ media_pk: '222', scheduled_after: Date.now() + 999999999, post_context: { caption: 'future', hashtags: [] } });
    const due = getPendingReplies();
    expect(due).toHaveLength(1);
    expect(due[0].media_pk).toBe('111');
  });
});

describe('markReplied', () => {
  it('adds comment_pk to replied_comment_ids', () => {
    scheduleCommentCheck({ media_pk: '111', scheduled_after: 0, post_context: { caption: 'x', hashtags: [] } });
    markReplied('111', 'comment_abc');
    const data = JSON.parse(fs.readFileSync(PATHS.pendingEngagement, 'utf8'));
    expect(data.pending_replies[0].replied_comment_ids).toContain('comment_abc');
  });
});

describe('outbound history', () => {
  it('getTodayOutboundCount returns 0 on empty history', () => {
    expect(getTodayOutboundCount()).toBe(0);
  });

  it('appendOutboundHistory increments count', () => {
    appendOutboundHistory({ media_pk: '111', user_id: 'user1', commented_at: Date.now() });
    appendOutboundHistory({ media_pk: '222', user_id: 'user2', commented_at: Date.now() });
    expect(getTodayOutboundCount()).toBe(2);
  });

  it('isAlreadyCommented detects existing entry', () => {
    appendOutboundHistory({ media_pk: '111', user_id: 'user1', commented_at: Date.now() });
    expect(isAlreadyCommented('111')).toBe(true);
    expect(isAlreadyCommented('999')).toBe(false);
  });

  it('pruneOutboundHistory removes entries older than 30 days', () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const fresh = Date.now();
    appendOutboundHistory({ media_pk: '111', user_id: 'u1', commented_at: old });
    appendOutboundHistory({ media_pk: '222', user_id: 'u2', commented_at: fresh });
    pruneOutboundHistory();
    expect(isAlreadyCommented('111')).toBe(false);
    expect(isAlreadyCommented('222')).toBe(true);
  });
});

describe('replyToComments', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('skips already-replied comments', async () => {
    scheduleCommentCheck({ media_pk: '111', scheduled_after: 0, post_context: { caption: 'test', hashtags: [] } });
    markReplied('111', 'comment_existing');

    vi.spyOn(bridgeClient, 'getComments').mockResolvedValue([
      { comment_pk: 'comment_existing', user_id: 'u1', username: 'user1', text: '好棒！', created_at: null, like_count: 0 },
      { comment_pk: 'comment_new', user_id: 'u2', username: 'user2', text: '请问这是什么cos？', created_at: null, like_count: 5 },
    ] as any);
    vi.spyOn(bridgeClient, 'replyComment').mockResolvedValue({ success: true, comment_pk: 'r1' });
    vi.spyOn(llmClient, 'callLLMJSON').mockResolvedValue([
      { comment_pk: 'comment_new', reply: '@user2 这是原神申鹤！' },
    ]);

    await replyToComments('111', { caption: 'test', hashtags: [] });

    expect(bridgeClient.replyComment).toHaveBeenCalledTimes(1);
    expect(bridgeClient.replyComment).toHaveBeenCalledWith('111', 'comment_new', '@user2 这是原神申鹤！');
  });

  it('skips pure-emoji spam comments before calling LLM', async () => {
    scheduleCommentCheck({ media_pk: '222', scheduled_after: 0, post_context: { caption: 'test', hashtags: [] } });

    vi.spyOn(bridgeClient, 'getComments').mockResolvedValue([
      { comment_pk: 'c1', user_id: 'u1', username: 'spammer', text: '❤️❤️❤️👏👏', created_at: null, like_count: 0 },
      { comment_pk: 'c2', user_id: 'u2', username: 'real', text: '太好看了，这个头饰哪里买的？', created_at: null, like_count: 2 },
    ] as any);
    vi.spyOn(bridgeClient, 'replyComment').mockResolvedValue({ success: true, comment_pk: 'r1' });
    vi.spyOn(llmClient, 'callLLMJSON').mockResolvedValue([
      { comment_pk: 'c2', reply: '@real 在cos.lol买的！' },
    ]);

    await replyToComments('222', { caption: 'test', hashtags: [] });

    const llmPrompt = (llmClient.callLLMJSON as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(llmPrompt).not.toContain('spammer');
    expect(llmPrompt).toContain('real');
  });
});

describe('engageOutbound', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('skips if today outbound count >= 5', async () => {
    for (let i = 0; i < 5; i++) {
      appendOutboundHistory({ media_pk: `m${i}`, user_id: `u${i}`, commented_at: Date.now() });
    }
    const spy = vi.spyOn(bridgeClient, 'postComment');
    await engageOutbound({ socialIntentIntensity: 8, emotionSummary: 'good', hashtags: [] });
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips already-commented posts', async () => {
    appendOutboundHistory({ media_pk: 'already_done', user_id: 'u1', commented_at: Date.now() });

    vi.spyOn(bridgeClient, 'hashtagTop').mockResolvedValue({
      posts: [{ pk: 'already_done', code: 'existing_user', user_id: 'user_123', username: 'existing_user', like_count: 100, comment_count: 5, caption_text: 'great cos', thumbnail_url: null }],
    });
    vi.spyOn(bridgeClient, 'postComment').mockResolvedValue({ success: true, comment_pk: 'c1' });
    vi.spyOn(llmClient, 'callLLMJSON').mockResolvedValue([]);

    await engageOutbound({ socialIntentIntensity: 8, emotionSummary: 'good', hashtags: ['cosplay'] });
    expect(bridgeClient.postComment).not.toHaveBeenCalled();
  });
});
