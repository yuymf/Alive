/**
 * topic-generator.ts
 * Given filtered trends + competitor data, generates N content drafts
 * (xhs + douyin) using tiktok-growth ClawHub skill for hook enrichment,
 * then pushes each draft into the review queue.
 *
 * Enhanced: Now injects content templates (scene/camera/styling constraints)
 * and competitor benchmarks into LLM prompts for better-targeted content.
 */

import * as path from 'path';
import {
  OpsConfig, ContentTemplate, CompetitorProfile, IdentityMode,
  QueueItemTemplateSpec, QueueItemCompetitorBenchmark, QueueItem, QueueItemContent,
  CompetitorAnalysisStore, ViralEntry,
} from '../utils/types';
import { LLMClient } from '../utils/llm-client';
import { FilteredTrend } from './trend-analyzer';
import { addItem, getItem, updateItemContent } from './review-queue';
import { buildCompetitorContext } from './competitor-tracker';
import { buildMemoryContext } from './competitor-memory';
import { loadCompetitorAnalysis } from './competitor-analyzer';
import { parseAccountKey } from './competitor-fetcher';
import { incrementPatternUsage } from './content-analyzer';
import { buildTasteContext } from './taste-engine';
import { buildDiscoveryContext } from './discovery-engine';
import { loadFormulaStore, queryFormulasByMode } from './formula-store';
import { PATHS, readJSON } from '../utils/file-utils';
import { CompetitorLog, CompetitorUpdate, ContentStrategy, ContentPatterns } from '../utils/types';
import { now } from '../utils/time-utils';
import { queryTrackInMemory, loadEntries, saveEntries, loadFormulas as loadViralFormulas } from './viral-kb-store';

import { matchesTaxonomy } from './ops-taxonomy';
import { buildOpsMemoryContext } from './ops-memory';
import { filterByDiversity } from './diversity-gate';

// ─── Viral KB context builder ────────────────────────────────────────────────

/**
 * Format top viral entries for a given platform track into a prompt paragraph.
 * Returns '' if entries list is empty (cold start — no viral data yet).
 */
export function buildViralContext(entries: ViralEntry[], platform: string): string {
  if (entries.length === 0) return '';

  const platformLabel = platform === 'xhs' ? '小红书' : platform === 'douyin' ? '抖音' : platform;
  const identityLabel = entries[0].dissection?.identity_mode ?? '';

  const lines = entries.map((e, idx) => {
    const d = e.dissection;
    if (!d) return null;
    const parts = [
      `${idx + 1}. 钩子：${d.hook_type} | 情绪弧：${d.emotion_arc} | 互动：${d.interaction_design}`,
      `   一句话逻辑：${d.summary}`,
    ];
    // Append audience desire signals if available
    if (d.audience_response?.desire_signals && d.audience_response.desire_signals.length > 0) {
      parts.push(`   受众渴望：${d.audience_response.desire_signals.join('、')}`);
    }
    return parts.join('\n');
  }).filter(Boolean);

  return [
    `近期${platformLabel}上【${identityLabel}】赛道爆款规律（供参考，不强制模仿）：`,
    ...lines,
  ].join('\n');
}

// ─── Pure functions (exported for testing) ───────────────────────────────────

export function selectIdentityMode(
  trend: FilteredTrend,
): IdentityMode {
  return trend.identity_mode;
}

/**
 * Select the best matching content template for a trend.
 * Strategy: match by identity_mode first, then prefer high-priority templates.
 * Returns null if no templates configured.
 */
export function selectContentTemplate(
  templates: readonly ContentTemplate[] | undefined,
  identityMode: IdentityMode,
  trendKeyword: string,
): ContentTemplate | null {
  if (!templates || templates.length === 0) return null;

  // Filter by identity mode
  const modeTemplates = templates.filter(t =>
    t.identity_mode === identityMode || !t.identity_mode,
  );

  if (modeTemplates.length === 0) return null;

  // Prefer high-priority templates
  const highPriority = modeTemplates.filter(t => t.priority === 'high');
  const pool = highPriority.length > 0 ? highPriority : modeTemplates;

  // Simple keyword matching: check if trend keyword overlaps with template category
  const keywordMatch = pool.find(t =>
    trendKeyword.includes(t.category) || trendKeyword.includes(t.type),
  );

  // Return keyword match or random from pool
  return keywordMatch ?? pool[Math.floor(Math.random() * pool.length)];
}

