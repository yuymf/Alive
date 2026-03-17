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
  type Candidate = { media_pk: string; user_id: string; username: string; caption: string; like_count: number; comment_count: number };
  const candidates: Candidate[] = [];

  for (const tag of ctx.hashtags.slice(0, 3)) {
    try {
      const result = await hashtagTop(tag, 5) as { posts: Array<{ pk: string; code: string; user_id: string; username: string; caption_text: string; like_count: number; comment_count: number }> };
      for (const p of result.posts ?? []) {
        if (!isAlreadyCommented(p.pk)) {
          candidates.push({ media_pk: p.pk, user_id: p.user_id, username: p.username, caption: (p.caption_text ?? '').slice(0, 100), like_count: p.like_count, comment_count: p.comment_count });
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
          candidates.push({ media_pk: m.media_pk, user_id: userId, username: userId, caption: m.caption.slice(0, 100), like_count: m.like_count, comment_count: m.comment_count });
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

  let planned: Array<{ media_pk: string; user_id: string; username: string; comment: string }> = [];
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
      appendOutboundHistory({ media_pk: plan.media_pk, user_id: plan.user_id, commented_at: Date.now() });

      const relationPath = path.join(PATHS.socialInstagramDir, `${plan.user_id}.json`);
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
