/**
 * topic-generator.ts
 * Given filtered trends + competitor data, generates N content drafts
 * (xhs + douyin) using content-writer and tiktok-growth ClawHub skills,
 * then pushes each draft into the review queue.
 *
 * Enhanced: Now injects content templates (scene/camera/styling constraints)
 * and competitor benchmarks into LLM prompts for better-targeted content.
 */

import { execFileSync } from 'child_process';
import {
  OpsConfig, ContentTemplate, CompetitorProfile, IdentityMode,
  QueueItemTemplateSpec, QueueItemCompetitorBenchmark, QueueItem, QueueItemContent,
} from '../utils/types';
import { LLMClient } from '../utils/llm-client';
import { FilteredTrend } from './trend-analyzer';
import { addItem, getItem, updateItemContent } from './review-queue';
import { buildCompetitorContext } from './competitor-tracker';
import { PATHS, readJSON } from '../utils/file-utils';
import { CompetitorLog, CompetitorUpdate, ContentStrategy, ContentPatterns } from '../utils/types';

import { matchesTaxonomy } from './ops-taxonomy';

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
 * Build competitor benchmark data for a queue item.
 * Matches competitors by identity_mode on their content templates,
 * or returns all primary competitors if no identity_mode-based filtering is possible.
 */
export function buildCompetitorBenchmarks(
  profiles: readonly CompetitorProfile[] | undefined,
  identityMode: string,
  templates?: readonly ContentTemplate[],
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
    .map(p => ({
      name: p.name,
      platform: p.platform,
      content_mix_relevant: p.content_mix
        ? Object.entries(p.content_mix).map(([k, v]) => `${k}${v}%`).join('、')
        : '未知',
      audience: p.audience ?? '未知',
      interaction_style: p.interaction_style ?? '未知',
    }));
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

export function buildContentPrompt(
  trend: FilteredTrend,
  personaDescription: string,
  platform: 'xhs' | 'douyin',
  platformStyle: string,
  extraContext?: string,
): string {
  const base = `你是内容创作者 "${personaDescription}"。

当前热点：${trend.keyword}（${trend.platform}，速度分 ${trend.velocity_score.toFixed(1)}x）
切入角度：${trend.hook_angle}
目标平台：${platform}
平台风格：${platformStyle}

请生成一条完整的 ${platform === 'xhs' ? '小红书图文' : '抖音视频脚本'} 内容草稿。

${platform === 'xhs' ? `输出格式 JSON：
{"title":"...","body":"...（正文300-500字）","tags":["#标签1","#标签2"],"cover_description":"封面图画面描述（用于AI生图）"}` : `输出格式 JSON：
{"opening_hook":"前3秒钩子（一句话）","script":"完整脚本（200-400字）","bgm_suggestion":"推荐BGM风格或歌名","key_captions":["字幕要点1","字幕要点2"],"cover_description":"封面图画面描述（用于AI生图）"}`}`;
  return extraContext ? `${base}\n${extraContext}` : base;
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
    'xhs.title': '20字以内，可含emoji',
    'xhs.body': '300-500字',
    'xhs.tags': '5-10个标签，数组格式',
    'douyin.opening_hook': '前3秒文案，15字以内',
    'douyin.script': '200-400字',
    'douyin.bgm_suggestion': '一句话描述BGM风格',
    'douyin.key_captions': '3-5个关键字幕，数组格式',
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

  const result = await llm.callJSON<Record<string, unknown>>(prompt, 1500);
  const newFieldValue = result[key] ?? result[field] ?? currentValue;
  const updatedPlatformContent = { ...item.content[platform], [key]: newFieldValue };
  const newContent = platform === 'xhs'
    ? { xhs: updatedPlatformContent as QueueItemContent['xhs'] }
    : { douyin: updatedPlatformContent as QueueItemContent['douyin'] };

  return updateItemContent(item.id, newContent, { instruction, field });
}

// ─── ClawHub skill calls ──────────────────────────────────────────────────────
interface TiktokGrowthResult {
  hooks?: string[];
  ideas?: Array<{ title: string; format: string }>;
}

function callTiktokGrowth(niche: string, count: number): string[] {
  try {
    const raw = execFileSync('openclaw', [
      'skill', 'run', 'tiktok-growth',
      '--args', JSON.stringify({ niche, count, action: 'generate_hooks' }),
    ], { timeout: 30_000, encoding: 'utf8' });
    const result = JSON.parse(raw) as TiktokGrowthResult;
    return result.hooks ?? [];
  } catch (err) {
    console.error('[topic-generator] tiktok-growth call failed:', err);
    return [];
  }
}

interface XhsDraft { title: string; body: string; tags: string[]; cover_description: string }
interface DouyinDraft { opening_hook: string; script: string; bgm_suggestion: string; key_captions: string[]; cover_description: string }

// ─── Image generation ────────────────────────────────────────────────────────

function callGenerateImage(description: string, stylePrompt: string): string[] {
  try {
    const raw = execFileSync('openclaw', [
      'skill', 'run', 'generate-image',
      '--args', JSON.stringify({ prompt: `${stylePrompt}, ${description}`, count: 3 }),
    ], { timeout: 60_000, encoding: 'utf8' });
    const result = JSON.parse(raw) as { images?: string[] };
    return result.images ?? [];
  } catch (err) {
    console.error('[topic-generator] generate-image call failed:', err);
    return [];
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function generateTopics(
  trends: FilteredTrend[],
  ops: OpsConfig,
  personaDescription: string,
  imageStylePrompt: string,
  llm: LLMClient,
): Promise<void> {
  const topN = trends.slice(0, ops.topic_count);

  const strategy = readJSON<ContentStrategy | null>(PATHS.contentStrategy, null);
  const patterns = readJSON<ContentPatterns | null>(PATHS.contentPatterns, null);
  const patternsContext = patterns && patterns.patterns.length > 0
    ? `【参考爆款模式】\n${patterns.patterns.slice(0, 5).map(
        p => `- ${p.type}：${p.formula}（来源：${p.source}）`
      ).join('\n')}`
    : '';

  // Load persisted competitor log for live data context
  const competitorLog = readJSON<CompetitorLog>(PATHS.competitorLog, { entries: [], last_updated: '' });
  const liveUpdates: CompetitorUpdate[] = competitorLog.entries;

  // Build competitor context once for all topics
  const competitorCtx = ops.competitors
    ? buildCompetitorContext(ops.competitors, liveUpdates)
    : '';

  for (const trend of topN) {
    const identityMode = selectIdentityMode(trend);
    const xhsStyle = ops.platforms.xhs?.style ?? '图文为主';
    const douyinStyle = ops.platforms.douyin?.style ?? '视频脚本';

    // Select matching content template
    const template = applyStrategyToTemplateSelection(ops.content_templates, identityMode, trend.keyword, strategy);
    const templateConstraint = template ? buildTemplateConstraint(template) : '';

    // Build competitor benchmarks for this identity
    const benchmarks = buildCompetitorBenchmarks(ops.competitors, identityMode, ops.content_templates);

    // Compose extra context: template + competitor + hooks
    const contextParts: string[] = [];
    if (templateConstraint) contextParts.push(templateConstraint);
    if (competitorCtx) contextParts.push(`【对标竞品参考】\n${competitorCtx}`);
    if (patternsContext) contextParts.push(patternsContext);

    // Generate XHS content via LLM
    let xhsDraft: XhsDraft = { title: '', body: '', tags: [], cover_description: '' };
    let douyinDraft: DouyinDraft = { opening_hook: '', script: '', bgm_suggestion: '', key_captions: [], cover_description: '' };

    try {
      xhsDraft = await llm.callJSON<XhsDraft>(
        buildContentPrompt(trend, personaDescription, 'xhs', xhsStyle, contextParts.join('\n\n')), 1500,
      );
    } catch (err) {
      console.error(`[topic-generator] XHS draft failed for "${trend.keyword}":`, err);
    }

    try {
      // Enrich douyin script with tiktok-growth hooks
      const hooks = callTiktokGrowth(identityMode, 3);
      const hookContext = hooks.length > 0 ? `参考钩子公式：${hooks.slice(0, 2).join(' / ')}` : '';
      const douyinContext = [...contextParts, hookContext].filter(Boolean).join('\n\n');
      douyinDraft = await llm.callJSON<DouyinDraft>(
        buildContentPrompt(trend, personaDescription, 'douyin', douyinStyle, douyinContext), 1500,
      );
    } catch (err) {
      console.error(`[topic-generator] Douyin draft failed for "${trend.keyword}":`, err);
    }

    // Generate cover images
    const coverDescription = xhsDraft.cover_description || douyinDraft.cover_description || trend.keyword;
    const coverImages = callGenerateImage(coverDescription, imageStylePrompt);

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
      trend_hook: `${trend.keyword} (${trend.platform}, ${trend.velocity_score.toFixed(1)}x)`,
      identity_mode: identityMode,
      content: {
        xhs: {
          title: xhsDraft.title,
          body: xhsDraft.body,
          tags: xhsDraft.tags,
          cover_images: [...coverImages],
        },
        douyin: {
          script: `${douyinDraft.opening_hook}\n\n${douyinDraft.script}`.trim(),
          bgm_suggestion: douyinDraft.bgm_suggestion,
          key_captions: douyinDraft.key_captions,
          cover_images: [...coverImages],
        },
      },
      template_spec: templateSpec,
      competitor_benchmarks: benchmarks.length > 0 ? benchmarks : undefined,
    });
  }
}
