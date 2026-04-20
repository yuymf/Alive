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
import { buildCompetitorKeyFromProfile } from './competitor-keys';
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
import { filterByDiversity, DiversityGateOptions } from './diversity-gate';

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
    // Append video_structure for douyin entries (爆款回流)
    if (d.video_structure) {
      const vs = d.video_structure;
      const moveStr = vs.dominant_moves.length > 0 ? vs.dominant_moves.join('、') : '未知';
      parts.push(`   视频结构：${vs.shot_count}镜头 · ${vs.pacing}节奏 · ${vs.transition_style} · 主运镜：${moveStr}`);
    }
    return parts.join('\n');
  }).filter(Boolean);

  return [
    `近期${platformLabel}上【${identityLabel}】赛道爆款规律（供参考，不强制模仿）：`,
    ...lines,
  ].join('\n');
}

/**
 * Build a video structure context from viral entries for douyin content generation.
 * Extracts common camera moves, pacing patterns, and transition styles from
 * dissected viral videos, then injects them as reference for new shot generation.
 *
 * This is the "爆款回流" loop: learn from what works → guide new creation.
 */
export function buildViralVideoContext(entries: ViralEntry[]): string {
  if (entries.length === 0) return '';

  // Only consider entries with video_structure
  const withVideo = entries.filter(e => e.dissection?.video_structure);
  if (withVideo.length === 0) return '';

  // Aggregate camera moves across all viral entries
  const moveCounts = new Map<string, number>();
  const pacingCounts = new Map<string, number>();
  const transitionStyles: string[] = [];

  for (const e of withVideo) {
    const vs = e.dissection!.video_structure!;

    // Count dominant moves
    for (const move of vs.dominant_moves) {
      moveCounts.set(move, (moveCounts.get(move) ?? 0) + 1);
    }

    // Count pacing patterns
    if (vs.pacing) {
      pacingCounts.set(vs.pacing, (pacingCounts.get(vs.pacing) ?? 0) + 1);
    }

    // Collect transition styles
    if (vs.transition_style) {
      transitionStyles.push(vs.transition_style);
    }
  }

  // Sort by frequency
  const topMoves = [...moveCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([move]) => move);

  const topPacing = [...pacingCounts.entries()]
    .sort((a, b) => b[1] - a[1])[0]?.[0];

  // Build context string
  const parts: string[] = [];

  if (topMoves.length > 0) {
    parts.push(`爆款高频运镜：${topMoves.join('、')}（建议至少使用其中一种）`);
  }

  if (topPacing) {
    const pacingLabel: Record<string, string> = {
      slow: '慢节奏（沉浸/治愈类）',
      medium: '中速节奏（日常/讲解类）',
      fast: '快节奏（变装/高燃类）',
      variable: '变速节奏（叙事/反差类）',
    };
    parts.push(`爆款常见节奏：${pacingLabel[topPacing] ?? topPacing}`);
  }

  if (transitionStyles.length > 0) {
    // Deduplicate and take top 2 most common styles
    const styleCounts = new Map<string, number>();
    for (const s of transitionStyles) {
      styleCounts.set(s, (styleCounts.get(s) ?? 0) + 1);
    }
    const topStyles = [...styleCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([s]) => s);
    parts.push(`爆款转场风格：${topStyles.join('、')}`);
  }

  // Calculate average shot count
  const avgShots = Math.round(
    withVideo.reduce((sum, e) => sum + e.dissection!.video_structure!.shot_count, 0) / withVideo.length
  );
  parts.push(`爆款平均镜头数：${avgShots}`);

  return `【爆款视频运镜参考（提炼自${withVideo.length}条爆款视频数据）】\n${parts.join('\n')}\n⚠️ 以上为数据参考，请结合内容模板蓝图的约束来设计分镜。`;
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
      const accountKey = buildCompetitorKeyFromProfile(p);
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
  const videoBP = template.video_blueprint;
  const videoBPSection = videoBP
    ? `
【视频分镜蓝图】
默认镜头数：${videoBP.default_shots ?? '4-7'}
节奏：${videoBP.pacing ?? 'variable'}
${videoBP.duration_range ? `时长范围：${videoBP.duration_range}` : ''}
${videoBP.required_moves && videoBP.required_moves.length > 0 ? `必须包含运镜：${videoBP.required_moves.join('、')}` : ''}
${videoBP.required_transitions && videoBP.required_transitions.length > 0 ? `必须包含转场：${videoBP.required_transitions.join('、')}` : ''}
${videoBP.mood_arc && videoBP.mood_arc.length > 0 ? `情绪弧线：${videoBP.mood_arc.join(' → ')}` : ''}`
    : '';

  return `【内容模板约束】
类型：${template.type}（${template.category}）
场景：${template.scene}
镜头语言：${template.camera}
人物形象/造型：${template.styling}
内容亮点：${template.highlights.join('、')}
${template.reference_links && template.reference_links.length > 0
    ? `参考案例：${template.reference_links.join(' / ')}`
    : ''}${videoBPSection}

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
    const accountKey = buildCompetitorKeyFromProfile(p);
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

// ─── Viral formula context builder (v2: 案例驱动，公式辅助) ──────────────────

/**
 * Build a rich context string from UniversalFormulas for runtime prompt injection.
 *
 * v2 design: instead of dumping trigger words only, we now inject:
 *   - 2-3 representative example titles (few-shot reference)
 *   - Structural template (if available, e.g. "[数字] + [反转] + [情绪结论]")
 *   - Trigger words (high-frequency emotion words)
 *   - A reminder to NOT copy verbatim
 *
 * This replaces the old buildTriggerWordsContext() which only injected trigger words.
 *
 * @param basePath  Memory base path for loading formulas
 * @param platform  Optional platform filter ('xhs' | 'douyin')
 * @param maxFormulas  Max number of formulas to include (default 4)
 */
export function buildViralFormulaContext(
  basePath: string,
  platform?: string,
  maxFormulas?: number,
): string {
  const formulas = loadViralFormulas(basePath);
  if (formulas.length === 0) return '';

  // Filter by platform and sort by confidence (highest first)
  const filtered = platform
    ? formulas.filter(f => f.platform === platform)
    : formulas;

  const sorted = [...filtered].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const limit = maxFormulas ?? 4;
  const top = sorted.slice(0, limit);

  if (top.length === 0) return '';

  const lines: string[] = [];

  for (const f of top) {
    const parts: string[] = [];
    const label = `${f.content_type}×${f.hook_type}`;
    const conf = f.confidence !== undefined ? `（置信度 ${Math.round(f.confidence * 100)}%）` : '';

    parts.push(`- ${label}${conf}`);

    // Structural template
    if (f.structural_template) {
      parts.push(`  句式结构：${f.structural_template}`);
    }

    // Example titles (few-shot)
    if (f.example_titles && f.example_titles.length > 0) {
      const examples = f.example_titles.slice(0, 3).map(t => `「${t}」`).join('、');
      parts.push(`  代表标题：${examples}`);
    }

    // Trigger words
    if (f.trigger_words && f.trigger_words.length > 0) {
      parts.push(`  高频触发词：${f.trigger_words.join('、')}`);
    }

    lines.push(parts.join('\n'));
  }

  return [
    '【爆款共性结构参考（提炼自多个爆款案例，借鉴结构不照搬标题）】',
    ...lines,
    '⚠️ 以上结构仅供句式和节奏参考，请结合自身风格重新创作，禁止直接复制标题。',
  ].join('\n');
}

/**
 * @deprecated Use buildViralFormulaContext() instead.
 * Kept for backward compat — it now delegates to buildViralFormulaContext
 * with maxFormulas=1 to produce a compact trigger-words-only output.
 */
export function buildTriggerWordsContext(
  basePath: string,
  platform?: string,
): string {
  // Fallback: extract just the trigger words from the new function
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
- BGM：匹配内容情绪，优先热门音频提升推荐权重

【分镜设计规范】（SCAAL框架：Subject + Camera + Action + Atmosphere + Length）
每个镜头必须回答四个核心问题：画面里有什么？镜头怎么运动？情绪氛围是什么？持续多久？

- 镜头数：4-7个镜头，节奏紧凑
- 每镜头时长：2-8秒，开场钩子镜头≤3秒，高潮镜头可延长至5-8秒
- 运镜原则：每镜头只指定一种运镜，不要组合多种运动；固定镜头用于对话/平静场景
- 转场设计：变装/身份切换用 match_cut 或 whip；情绪过渡用 dissolve；快节奏用 cut；结尾用 fade
- 景别节奏：开场用 long/medium_long 建立场景 → 中段切 close_up 抓情绪 → 高潮 extreme_close_up 放大细节 → 收尾 medium 回归稳定
- 氛围弧：各镜头 mood 必须构成递进弧线（如 好奇→紧张→惊艳→自信）
- text_overlay：仅在有强视觉冲击或关键信息时添加，不超过8字

运镜词汇参考（camera_move）：
  static(固定) | pan(水平摇) | tilt(垂直摇) | push_in(推入) | pull_out(拉远)
  tracking(跟踪) | dolly(推轨) | crane(摇臂升降) | orbit(环绕) | handheld(手持)
  whip_pan(快甩) | drone(航拍) | zoom_in(变焦推) | zoom_out(变焦拉)

机位词汇参考（camera_angle）：
  eye_level(平视) | low_angle(仰拍) | high_angle(俯拍) | dutch_angle(倾斜)
  over_shoulder(过肩) | pov(第一人称) | bird_eye(鸟瞰)

景别词汇参考（shot_size）：
  extreme_close_up(大特写) | close_up(特写) | medium_close_up(近景)
  medium(中景) | medium_long(中远景) | long(全景) | extreme_long(远景)

转场词汇参考（transition）：
  cut(硬切) | dissolve(叠化) | wipe(擦除) | match_cut(匹配剪辑)
  whip(甩镜头) | fade(淡入淡出) | smash(碎切) | zoom(变焦转场) | mask(遮罩) | none(无)

【Seedance 2.0 视频提示词规范】
每个镜头必须同时产出 Seedance 2.0 兼容的英文视频提示词，用于直接驱动 AI 视频生成。

六步公式（video_prompt，英文60-100词，严格按顺序）：
  ① Subject（主体） — 人物外貌+穿着，如 "A young woman with silver hair in a gaming jersey"
  ② Action（动作） — 正在做什么，如 "intensely staring at a monitor, fingers rapidly pressing keyboard keys"
  ③ Environment（环境） — 场景/背景，如 "in a dimly lit esports arena with neon blue and purple lights"
  ④ Lighting（光线） — 光线描述，如 "dramatic side lighting with rim light"（也单独填入 lighting 字段）
  ⑤ Camera（镜头运动） — 摄影机参数，如 "slow push-in camera"（与 camera_move 保持语义一致）
  ⑥ Style（风格） — 视觉风格关键词，如 "cinematic, 35mm, shallow depth of field"（也单独填入 style 字段）

lighting 字段参考词汇：
  soft natural light | dramatic side lighting with rim light | golden hour warm backlight
  neon-lit low key lighting | flat studio lighting | overhead fluorescent | candlelit warm glow
  harsh spotlight | blue hour ambient | backlit silhouette

style 字段参考词汇：
  cinematic, 35mm, shallow depth of field | vlog, handheld, natural | anime, cel-shaded, vibrant colors
  documentary, raw, unfiltered | fashion editorial, high contrast | retro film, grain, warm tones
  noir, high contrast, monochrome | dreamy, soft focus, pastel

negative_prompt 字段（英文，逗号分隔）：
  必须包含: jitter, bent limbs, deformed hands, blur, low quality, watermark
  可追加: text, subtitle, logo, oversaturated, distorted face, duplicate frames

重要规则：
- video_prompt 必须用英文写，60-100词，覆盖六步公式全部要素
- lighting 和 style 字段从参考词汇中选取或组合
- negative_prompt 每个镜头至少包含上面"必须包含"的6项
- 环境和光线是 Seedance 中杠杆最高的元素，务必详细描写`;

const XHS_OUTPUT_FORMAT = `输出格式 JSON：
{"title":"...（11-20字，含emoji）","body":"...（正文500字以内，段落间用emoji分隔）","tags":["#精准长尾词1","#精准长尾词2","#热门大词"]}`;

const XHS_VIDEO_OUTPUT_FORMAT = `输出格式 JSON（视频脚本+分镜结构，含 Seedance 2.0 视频提示词）：
{
  "title": "...（11-20字，含emoji）",
  "opening_hook": "前3秒钩子（11-20字，反问/冲突/悬念）",
  "script": "完整视频脚本（150-400字，口语化短句）",
  "bgm_suggestion": "推荐BGM风格或歌名",
  "key_captions": ["字幕要点1（≤10字）", "字幕要点2"],
  "total_duration": "总时长（如15-25秒）",
  "pacing": "slow | medium | fast | variable",
  "shots": [
    {
      "index": 1,
      "time_range": "0-3秒",
      "description": "画面内容描述（中文）",
      "camera_move": "从运镜词汇中选择一个",
      "camera_angle": "从机位词汇中选择一个",
      "shot_size": "从景别词汇中选择一个",
      "transition": "从转场词汇中选择一个（最后镜头用none）",
      "text_overlay": "画面文字（可选，≤8字）",
      "mood": "情绪标签",
      "video_prompt": "English 60-100 words, following 6-step formula: Subject + Action + Environment + Lighting + Camera + Style",
      "negative_prompt": "jitter, bent limbs, deformed hands, blur, low quality, watermark, ...",
      "lighting": "从lighting参考词汇中选取",
      "style": "从style参考词汇中选取"
    }
  ],
  "tags": ["#精准长尾词1", "#热门大词"]
}

分镜设计要求：
1. shots 数组必须包含 4-7 个镜头，按时间顺序排列
2. 第一个镜头必须对应 opening_hook 的时间段（0-3秒）
3. 各镜头 time_range 必须连续且覆盖 total_duration
4. mood 必须构成递进弧线（好奇→紧张→惊艳→自信 等）
5. text_overlay 仅在必要时添加，可省略（省略时不要输出该字段）
6. 每个 camera_move/camera_angle/shot_size/transition 必须从上面的词汇表中选择
7. 每个镜头的 video_prompt 必须是英文 60-100 词，严格按六步公式顺序写
8. negative_prompt 每个镜头至少包含: jitter, bent limbs, deformed hands, blur, low quality, watermark
9. lighting 和 style 字段从 Seedance 参考词汇中选取`;

const DOUYIN_OUTPUT_FORMAT = `输出格式 JSON（分镜结构，含 Seedance 2.0 视频提示词）：
{
  "opening_hook": "前3秒钩子（11-20字，反问/冲突/悬念）",
  "script": "完整口播脚本（200-500字，短句口语化）",
  "bgm_suggestion": "推荐BGM风格或歌名+节拍描述",
  "key_captions": ["字幕要点1（≤10字）", "字幕要点2"],
  "total_duration": "总时长（如25-30秒）",
  "pacing": "slow | medium | fast | variable",
  "shots": [
    {
      "index": 1,
      "time_range": "0-3秒",
      "description": "画面内容、人物动作、表情（中文）",
      "camera_move": "从运镜词汇中选择一个",
      "camera_angle": "从机位词汇中选择一个",
      "shot_size": "从景别词汇中选择一个",
      "transition": "从转场词汇中选择一个（最后镜头用none）",
      "text_overlay": "画面文字（可选，≤8字）",
      "mood": "情绪标签（如：紧张悬念）",
      "video_prompt": "English 60-100 words, following 6-step formula: Subject + Action + Environment + Lighting + Camera + Style",
      "negative_prompt": "jitter, bent limbs, deformed hands, blur, low quality, watermark, ...",
      "lighting": "从lighting参考词汇中选取",
      "style": "从style参考词汇中选取"
    },
    {
      "index": 2,
      "time_range": "3-8秒",
      "description": "...",
      "camera_move": "...",
      "camera_angle": "...",
      "shot_size": "...",
      "transition": "...",
      "text_overlay": "...",
      "mood": "...",
      "video_prompt": "...",
      "negative_prompt": "...",
      "lighting": "...",
      "style": "..."
    }
  ]
}

分镜设计要求：
1. shots 数组必须包含 4-7 个镜头，按时间顺序排列
2. 第一个镜头必须对应 opening_hook 的时间段（0-3秒）
3. 各镜头 time_range 必须连续且覆盖 total_duration
4. mood 必须构成递进弧线（好奇→紧张→惊艳→自信 等）
5. text_overlay 仅在必要时添加，可省略（省略时不要输出该字段）
6. 每个 camera_move/camera_angle/shot_size/transition 必须从上面的词汇表中选择
7. 每个镜头的 video_prompt 必须是英文 60-100 词，严格按六步公式顺序写
8. negative_prompt 每个镜头至少包含: jitter, bent limbs, deformed hands, blur, low quality, watermark
9. lighting 和 style 字段从 Seedance 参考词汇中选取`;

// ─── Prompt builder ─────────────────────────────────────────────────────────

/** Voice settings for content prompt — derived from persona.voice */
export interface ContentPromptOptions {
  voiceStyle?: string;
  sampleLines?: string[];
  identityMode?: string;
  /** Content template — used to determine XHS video_post format */
  template?: ContentTemplate | null;
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
  // XHS video_post templates use douyin-style guidelines + video output format
  const isXhsVideo = platform === 'xhs' && options?.template?.format === 'video_post';
  const guidelines = isXhsVideo ? DOUYIN_GUIDELINES
    : platform === 'xhs' ? XHS_GUIDELINES
    : DOUYIN_GUIDELINES;
  const platformLabel = isXhsVideo ? '小红书视频脚本'
    : platform === 'xhs' ? '小红书图文'
    : '抖音视频脚本';

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

${isXhsVideo ? XHS_VIDEO_OUTPUT_FORMAT : platform === 'xhs' ? XHS_OUTPUT_FORMAT : DOUYIN_OUTPUT_FORMAT}`;

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
    'xhs.opening_hook': '前3秒钩子，11-20字，反问/冲突/悬念',
    'xhs.script': '150-400字，视频脚本，口语化短句',
    'xhs.shots': '4-7个镜头的分镜数组，每个镜头含 index/time_range/description/camera_move/camera_angle/shot_size/transition/mood + Seedance video_prompt/negative_prompt/lighting/style',
    'xhs.bgm_suggestion': '匹配视频情绪的BGM',
    'xhs.key_captions': '3-5个关键字幕，每条≤10字',
    'douyin.opening_hook': '前3秒文案，11-20字，用反问/冲突/悬念/数字冲击',
    'douyin.script': '200-500字，口语化短句，每句≤15字，像聊天不像念稿',
    'douyin.bgm_suggestion': '匹配内容情绪的BGM，优先热门音频',
    'douyin.key_captions': '3-5个关键字幕，每条≤10字，强化记忆点',
    'douyin.shots': '4-7个镜头的分镜数组，每个镜头含 index/time_range/description/camera_move/camera_angle/shot_size/transition/mood + Seedance video_prompt/negative_prompt/lighting/style',
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

interface XhsDraft {
  title: string;
  body: string;
  tags: string[];
  cover_description: string;
  /** Video fields (only when template.format === 'video_post') */
  opening_hook?: string;
  script?: string;
  bgm_suggestion?: string;
  key_captions?: string[];
  total_duration?: string;
  pacing?: string;
  shots?: Array<{
    index: number;
    time_range: string;
    description: string;
    camera_move: string;
    camera_angle: string;
    shot_size: string;
    transition: string;
    text_overlay?: string;
    mood: string;
    // Seedance 2.0 fields
    video_prompt?: string;
    negative_prompt?: string;
    lighting?: string;
    style?: string;
  }>;
}
interface DouyinDraft {
  opening_hook: string;
  script: string;
  bgm_suggestion: string;
  key_captions: string[];
  total_duration: string;
  pacing: string;
  shots: Array<{
    index: number;
    time_range: string;
    description: string;
    camera_move: string;
    camera_angle: string;
    shot_size: string;
    transition: string;
    text_overlay?: string;
    mood: string;
    // Seedance 2.0 fields
    video_prompt: string;
    negative_prompt: string;
    lighting: string;
    style: string;
  }>;
  cover_description: string;
}

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
  diversityOptions?: DiversityGateOptions,
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
      { maxSameModeInWindow: 3, minAngleDistance: 0.5, ...diversityOptions },
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

    // Inject viral video structure context (爆款回流：运镜模式从爆款学习)
    const viralVideoCtx = buildViralVideoContext(trackPatterns);
    if (viralVideoCtx) contextParts.push(viralVideoCtx);

    // Inject content-driven factor context
    const cdfContext = buildContentDrivenContext(analysisStore, ops.competitors, identityMode);
    if (cdfContext) contextParts.push(cdfContext);

    // Inject viral formula context (案例+模板+触发词，v2 runtime injection)
    const viralFormulaCtx = buildViralFormulaContext(basePath, trackPlatform);
    if (viralFormulaCtx) contextParts.push(viralFormulaCtx);

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
    let xhsDraft: XhsDraft = { title: '', body: '', tags: [], cover_description: '' };
    let douyinDraft: DouyinDraft = { opening_hook: '', script: '', bgm_suggestion: '', key_captions: [], total_duration: '', pacing: 'variable', shots: [], cover_description: '' };

    try {
      xhsDraft = await llm.callJSON<XhsDraft>(
        buildContentPrompt(trend, personaDescription, 'xhs', xhsStyle, contextParts.join('\n\n'), {
          voiceStyle: voice?.style,
          sampleLines: voice?.sample_lines,
          identityMode,
          template,
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
          // Video fields for XHS video_post templates
          opening_hook: xhsDraft.opening_hook,
          script: xhsDraft.script,
          bgm_suggestion: xhsDraft.bgm_suggestion,
          key_captions: xhsDraft.key_captions,
          shots: (xhsDraft.shots ?? []).map(s => ({
            index: s.index,
            time_range: s.time_range,
            description: s.description,
            camera_move: s.camera_move as import('../utils/types').CameraMove,
            camera_angle: s.camera_angle as import('../utils/types').CameraAngle,
            shot_size: s.shot_size as import('../utils/types').ShotSize,
            transition: s.transition as import('../utils/types').ShotTransition,
            text_overlay: s.text_overlay,
            mood: s.mood,
            video_prompt: s.video_prompt ?? '',
            negative_prompt: s.negative_prompt ?? 'jitter, bent limbs, deformed hands, blur, low quality, watermark',
            lighting: s.lighting ?? '',
            style: s.style ?? '',
          })),
          total_duration: xhsDraft.total_duration,
          pacing: xhsDraft.pacing as QueueItemContent['xhs']['pacing'],
        },
        douyin: {
          script: `${douyinDraft.opening_hook}\n\n${douyinDraft.script}`.trim(),
          bgm_suggestion: douyinDraft.bgm_suggestion,
          key_captions: douyinDraft.key_captions,
          cover_images: [],
          shots: (douyinDraft.shots ?? []).map(s => ({
            index: s.index,
            time_range: s.time_range,
            description: s.description,
            camera_move: s.camera_move as import('../utils/types').CameraMove,
            camera_angle: s.camera_angle as import('../utils/types').CameraAngle,
            shot_size: s.shot_size as import('../utils/types').ShotSize,
            transition: s.transition as import('../utils/types').ShotTransition,
            text_overlay: s.text_overlay,
            mood: s.mood,
            video_prompt: s.video_prompt ?? '',
            negative_prompt: s.negative_prompt ?? 'jitter, bent limbs, deformed hands, blur, low quality, watermark',
            lighting: s.lighting ?? '',
            style: s.style ?? '',
          })),
          total_duration: douyinDraft.total_duration || '',
          pacing: (douyinDraft.pacing || 'variable') as QueueItemContent['douyin']['pacing'],
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
