# Instagram Engagement System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Instagram comment reply (passive) and outbound engagement (active) capabilities to the heartbeat loop.

**Architecture:** Extend existing bridge + engine pattern — new `comment-engine.ts` handles all comment logic, four new Python bridge commands handle Instagram I/O, heartbeat routes to comment check every tick and to outbound engagement on high social intent.

**Tech Stack:** TypeScript (strict, CommonJS, ES2022), Python 3 + instagrapi, Vitest for tests, `file-utils.ts` for all state I/O, `llm-client.ts` for LLM calls.

**Spec:** `docs/superpowers/specs/2025-03-16-instagram-engagement-design.md`

---

## File Map

### New Files
| Path | Purpose |
|------|---------|
| `skill/scripts/comment-engine.ts` | Core logic: `replyToComments()`, `engageOutbound()`, `scheduleCommentCheck()`, `getPendingReplies()` |
| `skill/templates/comment-reply-prompt.md` | LLM prompt for replying to comments on own posts |
| `skill/templates/outbound-comment-prompt.md` | LLM prompt for generating outbound comments |
| `tests/comment-engine.test.ts` | Unit tests for comment-engine |
| `tests/instagram-bridge-client.test.ts` | Unit tests for new bridge wrappers |

### Modified Files
| Path | Changes |
|------|---------|
| `skill/scripts/file-utils.ts` | Add `PATHS.pendingEngagement` and `PATHS.outboundHistory` getters |
| `skill/scripts/instagram-bridge.py` | Add 4 subcommands: `get_comments`, `reply_comment`, `post_comment`, `get_user_feed` |
| `skill/scripts/instagram-bridge-client.ts` | Add 4 TS wrapper functions + mock responses for all new commands + update `hashtag_top` mock shape |
| `skill/scripts/post-pipeline.ts` | Call `scheduleCommentCheck()` after successful post |
| `skill/scripts/heartbeat-tick.ts` | Add pending-reply check + social-engagement action routing |
| `skill/templates/heartbeat-prompt.md` | Document `social-engagement` as available real action |

---

## Chunk 1: Foundation — PATHS + Bridge

### Task 1: Add PATHS entries to file-utils.ts

**Files:**
- Modify: `skill/scripts/file-utils.ts` (inside PATHS object after `pendingChains` getter, ~line 72)
- Modify: `tests/file-utils-paths.test.ts` (add 2 test cases)

- [ ] **Step 1: Write the failing tests**

  Open `tests/file-utils-paths.test.ts` and add inside the existing test suite (follow the same `setBasePaths` / `resetBasePaths` pattern already there):
  ```typescript
  it('PATHS.pendingEngagement returns path ending in pending-engagement.json', () => {
    setBasePaths('/tmp/test-memory', '/tmp/test-skill');
    expect(PATHS.pendingEngagement).toBe('/tmp/test-memory/pending-engagement.json');
    resetBasePaths();
  });

  it('PATHS.outboundHistory returns path ending in outbound-history.json', () => {
    setBasePaths('/tmp/test-memory', '/tmp/test-skill');
    expect(PATHS.outboundHistory).toBe('/tmp/test-memory/outbound-history.json');
    resetBasePaths();
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `npx vitest run tests/file-utils-paths.test.ts`
  Expected: FAIL — `PATHS.pendingEngagement` is undefined

- [ ] **Step 3: Add PATHS entries**

  In `skill/scripts/file-utils.ts`, inside the `PATHS` object after the `pendingChains` getter (and before the closing `}`), add:
  ```typescript
  get pendingEngagement() { return path.join(getMemoryBase(), 'pending-engagement.json'); },
  get outboundHistory() { return path.join(getMemoryBase(), 'outbound-history.json'); },
  ```

- [ ] **Step 4: Run test to verify it passes**

  Run: `npx vitest run tests/file-utils-paths.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**

  ```bash
  git add skill/scripts/file-utils.ts tests/file-utils-paths.test.ts
  git commit -m "feat: add PATHS.pendingEngagement and PATHS.outboundHistory"
  ```

---

### Task 2: Add 4 new commands to instagram-bridge.py

**Files:**
- Modify: `skill/scripts/instagram-bridge.py`

