/**
 * content-dissector.ts
 * LLM-based 6-dimensional structural analysis of viral content items.
 * For each DissectQueueItem calls the LLM with a structured prompt and
 * maps the response to a ViralEntry.
 *
 * Failure policy: if LLM returns invalid JSON, the entry is still returned
 * with dissection_status = "failed" — callers should store it for auditing.
 */

import { wallNow } from '../utils/time-utils';
import { LLMClient } from '../utils/llm-client';
import { DissectQueueItem, ViralEntry, AudienceResponse } from '../utils/types';
import { buildEntryId } from './viral-kb-store';

// ─── Taxonomy constants ───────────────────────────────────────────────────────

/** Canonical content type labels — dissection output must map to one of these. */
export const CANONICAL_CONTENT_TYPES = [
  '种草类', '工具类', '情绪共鸣类', '知识科普类', '赛事解读类',
  '人物故事类', '热点评论类', '生活记录类', '搞笑娱乐类', '其他',
  '变装转场类', '卡点剪辑类', '口播讲解类', '剧情短片类',
] as const;

/** Canonical hook type labels. */
export const CANONICAL_HOOK_TYPES = [
  '数字冲击', '反问式', '指令式', '悬念留白', '对比反转',
  '身份共鸣', '痛点直击', '利益承诺', '权威背书', '其他',
] as const;

/** Canonical CTA type labels. */
export const CANONICAL_CTA_TYPES = [
  '关注', '收藏', '评论互动', '转发', '投票',
  '点赞', '私信', '链接跳转', '无明显CTA', '其他',
  '双击屏幕', '长按观看',
] as const;

/** Alias mapping: LLM variations → canonical content_type */
export const CONTENT_TYPE_ALIASES: Record<string, string> = {
  '情绪类': '情绪共鸣类', '情绪共鸣': '情绪共鸣类',
  '种草': '种草类', '好物推荐': '种草类', '好物种草': '种草类',
  '工具': '工具类', '干货类': '工具类', '干货': '工具类', '教程类': '工具类',
  '知识类': '知识科普类', '知识科普': '知识科普类', '科普类': '知识科普类', '科普': '知识科普类',
  '赛事': '赛事解读类', '赛事解读': '赛事解读类', '比赛': '赛事解读类',
  '人物类': '人物故事类', '人物故事': '人物故事类', '故事类': '人物故事类',
  '热点类': '热点评论类', '热点评论': '热点评论类', '时事类': '热点评论类',
  '生活类': '生活记录类', '日常类': '生活记录类', '生活记录': '生活记录类', 'vlog': '生活记录类',
  '搞笑类': '搞笑娱乐类', '搞笑': '搞笑娱乐类', '娱乐类': '搞笑娱乐类',
  '变装': '变装转场类', '变装类': '变装转场类', '换装': '变装转场类', '转场': '变装转场类',
  '卡点': '卡点剪辑类', '卡点类': '卡点剪辑类', '踩点': '卡点剪辑类', '踩点类': '卡点剪辑类',
  '口播': '口播讲解类', '口播类': '口播讲解类', '解说类': '口播讲解类', '讲解类': '口播讲解类',
  '剧情': '剧情短片类', '剧情类': '剧情短片类', '短剧': '剧情短片类', '情景剧': '剧情短片类',
};

/** Alias mapping: LLM variations → canonical hook_type */
export const HOOK_TYPE_ALIASES: Record<string, string> = {
  '命令式钩子': '指令式', '命令式': '指令式', '指令': '指令式',
  '反问': '反问式', '提问式': '反问式', '问答式': '反问式',
  '数字': '数字冲击', '数据冲击': '数字冲击', '数据': '数字冲击',
  '悬念': '悬念留白', '悬念式': '悬念留白',
  '对比': '对比反转', '反转': '对比反转', '反转式': '对比反转',
  '身份': '身份共鸣', '身份认同': '身份共鸣',
  '痛点': '痛点直击', '焦虑': '痛点直击',
  '利益': '利益承诺', '福利': '利益承诺',
  '权威': '权威背书', '专家': '权威背书',
};

/** Alias mapping: LLM variations → canonical cta_type */
export const CTA_TYPE_ALIASES: Record<string, string> = {
  '关注解锁': '关注', '关注我': '关注',
  '评论区投票': '投票', '评论区互动': '评论互动', '评论': '评论互动',
  '收藏备用': '收藏', '收藏夹': '收藏',
  '转发分享': '转发', '分享': '转发',
  '点赞支持': '点赞',
  '双击': '双击屏幕', '双击红心': '双击屏幕',
  '长按': '长按观看', '长按看更多': '长按观看',
};

// ─── Normalization & validation helpers ───────────────────────────────────────

/**
 * Map an LLM-output label to its canonical form using an alias table.
 * Falls back to the original trimmed value if no alias matches.
 */
export function normalizeLabel(value: string, aliases: Record<string, string>): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  // Direct alias match (case-insensitive)
  const lower = trimmed.toLowerCase();
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (lower === alias.toLowerCase() || trimmed === alias) return canonical;
  }
  // Partial / contains match — check if the value contains any alias key
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (trimmed.includes(alias)) return canonical;
  }
  return trimmed;
}