export function applyStrategyToTemplateSelection(
  templates: readonly ContentTemplate[] | undefined,
  identityMode: IdentityMode,
  trendKeyword: string,
  strategy: ContentStrategy | null,
): ContentTemplate | null {
  if (!strategy) return selectContentTemplate(templates, identityMode, trendKeyword);
  if (!templates || templates.length === 0) return null;

  const filtered = templates.filter(
    t => !strategy.next_week_recommendations.avoid_templates.includes(t.type),
  );

  const recommended = filtered.filter(
    t => strategy.next_week_recommendations.recommended_templates.includes(t.type),
  );

  if (recommended.length > 0) {
    const modeMatch = recommended.filter(t => t.identity_mode === identityMode || !t.identity_mode);
    if (modeMatch.length > 0) return modeMatch[0];
    return recommended[0];
  }

  return selectContentTemplate(filtered, identityMode, trendKeyword);
}

/**
 * Build a natural-language cluster context string from competitor analysis data.
 * Returns '' if no auto_cluster data is available — caller should fallback to static content_mix.
 */
export function buildClusterContext(
  accountKey: string,
  analysisStore: CompetitorAnalysisStore,
): string {
  const analysis = analysisStore.analyses[accountKey];
  if (!analysis?.auto_cluster) return '';
  if (analysis.topic_clusters.length === 0) return '';

  const { name: accountName } = parseAccountKey(accountKey);
  const lines: string[] = [`${accountName} 内容聚类（自动分析）：`];

  for (const cluster of analysis.topic_clusters) {
    const titles = cluster.representative_titles.slice(0, 2).map(t => `「${t}」`).join('');
    lines.push(`• ${cluster.cluster_name}（${cluster.post_count}条，均互动${cluster.avg_engagement}）：${titles}`);
  }

  return lines.join('\n');
}

/**
 * Build competitor benchmark data for a queue item.
 * Matches competitors by identity_mode on their content templates,
 * or returns all primary competitors if no identity_mode-based filtering is possible.
 */
export function buildCompetitorBenchmarks(
  profiles: readonly CompetitorProfile[] | undefined,
  identityMode: string,
  templates?: readonly ContentTemplate[],
  analysisStore?: CompetitorAnalysisStore,
): QueueItemCompetitorBenchmark[] {
  if (!profiles || profiles.length === 0) return [];

  // Use taxonomy to match competitors by identity mode
  const mode = identityMode as import('../utils/types').IdentityMode;

  return profiles
    .filter(p => p.reference_type === 'primary')
    .filter(p => {
      const profileGroup = p.group ?? p.tag;
      // Use taxonomy mapping for reliable matching
      return matchesTaxonomy(mode, profileGroup);
    })
    .map(p => {
      // A v2: prefer dynamic cluster context over static content_mix
      const accountKey = `${p.name}:${p.platform}`;
      const clusterCtx = analysisStore
        ? buildClusterContext(accountKey, analysisStore)
        : '';

      const content_mix_relevant = clusterCtx
        || (p.content_mix
          ? Object.entries(p.content_mix).map(([k, v]) => `${k}${v}%`).join('、')
          : '未知');

      return {
        name: p.name,
        platform: p.platform,
        content_mix_relevant,
        audience: p.audience ?? '未知',
        interaction_style: p.interaction_style ?? '未知',
      };
    });
}

/**
 * Build a template constraint string for LLM prompt injection.
 */
export function buildTemplateConstraint(template: ContentTemplate): string {
  return `【内容模板约束】
类型：${template.type}（${template.category}）
场景：${template.scene}
镜头语言：${template.camera}
人物形象/造型：${template.styling}
内容亮点：${template.highlights.join('、')}
${template.reference_links && template.reference_links.length > 0
    ? `参考案例：${template.reference_links.join(' / ')}`
    : ''}

请严格按照以上场景、镜头、造型要求来构思内容。`;
}

// ─── Formula context builder ─────────────────────────────────────────────────

