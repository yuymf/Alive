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