- [ ] **Step 1: Add 4 command functions**

  In `skill/scripts/instagram-bridge.py`, after the `cmd_get_user_info` function and before `def main()`, insert these four functions:

  ```python
  def cmd_get_comments(args):
      """Get comments for a media post."""
      media_pk = int(args.media_pk)
      amount = int(args.amount)

      def do_comments():
          cl = get_client()
          comments = cl.media_comments(media_pk, amount=amount)
          result = []
          for c in comments:
              result.append({
                  "comment_pk": str(c.pk),
                  "user_id": str(c.user.pk),
                  "username": c.user.username,
                  "text": c.text,
                  "created_at": c.created_at_utc.isoformat() if c.created_at_utc else None,
                  "like_count": c.like_count,
              })
          return result

      result = with_retry(do_comments)
      print(json.dumps(result))


  def cmd_reply_comment(args):
      """Reply to a comment on a media post."""
      media_pk = int(args.media_pk)
      comment_pk = int(args.comment_pk)

      def do_reply():
          cl = get_client()
          time.sleep(30)  # throttle: min 30s between comment actions
          comment = cl.media_comment(media_pk, args.text, replied_to_comment_id=comment_pk)
          return {"success": True, "comment_pk": str(comment.pk)}

      result = with_retry(do_reply)
      print(json.dumps(result))


  def cmd_post_comment(args):
      """Post a new comment on a media post."""
      media_pk = int(args.media_pk)

      def do_comment():
          cl = get_client()
          time.sleep(30)  # throttle: min 30s between comment actions
          comment = cl.media_comment(media_pk, args.text)
          return {"success": True, "comment_pk": str(comment.pk)}

      result = with_retry(do_comment)
      print(json.dumps(result))


  def cmd_get_user_feed(args):
      """Get recent media posts for a user."""
      user_id = int(args.user_id)
      amount = int(args.amount)

      def do_feed():
          cl = get_client()
          medias = cl.user_medias(user_id, amount=amount)
          result = []
          for m in medias:
              result.append({
                  "media_pk": str(m.pk),
                  "caption": (m.caption_text or "")[:300],
                  "like_count": m.like_count,
                  "comment_count": m.comment_count,
                  "taken_at": m.taken_at.isoformat() if m.taken_at else None,
              })
          return result

      result = with_retry(do_feed)
      print(json.dumps(result))
  ```

- [ ] **Step 2: Add subparsers in main()**

  In `main()`, after the `upload_album` subparser block and before `args = parser.parse_args()`, insert:
  ```python
  # get_comments
  p_get_comments = subparsers.add_parser("get_comments")
  p_get_comments.add_argument("--media-pk", required=True)
  p_get_comments.add_argument("--amount", default="20")

  # reply_comment
  p_reply = subparsers.add_parser("reply_comment")
  p_reply.add_argument("--media-pk", required=True)
  p_reply.add_argument("--comment-pk", required=True)
  p_reply.add_argument("--text", required=True)

  # post_comment
  p_post_comment = subparsers.add_parser("post_comment")
  p_post_comment.add_argument("--media-pk", required=True)
  p_post_comment.add_argument("--text", required=True)

  # get_user_feed
  p_user_feed = subparsers.add_parser("get_user_feed")
  p_user_feed.add_argument("--user-id", required=True)
  p_user_feed.add_argument("--amount", default="5")
  ```

- [ ] **Step 3: Add dispatch cases in main()**

  In the `try` block of `main()`, after `elif args.command == "get_user_info":`, add:
  ```python
  elif args.command == "get_comments":
      cmd_get_comments(args)
  elif args.command == "reply_comment":
      cmd_reply_comment(args)
  elif args.command == "post_comment":
      cmd_post_comment(args)
  elif args.command == "get_user_feed":
      cmd_get_user_feed(args)
  ```

- [ ] **Step 4: Smoke-test the parser (no Instagram creds needed)**

  Run: `python3 skill/scripts/instagram-bridge.py get_comments --help`
  Expected: prints usage with `--media-pk` and `--amount`

  Run: `python3 skill/scripts/instagram-bridge.py get_user_feed --help`
  Expected: prints usage with `--user-id` and `--amount`

- [ ] **Step 5: Commit**

  ```bash
  git add skill/scripts/instagram-bridge.py
  git commit -m "feat: add get_comments, reply_comment, post_comment, get_user_feed to instagram-bridge"
  ```

---

### Task 3: Add TypeScript bridge wrappers + fix mocks

**Files:**
- Modify: `skill/scripts/instagram-bridge-client.ts`
- Create: `tests/instagram-bridge-client.test.ts`