/**
 * Build a competitor formula context string for LLM prompt injection.
 * Loads the FormulaStore, queries formulas for the given identityMode,
 * and formats them as a bulleted reference section.
 * Returns '' if the store is empty or no formulas exist for the mode.
 */
export function buildFormulaContext(
  identityMode: IdentityMode,
  options?: { maxFormulas?: number },
): string {
  const store = loadFormulaStore();
  const formulas = queryFormulasByMode(store, identityMode);
  if (formulas.length === 0) return '';

  const max = options?.maxFormulas ?? 6;
  const lines = formulas.slice(0, max).map(f => {
    const freq = f.frequency === '高' ? '高频' : f.frequency === '中' ? '中频' : '低频';
    const account = f.source_account.split(':')[0];
    return `- ${f.formula}（${freq} · 来自 ${account}）`;
  });

  return `【竞品爆款句式参考（可借鉴改编，保持V姐风格）】\n${lines.join('\n')}`;
}

// ─── Content-driven factor context builder ──────────────────────────────────

/**
 * Aggregate content-driven factors for all competitors matching a given
 * identity mode, and return a one-liner for LLM prompt injection.
 * Returns '' if no competitors have content_driven_factor data.
 */
export function buildContentDrivenContext(
  analysisStore: CompetitorAnalysisStore,
  profiles: readonly CompetitorProfile[] | undefined,
  identityMode: IdentityMode,
): string {
  if (!profiles || profiles.length === 0) return '';

  const factors: number[] = [];
  for (const p of profiles) {
    const accountKey = `${p.name}:${p.platform}`;
    const analysis = analysisStore.analyses[accountKey];
    if (analysis?.content_driven_factor !== undefined) {
      // Match by identity mode via group/tag
      const profileGroup = p.group ?? p.tag;
      if (matchesTaxonomy(identityMode, profileGroup)) {
        factors.push(analysis.content_driven_factor);
      }
    }
  }

  if (factors.length === 0) return '';

  const avg = factors.reduce((s, f) => s + f, 0) / factors.length;
  const rounded = Math.round(avg * 100) / 100;
  const label = rounded >= 0.6 ? '高 — 好内容即使小号也能爆'
    : rounded >= 0.3 ? '中 — 内容与账号权重各占一半'
    : '低 — 账号权重决定流量，需先涨粉';

  return `【赛道内容驱动指数】${rounded.toFixed(2)}（${label}）`;
}

// ─── Trigger words context builder ──────────────────────────────────────────

/**
 * Aggregate trigger_words from all UniversalFormulas in the viral KB.
 * Optionally filter by platform.
 * Returns a one-liner for LLM prompt injection, or '' if no trigger words.
 */
export function buildTriggerWordsContext(
  basePath: string,
  platform?: string,
): string {
  const formulas = loadViralFormulas(basePath);
  if (formulas.length === 0) return '';

  const filtered = platform
    ? formulas.filter(f => f.platform === platform)
    : formulas;

  const allWords = new Set<string>();
  for (const f of filtered) {
    if (f.trigger_words) {
      for (const w of f.trigger_words) {
        allWords.add(w);
      }
    }
  }

  if (allWords.size === 0) return '';

  return `【高频情绪触发词（来自爆款分析）】${[...allWords].join('、')}`;
}

// ─── Platform writing guidelines (inspired by content-writer skill) ──────────

const XHS_GUIDELINES = `【小红书写作规范】
- 标题：11-20字，必须含emoji开头或穿插，制造好奇心缺口（疑问/数字/反转）
- 正文：500字以内，每2-3句换行，段落间用emoji分隔，口语化但有信息密度
- 情绪弧：开头3行定生死 → 痛点共鸣/好奇缺口 → 干货/故事/反差 → 金句收尾 → 互动引导（收藏暗示/提问式结尾）
- 互动钩子：正文至少留一个"评论钩"（如"你们觉得呢？""谁懂啊..."、"猜猜结果"），让人想说话
- 信息密度：每句话都要有存在理由，删掉任何"凑字数"的废话；如果一句话删掉不影响理解，就不要写
- 标签：5-10个，前3个为精准长尾词，后面为热门大词，自然穿插正文关键词做SEO
- 封面：高对比、大字报风格或真实生活感，避免过度精修`;

