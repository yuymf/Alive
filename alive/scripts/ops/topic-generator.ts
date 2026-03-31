/**
 * topic-generator.ts
 * Given filtered trends + competitor data, generates N content drafts
 * (xhs + douyin) using content-writer and tiktok-growth ClawHub skills,
 * then pushes each draft into the review queue.
 */

import { execFileSync } from 'child_process';
import { OpsConfig } from '../utils/types';
import { LLMClient } from '../utils/llm-client';
import { FilteredTrend } from './trend-analyzer';
import { addItem } from './review-queue';

// ─── Pure functions (exported for testing) ───────────────────────────────────

export function selectIdentityMode(
  trend: FilteredTrend,
): 'esports' | 'singer' | 'racer' | 'daily' {
  return trend.identity_mode;
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
  } catch {
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
  } catch {
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

  for (const trend of topN) {
    const identityMode = selectIdentityMode(trend);
    const xhsStyle = ops.platforms.xhs?.style ?? '图文为主';
    const douyinStyle = ops.platforms.douyin?.style ?? '视频脚本';

    // Generate XHS content via LLM
    let xhsDraft: XhsDraft = { title: '', body: '', tags: [], cover_description: '' };
    let douyinDraft: DouyinDraft = { opening_hook: '', script: '', bgm_suggestion: '', key_captions: [], cover_description: '' };

    try {
      xhsDraft = await llm.callJSON<XhsDraft>(
        buildContentPrompt(trend, personaDescription, 'xhs', xhsStyle), 1500,
      );
    } catch { /* keep empty draft */ }

    try {
      // Enrich douyin script with tiktok-growth hooks
      const hooks = callTiktokGrowth(identityMode, 3);
      const hookContext = hooks.length > 0 ? `参考钩子公式：${hooks.slice(0, 2).join(' / ')}` : undefined;
      douyinDraft = await llm.callJSON<DouyinDraft>(
        buildContentPrompt(trend, personaDescription, 'douyin', douyinStyle, hookContext), 1500,
      );
    } catch { /* keep empty draft */ }

    // Generate cover images
    const coverDescription = xhsDraft.cover_description || douyinDraft.cover_description || trend.keyword;
    const coverImages = callGenerateImage(coverDescription, imageStylePrompt);

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
    });
  }
}
