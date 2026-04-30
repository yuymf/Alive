// alive/sub-skills/social-engagement/scripts/index.ts
// Social engagement sub-skill — comment replies & outbound engagement
//
// Generalized from skill/scripts/comment-engine.ts
// Removes Instagram-specific API imports; uses abstract platform operations
// that the host application injects via ctx.config.

import * as fs from 'fs';
import * as path from 'path';
import type { SubSkillContext, SubSkillResult } from '../../../scripts/router/sub-skill-sdk';
import { createResult, createFeedback } from '../../../scripts/router/sub-skill-sdk';

// ── Types ────────────────────────────────────────────────────────

export interface PendingReply {
  media_pk: string;
  scheduled_after: number;
  post_context: { caption: string; hashtags: string[] };
  replied_comment_ids: string[];
}

export interface OutboundEntry {
  media_pk: string;
  user_id: string;
  commented_at: number;
}

interface Comment {
  comment_pk: string;
  username: string;
  user_id: string;
  text: string;
  like_count: number;
}

interface OutboundCandidate {
  media_pk: string;
  user_id: string;
  username: string;
  caption: string;
  like_count: number;
  comment_count: number;
}

// ── Constants ────────────────────────────────────────────────────

const MAX_DAILY_OUTBOUND = 5;
const MAX_COMMENTS_PER_USER_24H = 2;
const OUTBOUND_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Spam Filter ──────────────────────────────────────────────────

const SPAM_PATTERN = /^[\p{Emoji}\p{Emoji_Component}\s]+$/u;

export function isSpam(text: string): boolean {
  return SPAM_PATTERN.test(text.trim()) || text.trim().length < 3;
}

// ── Template Loader ──────────────────────────────────────────────

function loadTemplate(templateName: string): string {
  const templateDir = path.join(__dirname, '..', 'templates');
  const templatePath = path.join(templateDir, templateName);
  if (fs.existsSync(templatePath)) return fs.readFileSync(templatePath, 'utf8');
  throw new Error(`Template not found: ${templateName}`);
}

// ── State Helpers (via MemoryAccessor) ───────────────────────────

function readOutboundHistory(ctx: SubSkillContext): OutboundEntry[] {
  return ctx.memory.readJSON<{ commented: OutboundEntry[] }>('outbound-history', { commented: [] }).commented;
}

function writeOutboundHistory(ctx: SubSkillContext, entries: OutboundEntry[]): void {
  ctx.memory.writeJSON('outbound-history', { commented: entries });
}

function getTodayOutboundCount(ctx: SubSkillContext): number {
  const entries = readOutboundHistory(ctx);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return entries.filter(e => e.commented_at >= todayStart.getTime()).length;
}

function isAlreadyCommented(ctx: SubSkillContext, mediaPk: string): boolean {
  return readOutboundHistory(ctx).some(e => e.media_pk === mediaPk);
}

function getRecentCommentCountForUser(ctx: SubSkillContext, userId: string): number {
  const entries = readOutboundHistory(ctx);
  const windowStart = Date.now() - 24 * 60 * 60 * 1000;
  return entries.filter(e => e.user_id === userId && e.commented_at > windowStart).length;
}

function pruneOutboundHistory(ctx: SubSkillContext): void {
  const entries = readOutboundHistory(ctx);
  const cutoff = Date.now() - OUTBOUND_RETENTION_MS;
  writeOutboundHistory(ctx, entries.filter(e => e.commented_at > cutoff));
}

// ── Actions ──────────────────────────────────────────────────────