const DOUYIN_GUIDELINES = `【抖音脚本写作规范】
- 钩子：前3秒决定生死，11-20字，用反问/冲突/悬念/数字冲击制造停留
- 脚本：200-500字，口语化、短句为主，每句≤15字，像跟朋友聊天不像念稿
- 情绪弧：钩子（0-3秒）→ 建立共鸣（3-8秒）→ 核心内容/反转（8-20秒）→ 情绪高点（20-25秒）→ 行动号召（最后3秒）
- 互动设计：至少一个"评论钩"时刻（如提问、留悬念、争议观点），让用户忍不住评论
- 信息密度：每句话都要推进内容，删掉"嗯""那个""就是说"等口头禅填充词
- 字幕：3-5个关键要点，每条≤10字，强化记忆点
- BGM：匹配内容情绪，优先热门音频提升推荐权重`;

// ─── Prompt builder ─────────────────────────────────────────────────────────

/** Voice settings for content prompt — derived from persona.voice */
export interface ContentPromptOptions {
  voiceStyle?: string;
  sampleLines?: string[];
  identityMode?: string;
}

/** Identity-mode → voice personality mapping for prompt injection */
const IDENTITY_VOICE_MAP: Record<string, string> = {
  esports: '专业控场、理性分析但不失热血，电竞术语自然带出，偶尔一句毒舌金句',
  singer: '随性有态度、声音里的故事感，不刻意文艺但开口就有画面',
  racer: '果敢利落、不服就干，速度感和掌控感拉满，说话像过弯一样精准',
  daily: '松弛随性、低调贵气，不迎合但有温度，像闺蜜聊天但不腻',
};

const IDENTITY_MODE_LABELS: Record<string, string> = {
  esports: '电竞解说',
  singer: '歌手/音乐人',
  racer: '赛车手',
  daily: '生活日常',
};

export function buildContentPrompt(
  trend: FilteredTrend,
  personaDescription: string,
  platform: 'xhs' | 'douyin',
  platformStyle: string,
  extraContext?: string,
  options?: ContentPromptOptions,
): string {
  const guidelines = platform === 'xhs' ? XHS_GUIDELINES : DOUYIN_GUIDELINES;
  const platformLabel = platform === 'xhs' ? '小红书图文' : '抖音视频脚本';

  // ── Voice & identity injection ──
  const voiceStyle = options?.voiceStyle ?? '';
  const sampleLines = options?.sampleLines ?? [];
  const identityMode = options?.identityMode ?? trend.identity_mode;
  const identityLabel = IDENTITY_MODE_LABELS[identityMode] ?? identityMode;
  const identityVoice = IDENTITY_VOICE_MAP[identityMode] ?? '';

  const voiceBlock = voiceStyle
    ? `声线：${voiceStyle}`
    : '';
  const identityVoiceBlock = identityVoice
    ? `语感模式（${identityLabel}）：${identityVoice}`
    : '';
  const sampleLinesBlock = sampleLines.length > 0
    ? `标志性语录（感受语气，不要照搬）：\n${sampleLines.map(l => `  - "${l}"`).join('\n')}`
    : '';

  const personaParts = [
    `你是 ${personaDescription}。`,
    identityLabel ? `当前以【${identityLabel}】身份切入。` : '',
    voiceBlock,
    identityVoiceBlock,
    sampleLinesBlock,
  ].filter(Boolean).join('\n');

  // ── Viral thinking framework ──
  const viralFramework = `【爆款思维框架】（创作前必须过一遍）
1. 停留理由：用户刷到这条内容的 0.3 秒内，凭什么停下来？
2. 情绪弧：好奇/共鸣 → 反转/干货 → 情绪高点 → 行动引导
3. 互动设计：评论区最可能聊什么？内容里预留什么"钩"让人想评论/收藏？
4. 差异化：同热点下大部分人会怎么写？你怎么写得不一样？`;

  // ── Hard prohibitions ──
  const prohibitions = `【绝对禁止】
- 禁止"最好/第一/绝对"等绝对化表述
- 禁止虚构数据或伪造引用
- 禁止硬广口吻，要像朋友分享不像销售推荐
- 禁止泛泛而谈没有信息密度，每句话都要有存在理由
- 禁止堆砌emoji没有实质内容，emoji是节奏工具不是装饰
- 禁止照搬标志性语录原句，那是参考语气不是要你复读`;

  // ── Trend intelligence ──
  const trendIntel = `【热点情报】
- 热点：${trend.keyword}（${trend.platform}，速度分 ${trend.velocity_score.toFixed(1)}x）
- 切入角度：${trend.hook_angle}
- 身份模式：${identityLabel}
- 目标平台：${platform}
- 平台风格：${platformStyle}`;

  const base = `【角色】
${personaParts}

【创作任务】
借势热点「${trend.keyword}」创作一条${platformLabel}内容，目标是做出这条热点下最有人格辨识度、最容易引发互动的内容。

${trendIntel}

${viralFramework}

${guidelines}

${prohibitions}

请严格按照以上写作规范和爆款思维框架，生成一条完整的 ${platformLabel} 内容草稿。

${platform === 'xhs' ? `输出格式 JSON：
{"title":"...（11-20字，含emoji）","body":"...（正文500字以内，段落间用emoji分隔）","tags":["#精准长尾词1","#精准长尾词2","#热门大词"]}` : `输出格式 JSON：
{"opening_hook":"前3秒钩子（11-20字，反问/冲突/悬念）","script":"完整口播脚本（200-500字，短句口语化）","bgm_suggestion":"推荐BGM风格或歌名","key_captions":["字幕要点1（≤10字）","字幕要点2"]}`}`;

  return extraContext ? `${base}\n\n${extraContext}` : base;
}

