/**
 * post-analyzer.ts
 * Per-post performance analysis — engagement scoring, tier classification,
 * pattern extraction, and persona alignment checking.
 * Triggered at T+24h after publish for every published content item.
 */

import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now, wallNow } from '../utils/time-utils';
import { LLMClient } from '../utils/llm-client';
import {
  PerformanceMetrics, PerformanceEntry, PerformanceLog,
  AnalysisLog, PerformanceTier, ContentAnalysis,
} from '../utils/types';
import { loadQueue } from './review-queue';
import { addPattern, loadContentPatterns, saveContentPatterns } from './content-analyzer';
import { updateTasteFromAnalysis } from './taste-engine';
import { upsertAudiencePerceptionEntry, buildAudiencePerceptionEntry } from './audience-perception';

// ─── Constants ────────────────────────────────────────────────────────────────

const ANALYSIS_LOG_RETENTION_DAYS = 30;

const DEFAULT_ANALYSIS_LOG: AnalysisLog = { entries: [], last_updated: '' };
const DEFAULT_BASELINE = 50;

// ─── Platform Engagement Weights ──────────────────────────────────────────────
const XHS_WEIGHTS = { likes: 1.0, comments: 3.0, saves: 5.0, shares: 4.0 } as const;
const DOUYIN_WEIGHTS = { likes: 1.0, comments: 2.0, saves: 3.0, shares: 5.0, views: 0.01 } as const;

// ─── Tier Classification Thresholds ───────────────────────────────────────────
const TIER_VIRAL_MULTIPLIER = 2.0;
const TIER_ABOVE_AVG_MULTIPLIER = 1.3;
const TIER_BELOW_AVG_MULTIPLIER = 0.7;

// ─── Engagement Scoring ───────────────────────────────────────────────────────

export function computeEngagementScore(
  metrics: PerformanceMetrics,
  platform: 'xhs' | 'douyin',
): number {
  const likes = metrics.likes ?? 0;
  const comments = metrics.comments ?? 0;
  const saves = metrics.saves ?? 0;
  const shares = metrics.shares ?? 0;
  const views = metrics.views ?? 0;

  if (platform === 'douyin') {
    const w = DOUYIN_WEIGHTS;
    return likes * w.likes + comments * w.comments + saves * w.saves + shares * w.shares + views * w.views;
  }
  const w = XHS_WEIGHTS;
  return likes * w.likes + comments * w.comments + saves * w.saves + shares * w.shares;
}

// ─── Tier Classification ──────────────────────────────────────────────────────

export function classifyTier(score: number, baseline: number): PerformanceTier {
  const effectiveBaseline = baseline > 0 ? baseline : DEFAULT_BASELINE;
  if (score > effectiveBaseline * TIER_VIRAL_MULTIPLIER) return 'viral';
  if (score > effectiveBaseline * TIER_ABOVE_AVG_MULTIPLIER) return 'above_avg';
  if (score >= effectiveBaseline * TIER_BELOW_AVG_MULTIPLIER) return 'normal';
  return 'below_avg';
}

// ─── Analysis Log I/O ─────────────────────────────────────────────────────────

export function loadAnalysisLog(): AnalysisLog {
  return readJSON<AnalysisLog>(PATHS.analysisLog, DEFAULT_ANALYSIS_LOG);
}

export function saveAnalysisLog(log: AnalysisLog): void {
  writeJSON(PATHS.analysisLog, { ...log, last_updated: wallNow().toISOString() });
}

// ─── Baseline Computation ─────────────────────────────────────────────────────

export function computeBaseline(
  entries: PerformanceEntry[],
  platform: 'xhs' | 'douyin',
  windowDays: number,
): number {
  const cutoff = new Date(now().getTime() - windowDays * 24 * 60 * 60 * 1000);
  const relevant = entries.filter(
    e => e.platform === platform && new Date(e.published_at) >= cutoff,
  );
  if (relevant.length === 0) return 0;

  const totalScore = relevant.reduce(
    (sum, e) => sum + computeEngagementScore(e.peak_metrics, platform),
    0,
  );
  return Math.round(totalScore / relevant.length);
}

