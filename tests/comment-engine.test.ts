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
  getRecentCommentCountForUser,
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

describe('getRecentCommentCountForUser', () => {
  it('returns 0 for user with no history', () => {
    expect(getRecentCommentCountForUser('user_xyz')).toBe(0);
  });

  it('counts only entries within 24h for the specific user', () => {
    const within24h = Date.now() - 1000;
    const beyond24h = Date.now() - 25 * 60 * 60 * 1000;
    appendOutboundHistory({ media_pk: 'm1', user_id: 'user_a', commented_at: within24h });
    appendOutboundHistory({ media_pk: 'm2', user_id: 'user_a', commented_at: within24h });
    appendOutboundHistory({ media_pk: 'm3', user_id: 'user_a', commented_at: beyond24h }); // too old
    appendOutboundHistory({ media_pk: 'm4', user_id: 'user_b', commented_at: within24h }); // different user
    expect(getRecentCommentCountForUser('user_a')).toBe(2);
    expect(getRecentCommentCountForUser('user_b')).toBe(1);
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

  it('skips users already commented on 2+ times today', async () => {
    // user_123 already has 2 comments today
    appendOutboundHistory({ media_pk: 'prev_1', user_id: 'user_123', commented_at: Date.now() - 1000 });
    appendOutboundHistory({ media_pk: 'prev_2', user_id: 'user_123', commented_at: Date.now() - 2000 });

    vi.spyOn(bridgeClient, 'hashtagTop').mockResolvedValue({
      posts: [
        { pk: 'new_post', code: 'some_code', user_id: 'user_123', username: 'target_user', like_count: 100, comment_count: 5, caption_text: 'great cos', thumbnail_url: null },
      ],
    });
    vi.spyOn(bridgeClient, 'postComment').mockResolvedValue({ success: true, comment_pk: 'c1' });
    vi.spyOn(llmClient, 'callLLMJSON').mockResolvedValue([
      { media_pk: 'new_post', username: 'target_user', comment: 'cool!' }
    ]);

    await engageOutbound({ socialIntentIntensity: 8, emotionSummary: 'good', hashtags: ['cosplay'] });
    expect(bridgeClient.postComment).not.toHaveBeenCalled();
  });

  it('does not post twice to same user even if LLM returns two plans', async () => {
    vi.spyOn(bridgeClient, 'hashtagTop').mockResolvedValue({
      posts: [
        { pk: 'post_a', code: 'c_a', user_id: 'same_user', username: 'same_user_handle', like_count: 100, comment_count: 5, caption_text: 'post a', thumbnail_url: null },
        { pk: 'post_b', code: 'c_b', user_id: 'same_user', username: 'same_user_handle', like_count: 80, comment_count: 3, caption_text: 'post b', thumbnail_url: null },
      ],
    });
    vi.spyOn(bridgeClient, 'postComment').mockResolvedValue({ success: true, comment_pk: 'c1' });
    // LLM returns plans for both posts from same_user
    vi.spyOn(llmClient, 'callLLMJSON').mockResolvedValue([
      { media_pk: 'post_a', user_id: 'same_user', username: 'same_user_handle', comment: 'great!' },
      { media_pk: 'post_b', user_id: 'same_user', username: 'same_user_handle', comment: 'amazing!' },
    ]);

    await engageOutbound({ socialIntentIntensity: 8, emotionSummary: 'good', hashtags: ['cosplay'] });
    // Only one comment should be posted (first one wins, second blocked by per-user dedup)
    expect(bridgeClient.postComment).toHaveBeenCalledTimes(1);
    expect(bridgeClient.postComment).toHaveBeenCalledWith('post_a', 'great!');
  });
});
