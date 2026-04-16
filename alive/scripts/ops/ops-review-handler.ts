/**
 * ops-review-handler.ts
 * Handles natural-language review messages by dispatching through message-parser
 * and executing the corresponding lifecycle mutations on the review queue.
 *
 * This is the bridge between the user's free-text input (via /alive or WeChat)
 * and the structured review queue lifecycle APIs.
 */

import { parseMessage } from '../../sub-skills/ops-desk/scripts/message-parser';
import {
  getItem, markApproved, markDiscarded, markPublished,
  updateItemContent, getPendingItems, loadQueue,
  addReviewFeedback,
} from './review-queue';
import { formatContentPackage } from './brief-generator';
import { getActiveReviewItem, setActiveReviewItem, appendEditTurn, buildEditConversationContext } from './review-session';
import type { LLMClient } from '../utils/llm-client';

/**
 * Process a free-text review message.
 * Returns a human-readable reply string.
 */
export async function handleReviewMessage(input: string, llm: LLMClient): Promise<string> {
  const activeItemId = getActiveReviewItem();
  const parsed = await parseMessage(input, activeItemId, llm);

  if (parsed.type === 'slash') {
    return `⚠️ 请使用 /alive ${parsed.cmd.command} ${parsed.cmd.args.join(' ')} 来执行命令`;
  }

  const intent = parsed.intent;

  switch (intent.action) {
    case 'approve': {
      const id = intent.item_id;
      if (!id) return '⚠️ 没有指定要审批的内容项。先用 /alive post N 选择一个选题。';
      const result = await markApproved(id);
      if (!result) return `⚠️ 无法审批内容项 ${id}（可能状态不对或不存在）`;
      // Write structured review feedback
      await addReviewFeedback(id, {
        decision: 'approved',
        source: 'chat',
        reason_summary: intent.reason_summary ?? '运营确认',
        persona_deviation_tags: intent.persona_deviation_tags,
        risk_tags: intent.risk_tags,
        platform_fit_tags: intent.platform_fit_tags,
        improvement_directions: intent.improvement_directions,
      });
      return `✅ 已审批通过：${result.topic}`;
    }

    case 'discard': {
      const id = intent.item_id;
      if (!id) return '⚠️ 没有指定要弃置的内容项。';
      const result = await markDiscarded(id);
      if (!result) return `⚠️ 无法弃置内容项 ${id}`;
      // Write structured review feedback
      await addReviewFeedback(id, {
        decision: 'discarded',
        source: 'chat',
        reason_summary: intent.reason_summary ?? '运营否决',
        persona_deviation_tags: intent.persona_deviation_tags,
        risk_tags: intent.risk_tags,
        improvement_directions: intent.improvement_directions,
      });
      setActiveReviewItem(null);
      return `🗑️ 已弃置：${result.topic}`;
    }

    case 'edit': {
      const id = intent.item_id;
      if (!id) return '⚠️ 没有指定要编辑的内容项。';
      const field = intent.field ?? 'unknown';
      const instruction = intent.instruction ?? input;

      // Retrieve the current item for LLM context
      const currentItem = await getItem(id);
      if (!currentItem) return `⚠️ 找不到内容项 ${id}`;

      // Record operator's edit instruction as a conversation turn
      appendEditTurn({ role: 'operator', content: instruction, field });

      // Build conversation context for multi-turn editing
      const conversationCtx = buildEditConversationContext();

      // Attempt LLM-based content rewrite
      try {
        const rewriteResult = await rewriteContentField(currentItem, field, instruction, conversationCtx, llm);

        if (rewriteResult) {
          // Apply the rewrite to the queue item
          const result = await updateItemContent(id, rewriteResult.content, { instruction, field });
          if (!result) return `⚠️ 无法编辑内容项 ${id}`;

          // Record AI's response as a conversation turn
          appendEditTurn({ role: 'ai', content: rewriteResult.summary, field });

          // Write structured review feedback for edit request
          await addReviewFeedback(id, {
            decision: 'edit_requested',
            source: 'chat',
            reason_summary: intent.reason_summary ?? instruction,
            improvement_directions: intent.improvement_directions ?? [instruction],
          });

          return `✏️ 已修改「${field}」：${rewriteResult.summary}\n\n可以继续说修改意见，或回复"好"确认`;
        }
      } catch (err) {
        console.error(`[ops-review-handler] LLM rewrite failed:`, (err as Error).message);
      }

      // Fallback: just record the edit instruction without rewriting
      const result = await updateItemContent(id, {}, { instruction, field });
      if (!result) return `⚠️ 无法编辑内容项 ${id}`;
      // Write structured review feedback for edit request
      await addReviewFeedback(id, {
        decision: 'edit_requested',
        source: 'chat',
        reason_summary: intent.reason_summary ?? instruction,
        improvement_directions: intent.improvement_directions ?? [instruction],
      });
      return `✏️ 已记录修改意见：${instruction}`;
    }

    case 'publish': {
      const id = intent.item_id;
      const platform = intent.field as 'xhs' | 'douyin' | undefined;
      const url = intent.instruction;
      if (!platform || !url) return '⚠️ 请提供平台 URL，例如：已发 https://www.xiaohongshu.com/explore/xxx';
      if (!id) {
        // Try to find most recent approved/pending item to publish
        const queue = await loadQueue();
        const candidates = queue.items.filter(i =>
          i.status === 'pending' || i.status === 'approved'
        );
        if (candidates.length === 0) return '⚠️ 队列中没有可发布的内容。';
        // Use the last one (most recent)
        const target = candidates[candidates.length - 1];
        const result = await markPublished(target.id, { platform, url });
        if (!result) return `⚠️ 发布记录失败`;
        return `✅ 已记录发布链接：${result.topic}\n📎 ${platform}: ${url}`;
      }
      const result = await markPublished(id, { platform, url });
      if (!result) return `⚠️ 无法记录发布信息（ID: ${id}）`;
      return `✅ 已记录发布链接：${result.topic}\n📎 ${platform}: ${url}`;
    }

    case 'list': {
      const pending = await getPendingItems();
      if (pending.length === 0) return '📭 没有待审核的选题';
      const lines = [`📋 待审核选题（${pending.length}个）`, ''];
      pending.forEach((item, idx) => {
        lines.push(`${idx + 1}️⃣  ${item.topic}`);
        lines.push(`   ${item.trend_hook}`);
      });
      lines.push('', '回复 /alive post N 查看详情');
      return lines.join('\n');
    }

    case 'unknown':
    default:
      if (activeItemId) {
        const item = await getItem(activeItemId);
        if (item) {
          return `💭 没有理解你的意思。当前正在审核「${item.topic}」，可以说：\n• "好/发" — 审批通过\n• "不要了" — 弃置\n• "标题改成xxx" — 修改\n• "已发 <URL>" — 记录发布`;
        }
      }
      return '💭 没有理解你的意思。试试 /alive help 查看可用命令。';
  }
}