// ─── Pending Analysis Detection ───────────────────────────────────────────────

export function findPendingAnalysis(
  perfLog: PerformanceLog,
  analysisLog: AnalysisLog,
  delayHours: number,
): PerformanceEntry[] {
  const cutoff = new Date(now().getTime() - delayHours * 60 * 60 * 1000);
  const analyzedIds = new Set(analysisLog.entries.map(e => e.item_id));

  return perfLog.entries.filter(entry => {
    if (analyzedIds.has(entry.item_id)) return false;
    const publishedAt = new Date(entry.published_at);
    return publishedAt <= cutoff;
  });
}

// ─── LLM Prompt Building ──────────────────────────────────────────────────────

export interface PostAnalysisInput {
  contentText: string;
  platform: 'xhs' | 'douyin';
  metrics: PerformanceMetrics;
  templateType: string;
  identityMode: string;
  baseline: number;
  personaSummary: string;
  /** Whether the content is a video post (has shots/storyboard) */
  isVideoContent?: boolean;
  /** The hook angle used in this content (from trend data) */
  hookAngle?: string;
  /** Topic keywords associated with this content */
  topicKeywords?: string[];
}

export function buildPostAnalysisPrompt(input: PostAnalysisInput): string {
  const { contentText, platform, metrics, templateType, identityMode, baseline, personaSummary, isVideoContent } = input;
  const metricsStr = [
    `${metrics.likes}赞`,
    `${metrics.comments}评`,
    metrics.saves ? `${metrics.saves}藏` : null,
    metrics.shares ? `${metrics.shares}转` : null,
    metrics.views ? `${metrics.views}播` : null,
  ].filter(Boolean).join(' ');

  const videoDimensions = isVideoContent ? `
6. video_analysis: 视频专属维度分析（仅视频内容需填写）：
   - shot_execution: 分镜执行质量 0-10（镜头设计是否合理、节奏是否紧凑）
   - pacing_effectiveness: 节奏效果 0-10（节奏是否匹配内容类型，观众是否有耐心看完）
   - visual_storytelling: 视觉叙事 0-10（运镜和转场是否增强了叙事表现力）
   - camera_move_highlights: 运镜亮点（如：哪几个运镜特别有效，为什么）
   - transition_feedback: 转场反馈（如：哪几个转场自然，哪几个突兀）` : '';

  const videoJSONFields = isVideoContent ? `,
  "video_analysis": {
    "shot_execution": 8,
    "pacing_effectiveness": 7,
    "visual_storytelling": 8,
    "camera_move_highlights": "亮点描述",
    "transition_feedback": "反馈描述"
  }` : '';

  return `你是内容数据分析专家。请对以下已发布内容进行全面分析。

【内容信息】
平台: ${platform === 'xhs' ? '小红书' : '抖音'}${isVideoContent ? '（视频内容）' : ''}
身份模式: ${identityMode}
内容模板: ${templateType}
正文/脚本:
${contentText}

【表现数据】
${metricsStr}
7天基线均值: ${baseline}

【人设参考】
${personaSummary}

请分析以下维度并返回 JSON:

1. performance_tier: 与基线对比的效果分级 ("viral"=基线2倍以上, "above_avg"=1.3倍以上, "normal"=0.7倍以上, "below_avg"=0.7倍以下)
2. engagement_score: 综合得分 0-100
3. pattern_analysis: 各维度 0-10 评分 + 成功因素 + 改进方向
4. extracted_patterns: 如果是 viral 或 above_avg，提取可复用模式（否则不包含此字段）
5. persona_alignment: 人设一致性检查${videoDimensions}
6. hook_angle: 内容切入角度分类（如"反常识"、"共鸣式"、"冲突对比"、"数据冲击"、"悬念"、"实用干货"等）
7. topic_tags: 内容话题标签数组（如["赛事分析","选手故事","战术拆解"]），2-4个标签

JSON格式:
\`\`\`json
{
  "performance_tier": "viral|above_avg|normal|below_avg",
  "engagement_score": 85,
  "hook_angle": "反常识",
  "topic_tags": ["赛事分析", "选手故事"],
  "pattern_analysis": {
    "hook_effectiveness": 9,
    "emotional_resonance": 8,
    "trending_alignment": 7,
    "visual_impact": 8,
    "call_to_action": 6,
    "key_success_factors": ["因素1", "因素2", "因素3"],
    "improvement_areas": ["改进1", "改进2"]
  },
  "extracted_patterns": [
    {
      "pattern_type": "反转式开头",
      "description": "先说反面观点再翻转",
      "applicable_templates": ["适用模板"],
      "confidence": 0.8
    }
  ],
  "persona_alignment": {
    "score": 9,
    "identity_mode_match": true,
    "tone_consistency": "on_brand|slight_drift|off_brand",
    "specific_notes": "具体说明"
  }${videoJSONFields}
}
\`\`\``;
}

