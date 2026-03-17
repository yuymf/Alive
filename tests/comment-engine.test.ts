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