- [ ] **Step 1: Write failing tests**

  Create `tests/instagram-bridge-client.test.ts`:
  ```typescript
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import {
    getComments, replyComment, postComment, getUserFeed, hashtagTop,
  } from '../skill/scripts/instagram-bridge-client';

  describe('instagram-bridge-client mock mode', () => {
    beforeEach(() => { process.env.E2E_MOCK_INSTAGRAM = '1'; });
    afterEach(() => { delete process.env.E2E_MOCK_INSTAGRAM; });

    it('getComments returns an array', async () => {
      const result = await getComments('12345');
      expect(Array.isArray(result)).toBe(true);
    });

    it('getUserFeed returns an array', async () => {
      const result = await getUserFeed('67890');
      expect(Array.isArray(result)).toBe(true);
    });

    it('replyComment returns success object', async () => {
      const result = await replyComment('12345', '99999', 'test reply');
      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('comment_pk');
    });

    it('postComment returns success object', async () => {
      const result = await postComment('12345', 'test comment');
      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('comment_pk');
    });

    it('hashtagTop returns object with posts array', async () => {
      const result = await hashtagTop('cosplay') as { posts: unknown[] };
      expect(Array.isArray(result.posts)).toBe(true);
      if (result.posts.length > 0) {
        const p = result.posts[0] as Record<string, unknown>;
        expect(p).toHaveProperty('pk');
        expect(p).toHaveProperty('like_count');
      }
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `npx vitest run tests/instagram-bridge-client.test.ts`
  Expected: FAIL — functions not exported

- [ ] **Step 3: Update the `hashtag_top` mock and add new mocks**

  In `instagram-bridge-client.ts`, in the `mockInstagramResponse` switch, **replace** the existing `hashtag_top` case and add new cases before `default`:

  ```typescript
  case 'hashtag_top':
    return {
      hashtag: 'mock_tag',
      posts: [
        { pk: 'mock_pk_1', code: 'mock_code_1', like_count: 500, comment_count: 10, caption_text: 'Amazing cosplay! #cosplay', thumbnail_url: null },
        { pk: 'mock_pk_2', code: 'mock_code_2', like_count: 300, comment_count: 5, caption_text: 'Daily OOTD #fashion', thumbnail_url: null },
      ],
    };
  case 'get_comments':
    return [];
  case 'get_user_feed':
    return [];
  case 'reply_comment':
    return { success: true, comment_pk: 'mock_reply_pk' };
  case 'post_comment':
    return { success: true, comment_pk: 'mock_comment_pk' };
  ```

- [ ] **Step 4: Add the 5 TypeScript wrapper functions**

  At the bottom of `instagram-bridge-client.ts`, after `uploadAlbum`, add:

  ```typescript
  // ── Types for new engagement commands ──────────────────────────────────────

  export interface InstagramComment {
    comment_pk: string;
    user_id: string;
    username: string;
    text: string;
    created_at: string | null;
    like_count: number;
  }

  export interface InstagramMediaSummary {
    media_pk: string;
    caption: string;
    like_count: number;
    comment_count: number;
    taken_at: string | null;
  }

  export interface CommentResult {
    success: boolean;
    comment_pk: string;
  }

  // ── Wrapper functions ───────────────────────────────────────────────────────

  export async function getComments(mediaPk: string, amount = 20): Promise<InstagramComment[]> {
    const result = await callInstagramBridge('get_comments', {
      'media-pk': mediaPk,
      amount: String(amount),
    });
    return result as InstagramComment[];
  }

  export async function replyComment(mediaPk: string, commentPk: string, text: string): Promise<CommentResult> {
    const result = await callInstagramBridge('reply_comment', {
      'media-pk': mediaPk,
      'comment-pk': commentPk,
      text,
    });
    return result as CommentResult;
  }

  export async function postComment(mediaPk: string, text: string): Promise<CommentResult> {
    const result = await callInstagramBridge('post_comment', {
      'media-pk': mediaPk,
      text,
    });
    return result as CommentResult;
  }

  export async function getUserFeed(userId: string, amount = 5): Promise<InstagramMediaSummary[]> {
    const result = await callInstagramBridge('get_user_feed', {
      'user-id': userId,
      amount: String(amount),
    });
    return result as InstagramMediaSummary[];
  }

  export async function hashtagTop(name: string, amount = 15): Promise<unknown> {
    return callInstagramBridge('hashtag_top', { name, amount: String(amount) });
  }
  ```

- [ ] **Step 5: Run test to verify it passes**

  Run: `npx vitest run tests/instagram-bridge-client.test.ts`
  Expected: PASS (5 tests)

- [ ] **Step 6: Run full test suite for regressions**

  Run: `npm test`
  Expected: PASS — existing hashtag_top callers (inspiration-collector) should still work since the mock shape now has the same `posts` array key

- [ ] **Step 7: Commit**

  ```bash
  git add skill/scripts/instagram-bridge-client.ts tests/instagram-bridge-client.test.ts
  git commit -m "feat: add getComments/replyComment/postComment/getUserFeed/hashtagTop wrappers and fix hashtag_top mock shape"
  ```

---

## Chunk 2: LLM Prompt Templates

### Task 4: Write comment-reply-prompt.md

**Files:**
- Create: `skill/templates/comment-reply-prompt.md`

- [ ] **Step 1: Create the template**

  Create `skill/templates/comment-reply-prompt.md` with this exact content:
  ````markdown
  你是水瀬 Minase，18岁的cos博主。有人在你的Instagram帖子下留了评论，你要回复他们。

  ## 当前状态
  {emotion_summary}

  {voice_directive}

  ## 你的帖子
  {post_caption}

  ## 需要回复的评论
  {comments_json}

  ## 回复要求
  - 每条回复必须针对评论的具体内容，不能是"谢谢！""好棒！"这种通用回复
  - 回复开头带 @用户名
  - 长度 10-30 字，自然随意，不要像公关稿
  - 中英文混用，偶尔加日文词，符合你的说话风格
  - 不要回复看起来是广告/引流/垃圾信息的评论

  ## 输出格式
  严格输出 JSON 数组，放在 ```json 代码块中：
  ```json
  [
    {"comment_pk": "<评论pk>", "reply": "<回复内容>"},
    ...
  ]
  ```
  如果某条评论不值得回复（广告/垃圾），直接跳过不输出。
  ````

- [ ] **Step 2: Verify file is readable**

  Run: `npx vitest run tests/file-utils-paths.test.ts` (just to confirm the test suite still passes — no template-specific test needed)

- [ ] **Step 3: Commit**

  ```bash
  git add skill/templates/comment-reply-prompt.md
  git commit -m "feat: add comment-reply-prompt.md template"
  ```

---

### Task 5: Write outbound-comment-prompt.md

**Files:**
- Create: `skill/templates/outbound-comment-prompt.md`

