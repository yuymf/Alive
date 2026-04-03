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
import { addPattern, loadContentPatterns, updatePatternSuccessRate } from './content-analyzer';
import { updateTasteFromAnalysis } from './taste-engine';

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
}

export function buildPostAnalysisPrompt(input: PostAnalysisInput): string {
  const { contentText, platform, metrics, templateType, identityMode, baseline, personaSummary } = input;
  const metricsStr = [
    `${metrics.likes}赞`,
    `${metrics.comments}评`,
    metrics.saves ? `${metrics.saves}藏` : null,
    metrics.shares ? `${metrics.shares}转` : null,
    metrics.views ? `${metrics.views}播` : null,
  ].filter(Boolean).join(' ');

  return `你是内容数据分析专家。请对以下已发布内容进行全面分析。

【内容信息】
平台: ${platform === 'xhs' ? '小红书' : '抖音'}
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
5. persona_alignment: 人设一致性检查

JSON格式:
\`\`\`json
{
  "performance_tier": "viral|above_avg|normal|below_avg",
  "engagement_score": 85,
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
  }
}
\`\`\``;
}

// ─── Response Parsing ─────────────────────────────────────────────────────────

interface AnalysisContext {
  item_id: string;
  platform: 'xhs' | 'douyin';
  identity_mode: string;
  template_type: string;
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
    return `标题: ${xhs.title}\n正文: ${xhs.body}`;
  }
  const douyin = item.content?.douyin;
  if (!douyin) return '';
  return `脚本: ${douyin.script}`;
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
  });

  try {
    const response = await llm.callJSON<Record<string, unknown>>(prompt, 2000);
    return parseAnalysisResponse(response, {
      item_id: entry.item_id,
      platform: entry.platform,
      identity_mode: entry.identity_mode,
      template_type: entry.template_type,
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

    // Update content taste memory from this analysis
    updateTasteFromAnalysis(analysis);

    // Update success rates for existing patterns based on performance tier
    const tierToRate: Record<PerformanceTier, number> = {
      viral: 1.0,
      above_avg: 0.7,
      normal: 0.4,
      below_avg: 0.1,
    };
    const rate = tierToRate[analysis.performance_tier];
    const existingPatterns = loadContentPatterns();
    for (const ep of existingPatterns.patterns) {
      if (ep.times_used > 0) {
        // Update patterns that have been used (i.e. injected into generation prompts)
        // Use exponential moving average: new_rate = old_rate * 0.7 + observed_rate * 0.3
        const oldRate = ep.success_rate ?? rate;
        const newRate = Math.round((oldRate * 0.7 + rate * 0.3) * 100) / 100;
        updatePatternSuccessRate(ep.type, ep.source, newRate);
      }
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
