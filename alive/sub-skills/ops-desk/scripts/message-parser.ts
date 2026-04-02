/**
 * message-parser.ts
 * Parses incoming WeChat Work messages into structured intents.
 * Two modes:
 *   1. Slash command: /post, /trends, /status, /brief, /idea, /help, /competitors, /positioning
 *   2. Natural language (LLM): used when a queue item is "active" in context
 */

import { ParsedIntent } from '../../../scripts/utils/types';
import { LLMClient } from '../../../scripts/utils/llm-client';

export { ParsedIntent };

export interface SlashCommand {
  command: string;
  args: string[];
}

// ─── Pure functions (exported for testing) ───────────────────────────────────

export function parseSlashCommand(input: string): SlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.slice(1).trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);
  return { command, args };
}

export function buildNluPrompt(userMessage: string, activeItemId: string): string {
  return `用户正在审核内容项 "${activeItemId}"，发送了如下消息：

"${userMessage}"

请判断用户的意图，返回 JSON：

可能的意图：
- approve: 用户想发布这条内容（"发出去"、"ok发吧"、"发"、"好"等）
- discard: 用户想丢弃这条内容（"不要了"、"弃掉"、"算了"等）
- edit: 用户想修改内容（需要提取修改字段和指令）
- list: 用户想看其他内容（"看看别的"、"其他的"等）
- unknown: 无法判断

格式（必须是合法 JSON，无 markdown）：
{"action":"approve","item_id":"${activeItemId}"}
{"action":"discard","item_id":"${activeItemId}"}
{"action":"edit","item_id":"${activeItemId}","field":"title","instruction":"修改说明"}
{"action":"list"}
{"action":"unknown","raw":"原始消息"}`;
}

export function extractIntentFromNluResponse(raw: string, itemId: string): ParsedIntent {
  try {
    // Strip markdown fences if present
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned) as ParsedIntent;
    return { ...parsed, item_id: parsed.item_id ?? itemId };
  } catch {
    return { action: 'unknown', raw };
  }
}

export function extractPlatformUrl(input: string): { platform: 'xhs' | 'douyin'; url: string } | null {
  const urlMatch = input.match(/(https?:\/\/[^\s]+)/);
  if (!urlMatch) return null;
  const url = urlMatch[1];
  if (url.includes('xiaohongshu.com') || url.includes('xhslink.com')) return { platform: 'xhs', url };
  if (url.includes('douyin.com')) return { platform: 'douyin', url };
  return null;
}

export function parsePublishIntent(input: string, activeItemId: string | null): ParsedIntent | null {
  const extracted = extractPlatformUrl(input);
  if (!extracted) return null;
  const publishKeywords = ['已发', '发了', '发布了', '上线了', '发出去了'];
  const hasPublishKeyword = publishKeywords.some(kw => input.includes(kw));
  if (hasPublishKeyword || extracted.platform) {
    return {
      action: 'publish',
      item_id: activeItemId ?? undefined,
      field: extracted.platform,
      instruction: extracted.url,
    };
  }
  return null;
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function parseMessage(
  input: string,
  activeItemId: string | null,
  llm: LLMClient,
): Promise<{ type: 'slash'; cmd: SlashCommand } | { type: 'intent'; intent: ParsedIntent }> {
  const slash = parseSlashCommand(input);
  if (slash) return { type: 'slash', cmd: slash };

  const publishIntent = parsePublishIntent(input, activeItemId);
  if (publishIntent) return { type: 'intent', intent: publishIntent };

  if (activeItemId) {
    const prompt = buildNluPrompt(input, activeItemId);
    try {
      const raw = await llm.call(prompt, 400);
      const intent = extractIntentFromNluResponse(raw, activeItemId);
      return { type: 'intent', intent };
    } catch {
      return { type: 'intent', intent: { action: 'unknown', raw: input } };
    }
  }
  return { type: 'intent', intent: { action: 'unknown', raw: input } };
}