- [ ] **Step 1: Create the template**

  Create `skill/templates/outbound-comment-prompt.md`:
  ````markdown
  你是水瀬 Minase，18岁的cos博主。你现在在刷cos圈的动态，想去评论几个感兴趣的帖子。

  ## 当前状态
  {emotion_summary}
  社交冲动强度：{social_intent_intensity}/10

  ## 候选帖子
  {candidates_json}

  ## 评论要求
  - 选择 3-5 个你真正感兴趣的帖子来评论（不要强迫自己每条都评）
  - 评论必须针对帖子的具体内容：夸细节、问真实问题、分享共鸣，不能是"好棒！""太美了！"
  - 优先选和你 cos 方向相关的帖子（和服/汉服/游戏角色/摄影技巧）
  - 评论长度 15-40 字，自然，不像机器人
  - 中英文混用，符合你的说话风格

  ## 输出格式
  严格输出 JSON 数组，放在 ```json 代码块中：
  ```json
  [
    {"media_pk": "<帖子pk>", "username": "<账号名>", "comment": "<评论内容>"},
    ...
  ]
  ```
  ````

- [ ] **Step 2: Commit**

  ```bash
  git add skill/templates/outbound-comment-prompt.md
  git commit -m "feat: add outbound-comment-prompt.md template"
  ```

---

## Chunk 3: comment-engine.ts

### Task 6: Write comment-engine.ts — types and state helpers

**Files:**
- Create: `skill/scripts/comment-engine.ts`
- Create: `tests/comment-engine.test.ts`

- [ ] **Step 1: Write failing tests for state helpers**

  Create `tests/comment-engine.test.ts`:
  ```typescript
  import { describe, it, expect, beforeEach, afterEach } from 'vitest';
  import * as fs from 'fs';
  import * as path from 'path';
  import * as os from 'os';
  import { setBasePaths, resetBasePaths, PATHS } from '../skill/scripts/file-utils';
  import {
    getPendingReplies,
    scheduleCommentCheck,
    markReplied,
    getTodayOutboundCount,
    appendOutboundHistory,
    pruneOutboundHistory,
    isAlreadyCommented,
  } from '../skill/scripts/comment-engine';

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
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `npx vitest run tests/comment-engine.test.ts`
  Expected: FAIL — module not found

- [ ] **Step 3: Create comment-engine.ts with state helpers**

  Create `skill/scripts/comment-engine.ts`:
  ```typescript
  /**
   * comment-engine.ts
   * Handles Instagram comment interactions:
   *   - Passive: reply to comments on own posts (triggered 24h after posting)
   *   - Active: outbound engagement on cos-related posts (triggered by social intent)
   */

  import * as path from 'path';
  import * as fs from 'fs';
  import { PATHS, readJSON, writeJSON, appendText, readTemplate, writeSocialRelation } from './file-utils';
  import { callLLMJSON } from './llm-client';
  import {
    getComments, replyComment, postComment, getUserFeed, hashtagTop,
    InstagramComment,
  } from './instagram-bridge-client';
  import { applyClosenessChange, classifyTier } from './social-graph-engine';
  import { SocialRelation } from './types';
  import { getLocalDate } from './time-utils';

  // ── Types ─────────────────────────────────────────────────────────────────

  export interface PendingReply {
    media_pk: string;
    scheduled_after: number;
    post_context: { caption: string; hashtags: string[] };
    replied_comment_ids: string[];
  }

  interface PendingEngagement {
    pending_replies: PendingReply[];
  }

  export interface OutboundEntry {
    media_pk: string;
    user_id: string;
    commented_at: number;
  }

  interface OutboundHistory {
    commented: OutboundEntry[];
  }

  const OUTBOUND_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const MAX_DAILY_OUTBOUND = 5;

  // ── Pending Reply State ────────────────────────────────────────────────────

  export function scheduleCommentCheck(entry: Omit<PendingReply, 'replied_comment_ids'>): void {
    const current = readJSON<PendingEngagement>(PATHS.pendingEngagement, { pending_replies: [] });
    writeJSON(PATHS.pendingEngagement, {
      pending_replies: [...current.pending_replies, { ...entry, replied_comment_ids: [] }],
    });
  }

  export function getPendingReplies(): PendingReply[] {
    const data = readJSON<PendingEngagement>(PATHS.pendingEngagement, { pending_replies: [] });
    return data.pending_replies.filter(p => Date.now() > p.scheduled_after);
  }

  export function markReplied(mediaPk: string, commentPk: string): void {
    const data = readJSON<PendingEngagement>(PATHS.pendingEngagement, { pending_replies: [] });
    writeJSON(PATHS.pendingEngagement, {
      pending_replies: data.pending_replies.map(p =>
        p.media_pk === mediaPk
          ? { ...p, replied_comment_ids: [...p.replied_comment_ids, commentPk] }
          : p
      ),
    });
  }

  // ── Outbound History State ─────────────────────────────────────────────────

  export function appendOutboundHistory(entry: OutboundEntry): void {
    const data = readJSON<OutboundHistory>(PATHS.outboundHistory, { commented: [] });
    writeJSON(PATHS.outboundHistory, { commented: [...data.commented, entry] });
  }

  export function pruneOutboundHistory(): void {
    const data = readJSON<OutboundHistory>(PATHS.outboundHistory, { commented: [] });
    const cutoff = Date.now() - OUTBOUND_RETENTION_MS;
    writeJSON(PATHS.outboundHistory, {
      commented: data.commented.filter(e => e.commented_at > cutoff),
    });
  }

  export function isAlreadyCommented(mediaPk: string): boolean {
    const data = readJSON<OutboundHistory>(PATHS.outboundHistory, { commented: [] });
    return data.commented.some(e => e.media_pk === mediaPk);
  }

  export function getTodayOutboundCount(): number {
    const data = readJSON<OutboundHistory>(PATHS.outboundHistory, { commented: [] });
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return data.commented.filter(e => e.commented_at >= todayStart.getTime()).length;
  }
  ```