export const actions = {
  /**
   * Reply to comments on own posts.
   *
   * Expects ctx.config to contain:
   *   - getComments(mediaPk, limit): Promise<Comment[]>
   *   - replyComment(mediaPk, commentPk, text): Promise<void>
   *   - pendingMediaPks?: string[]  (media PKs with pending replies)
   *   - postCaptions?: Record<string, string>  (mediaPk → caption)
   */
  async 'comment-reply'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const { persona, emotion, llm, config, memory } = ctx;

    const getComments = config.getComments as ((mediaPk: string, limit: number) => Promise<Comment[]>) | undefined;
    const replyComment = config.replyComment as ((mediaPk: string, commentPk: string, text: string) => Promise<void>) | undefined;
    const pendingMediaPks = (config.pendingMediaPks as string[]) ?? [];
    const postCaptions = (config.postCaptions as Record<string, string>) ?? {};

    if (!getComments || !replyComment || pendingMediaPks.length === 0) {
      return createResult('没有需要回复的评论', { vitality_cost: 0 });
    }

    const voiceStyle = persona.voice?.style ?? '';
    const emotionSummary = `${emotion.mood.description} (v:${emotion.mood.valence.toFixed(1)})`;
    let totalReplies = 0;

    for (const mediaPk of pendingMediaPks) {
      // Read pending state
      const pending = memory.readJSON<{ pending_replies: PendingReply[] }>('pending-engagement', { pending_replies: [] });
      const entry = pending.pending_replies.find(p => p.media_pk === mediaPk);
      const repliedIds = new Set(entry?.replied_comment_ids ?? []);

      let comments: Comment[];
      try {
        comments = await getComments(mediaPk, 20);
      } catch (err) {
        console.error(`[social-engagement] getComments failed for ${mediaPk}: ${(err as Error).message}`);
        continue;
      }

      // Filter: skip already replied + spam
      const eligible = comments
        .filter(c => !repliedIds.has(c.comment_pk))
        .filter(c => !isSpam(c.text))
        .sort((a, b) => b.like_count - a.like_count)
        .slice(0, 10);

      if (eligible.length === 0) continue;

      const commentsJson = JSON.stringify(
        eligible.map(c => ({ comment_pk: c.comment_pk, username: c.username, text: c.text })),
      );

      const template = loadTemplate('comment-reply-prompt.md');
      const prompt = template
        .replace('{emotion_summary}', emotionSummary)
        .replace('{voice_directive}', voiceStyle)
        .replace('{post_caption}', postCaptions[mediaPk] ?? '')
        .replace('{comments_json}', commentsJson)
        .replace(/\{persona\.meta\.name\}/g, persona.meta.name)
        .replace(/\{persona\.meta\.tagline\}/g, persona.meta.tagline ?? '');

      let replies: Array<{ comment_pk: string; reply: string }>;
      try {
        replies = await llm.callJSON<typeof replies>(prompt, 800);
      } catch {
        continue;
      }

      for (const r of replies) {
        const comment = eligible.find(c => c.comment_pk === r.comment_pk);
        if (!comment) continue;

        try {
          await replyComment(mediaPk, r.comment_pk, r.reply);

          // Mark as replied
          const currentPending = memory.readJSON<{ pending_replies: PendingReply[] }>('pending-engagement', { pending_replies: [] });
          memory.writeJSON('pending-engagement', {
            pending_replies: currentPending.pending_replies.map(p =>
              p.media_pk === mediaPk
                ? { ...p, replied_comment_ids: [...p.replied_comment_ids, r.comment_pk] }
                : p,
            ),
          });

          // Update social graph
          if (comment.user_id) {
            ctx.socialGraph.updateRelation(comment.user_id, {
              last_interaction: new Date().toISOString(),
            });
          }

          totalReplies++;

          // Delay between comment posts to avoid rate limiting
          await new Promise(r => setTimeout(r, 2000));
        } catch (err) {
          console.error(`[social-engagement] Reply failed: ${(err as Error).message}`);
        }
      }
    }

    if (totalReplies === 0) {
      return createResult('看了看评论，暂时没什么要回复的', { vitality_cost: 5 });
    }

    return createResult(
      `回复了 ${totalReplies} 条评论`,
      {
        vitality_cost: 15,
        emotion_deltas: [{ sociability: 0.05, valence: 0.03 }],
        feedback: [createFeedback('comment-reply', totalReplies, 3)],
      },
    );
  },

  /**
   * Active outbound engagement — comment on other people's content.
   *
   * Expects ctx.config to contain:
   *   - getCandidates(): Promise<OutboundCandidate[]>
   *   - postComment(mediaPk, text): Promise<void>
   */
  async 'social-engagement'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const { persona, emotion, intent, llm, config } = ctx;

    const getCandidates = config.getCandidates as (() => Promise<OutboundCandidate[]>) | undefined;
    const postComment = config.postComment as ((mediaPk: string, text: string) => Promise<void>) | undefined;

    if (!getCandidates || !postComment) {
      return createResult(
        '想去社交互动但平台 API 未配置',
        { vitality_cost: 0 },
      );
    }

    if (getTodayOutboundCount(ctx) >= MAX_DAILY_OUTBOUND) {
      return createResult(
        '今天已经评论够多了，不想太刻意',
        { vitality_cost: 0 },
      );
    }

    pruneOutboundHistory(ctx);

    // 1. Get candidates
    let candidates: OutboundCandidate[];
    try {
      candidates = await getCandidates();
    } catch (err) {
      console.error(`[social-engagement] getCandidates failed: ${(err as Error).message}`);
      return createResult('刷了刷但没找到想评论的', { vitality_cost: 5 });
    }

    // Filter out already commented
    candidates = candidates.filter(
      c => !isAlreadyCommented(ctx, c.media_pk) && getRecentCommentCountForUser(ctx, c.user_id) < MAX_COMMENTS_PER_USER_24H,
    );

    if (candidates.length === 0) {
      return createResult('刷了刷没看到什么想评论的帖子', { vitality_cost: 5 });
    }

    // 2. LLM: select and generate comments
    const voiceStyle = persona.voice?.style ?? '';
    const emotionSummary = `${emotion.mood.description} (v:${emotion.mood.valence.toFixed(1)})`;

    const template = loadTemplate('outbound-comment-prompt.md');
    const prompt = template
      .replace('{emotion_summary}', emotionSummary)
      .replace('{social_intent_intensity}', String(Math.round(intent.intensity)))
      .replace('{candidates_json}', JSON.stringify(candidates.slice(0, 10)))
      .replace(/\{persona\.meta\.name\}/g, persona.meta.name)
      .replace(/\{persona\.meta\.tagline\}/g, persona.meta.tagline ?? '');

    let planned: Array<{ media_pk: string; user_id: string; username: string; comment: string }>;
    try {
      planned = await llm.callJSON<typeof planned>(prompt, 800);
    } catch (err) {
      console.error(`[social-engagement] LLM outbound failed: ${(err as Error).message}`);
      return createResult('想评论但没想好说什么', { vitality_cost: 5 });
    }

    // 3. Post comments
    let postedCount = 0;
    const postedUserIds = new Set<string>();

    for (const plan of planned) {
      if (getTodayOutboundCount(ctx) >= MAX_DAILY_OUTBOUND) break;
      if (isAlreadyCommented(ctx, plan.media_pk)) continue;
      if (getRecentCommentCountForUser(ctx, plan.user_id) >= MAX_COMMENTS_PER_USER_24H) continue;
      if (postedUserIds.has(plan.user_id)) continue;

      try {
        await postComment(plan.media_pk, plan.comment);

        // Record in outbound history
        const entries = readOutboundHistory(ctx);
        entries.push({ media_pk: plan.media_pk, user_id: plan.user_id, commented_at: Date.now() });
        writeOutboundHistory(ctx, entries);

        // Update social graph
        ctx.socialGraph.updateRelation(plan.user_id, {
          last_interaction: new Date().toISOString(),
        });

        postedUserIds.add(plan.user_id);
        postedCount++;

        // Delay between comment posts to avoid rate limiting
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        console.error(`[social-engagement] Post comment failed: ${(err as Error).message}`);
      }
    }

    if (postedCount === 0) {
      return createResult('评论没发出去', { vitality_cost: 5 });
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    ctx.memory.appendDiary(
      `\n## ${dateStr}\n今天主动去评论了 ${postedCount} 个帖子～\n情绪: ${emotion.mood.description} | 重要性: 3\n标签: 社交, 互动\n`,
    );

    return createResult(
      `主动评论了 ${postedCount} 个帖子`,
      {
        vitality_cost: 15,
        emotion_deltas: [{ sociability: 0.1, valence: 0.05 }],
        feedback: [createFeedback('outbound-engagement', postedCount, 2)],
      },
    );
  },
};