// ─── Edit regeneration ──────────────────────────────────────────────────────

export function buildRegeneratePrompt(
  originalContent: string,
  instruction: string,
  field: string,
  voiceStyle: string,
  platformStyle: string,
  contentPatterns?: string,
): string {
  const fieldConstraints: Record<string, string> = {
    'xhs.title': '11-20字，必须含emoji，制造好奇心缺口（疑问/数字/反转）',
    'xhs.body': '500字以内，每2-3句换行，段落间用emoji分隔，口语化但有信息密度',
    'xhs.tags': '5-10个标签，前3个精准长尾词，后面热门大词',
    'douyin.opening_hook': '前3秒文案，11-20字，用反问/冲突/悬念/数字冲击',
    'douyin.script': '200-500字，口语化短句，每句≤15字，像聊天不像念稿',
    'douyin.bgm_suggestion': '匹配内容情绪的BGM，优先热门音频',
    'douyin.key_captions': '3-5个关键字幕，每条≤10字，强化记忆点',
  };
  const constraint = fieldConstraints[field] ?? '无特殊约束';
  const jsonKey = field.split('.').pop() ?? field;
  const parts: string[] = [
    `你是内容编辑助手。请根据修改指令重新生成内容。`,
    '',
    `【原始内容】`,
    originalContent,
    '',
    `【修改指令】`,
    instruction,
    '',
    `【约束】`,
    `- 声线风格：${voiceStyle}`,
    `- 平台风格：${platformStyle}`,
    `- 字段：${field}`,
    `- 字数/格式要求：${constraint}`,
  ];
  if (contentPatterns) {
    parts.push('', '【参考爆款模式】', contentPatterns);
  }
  parts.push('', `请输出修改后的内容，JSON格式（只包含被修改的字段）：`, `{"${jsonKey}": "..."}`);
  return parts.join('\n');
}

export async function regenerateContent(
  itemId: string,
  field: string,
  instruction: string,
  llm: LLMClient,
  voiceStyle: string,
  platformStyle: string,
  contentPatterns?: string,
): Promise<QueueItem | null> {
  const item = await getItem(itemId);
  if (!item) return null;

  const [platform, key] = field.split('.') as ['xhs' | 'douyin', string];
  const currentValue = (item.content[platform] as Record<string, unknown>)?.[key];
  const originalContent = typeof currentValue === 'string'
    ? currentValue
    : JSON.stringify(currentValue);

  const prompt = buildRegeneratePrompt(
    originalContent, instruction, field, voiceStyle, platformStyle, contentPatterns,
  );

  const result = await llm.callJSON<Record<string, unknown>>(prompt, 3000);
  const newFieldValue = result[key] ?? result[field] ?? currentValue;
  const updatedPlatformContent = { ...item.content[platform], [key]: newFieldValue };
  const newContent = platform === 'xhs'
    ? { xhs: updatedPlatformContent as QueueItemContent['xhs'] }
    : { douyin: updatedPlatformContent as QueueItemContent['douyin'] };

  return updateItemContent(item.id, newContent, { instruction, field });
}