- [ ] **Step 4: Run tests to verify state helpers pass**

  Run: `npx vitest run tests/comment-engine.test.ts`
  Expected: all state helper tests PASS

- [ ] **Step 5: Commit**

  ```bash
  git add skill/scripts/comment-engine.ts tests/comment-engine.test.ts
  git commit -m "feat: comment-engine state helpers (scheduleCommentCheck, getPendingReplies, outbound history)"
  ```

---

### Task 7: Implement replyToComments()

**Files:**
- Modify: `skill/scripts/comment-engine.ts` (append to end of file)
- Modify: `tests/comment-engine.test.ts` (add new describe block)

- [ ] **Step 1: Write failing tests for replyToComments**

  Add at the top of `tests/comment-engine.test.ts` (with other imports):
  ```typescript
  import { vi } from 'vitest';
  import * as bridgeClient from '../skill/scripts/instagram-bridge-client';
  import * as llmClient from '../skill/scripts/llm-client';
  import { replyToComments } from '../skill/scripts/comment-engine';
  ```

  Add a new describe block at the bottom of the test file:
  ```typescript
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
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `npx vitest run tests/comment-engine.test.ts --reporter=verbose 2>&1 | tail -15`
  Expected: FAIL — `replyToComments` not exported

- [ ] **Step 3: Implement replyToComments**

  Append to `skill/scripts/comment-engine.ts`:
  ```typescript
  // ── Spam Filter ────────────────────────────────────────────────────────────

  const SPAM_PATTERN = /^[\p{Emoji}\s]+$/u;

  function isSpam(text: string): boolean {
    return SPAM_PATTERN.test(text.trim()) || text.trim().length < 3;
  }

  // ── Passive Reply ──────────────────────────────────────────────────────────

  export interface ReplyContext {
    caption: string;
    hashtags: string[];
    emotionSummary?: string;
    voiceDirective?: string;
  }

  export async function replyToComments(mediaPk: string, postContext: ReplyContext): Promise<void> {
    const pending = readJSON<PendingEngagement>(PATHS.pendingEngagement, { pending_replies: [] });
    const entry = pending.pending_replies.find(p => p.media_pk === mediaPk);
    const repliedIds = new Set(entry?.replied_comment_ids ?? []);

    let comments: InstagramComment[];
    try {
      comments = await getComments(mediaPk, 20);
    } catch (err) {
      console.error(`[comment-engine] getComments failed for ${mediaPk}: ${(err as Error).message}`);
      return;
    }

    // Filter: skip already replied + spam, sort by engagement, cap at 10
    const eligible = comments
      .filter(c => !repliedIds.has(c.comment_pk))
      .filter(c => !isSpam(c.text))
      .sort((a, b) => b.like_count - a.like_count)
      .slice(0, 10);

    if (eligible.length === 0) {
      console.log(`[comment-engine] No eligible comments for ${mediaPk}`);
      return;
    }

    const commentsJson = JSON.stringify(
      eligible.map(c => ({ comment_pk: c.comment_pk, username: c.username, text: c.text }))
    );
    const template = readTemplate('comment-reply-prompt.md');
    const prompt = template
      .replace('{emotion_summary}', postContext.emotionSummary ?? '心情还好')
      .replace('{voice_directive}', postContext.voiceDirective ?? '')
      .replace('{post_caption}', postContext.caption)
      .replace('{comments_json}', commentsJson);

    let replies: Array<{ comment_pk: string; reply: string }> = [];
    try {
      replies = await callLLMJSON(prompt, 600, 'comment-engine-reply') as typeof replies;
    } catch (err) {
      console.error(`[comment-engine] LLM reply generation failed: ${(err as Error).message}`);
      return;
    }

    for (const r of replies) {
      const comment = eligible.find(c => c.comment_pk === r.comment_pk);
      if (!comment) continue;

      try {
        await replyComment(mediaPk, r.comment_pk, r.reply);
        markReplied(mediaPk, r.comment_pk);

        // Update social graph if relation exists
        const relationPath = path.join(PATHS.socialInstagramDir, `${comment.user_id}.json`);
        if (fs.existsSync(relationPath)) {
          const relation = readJSON<SocialRelation>(relationPath, null as unknown as SocialRelation);
          if (relation) {
            const updated = applyClosenessChange(relation, 'reply_sent', new Date().toISOString());
            writeSocialRelation(PATHS.socialInstagramDir, updated);
          }
        }

        appendText(PATHS.diary, `\n回复了 @${comment.username} 的评论: 「${r.reply}」\n`);
        console.log(`[comment-engine] Replied to @${comment.username}`);
      } catch (err) {
        console.error(`[comment-engine] Failed to reply to ${comment.comment_pk}: ${(err as Error).message}`);
      }
    }
  }
  ```

- [ ] **Step 4: Run tests to verify they pass**

  Run: `npx vitest run tests/comment-engine.test.ts`
  Expected: all tests PASS

- [ ] **Step 5: Commit**

  ```bash
  git add skill/scripts/comment-engine.ts tests/comment-engine.test.ts
  git commit -m "feat: replyToComments — passive comment reply with spam filter and social graph update"
  ```

---

### Task 8: Implement engageOutbound()

**Files:**
- Modify: `skill/scripts/comment-engine.ts` (append)
- Modify: `tests/comment-engine.test.ts` (add describe block)

- [ ] **Step 1: Write failing tests for engageOutbound**

  Add import at top of test file:
  ```typescript
  import { engageOutbound } from '../skill/scripts/comment-engine';
  ```

  Add describe block at bottom:
  ```typescript
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
        posts: [{ pk: 'already_done', code: 'existing_user', like_count: 100, comment_count: 5, caption_text: 'great cos', thumbnail_url: null }],
      });
      vi.spyOn(bridgeClient, 'postComment').mockResolvedValue({ success: true, comment_pk: 'c1' });
      vi.spyOn(llmClient, 'callLLMJSON').mockResolvedValue([]);

      await engageOutbound({ socialIntentIntensity: 8, emotionSummary: 'good', hashtags: ['cosplay'] });
      expect(bridgeClient.postComment).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `npx vitest run tests/comment-engine.test.ts --reporter=verbose 2>&1 | tail -15`
  Expected: FAIL — `engageOutbound` not exported