// ─── LLM-based Content Rewrite ───────────────────────────────────────────────

import type { QueueItem, QueueItemContent } from '../utils/types';

interface RewriteResult {
  content: Partial<QueueItemContent>;
  summary: string;
}

/**
 * Rewrite a specific field of a queue item's content using LLM,
 * with conversation context for multi-turn editing.
 */
async function rewriteContentField(
  item: QueueItem,
  field: string,
  instruction: string,
  conversationContext: string,
  llm: LLMClient,
): Promise<RewriteResult | null> {
  // Determine which content to show and which field to rewrite
  const xhs = item.content.xhs;
  const douyin = item.content.douyin;

  // Map field names to actual content fields
  const fieldMap: Record<string, { platform: 'xhs' | 'douyin'; key: string; current: string }> = {
    '标题': { platform: 'xhs', key: 'title', current: xhs.title },
    'title': { platform: 'xhs', key: 'title', current: xhs.title },
    '正文': { platform: 'xhs', key: 'body', current: xhs.body },
    'body': { platform: 'xhs', key: 'body', current: xhs.body },
    '标签': { platform: 'xhs', key: 'tags', current: xhs.tags.join(' ') },
    'tags': { platform: 'xhs', key: 'tags', current: xhs.tags.join(' ') },
    '脚本': { platform: 'douyin', key: 'script', current: douyin.script },
    'script': { platform: 'douyin', key: 'script', current: douyin.script },
  };

  // Try to match field; if not found, default to xhs body
  const target = fieldMap[field] ?? fieldMap['正文'];

  const prompt = `你是一个内容编辑助手。请根据运营的修改意见，重写以下内容。

【选题】${item.topic}
【身份模式】${item.identity_mode}

【当前内容（${target.key}）】
${target.current}

${conversationContext}

【本次修改意见】
${instruction}

要求：
1. 仅返回修改后的内容文本，不要添加任何解释或前缀
2. 保持原有风格和人设
3. 精准执行运营的修改要求
4. 如果之前有修改对话，要在上一轮修改的基础上继续调整`;

  try {
    const rewritten = await llm.call(prompt, 2000);
    if (!rewritten || rewritten.length < 5) return null;

    const trimmed = rewritten.trim();

    // Build the content update
    const content: Partial<QueueItemContent> = {};
    if (target.platform === 'xhs') {
      if (target.key === 'title') {
        content.xhs = { ...xhs, title: trimmed };
      } else if (target.key === 'body') {
        content.xhs = { ...xhs, body: trimmed };
      } else if (target.key === 'tags') {
        const newTags = trimmed.replace(/[#＃]/g, '').split(/[\s,，;；]+/).filter(Boolean);
        content.xhs = { ...xhs, tags: newTags };
      }
    } else {
      if (target.key === 'script') {
        content.douyin = { ...douyin, script: trimmed };
      }
    }

    // Generate a one-line summary of what changed
    const oldPreview = target.current.slice(0, 30);
    const newPreview = trimmed.slice(0, 30);
    const summary = oldPreview !== newPreview
      ? `${target.key}: "${oldPreview}..." → "${newPreview}..."`
      : `已根据意见调整 ${target.key}`;

    return { content, summary };
  } catch {
    return null;
  }
}