// ─── Response Parsing ─────────────────────────────────────────────────────────

interface AnalysisContext {
  item_id: string;
  platform: 'xhs' | 'douyin';
  identity_mode: string;
  template_type: string;
  /** Fallback hook_angle from trend data if LLM doesn't provide one */
  hook_angle?: string;
  /** Fallback topic_tags from trend data if LLM doesn't provide them */
  topic_tags?: string[];
}

export function parseAnalysisResponse(
  response: Record<string, unknown>,
  ctx: AnalysisContext,
): ContentAnalysis {
  const pa = response.pattern_analysis as Record<string, unknown> | undefined;
  const alignment = response.persona_alignment as Record<string, unknown> | undefined;
  const extracted = response.extracted_patterns as Record<string, unknown>[] | undefined;

  return {
    item_id: ctx.item_id,
    analyzed_at: now().toISOString(),
    performance_tier: (response.performance_tier as PerformanceTier) ?? 'normal',
    engagement_score: (response.engagement_score as number) ?? 0,
    platform: ctx.platform,
    identity_mode: ctx.identity_mode as ContentAnalysis['identity_mode'],
    template_type: ctx.template_type,
    hook_angle: (response.hook_angle as string) ?? ctx.hook_angle,
    topic_tags: (response.topic_tags as string[]) ?? ctx.topic_tags,
    pattern_analysis: {
      hook_effectiveness: (pa?.hook_effectiveness as number) ?? 5,
      emotional_resonance: (pa?.emotional_resonance as number) ?? 5,
      trending_alignment: (pa?.trending_alignment as number) ?? 5,
      visual_impact: (pa?.visual_impact as number) ?? 5,
      call_to_action: (pa?.call_to_action as number) ?? 5,
      key_success_factors: (pa?.key_success_factors as string[]) ?? [],
      improvement_areas: (pa?.improvement_areas as string[]) ?? [],
    },
    extracted_patterns: extracted
      ? extracted.map(p => ({
          pattern_type: (p.pattern_type as string) ?? '',
          description: (p.description as string) ?? '',
          applicable_templates: (p.applicable_templates as string[]) ?? [],
          confidence: (p.confidence as number) ?? 0.5,
        }))
      : undefined,
    persona_alignment: {
      score: (alignment?.score as number) ?? 5,
      identity_mode_match: (alignment?.identity_mode_match as boolean) ?? true,
      tone_consistency: (alignment?.tone_consistency as 'on_brand' | 'slight_drift' | 'off_brand') ?? 'on_brand',
      specific_notes: (alignment?.specific_notes as string) ?? '',
    },
  };
}

// ─── Analysis Log Management ──────────────────────────────────────────────────