- [ ] **Step 3: Implement engageOutbound**

  Append to `skill/scripts/comment-engine.ts`:
  ```typescript
  // ── Active Outbound Engagement ─────────────────────────────────────────────

  export interface OutboundContext {
    socialIntentIntensity: number;
    emotionSummary: string;
    hashtags: string[];
    followingUserIds?: string[];
  }

  export async function engageOutbound(ctx: OutboundContext): Promise<void> {
    if (getTodayOutboundCount() >= MAX_DAILY_OUTBOUND) {
      console.log('[comment-engine] Daily outbound quota reached (5), skipping');
      return;
    }

    pruneOutboundHistory();

    // 1. Discover candidates
    type Candidate = { media_pk: string; username: string; caption: string; like_count: number; comment_count: number };
    const candidates: Candidate[] = [];

    for (const tag of ctx.hashtags.slice(0, 3)) {
      try {
        const result = await hashtagTop(tag, 5) as { posts: Array<{ pk: string; code: string; caption_text: string; like_count: number; comment_count: number }> };
        for (const p of result.posts ?? []) {
          if (!isAlreadyCommented(p.pk)) {
            candidates.push({ media_pk: p.pk, username: p.code, caption: (p.caption_text ?? '').slice(0, 100), like_count: p.like_count, comment_count: p.comment_count });
          }
        }
      } catch (err) {
        console.error(`[comment-engine] hashtagTop failed for ${tag}: ${(err as Error).message}`);
      }
    }

    for (const userId of (ctx.followingUserIds ?? []).slice(0, 5)) {
      try {
        const feed = await getUserFeed(userId, 3);
        for (const m of feed) {
          if (!isAlreadyCommented(m.media_pk)) {
            candidates.push({ media_pk: m.media_pk, username: userId, caption: m.caption.slice(0, 100), like_count: m.like_count, comment_count: m.comment_count });
          }
        }
      } catch (err) {
        console.error(`[comment-engine] getUserFeed failed for ${userId}: ${(err as Error).message}`);
      }
    }

    if (candidates.length === 0) {
      console.log('[comment-engine] No candidates for outbound engagement');
      return;
    }

    // 2. LLM: select and generate comments
    const template = readTemplate('outbound-comment-prompt.md');
    const prompt = template
      .replace('{emotion_summary}', ctx.emotionSummary)
      .replace('{social_intent_intensity}', String(Math.round(ctx.socialIntentIntensity)))
      .replace('{candidates_json}', JSON.stringify(candidates.slice(0, 10)));

    let planned: Array<{ media_pk: string; username: string; comment: string }> = [];
    try {
      planned = await callLLMJSON(prompt, 400, 'comment-engine-outbound') as typeof planned;
    } catch (err) {
      console.error(`[comment-engine] LLM outbound generation failed: ${(err as Error).message}`);
      return;
    }

    // 3. Post comments
    let postedCount = 0;
    for (const plan of planned) {
      if (getTodayOutboundCount() >= MAX_DAILY_OUTBOUND) break;
      if (isAlreadyCommented(plan.media_pk)) continue;

      try {
        await postComment(plan.media_pk, plan.comment);
        appendOutboundHistory({ media_pk: plan.media_pk, user_id: plan.username, commented_at: Date.now() });

        const relationPath = path.join(PATHS.socialInstagramDir, `${plan.username}.json`);
        if (fs.existsSync(relationPath)) {
          const relation = readJSON<SocialRelation>(relationPath, null as unknown as SocialRelation);
          if (relation) {
            const updated = applyClosenessChange(relation, 'comment_sent', new Date().toISOString());
            writeSocialRelation(PATHS.socialInstagramDir, updated);
          }
        }

        appendText(PATHS.diary, `\n在 @${plan.username} 的帖子下评论了: 「${plan.comment}」\n`);
        console.log(`[comment-engine] Commented on @${plan.username}`);
        postedCount++;
      } catch (err) {
        console.error(`[comment-engine] Failed to post on ${plan.media_pk}: ${(err as Error).message}`);
      }
    }

    if (postedCount > 0) {
      const todayStr = getLocalDate(new Date());
      appendText(PATHS.diary, `\n## ${todayStr}\n今天主动去cos圈评论了 ${postedCount} 个帖子～\n情绪: 开心 | 重要性: 3\n标签: 社交, cos圈\n`);
    }
  }
  ```

- [ ] **Step 4: Run all comment-engine tests**

  Run: `npx vitest run tests/comment-engine.test.ts`
  Expected: all tests PASS

- [ ] **Step 5: Run full test suite**

  Run: `npm test`
  Expected: all tests PASS

- [ ] **Step 6: Commit**

  ```bash
  git add skill/scripts/comment-engine.ts tests/comment-engine.test.ts
  git commit -m "feat: engageOutbound — active outbound comment with daily quota and dedup"
  ```

---

## Chunk 4: Integration — post-pipeline + heartbeat

### Task 9: Wire scheduleCommentCheck into post-pipeline.ts

**Files:**
- Modify: `skill/scripts/post-pipeline.ts`

- [ ] **Step 1: Add import**

  In `skill/scripts/post-pipeline.ts`, in the imports section at the top (after the existing imports), add:
  ```typescript
  import { scheduleCommentCheck } from './comment-engine';
  ```

- [ ] **Step 2: Locate the postToInstagram success point**

  Find the block that looks like:
  ```typescript
  const mediaPk = await postToInstagram(existingPhotos, caption);
  ```
  This is inside the `try` block of `runPipeline()`. The line immediately after is where we insert our call.

- [ ] **Step 3: Insert scheduleCommentCheck call**

  After the `const mediaPk = await postToInstagram(...)` line, and before the `// Record to post history` comment, add:
  ```typescript
  // Schedule comment replies 24h after posting
  scheduleCommentCheck({
    media_pk: mediaPk,
    scheduled_after: Date.now() + 24 * 60 * 60 * 1000,
    post_context: {
      caption: postIntent.caption,
      hashtags: postIntent.hashtags,
    },
  });
  ```