// ─── Hook generation (replaced deprecated openclaw CLI call) ─────────────────

/**
 * Generate hook formulas for a given niche using LLM.
 * Previously called `openclaw skills run tiktok-growth` which has been deprecated.
 * Now generates hooks inline via the LLM client passed to generateTopics().
 */
async function generateHooksViaLLM(
  niche: string,
  count: number,
  llm: LLMClient,
): Promise<string[]> {
  try {
    const prompt = `你是短视频钩子公式专家。为「${niche}」赛道生成${count}个高转化的开头钩子公式。
要求：每个钩子11-20字，使用反问/冲突/悬念/数字冲击手法。
直接输出JSON：{"hooks":["钩子1","钩子2",...]}`;
    const result = await llm.callJSON<{ hooks?: string[] }>(prompt, 500);
    return result.hooks ?? [];
  } catch (err) {
    console.error('[topic-generator] hook generation via LLM failed:', err);
    return [];
  }
}

interface XhsDraft { title: string; body: string; tags: string[] }
interface DouyinDraft { opening_hook: string; script: string; bgm_suggestion: string; key_captions: string[] }

// ─── Main export ─────────────────────────────────────────────────────────────

const STRATEGY_MAX_AGE_DAYS = 7;

export function loadConfirmedStrategy(): ContentStrategy | null {
  const strategy = readJSON<ContentStrategy | null>(PATHS.contentStrategy, null);
  if (!strategy) return null;
  if (strategy.status !== 'confirmed') return null;

  const age = now().getTime() - new Date(strategy.generated_at).getTime();
  if (age > STRATEGY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000) return null;

  return strategy;
}

export function buildStrategyContext(strategy: ContentStrategy): string {
  const recs = strategy.next_week_recommendations;
  const mix = strategy.content_mix_recommendation;
  const patterns = strategy.top_patterns;
  const health = strategy.persona_health;

  const parts: string[] = [
    '## 本周内容策略 (已确认)',
    `- 推荐模板: ${recs.recommended_templates.join('、')}`,
    `- 避免模板: ${recs.avoid_templates.join('、')}`,
    `- 内容方向: ${recs.content_direction}`,
    `- 配比建议: ${Object.entries(mix.recommended_mix).map(([k, v]) => `${k}:${v}%`).join('、')}`,
  ];

  if (patterns.length > 0) {
    parts.push(`- 高效模式: ${patterns.slice(0, 3).map(p => p.pattern_type).join('、')}`);
  }

  if (health.overall_score < 7 && health.correction_suggestions.length > 0) {
    parts.push(`- 人设提醒: ${health.correction_suggestions.join('、')}`);
  }

  return parts.join('\n');
}

