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

// ── Spam Filter ────────────────────────────────────────────────────────────

const SPAM_PATTERN = /^[\p{Emoji}\p{Emoji_Component}\s]+$/u;

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
