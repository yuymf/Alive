/**
 * content-dissector.ts
 * LLM-based 6-dimensional structural analysis of viral content items.
 * For each DissectQueueItem calls the LLM with a structured prompt and
 * maps the response to a ViralEntry.
 *
 * Failure policy: if LLM returns invalid JSON, the entry is still returned
 * with dissection_status = "failed" — callers should store it for auditing.
 */

import * as crypto from 'crypto';
import { wallNow } from '../utils/time-utils';
import { LLMClient } from '../utils/llm-client';
import { DissectQueueItem, ViralEntry } from '../utils/types';

// ─── LLM output shape ─────────────────────────────────────────────────────────

interface DissectionJSON {
  hook_type: string;
  content_type: string;
  identity_mode: string | null;
  emotion_arc: string;
  interaction_design: string;
  visual_style: string;
  cta_type: string;
  summary: string;
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildDissectPrompt(item: DissectQueueItem): string {
  const platformLabel = item.platform === 'xhs' ? '小红书' : '抖音';
  const trackHint = item.identity_mode ?? '未知';

  return `你是内容分析专家。请对以下${platformLabel}内容进行结构化拆解：

标题：${item.title}
描述：${item.description}
点赞：${item.likes} | 评论：${item.comments} | 分享：${item.shares}
账号赛道（如已知）：${trackHint}

请输出 JSON（字段说明见下）：
{
  "hook_type": "钩子类型，如反问式/数字冲击/悬念留白",
  "content_type": "内容类型，如工具类/种草类/情绪类/赛事解读",
  "identity_mode": "若内容明显属于特定垂直赛道（如电竞/美妆/赛车）则填写该赛道名称，否则返回 null",
  "emotion_arc": "情绪弧线描述，如焦虑→共鸣→解脱",
  "interaction_design": "互动引导手法描述",
  "visual_style": "视觉风格特征描述",
  "cta_type": "结尾 CTA，如评论区投票/关注解锁",
  "summary": "一句话爆款逻辑总结（20字以内）"
}

只输出 JSON，不要任何解释或 markdown。`;
}

// ─── ID builder ───────────────────────────────────────────────────────────────

function buildEntryId(platform: string, sourceId: string): string {
  return crypto.createHash('md5').update(`${platform}:${sourceId}`).digest('hex');
}

// ─── Core dissect ─────────────────────────────────────────────────────────────

async function dissectOne(
  item: DissectQueueItem,
  llm: LLMClient,
  personaId: string,
): Promise<ViralEntry> {
  const base: Omit<ViralEntry, 'dissection' | 'dissection_status' | 'kb_tier'> = {
    id: buildEntryId(item.platform, item.source_id),
    platform: item.platform,
    source_id: item.source_id,
    source_type: item.source_type,
    persona_id: personaId,
    title: item.title,
    description: item.description,
    likes: item.likes,
    comments: item.comments,
    shares: item.shares,
    collected_at: wallNow().toISOString(),
    promoted_to_template: false,
    times_referenced: 0,
  };

  const prompt = buildDissectPrompt(item);

  try {
    const parsed = await llm.callJSON<DissectionJSON>(prompt, 800);

    const dissection: ViralEntry['dissection'] = {
      hook_type: parsed.hook_type ?? '',
      content_type: parsed.content_type ?? '',
      identity_mode: parsed.identity_mode ?? null,
      emotion_arc: parsed.emotion_arc ?? '',
      interaction_design: parsed.interaction_design ?? '',
      visual_style: parsed.visual_style ?? '',
      cta_type: parsed.cta_type ?? '',
      summary: parsed.summary ?? '',
    };

    const kb_tier: ViralEntry['kb_tier'] =
      dissection.identity_mode !== null ? 'track' : 'universal';

    return {
      ...base,
      dissection,
      dissection_status: 'done',
      kb_tier,
    };
  } catch (err) {
    console.error(
      `[content-dissector] Failed to dissect item ${item.id} (${item.title}):`,
      (err as Error).message,
    );

    return {
      ...base,
      dissection: {
        hook_type: '',
        content_type: '',
        identity_mode: item.identity_mode ?? null,
        emotion_arc: '',
        interaction_design: '',
        visual_style: '',
        cta_type: '',
        summary: '',
      },
      dissection_status: 'failed',
      kb_tier: item.identity_mode ? 'track' : 'universal',
    };
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Dissect a batch of queue items using LLM.
 * Each item is processed sequentially to avoid overwhelming the LLM API.
 * Failed items are returned with dissection_status = "failed" — never dropped.
 *
 * @param items     Items dequeued from dissect-queue
 * @param llm       LLM client (use createRealLLMClient("viral-dissector") in prod)
 * @param personaId The active persona's id (for persona isolation)
 */
export async function dissectBatch(
  items: DissectQueueItem[],
  llm: LLMClient,
  personaId: string,
): Promise<ViralEntry[]> {
  const results: ViralEntry[] = [];

  for (const item of items) {
    const entry = await dissectOne(item, llm, personaId);
    results.push(entry);
  }

  return results;
}
