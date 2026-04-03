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
} from './review-queue';
import { formatContentPackage } from './brief-generator';
import { getActiveReviewItem, setActiveReviewItem } from './review-session';
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
      return `✅ 已审批通过：${result.topic}`;
    }

    case 'discard': {
      const id = intent.item_id;
      if (!id) return '⚠️ 没有指定要弃置的内容项。';
      const result = await markDiscarded(id);
      if (!result) return `⚠️ 无法弃置内容项 ${id}`;
      setActiveReviewItem(null);
      return `🗑️ 已弃置：${result.topic}`;
    }

    case 'edit': {
      const id = intent.item_id;
      if (!id) return '⚠️ 没有指定要编辑的内容项。';
      const field = intent.field ?? 'unknown';
      const instruction = intent.instruction ?? input;
      const result = await updateItemContent(id, {}, { instruction, field });
      if (!result) return `⚠️ 无法编辑内容项 ${id}`;
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