- [ ] **Step 4: Run full test suite for regressions**

  Run: `npm test`
  Expected: PASS

- [ ] **Step 5: Commit**

  ```bash
  git add skill/scripts/post-pipeline.ts
  git commit -m "feat: schedule comment reply check 24h after successful Instagram post"
  ```

---

### Task 10: Add pending-reply check to heartbeat-tick.ts

**Files:**
- Modify: `skill/scripts/heartbeat-tick.ts`

- [ ] **Step 1: Add imports**

  In `heartbeat-tick.ts`, in the imports section, add:
  ```typescript
  import { getPendingReplies, replyToComments, engageOutbound } from './comment-engine';
  ```

- [ ] **Step 2: Insert pending-reply check after voiceDirective is computed**

  In `regularTick()`, find the line:
  ```typescript
  const voiceDirective = computeVoiceDirective(flowState.status, emotion, thresholdBroke);
  ```
  (This is around line 325 in the current file.) Immediately after that line (and before the flow state judgment section), add:

  ```typescript
  // Check for pending comment replies (posts that are ~24h old)
  try {
    const pendingReplies = getPendingReplies();
    for (const pending of pendingReplies) {
      console.log(`[heartbeat] Checking comments for post ${pending.media_pk}`);
      await replyToComments(pending.media_pk, {
        caption: pending.post_context.caption,
        hashtags: pending.post_context.hashtags,
        emotionSummary: `${emotion.mood.description}，valence ${emotion.mood.valence.toFixed(1)}`,
        voiceDirective,
      });
    }
  } catch (err) {
    console.error(`[heartbeat] Pending reply check failed: ${(err as Error).message}`);
  }
  ```

- [ ] **Step 3: Run full test suite**

  Run: `npm test`
  Expected: PASS

- [ ] **Step 4: Commit**

  ```bash
  git add skill/scripts/heartbeat-tick.ts
  git commit -m "feat: check pending comment replies at each heartbeat tick"
  ```

---

### Task 11: Add social-engagement action routing

**Files:**
- Modify: `skill/scripts/heartbeat-tick.ts`

- [ ] **Step 1: Locate the real action dispatch block**

  In `heartbeat-tick.ts`, find the `else if (action.type === 'real' && action.skill)` block (around line 559). It currently ends with:
  ```typescript
  console.log(`[REAL ACTION] Unknown skill: ${action.skill} for: ${action.action}`);
  actionResults.push(`[real] ${action.action}`);
  ```