export async function generateTopics(
  trends: FilteredTrend[],
  ops: OpsConfig,
  personaDescription: string,
  llm: LLMClient,
  voice?: { style?: string; sample_lines?: string[] },
): Promise<void> {
  const topN = trends.slice(0, ops.topic_count);

  // ── Diversity gate: filter out trends too similar to existing queue items ──
  let diverseTopN = topN;
  try {
    const { loadQueue } = await import('./review-queue');
    const queue = await loadQueue();
    diverseTopN = filterByDiversity(
      topN,
      queue.items,
      selectIdentityMode,
      { maxSameModeInWindow: 3, minAngleDistance: 0.5 },
    );
    if (diverseTopN.length < topN.length) {
      console.log(`[topic-generator] Diversity gate: ${topN.length} → ${diverseTopN.length} topics`);
    }
  } catch {
    // diversity gate not available, proceed with original list
  }

  // Derive memory base path for viral KB queries
  const basePath = path.dirname(PATHS.emotionState);

  const strategy = loadConfirmedStrategy();
  const patterns = readJSON<ContentPatterns | null>(PATHS.contentPatterns, null);

  // Select patterns for injection: prioritize strategy-recommended patterns, then by success rate
  let candidatePatterns = patterns?.patterns ?? [];
  if (strategy?.next_week_recommendations.recommended_patterns?.length) {
    const recommended = new Set(strategy.next_week_recommendations.recommended_patterns);
    const declining = new Set(strategy.next_week_recommendations.declining_patterns ?? []);
    // Sort: recommended first, then non-declining sorted by success_rate desc
    candidatePatterns = [...candidatePatterns]
      .filter(p => !declining.has(p.type))
      .sort((a, b) => {
        const aRec = recommended.has(a.type) ? 1 : 0;
        const bRec = recommended.has(b.type) ? 1 : 0;
        if (aRec !== bRec) return bRec - aRec;
        return (b.success_rate ?? 0) - (a.success_rate ?? 0);
      });
  }

  const injectedPatterns = candidatePatterns.slice(0, 5);
  const patternsContext = injectedPatterns.length > 0
    ? `【参考爆款模式】\n${injectedPatterns.map(
        p => `- ${p.type}：${p.formula}（来源：${p.source}）`
      ).join('\n')}`
    : '';

  // Load persisted competitor log for live data context (used by brief-generator)
  const competitorLog = readJSON<CompetitorLog>(PATHS.competitorLog, { entries: [], last_updated: '' });
  const liveUpdates: CompetitorUpdate[] = competitorLog.entries;

  const strategyContext = strategy ? buildStrategyContext(strategy) : '';

  // A v2: load competitor analysis once for dynamic cluster context
  const analysisStore = loadCompetitorAnalysis();

  // Load all viral KB entries once (avoids N re-reads inside the per-trend loop)
  const allViralEntries = loadEntries(basePath);
  // Accumulate times_referenced increments: id → delta
  const refIncrements = new Map<string, number>();

  // Cache benchmarks by identityMode — only identityMode varies per trend
  const benchmarkCache = new Map<string, ReturnType<typeof buildCompetitorBenchmarks>>();

  for (const trend of diverseTopN) {
    const identityMode = selectIdentityMode(trend);
    const xhsStyle = ops.platforms.xhs?.style ?? '图文为主';
    const douyinStyle = ops.platforms.douyin?.style ?? '视频脚本';

    // Select matching content template
    const template = applyStrategyToTemplateSelection(ops.content_templates, identityMode, trend.keyword, strategy);
    const templateConstraint = template ? buildTemplateConstraint(template) : '';

    // Build competitor benchmarks for this identity (cached by mode)
    const benchmarks = benchmarkCache.get(identityMode)
      ?? (() => {
        const b = buildCompetitorBenchmarks(ops.competitors, identityMode, ops.content_templates, analysisStore);
        benchmarkCache.set(identityMode, b);
        return b;
      })();

    // Compose extra context: template + competitor memory + hooks + taste
    const competitorCtx = buildMemoryContext(identityMode, {
      maxProfiles: 5,
      maxBreakdowns: 3,
    });
    const tasteContext = buildTasteContext();
    const discoveryContext = buildDiscoveryContext();
    const contextParts: string[] = [];
    const formulaContext = buildFormulaContext(identityMode);

    // === Viral KB: inject top-3 track patterns (cold-start safe) ===
    const trackPlatform = (trend.platform === 'xhs' || trend.platform === 'douyin')
      ? trend.platform
      : undefined;
    // Query in-memory (no disk I/O) — entries were loaded once above
    const trackPatterns = queryTrackInMemory(allViralEntries, {
      platform: trackPlatform,
      identity_mode: identityMode,
      limit: 3,
      sort: 'recency',
    });
    const viralContext = buildViralContext(trackPatterns, trend.platform);
    // Accumulate times_referenced increments (apply in one pass after the loop)
    for (const entry of trackPatterns) {
      refIncrements.set(entry.id, (refIncrements.get(entry.id) ?? 0) + 1);
    }

    if (templateConstraint) contextParts.push(templateConstraint);
    if (competitorCtx) contextParts.push(`【对标竞品参考】\n${competitorCtx}`);
    if (formulaContext) contextParts.push(formulaContext);
    if (viralContext) contextParts.push(viralContext);

    // Inject content-driven factor context
    const cdfContext = buildContentDrivenContext(analysisStore, ops.competitors, identityMode);
    if (cdfContext) contextParts.push(cdfContext);

    // Inject trigger words from viral KB formulas
    const triggerWordsContext = buildTriggerWordsContext(basePath);
    if (triggerWordsContext) contextParts.push(triggerWordsContext);

    if (patternsContext) contextParts.push(patternsContext);
    if (strategyContext) contextParts.push(strategyContext);
    if (tasteContext) contextParts.push(tasteContext);
    if (discoveryContext) contextParts.push(discoveryContext);

    // Inject unified ops memory (audience perception + review learning + operator preference + taste + strategy)
    try {
      const opsMemoryCtx = await buildOpsMemoryContext({
        maxChars: 1500,
        identityMode,
      });
      if (opsMemoryCtx) contextParts.push(opsMemoryCtx);
    } catch {
      // ops memory not available, skip
    }

    // Generate XHS content via LLM
    let xhsDraft: XhsDraft = { title: '', body: '', tags: [] };
    let douyinDraft: DouyinDraft = { opening_hook: '', script: '', bgm_suggestion: '', key_captions: [] };

    try {
      xhsDraft = await llm.callJSON<XhsDraft>(
        buildContentPrompt(trend, personaDescription, 'xhs', xhsStyle, contextParts.join('\n\n'), {
          voiceStyle: voice?.style,
          sampleLines: voice?.sample_lines,
          identityMode,
        }), 4000,
      );
    } catch (err) {
      console.error(`[topic-generator] XHS draft failed for "${trend.keyword}":`, err);
    }

    try {
      // Enrich douyin script with LLM-generated hooks (replaced deprecated tiktok-growth skill)
      const hooks = await generateHooksViaLLM(identityMode, 3, llm);
      const hookContext = hooks.length > 0 ? `参考钩子公式：${hooks.slice(0, 2).join(' / ')}` : '';
      const douyinContext = [...contextParts, hookContext].filter(Boolean).join('\n\n');
      douyinDraft = await llm.callJSON<DouyinDraft>(
        buildContentPrompt(trend, personaDescription, 'douyin', douyinStyle, douyinContext, {
          voiceStyle: voice?.style,
          sampleLines: voice?.sample_lines,
          identityMode,
        }), 3000,
      );
    } catch (err) {
      console.error(`[topic-generator] Douyin draft failed for "${trend.keyword}":`, err);
    }

    // Build template spec for review queue
    const templateSpec: QueueItemTemplateSpec | undefined = template
      ? {
        content_type: template.type,
        category: template.category,
        scene: template.scene,
        camera: template.camera,
        styling: template.styling,
        highlights: template.highlights,
        reference_links: template.reference_links ?? [],
      }
      : undefined;

    await addItem({
      topic: `蹭 ${trend.keyword}：${trend.hook_angle}`,
      trend_hook: `${trend.keyword} (${trend.platform}, ${trend.velocity_score.toFixed(1)}x, ${trend.source_bucket ?? '热榜'})${trend.clickbait_labels && trend.clickbait_labels.length >= 2 ? ' ⚠️疑似标题党' : ''}${trend.is_ad ? ' 📢广告' : ''}`,
      identity_mode: identityMode,
      content: {
        xhs: {
          title: xhsDraft.title,
          body: xhsDraft.body,
          tags: xhsDraft.tags,
          cover_images: [],
        },
        douyin: {
          script: `${douyinDraft.opening_hook}\n\n${douyinDraft.script}`.trim(),
          bgm_suggestion: douyinDraft.bgm_suggestion,
          key_captions: douyinDraft.key_captions,
          cover_images: [],
        },
      },
      template_spec: templateSpec,
      competitor_benchmarks: benchmarks.length > 0 ? benchmarks : undefined,
    });

    // Track which patterns were injected into the prompt for this generation
    for (const p of injectedPatterns) {
      incrementPatternUsage(p.type, p.source);
    }
  }

  // Apply all accumulated times_referenced increments in a single read+write pass
  if (refIncrements.size > 0) {
    const currentEntries = loadEntries(basePath);
    const updatedEntries = currentEntries.map(e => {
      const delta = refIncrements.get(e.id);
      return delta ? { ...e, times_referenced: e.times_referenced + delta } : e;
    });
    saveEntries(basePath, updatedEntries);
  }
}