export function cleanupAnalysisLog(log: AnalysisLog, retentionDays: number): AnalysisLog {
  const cutoff = new Date(now().getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const filtered = log.entries.filter(e => new Date(e.analyzed_at) >= cutoff);
  return { ...log, entries: filtered };
}

export function saveAnalysis(analysis: ContentAnalysis): void {
  const current = loadAnalysisLog();
  const cleaned = cleanupAnalysisLog(current, ANALYSIS_LOG_RETENTION_DAYS);
  const updated: AnalysisLog = {
    ...cleaned,
    entries: [...cleaned.entries, analysis],
    last_updated: wallNow().toISOString(),
  };
  saveAnalysisLog(updated);
}

// ─── Content Text Extraction ──────────────────────────────────────────────────

function getContentText(item: Awaited<ReturnType<typeof loadQueue>>['items'][number], platform: 'xhs' | 'douyin'): string {
  if (platform === 'xhs') {
    const xhs = item.content?.xhs;
    if (!xhs) return '';
    const parts = [`标题: ${xhs.title}`];
    // XHS video: include script + shots summary
    if (xhs.shots && xhs.shots.length > 0) {
      if (xhs.script) parts.push(`视频脚本: ${xhs.script}`);
      if (xhs.opening_hook) parts.push(`钩子: ${xhs.opening_hook}`);
      parts.push(`分镜(${xhs.shots.length}镜头, ${xhs.total_duration ?? '未知时长'}, ${xhs.pacing ?? '未知'}节奏):`);
      xhs.shots.forEach(s => {
        parts.push(`  #${s.index} [${s.time_range}] ${s.camera_move}/${s.camera_angle}/${s.shot_size} → ${s.transition} | ${s.mood} | ${s.description}`);
      });
    } else {
      parts.push(`正文: ${xhs.body}`);
    }
    return parts.join('\n');
  }
  const douyin = item.content?.douyin;
  if (!douyin) return '';
  const parts = [`脚本: ${douyin.script}`];
  // Include shots summary if available
  if (douyin.shots && douyin.shots.length > 0) {
    parts.push(`分镜(${douyin.shots.length}镜头, ${douyin.total_duration ?? '未知时长'}, ${douyin.pacing ?? '未知'}节奏):`);
    douyin.shots.forEach(s => {
      parts.push(`  #${s.index} [${s.time_range}] ${s.camera_move}/${s.camera_angle}/${s.shot_size} → ${s.transition} | ${s.mood} | ${s.description}`);
    });
  }
  return parts.join('\n');
}

/** Detect if a queue item is video content based on shots presence */
function isVideoContent(item: Awaited<ReturnType<typeof loadQueue>>['items'][number], platform: 'xhs' | 'douyin'): boolean {
  if (platform === 'xhs') {
    return !!(item.content?.xhs?.shots && item.content.xhs.shots.length > 0);
  }
  return !!(item.content?.douyin?.shots && item.content.douyin.shots.length > 0);
}

// ─── Main Orchestration ───────────────────────────────────────────────────────

async function analyzeSinglePost(
  entry: PerformanceEntry,
  queueItem: Awaited<ReturnType<typeof loadQueue>>['items'][number],
  perfEntries: PerformanceEntry[],
  llm: LLMClient,
  personaSummary: string,
  baselineWindowDays: number,
): Promise<ContentAnalysis | null> {
  const contentText = getContentText(queueItem, entry.platform);
  const baseline = computeBaseline(perfEntries, entry.platform, baselineWindowDays);

  const prompt = buildPostAnalysisPrompt({
    contentText,
    platform: entry.platform,
    metrics: entry.peak_metrics,
    templateType: entry.template_type,
    identityMode: entry.identity_mode,
    baseline,
    personaSummary,
    isVideoContent: isVideoContent(queueItem, entry.platform),
    hookAngle: queueItem.trend_hook,
    topicKeywords: queueItem.topic ? [queueItem.topic] : [],
  });

  try {
    const response = await llm.callJSON<Record<string, unknown>>(prompt, 2000);
    return parseAnalysisResponse(response, {
      item_id: entry.item_id,
      platform: entry.platform,
      identity_mode: entry.identity_mode,
      template_type: entry.template_type,
      hook_angle: queueItem.trend_hook,
      topic_tags: queueItem.topic ? [queueItem.topic] : [],
    });
  } catch (err) {
    console.error(`[post-analyzer] Failed to analyze ${entry.item_id}:`, (err as Error).message);
    return null;
  }
}

export async function analyzePublishedPosts(
  llm: LLMClient,
  personaSummary: string,
  delayHours: number,
  baselineWindowDays: number,
): Promise<number> {
  const perfLog = readJSON<PerformanceLog>(PATHS.performanceLog, { entries: [], last_updated: '' });
  const analysisLog = loadAnalysisLog();
  const queue = await loadQueue();

  const pending = findPendingAnalysis(perfLog, analysisLog, delayHours);
  if (pending.length === 0) return 0;

  let analyzedCount = 0;

  for (const entry of pending) {
    const queueItem = queue.items.find(i => i.id === entry.item_id);
    if (!queueItem) continue;

    const analysis = await analyzeSinglePost(entry, queueItem, perfLog.entries, llm, personaSummary, baselineWindowDays);
    if (!analysis) continue;

    saveAnalysis(analysis);

    // Build and store audience perception entry from available comment data
    try {
      const perceptionEntry = buildAudiencePerceptionEntry({
        item_id: entry.item_id,
        platform: entry.platform,
        identity_mode: entry.identity_mode,
        comment_analysis: entry.comment_analysis,
      });
      upsertAudiencePerceptionEntry(perceptionEntry);
    } catch {
      // Non-blocking: audience perception is enrichment, not critical path
    }

    // Update content taste memory from this analysis
    updateTasteFromAnalysis(analysis);

    // ─── Feed drift signal back to personality-drift engine ───
    if (analysis.persona_alignment.tone_consistency !== 'on_brand') {
      try {
        const { loadPersonalityDrift, savePersonalityDrift } = await import('../engines/personality-drift');
        const drift = loadPersonalityDrift();
        const strength = analysis.persona_alignment.tone_consistency === 'off_brand' ? 1.5 : 0.7;
        const modifier: import('../utils/types').PersonalityModifier = {
          trait: analysis.persona_alignment.specific_notes || 'tone',
          strength,
          origin: `post-analyzer ${now().toISOString().slice(0, 10)}`,
          effect: `内容分析检测到${analysis.persona_alignment.tone_consistency === 'off_brand' ? '显著' : '轻微'}调性偏移：${analysis.persona_alignment.specific_notes}`,
        };
        drift.modifiers.push(modifier);
        savePersonalityDrift(drift);
      } catch {
        // personality-drift engine not available, skip
      }
    }

    // Update success rates for patterns actually used by this post
    // Only update patterns that match the template_type or extracted_patterns of the analyzed post
    const tierToRate: Record<PerformanceTier, number> = {
      viral: 1.0,
      above_avg: 0.7,
      normal: 0.4,
      below_avg: 0.1,
    };
    const rate = tierToRate[analysis.performance_tier];
    const existingPatterns = loadContentPatterns();

    // Build a set of pattern types that are relevant to this specific post
    const relevantPatternTypes = new Set<string>();
    // 1. Patterns whose type matches the template type used
    relevantPatternTypes.add(analysis.template_type);
    // 2. Extracted patterns from this analysis (if any)
    if (analysis.extracted_patterns) {
      for (const ep of analysis.extracted_patterns) {
        relevantPatternTypes.add(ep.pattern_type);
      }
    }
    // 3. Key success factors identified for this post
    for (const factor of analysis.pattern_analysis.key_success_factors) {
      relevantPatternTypes.add(factor);
    }

    // Batch update: collect all changes, save once
    let patternsModified = false;
    const updatedPatterns = existingPatterns.patterns.map(ep => {
      if (ep.times_used > 0 && relevantPatternTypes.has(ep.type)) {
        const oldRate = ep.success_rate ?? rate;
        const newRate = Math.round((oldRate * 0.7 + rate * 0.3) * 100) / 100;
        patternsModified = true;
        return { ...ep, success_rate: newRate };
      }
      return ep;
    });
    if (patternsModified) {
      saveContentPatterns({ ...existingPatterns, patterns: updatedPatterns });
    }

    if (analysis.extracted_patterns && analysis.extracted_patterns.length > 0) {
      for (const pattern of analysis.extracted_patterns) {
        addPattern({
          type: pattern.pattern_type,
          source: 'self',
          source_post: queueItem.topic,
          formula: pattern.description,
          examples: pattern.applicable_templates,
        });
      }
    }

    analyzedCount++;
  }

  return analyzedCount;
}