/**
 * Check if a summary string carries meaningful information (not empty/placeholder).
 */
function isMeaningfulSummary(summary: string): boolean {
  if (!summary || summary.trim().length < 2) return false;
  // Reject obvious placeholders
  const placeholders = ['无', '无法判断', '未知', 'N/A', 'n/a', 'null', 'undefined', '—', '-'];
  return !placeholders.includes(summary.trim());
}

function coerceCanonicalLabel(
  value: string,
  canonicalSet: readonly string[],
): string {
  if (!value) return '';
  return canonicalSet.includes(value) ? value : '其他';
}

/**
 * Validate & normalize a raw DissectionJSON into a clean dissection object.
 * Returns { isValid: false, errorReason } if the result is hollow/unusable.
 */
function normalizeDissection(parsed: DissectionJSON): {
  dissection: ViralEntry['dissection'];
  isValid: boolean;
  errorReason?: string;
} {
  const hook_type = coerceCanonicalLabel(
    normalizeLabel(parsed.hook_type ?? '', HOOK_TYPE_ALIASES),
    CANONICAL_HOOK_TYPES,
  );
  const content_type = coerceCanonicalLabel(
    normalizeLabel(parsed.content_type ?? '', CONTENT_TYPE_ALIASES),
    CANONICAL_CONTENT_TYPES,
  );
  const cta_type = coerceCanonicalLabel(
    normalizeLabel(parsed.cta_type ?? '', CTA_TYPE_ALIASES),
    CANONICAL_CTA_TYPES,
  );

  const dissection: ViralEntry['dissection'] = {
    hook_type,
    content_type,
    identity_mode: parsed.identity_mode ?? null,
    emotion_arc: (parsed.emotion_arc ?? '').trim(),
    interaction_design: (parsed.interaction_design ?? '').trim(),
    visual_style: (parsed.visual_style ?? '').trim(),
    cta_type,
    summary: (parsed.summary ?? '').trim(),
  };

  // Attach video_structure if present and valid
  if (parsed.video_structure && typeof parsed.video_structure.shot_count === 'number') {
    dissection.video_structure = {
      shot_count: parsed.video_structure.shot_count,
      pacing: parsed.video_structure.pacing ?? '',
      transition_style: parsed.video_structure.transition_style ?? '',
      dominant_moves: Array.isArray(parsed.video_structure.dominant_moves)
        ? parsed.video_structure.dominant_moves
        : [],
    };
  }

  // Hollow check: at minimum, hook_type + content_type + summary must be non-empty
  const hollowFields = [hook_type, content_type, dissection.summary].filter(v => !v);
  if (hollowFields.length > 0 || !isMeaningfulSummary(dissection.summary)) {
    return { dissection, isValid: false, errorReason: 'hollow_result' };
  }

  return { dissection, isValid: true };
}

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
  /** Video structure analysis (for video content only) */
  video_structure?: {
    shot_count: number;
    pacing: string;
    transition_style: string;
    dominant_moves: string[];
  };
  audience_response?: {
    top_keywords: string[];
    emotional_triggers: string[];
    desire_signals: string[];
  };
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Detect if a DissectQueueItem is a video-type XHS post.
 * Uses heuristics: description/title contains video-related keywords,
 * or the source_type/content_type metadata indicates video.
 */
export function isXhsVideoItem(item: DissectQueueItem): boolean {
  if (item.platform !== 'xhs') return false;
  // Check for video indicators in title or description
  const videoKeywords = ['视频', '视频脚本', '分镜', '运镜', '转场', '变装', '卡点', '手势舞', 'VLOG', 'vlog'];
  const text = `${item.title} ${item.description}`.toLowerCase();
  return videoKeywords.some(kw => text.includes(kw.toLowerCase()));
}

