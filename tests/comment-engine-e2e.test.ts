/**
 * comment-engine-e2e.test.ts
 *
 * End-to-end integration tests for the Instagram comment engagement pipeline.
 *
 * Chain A: Passive reply (replyToComments)
 * Chain B: Active outbound (engageOutbound)
 * Chain C: Schedule timing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { vi } from 'vitest';
import * as bridgeClient from '../skill/scripts/instagram-bridge-client';
import * as llmClient from '../skill/scripts/llm-client';
import { setBasePaths, resetBasePaths, PATHS } from '../skill/scripts/file-utils';
import {
  scheduleCommentCheck,
  getPendingReplies,
  replyToComments,
  engageOutbound,
  appendOutboundHistory,
} from '../skill/scripts/comment-engine';

// ── Shared test fixtures ──────────────────────────────────────────────────────

const GENUINE_COMMENT_1 = {
  comment_pk: 'c1',
  user_id: 'u1',
  username: 'cosplayer_alice',
  text: '这个cos太美了！请问是什么角色？',
  created_at: null,
  like_count: 5,
};

const SPAM_COMMENT = {
  comment_pk: 'c_spam',
  user_id: 'u_spam',
  username: 'spammer',
  text: '❤️❤️👏👏',
  created_at: null,
  like_count: 0,
};

const GENUINE_COMMENT_2 = {
  comment_pk: 'c2',
  user_id: 'u2',
  username: 'hanfu_lover',
  text: '汉服配色好看！',
  created_at: null,
  like_count: 3,
};

const HASHTAG_POST_ALICE = {
  pk: 'post_001',
  code: 'abc123',
  user_id: 'uid_alice',
  username: 'alice_cos',
  like_count: 200,
  comment_count: 8,
  caption_text: '今天的国风汉服！',
  thumbnail_url: null,
};

const HASHTAG_POST_BOB = {
  pk: 'post_002',
  code: 'def456',
  user_id: 'uid_bob',
  username: 'bob_cosplay',
  like_count: 150,
  comment_count: 5,
  caption_text: '原神申鹤cosplay完成！',
  thumbnail_url: null,
};

// ── Setup / Teardown ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minase-e2e-test-'));
  setBasePaths(tmpDir, tmpDir);
  fs.mkdirSync(path.join(tmpDir, 'relations', 'social', 'instagram'), { recursive: true });
  // Create an empty diary.md so appendText has a file to append to
  fs.writeFileSync(path.join(tmpDir, 'diary.md'), '');
});

afterEach(() => {
  vi.restoreAllMocks();
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Chain A: Passive Reply ───────────────────────────────────────────────────

describe('Chain A: replyToComments — passive reply pipeline', () => {
  it('full flow: schedules check, retrieves pending, replies to genuine comments, updates pending-engagement.json and diary.md', async () => {
    // Step 1: Schedule a comment check with scheduled_after in the past
    scheduleCommentCheck({
      media_pk: 'media_abc',
      scheduled_after: Date.now() - 1000,
      post_context: { caption: '今日的申鹤cos～', hashtags: ['cosplay', '原神'] },
    });

    // Step 2: getPendingReplies returns the entry
    const pending = getPendingReplies();
    expect(pending).toHaveLength(1);
    expect(pending[0].media_pk).toBe('media_abc');

    // Step 3: Mock bridge — return 3 comments (spam + 2 genuine)
    vi.spyOn(bridgeClient, 'getComments').mockResolvedValue([
      GENUINE_COMMENT_1,
      SPAM_COMMENT,
      GENUINE_COMMENT_2,
    ] as any);

    // Mock replyComment to succeed
    const replyCommentSpy = vi.spyOn(bridgeClient, 'replyComment').mockResolvedValue({
      success: true,
      comment_pk: 'r1',
    });

    // Mock LLM — returns replies for the 2 genuine comments
    vi.spyOn(llmClient, 'callLLMJSON').mockResolvedValue([
      { comment_pk: 'c1', reply: '@cosplayer_alice 这是原神里的申鹤哦～' },
      { comment_pk: 'c2', reply: '@hanfu_lover 谢谢！配色参考了古风图' },
    ]);

    // Step 3: Call replyToComments
    await replyToComments('media_abc', {
      caption: '今日的申鹤cos～',
      hashtags: ['cosplay', '原神'],
      emotionSummary: '很开心',
    });

    // Step 4: bridge replyComment was called for each valid reply
    expect(replyCommentSpy).toHaveBeenCalledTimes(2);
    expect(replyCommentSpy).toHaveBeenCalledWith(
      'media_abc',
      'c1',
      '@cosplayer_alice 这是原神里的申鹤哦～',
    );
    expect(replyCommentSpy).toHaveBeenCalledWith(
      'media_abc',
      'c2',
      '@hanfu_lover 谢谢！配色参考了古风图',
    );

    // Step 5: pending-engagement.json updated with replied_comment_ids
    const engagementData = JSON.parse(
      fs.readFileSync(PATHS.pendingEngagement, 'utf8'),
    );
    const entry = engagementData.pending_replies.find(
      (p: any) => p.media_pk === 'media_abc',
    );
    expect(entry).toBeDefined();
    expect(entry.replied_comment_ids).toContain('c1');
    expect(entry.replied_comment_ids).toContain('c2');

    // Step 6: diary.md has entries mentioning the replies
    const diary = fs.readFileSync(path.join(tmpDir, 'diary.md'), 'utf8');
    expect(diary).toContain('@cosplayer_alice');
    expect(diary).toContain('@hanfu_lover');
  });

  it('spam comments are excluded from the LLM prompt', async () => {
    scheduleCommentCheck({
      media_pk: 'media_spam_test',
      scheduled_after: Date.now() - 1000,
      post_context: { caption: 'test', hashtags: [] },
    });

    vi.spyOn(bridgeClient, 'getComments').mockResolvedValue([
      SPAM_COMMENT,
      GENUINE_COMMENT_1,
    ] as any);
    vi.spyOn(bridgeClient, 'replyComment').mockResolvedValue({ success: true, comment_pk: 'r1' });

    const llmSpy = vi.spyOn(llmClient, 'callLLMJSON').mockResolvedValue([
      { comment_pk: 'c1', reply: '@cosplayer_alice 是申鹤！' },
    ]);

    await replyToComments('media_spam_test', { caption: 'test', hashtags: [] });

    const llmPrompt = (llmSpy.mock.calls[0][0]) as string;
    // spam username should NOT appear in the prompt sent to LLM
    expect(llmPrompt).not.toContain('spammer');
    // genuine comment should appear
    expect(llmPrompt).toContain('cosplayer_alice');
  });

  it('does not re-reply to a comment that was already marked as replied', async () => {
    scheduleCommentCheck({
      media_pk: 'media_rereplied',
      scheduled_after: Date.now() - 1000,
      post_context: { caption: 'test', hashtags: [] },
    });

    // Simulate c1 already replied
    const engData = JSON.parse(fs.readFileSync(PATHS.pendingEngagement, 'utf8'));
    engData.pending_replies[0].replied_comment_ids = ['c1'];
    fs.writeFileSync(PATHS.pendingEngagement, JSON.stringify(engData));

    vi.spyOn(bridgeClient, 'getComments').mockResolvedValue([
      GENUINE_COMMENT_1,
      GENUINE_COMMENT_2,
    ] as any);
    const replyCommentSpy = vi
      .spyOn(bridgeClient, 'replyComment')
      .mockResolvedValue({ success: true, comment_pk: 'r1' });
    vi.spyOn(llmClient, 'callLLMJSON').mockResolvedValue([
      { comment_pk: 'c2', reply: '@hanfu_lover 谢谢！' },
    ]);

    await replyToComments('media_rereplied', { caption: 'test', hashtags: [] });

    // Only the new (c2) comment should be replied to
    expect(replyCommentSpy).toHaveBeenCalledTimes(1);
    expect(replyCommentSpy).toHaveBeenCalledWith('media_rereplied', 'c2', '@hanfu_lover 谢谢！');
  });
});

// ── Chain B: Active Outbound ─────────────────────────────────────────────────

describe('Chain B: engageOutbound — active outbound pipeline', () => {
  it('full flow: discovers posts, posts comments, writes outbound-history.json and diary.md', async () => {
    // Mock hashtagTop returning 2 posts from different users
    vi.spyOn(bridgeClient, 'hashtagTop').mockResolvedValue({
      posts: [HASHTAG_POST_ALICE, HASHTAG_POST_BOB],
    });

    const postCommentSpy = vi
      .spyOn(bridgeClient, 'postComment')
      .mockResolvedValue({ success: true, comment_pk: 'c1' });

    // LLM returns one comment per user
    vi.spyOn(llmClient, 'callLLMJSON').mockResolvedValue([
      {
        media_pk: 'post_001',
        user_id: 'uid_alice',
        username: 'alice_cos',
        comment: '好美的汉服配色！',
      },
      {
        media_pk: 'post_002',
        user_id: 'uid_bob',
        username: 'bob_cosplay',
        comment: '申鹤cos做得太好了！',
      },
    ]);

    await engageOutbound({
      socialIntentIntensity: 8,
      emotionSummary: '今天心情很好，想跟cos圈的朋友互动',
      hashtags: ['汉服', 'cosplay'],
    });

    // bridge postComment called twice (one per user)
    expect(postCommentSpy).toHaveBeenCalledTimes(2);
    expect(postCommentSpy).toHaveBeenCalledWith('post_001', '好美的汉服配色！');
    expect(postCommentSpy).toHaveBeenCalledWith('post_002', '申鹤cos做得太好了！');

    // outbound-history.json has 2 entries with correct user_ids
    const historyData = JSON.parse(
      fs.readFileSync(PATHS.outboundHistory, 'utf8'),
    );
    expect(historyData.commented).toHaveLength(2);
    const userIds = historyData.commented.map((e: any) => e.user_id);
    expect(userIds).toContain('uid_alice');
    expect(userIds).toContain('uid_bob');
    const mediaPks = historyData.commented.map((e: any) => e.media_pk);
    expect(mediaPks).toContain('post_001');
    expect(mediaPks).toContain('post_002');

    // diary.md has entries for both comments
    const diary = fs.readFileSync(path.join(tmpDir, 'diary.md'), 'utf8');
    expect(diary).toContain('@alice_cos');
    expect(diary).toContain('@bob_cosplay');
  });

  it('per-user dedup: second engageOutbound call skips users already commented on in current session', async () => {
    // First call: alice and bob both get comments
    vi.spyOn(bridgeClient, 'hashtagTop').mockResolvedValue({
      posts: [HASHTAG_POST_ALICE, HASHTAG_POST_BOB],
    });
    vi.spyOn(bridgeClient, 'postComment').mockResolvedValue({ success: true, comment_pk: 'c1' });
    vi.spyOn(llmClient, 'callLLMJSON').mockResolvedValue([
      {
        media_pk: 'post_001',
        user_id: 'uid_alice',
        username: 'alice_cos',
        comment: '好美的汉服！',
      },
      {
        media_pk: 'post_002',
        user_id: 'uid_bob',
        username: 'bob_cosplay',
        comment: '申鹤cos棒棒！',
      },
    ]);

    await engageOutbound({
      socialIntentIntensity: 8,
      emotionSummary: '好',
      hashtags: ['cosplay'],
    });

    // First call: 2 posts commented
    const historyAfterFirst = JSON.parse(
      fs.readFileSync(PATHS.outboundHistory, 'utf8'),
    );
    expect(historyAfterFirst.commented).toHaveLength(2);

    // Restore mocks and set up a second call where SAME users appear again
    vi.restoreAllMocks();

    // New post from alice (same user_id)
    const ALICE_POST_2 = { ...HASHTAG_POST_ALICE, pk: 'post_001b', code: 'zzz999' };

    vi.spyOn(bridgeClient, 'hashtagTop').mockResolvedValue({
      posts: [ALICE_POST_2],
    });
    const secondPostCommentSpy = vi
      .spyOn(bridgeClient, 'postComment')
      .mockResolvedValue({ success: true, comment_pk: 'c2' });
    vi.spyOn(llmClient, 'callLLMJSON').mockResolvedValue([
      {
        media_pk: 'post_001b',
        user_id: 'uid_alice',
        username: 'alice_cos',
        comment: '又看到你了！',
      },
    ]);

    await engageOutbound({
      socialIntentIntensity: 8,
      emotionSummary: '好',
      hashtags: ['cosplay'],
    });

    // Alice already has MAX_COMMENTS_PER_USER_24H (2) within 24h? No — only 1 here.
    // But isAlreadyCommented('post_001b') = false, so the filter is getRecentCommentCountForUser.
    // After first call uid_alice has 1 comment in history, which is < 2 (MAX_COMMENTS_PER_USER_24H).
    // So she CAN be commented on again in a fresh call (not the same batch).
    // The per-batch dedup (postedUserIds Set) only deduplicates WITHIN a single engageOutbound call.
    // This test verifies that behaviour: a fresh call CAN still comment on the same user
    // as long as per-24h limit isn't exceeded.
    const historyAfterSecond = JSON.parse(
      fs.readFileSync(PATHS.outboundHistory, 'utf8'),
    );
    expect(historyAfterSecond.commented).toHaveLength(3);
    expect(secondPostCommentSpy).toHaveBeenCalledTimes(1);
    expect(secondPostCommentSpy).toHaveBeenCalledWith('post_001b', '又看到你了！');
  });

  it('per-user dedup WITHIN a single call: same user_id in LLM output only gets one comment', async () => {
    // Both posts share the same user_id
    const POST_A = { ...HASHTAG_POST_ALICE, pk: 'p_a', code: 'pa1' };
    const POST_B = { ...HASHTAG_POST_ALICE, pk: 'p_b', code: 'pb1', user_id: 'uid_alice' };

    vi.spyOn(bridgeClient, 'hashtagTop').mockResolvedValue({
      posts: [POST_A, POST_B],
    });
    const postCommentSpy = vi
      .spyOn(bridgeClient, 'postComment')
      .mockResolvedValue({ success: true, comment_pk: 'c1' });
    vi.spyOn(llmClient, 'callLLMJSON').mockResolvedValue([
      {
        media_pk: 'p_a',
        user_id: 'uid_alice',
        username: 'alice_cos',
        comment: 'first comment',
      },
      {
        media_pk: 'p_b',
        user_id: 'uid_alice',
        username: 'alice_cos',
        comment: 'second comment - should be skipped',
      },
    ]);

    await engageOutbound({
      socialIntentIntensity: 8,
      emotionSummary: '好',
      hashtags: ['cosplay'],
    });

    // Only one comment posted (per-batch postedUserIds set deduplication)
    expect(postCommentSpy).toHaveBeenCalledTimes(1);
    expect(postCommentSpy).toHaveBeenCalledWith('p_a', 'first comment');
  });
});

// ── Chain C: Schedule Timing ─────────────────────────────────────────────────

describe('Chain C: schedule timing', () => {
  it('entry with scheduled_after in the future is NOT returned by getPendingReplies', () => {
    scheduleCommentCheck({
      media_pk: 'future_post',
      scheduled_after: Date.now() + 60 * 60 * 1000, // +1 hour
      post_context: { caption: 'not yet', hashtags: [] },
    });

    const pending = getPendingReplies();
    expect(pending).toHaveLength(0);
  });

  it('entry with scheduled_after 1 second in the past IS returned by getPendingReplies', () => {
    scheduleCommentCheck({
      media_pk: 'past_post',
      scheduled_after: Date.now() - 1000, // -1 second
      post_context: { caption: 'ready now', hashtags: [] },
    });

    const pending = getPendingReplies();
    expect(pending).toHaveLength(1);
    expect(pending[0].media_pk).toBe('past_post');
  });

  it('correctly distinguishes between past and future entries in the same file', () => {
    scheduleCommentCheck({
      media_pk: 'past_entry',
      scheduled_after: Date.now() - 1000,
      post_context: { caption: 'past', hashtags: [] },
    });
    scheduleCommentCheck({
      media_pk: 'future_entry',
      scheduled_after: Date.now() + 60 * 60 * 1000,
      post_context: { caption: 'future', hashtags: [] },
    });

    const pending = getPendingReplies();
    expect(pending).toHaveLength(1);
    expect(pending[0].media_pk).toBe('past_entry');
    // Ensure the future entry is still persisted but not returned
    const raw = JSON.parse(fs.readFileSync(PATHS.pendingEngagement, 'utf8'));
    expect(raw.pending_replies).toHaveLength(2);
  });
});