- [ ] **Step 2: Insert social-engagement routing before the unknown-skill fallback**

  Replace the content from the search-intent block through the unknown-skill log line:
  ```typescript
  // Search pipeline routing
  const isSearchIntent = /search|搜|查|学习|研究|了解/.test(lowerSkill);
  if (isSearchIntent) {
    if (vitalityConstraints.canSearch) {
      vitality = await executeSearch(action, vitality, actionResults, voiceDirective);
    } else {
      console.log(`[SEARCH] Skipped — vitality too low (${vitality.vitality})`);
      actionResults.push(`[skipped:low-vitality] ${action.action}`);
    }
    continue;
  }
  // Social engagement routing
  const isSocialEngagement = /social.engagement|互动|评论|刷动态|cos圈/.test(lowerSkill);
  if (isSocialEngagement) {
    if (vitalityConstraints.canDoHeavySocial) {
      try {
        const inspiration = readJSON<{ hashtags?: string[] }>(PATHS.inspiration, {});
        const hashtags = inspiration.hashtags ?? [];
        const relationsForEngagement = readAllJSON<SocialRelation>(PATHS.socialInstagramDir);
        const followingIds = relationsForEngagement
          .filter(r => classifyTier(r.relationship.closeness) === 'core' || classifyTier(r.relationship.closeness) === 'familiar')
          .map(r => r.id)
          .slice(0, 10);
        await engageOutbound({
          socialIntentIntensity: topIntents[0]?.intensity ?? 5,
          emotionSummary: `${emotion.mood.description}，valence ${emotion.mood.valence.toFixed(1)}`,
          hashtags,
          followingUserIds: followingIds,
        });
        vitality = applyActionCost(vitality, 'high_social');
      } catch (err) {
        console.error(`[heartbeat] Social engagement failed: ${(err as Error).message}`);
      }
    } else {
      console.log(`[SOCIAL] Skipped — vitality too low (${vitality.vitality})`);
    }
    actionResults.push(`[social-engagement] ${action.action}`);
    continue;
  }
  console.log(`[REAL ACTION] Unknown skill: ${action.skill} for: ${action.action}`);
  actionResults.push(`[real] ${action.action}`);
  ```

  Note: `topIntents` is the top intent array. Check that `getTopIntents` is already called earlier in regularTick — if not, use `getTopIntentsRaw(intentPool, 1)` instead and take `[0]`.

- [ ] **Step 3: Run full test suite**

  Run: `npm test`
  Expected: PASS

- [ ] **Step 4: Commit**

  ```bash
  git add skill/scripts/heartbeat-tick.ts
  git commit -m "feat: route social-engagement action to engageOutbound in heartbeat"
  ```

---

### Task 12: Document social-engagement in heartbeat-prompt.md

**Files:**
- Modify: `skill/templates/heartbeat-prompt.md`

- [ ] **Step 1: Find the real actions list in the template**

  Run this to find where real skills are documented:
  ```bash
  grep -n "post-pipeline\|search\|real" skill/templates/heartbeat-prompt.md | head -20
  ```

- [ ] **Step 2: Add social-engagement to the list**

  In the section documenting available `real` skills, add:
  ```
  - `social-engagement`：去cos圈刷动态，给感兴趣的帖子评论（需社交意图强、活力充足）
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add skill/templates/heartbeat-prompt.md
  git commit -m "docs: add social-engagement to heartbeat-prompt available real actions"
  ```

---

## Chunk 5: Type Check + Final Verification

### Task 13: TypeScript type-check and full test run

**Files:** No new files — verification only

- [ ] **Step 1: Run TypeScript type-check**

  Run: `npm run typecheck`
  Expected: 0 errors

  Common issues to fix if they appear:
  - `topIntents` might not be in scope at the social-engagement insertion point — use `getTopIntentsRaw(intentPool, 1)` which returns the same array
  - `classifyTier` is already imported in heartbeat-tick — confirm it's in the import list from social-graph-engine
  - `readAllJSON` is already imported in heartbeat-tick — confirm it's in the import from file-utils
  - If any `unknown` cast errors appear on LLM output, use `as Array<{...}>` with the explicit shape

- [ ] **Step 2: Fix any type errors**

  For each error, make the minimal fix. Re-run `npm run typecheck` after each fix.

- [ ] **Step 3: Run full test suite**

  Run: `npm test`
  Expected: all tests PASS

- [ ] **Step 4: Final commit if any fixes were needed**

  ```bash
  git add -A
  git commit -m "fix: resolve TypeScript type errors from comment-engine integration"
  ```

---

## Summary

| Task | What it builds | Key test |
|------|---------------|----------|
| 1 | `PATHS.pendingEngagement` + `PATHS.outboundHistory` | `file-utils-paths.test.ts` |
| 2 | Python bridge: 4 new commands | `--help` smoke test |
| 3 | TS wrappers + updated mocks | `instagram-bridge-client.test.ts` |
| 4 | `comment-reply-prompt.md` | — |
| 5 | `outbound-comment-prompt.md` | — |
| 6 | `comment-engine.ts` state helpers | `comment-engine.test.ts` |
| 7 | `replyToComments()` | `comment-engine.test.ts` |
| 8 | `engageOutbound()` | `comment-engine.test.ts` |
| 9 | post-pipeline → `scheduleCommentCheck` | regression: `npm test` |
| 10 | heartbeat pending-reply check | regression: `npm test` |
| 11 | heartbeat `social-engagement` routing | regression: `npm test` |
| 12 | heartbeat-prompt docs | — |
| 13 | Full type-check + test sweep | `npm run typecheck && npm test` |