function buildDissectPrompt(item: DissectQueueItem): string {
  const platformLabel = item.platform === 'xhs' ? '小红书' : '抖音';
  const trackHint = item.identity_mode ?? '未知';

  const hasComments = item.comment_texts && item.comment_texts.length > 0;
  const commentSection = hasComments
    ? `\n\n热门评论（按点赞排序，top ${item.comment_texts!.length} 条）：\n${item.comment_texts!.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
    : '';

  const audienceResponseField = hasComments
    ? `,
  "audience_response": {
    "top_keywords": ["评论中反复出现的关键词，3-5个"],
    "emotional_triggers": ["评论中反映的情绪触发点，2-4个"],
    "desire_signals": ["评论中暗含的需求/渴望信号，2-4个，如'求教程/想要同款/太需要了'"]
  }`
    : '';

  return `你是内容分析专家。请对以下${platformLabel}内容进行结构化拆解：

标题：${item.title}
描述：${item.description}
点赞：${item.likes} | 评论：${item.comments} | 分享：${item.shares}
账号赛道（如已知）：${trackHint}${commentSection}

你必须严格输出一个 JSON 对象，并遵守以下分类规则：

1. hook_type 只能从以下主标签里选一个：
${CANONICAL_HOOK_TYPES.map(label => `- ${label}`).join('\n')}

2. content_type 只能从以下主标签里选一个：
${CANONICAL_CONTENT_TYPES.map(label => `- ${label}`).join('\n')}

3. cta_type 只能从以下主标签里选一个：
${CANONICAL_CTA_TYPES.map(label => `- ${label}`).join('\n')}

4. 若看到类似"命令式钩子/情绪类/关注解锁"这类宽泛或同义表达，必须归一化为上面的主标签。
5. 每个字段只能输出一个主标签，不允许输出多个标签拼接。
6. 不允许空字符串；如果无法完全判断，也要给出最接近的主类。
7. identity_mode 仅在内容明显属于特定垂直赛道时填写，否则返回 null。
8. summary 必须是非空的一句话，概括爆款逻辑，不要写成"无法判断"。
9. 若该内容为视频类型（抖音或小红书视频），必须填写 video_structure 字段，分析其镜头结构。

请输出 JSON（字段说明见下）：
{
  "hook_type": "从主标签中选择一个",
  "content_type": "从主标签中选择一个",
  "identity_mode": "若内容明显属于特定垂直赛道（如电竞/美妆/赛车）则填写该赛道名称，否则返回 null",
  "emotion_arc": "情绪弧线描述，如焦虑→共鸣→解脱",
  "interaction_design": "互动引导手法描述",
  "visual_style": "视觉风格特征描述",
  "cta_type": "从主标签中选择一个",
  "summary": "一句话爆款逻辑总结（20字以内）"${(item.platform === 'douyin' || isXhsVideoItem(item)) ? `,
  "video_structure": {
    "shot_count": "镜头数量（整数）",
    "pacing": "节奏特征：slow/medium/fast/variable",
    "transition_style": "转场风格描述（如：快切为主/变装匹配剪辑/叠化过渡）",
    "dominant_moves": ["主要运镜方式1", "主要运镜方式2"]
  }` : ''}${audienceResponseField}
}

只输出 JSON，不要任何解释或 markdown。`;
}

// ─── Failed entry builder ─────────────────────────────────────────────────────

/**
 * Build a ViralEntry with dissection_status = "failed" for an item that
 * could not be dissected (LLM error or invalid JSON).
 */
function buildFailedEntry(
  item: DissectQueueItem,
  personaId: string,
  errorReason?: string,
): ViralEntry {
  return {
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
    dissection: {
      hook_type: '',
      content_type: '',
      identity_mode: item.identity_mode ?? null,
      emotion_arc: '',
      interaction_design: '',
      visual_style: '',
      cta_type: '',
      summary: '',
      video_structure: undefined,
    },
    dissection_status: 'failed',
    dissection_error_reason: errorReason,
    kb_tier: item.identity_mode ? 'track' : 'universal',
  };
}

// ─── Core dissect ─────────────────────────────────────────────────────────────

async function dissectOne(
  item: DissectQueueItem,
  llm: LLMClient,
  personaId: string,
): Promise<ViralEntry> {
  // Early exit: skip LLM call if source data is fundamentally hollow (no title)
  if (!item.title || !item.title.trim()) {
    console.warn(
      `[content-dissector] Skipping item ${item.id}: empty title, source data is hollow`,
    );
    return buildFailedEntry(item, personaId, 'empty_title');
  }

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
  const hasComments = item.comment_texts && item.comment_texts.length > 0;
  const maxTokens = hasComments ? 1200 : 800;

  try {
    const parsed = await llm.callJSON<DissectionJSON>(prompt, maxTokens);

    // Normalize and validate the dissection output
    const { dissection, isValid, errorReason } = normalizeDissection(parsed);

    // If hollow / invalid → mark as failed instead of done
    if (!isValid) {
      return {
        ...base,
        dissection,
        dissection_status: 'failed',
        dissection_error_reason: errorReason,
        kb_tier: dissection.identity_mode !== null ? 'track' : 'universal',
      } as ViralEntry;
    }

    // Map audience_response if present
    const audienceResponse: AudienceResponse | undefined =
      parsed.audience_response &&
      Array.isArray(parsed.audience_response.top_keywords)
        ? {
            top_keywords: parsed.audience_response.top_keywords,
            emotional_triggers: parsed.audience_response.emotional_triggers ?? [],
            desire_signals: parsed.audience_response.desire_signals ?? [],
          }
        : undefined;

    if (audienceResponse) {
      dissection.audience_response = audienceResponse;
    }

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
    return buildFailedEntry(item, personaId, 'invalid_json');
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Dissect a batch of queue items using LLM in parallel (Promise.allSettled).
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
  const settled = await Promise.allSettled(
    items.map(item => dissectOne(item, llm, personaId)),
  );

  return settled.map((r, i) =>
    r.status === 'fulfilled' ? r.value : buildFailedEntry(items[i], personaId, 'unexpected_error'),
  );
}
