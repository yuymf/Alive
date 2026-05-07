/**
 * brief-generator.ts
 * Formats and sends the daily ops brief to WeChat Work via OpenClaw gateway.
 * Also handles /brief command re-generation.
 */

import { execFileSync } from 'child_process';
import { PATHS, readJSON, writeJSON, readTunableJSON } from '../utils/file-utils';
import { now } from '../utils/time-utils';
import { QueueItem, CompetitorUpdate, OpsBriefLog, ContentStrategy, PersonaAlignmentReport, CompetitorAnalysisStore, PerformanceLog, aggregateCommentInsights } from '../utils/types';
import { FilteredTrend } from './trend-analyzer';
import { formatAlignmentBriefSection } from './persona-advisor';
import { buildCandidateContext } from './discovery-engine';
import { PENDING_EXPIRE_HOURS, hoursSinceCreated } from './review-queue';
import { UNKNOWN_POST_AGE_DAYS, FETCH_FAILED_DAYS } from './competitor-tracker';
import type { HealthReport } from './health-check';
import type { KBStats } from './viral-kb-store';
import type { UniversalFormula, ViralEntry } from '../utils/types';
import { buildAudiencePerceptionContext } from './audience-perception';
import { generateProactiveAdvice, formatAdviceSection } from './proactive-advisor';
import type { ProactiveAdvice } from './proactive-advisor';

// ─── Brief helpers ───────────────────────────────────────────────────────────

/** Format engagement number to human-readable form (e.g. 22268 → "2.2w") */
function fmtEngagement(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

// ─── Tunable display limits ─────────────────────────────────────────────────
// Tunable override: eval/tunable/prompts/ops/brief-generator.limits.json
// All fields optional; missing values fall back to defaults below.

interface BriefLimitsTunable {
  /** Number of trend entries shown per signal-kind section. */
  trendsPerSection?: number;
  /** Competitor becomes "stale" after this many days without a new post. */
  staleThresholdDays?: number;
  /** Max recent competitor posts shown per account (in addition to latest_post). */
  maxRecentPosts?: number;
  /** Max AI-recommended pending topics shown. */
  maxActivePending?: number;
  /** Topic title max chars before truncation "…" in competitor section. */
  competitorTopicChars?: number;
  /** Max top viral KB entries shown in brief. */
  maxViralEntries?: number;
  /** Max promoted viral formulas shown in brief. */
  maxViralFormulas?: number;
  /** Max review consensus reasons (approve/discard) shown. */
  maxReviewReasons?: number;
}

interface ResolvedBriefLimits {
  trendsPerSection: number;
  staleThresholdDays: number;
  maxRecentPosts: number;
  maxActivePending: number;
  competitorTopicChars: number;
  maxViralEntries: number;
  maxViralFormulas: number;
  maxReviewReasons: number;
}

const DEFAULT_BRIEF_LIMITS: ResolvedBriefLimits = {
  trendsPerSection: 3,
  staleThresholdDays: 7,
  maxRecentPosts: 2,
  maxActivePending: Number.POSITIVE_INFINITY, // no cap by default
  competitorTopicChars: 18,
  maxViralEntries: 3,
  maxViralFormulas: 2,
  maxReviewReasons: 3,
};

function pickPositive(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/** Pure helper — exported for tests. */
export function resolveBriefLimits(
  override?: BriefLimitsTunable | null,
): ResolvedBriefLimits {
  const src = override ?? {};
  return {
    trendsPerSection: pickPositive(src.trendsPerSection, DEFAULT_BRIEF_LIMITS.trendsPerSection),
    staleThresholdDays: pickPositive(src.staleThresholdDays, DEFAULT_BRIEF_LIMITS.staleThresholdDays),
    maxRecentPosts: pickPositive(src.maxRecentPosts, DEFAULT_BRIEF_LIMITS.maxRecentPosts),
    maxActivePending: pickPositive(src.maxActivePending, DEFAULT_BRIEF_LIMITS.maxActivePending),
    competitorTopicChars: pickPositive(src.competitorTopicChars, DEFAULT_BRIEF_LIMITS.competitorTopicChars),
    maxViralEntries: pickPositive(src.maxViralEntries, DEFAULT_BRIEF_LIMITS.maxViralEntries),
    maxViralFormulas: pickPositive(src.maxViralFormulas, DEFAULT_BRIEF_LIMITS.maxViralFormulas),
    maxReviewReasons: pickPositive(src.maxReviewReasons, DEFAULT_BRIEF_LIMITS.maxReviewReasons),
  };
}

let _cachedBriefLimits: ResolvedBriefLimits | null = null;

function getBriefLimits(): ResolvedBriefLimits {
  if (_cachedBriefLimits) return _cachedBriefLimits;
  const override = readTunableJSON<BriefLimitsTunable>('ops/brief-generator.limits.json');
  _cachedBriefLimits = resolveBriefLimits(override);
  return _cachedBriefLimits;
}

/** Test helper: force re-read of tunable on next access. */
export function resetBriefLimitsCache(): void {
  _cachedBriefLimits = null;
}

/** Convert ISO timestamp to relative time string (e.g. "3小时前", "昨天", "3天前") */
function relativeTime(isoTime: string | undefined): string {
  if (!isoTime) return '时间未知';
  const d = new Date(isoTime);
  if (isNaN(d.getTime())) return '时间未知';
  const diffMs = Date.now() - d.getTime();
  const diffH = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffH < 1) return '刚刚';
  if (diffH < 24) return `${diffH}小时前`;
  const diffD = Math.floor(diffH / 24);
  if (diffD === 1) return '昨天';
  if (diffD <= 7) return `${diffD}天前`;
  return `${diffD}天前`;
}

// ─── Brief Enrichment (optional, backward-compatible) ────────────────────────

export interface BriefEnrichment {
  /** Persona alignment report for 💡人设建议 section */
  personaReport?: PersonaAlignmentReport | null;
  /** Full queue items for 🎨生图Prompt + 🎬视频分镜 extraction */
  fullQueueItems?: readonly QueueItem[];
  /** Competitor analysis store for enriched competitor insights */
  competitorAnalysis?: CompetitorAnalysisStore | null;
  /** Health check report for 🏥链路健康 section (only shown when warnings/missing exist) */
  healthReport?: HealthReport | null;
  /** Identity mode keys for candidate track-overlap scoring */
  identityKeys?: string[];
  /** Viral KB stats for 📚爆款知识库 section */
  viralKbStats?: KBStats | null;
  /** Top viral entries for brief display (sorted by likes desc) */
  viralKbTopEntries?: readonly ViralEntry[];
  /** Recently promoted universal formulas */
  viralKbFormulas?: readonly UniversalFormula[];
  /** Pre-computed proactive advice (if not provided, will be auto-generated) */
  proactiveAdvice?: ProactiveAdvice[];
}

// ─── Pure formatting (exported for testing) ──────────────────────────────────

export function formatBriefCard(
  date: string,
  trends: FilteredTrend[],
  competitors: CompetitorUpdate[],
  queueItems: QueueItem[],
  enrichment?: BriefEnrichment,
): string {
  const limits = getBriefLimits();
  const lines: string[] = [`📊 今日简报  ${date}`, ''];

  // Trends — split by signal_kind for clear semantics
  if (trends.length > 0) {
    const breakout = trends.filter(t => t.signal_kind === 'breakout');
    const searchDemand = trends.filter(t => t.signal_kind === 'search_demand');
    const recommended = trends.filter(t => t.signal_kind === 'recommended_track');
    // Also include items without signal_kind (legacy) as breakout
    const unknown = trends.filter(t => !t.signal_kind);
    const effectiveBreakout = [...breakout, ...unknown];

    if (effectiveBreakout.length > 0) {
      lines.push('━━ 趋势加速 ━━');
      for (const t of effectiveBreakout.slice(0, limits.trendsPerSection)) {
        const icon = t.velocity_score >= 2.0 ? '🔥' : '⚡';
        lines.push(`${icon} ${t.keyword}  ${t.platform}  ${t.velocity_score.toFixed(1)}x  📰热榜`);
      }
      lines.push('');
    }

    if (searchDemand.length > 0) {
      lines.push('━━ 真实搜索 ━━');
      for (const t of searchDemand.slice(0, limits.trendsPerSection)) {
        const metric = t.display_metric ?? `${t.velocity_score.toFixed(1)}x`;
        lines.push(`🔍 ${t.keyword}  ${t.platform}  ${metric}`);
      }
      lines.push('');
    }

    if (recommended.length > 0) {
      lines.push('━━ 平台持续推荐 ━━');
      for (const t of recommended.slice(0, limits.trendsPerSection)) {
        const metric = t.display_metric ?? '赛道信号';
        lines.push(`🏷️ ${t.keyword}  ${t.platform}  ${metric}`);
      }
      lines.push('');
    }

    lines.push('🔥 /trends 查看更多趋势');
    lines.push('');
  } else {
    lines.push('━━ 趋势信号 ━━');
    lines.push('📭 今日暂无捕获到强趋势信号');
    lines.push('🔥 /trends 手动刷新');
    lines.push('');
  }

  // Competitors — grouped by activity level
  if (competitors.length > 0) {
    const STALE_THRESHOLD_DAYS = limits.staleThresholdDays;
    // Classify competitors into three tiers
    const active: CompetitorUpdate[] = [];
    const stale: CompetitorUpdate[] = [];
    const inactive: CompetitorUpdate[] = [];
    for (const c of competitors) {
      if (c.latest_post && c.days_since_last_post !== FETCH_FAILED_DAYS) {
        if (c.days_since_last_post >= 0 && c.days_since_last_post <= STALE_THRESHOLD_DAYS) {
          active.push(c);
        } else if (c.days_since_last_post === UNKNOWN_POST_AGE_DAYS) {
          // Unknown time but has content → treat as active
          active.push(c);
        } else {
          stale.push(c);
        }
      } else if (c.days_since_last_post === FETCH_FAILED_DAYS) {
        inactive.push(c); // fetch failed
      } else {
        inactive.push(c); // no posts found or very old
      }
    }

    lines.push('━━ 竞品动态 ━━');

    // Active competitors: detailed display with recent posts
    for (const c of active) {
      const { topic, engagement } = c.latest_post!;
      const timeStr = c.days_since_last_post === UNKNOWN_POST_AGE_DAYS
        ? '' : ` ${relativeTime(c.latest_post!.time)}`;
      const engStr = fmtEngagement(engagement);
      const analysisKey = `${c.account}:${c.platform}`;
      const analysis = enrichment?.competitorAnalysis?.analyses?.[analysisKey];
      const topicTruncated = topic.length > limits.competitorTopicChars ? topic.slice(0, limits.competitorTopicChars) + '…' : topic;
      lines.push(`@${c.account}${timeStr}「${topicTruncated}」互动${engStr}`);
      // Show up to N more recent posts
      if (c.recent_posts?.length > 1) {
        for (const rp of c.recent_posts.slice(1, 1 + limits.maxRecentPosts)) {
          const rpTruncated = rp.topic.length > 15 ? rp.topic.slice(0, 15) + '…' : rp.topic;
          lines.push(`  ·「${rpTruncated}」互动${fmtEngagement(rp.engagement)}`);
        }
      }
      if (analysis?.key_insight) {
        lines.push(`  💡 核心洞察：${analysis.key_insight}`);
      }
    }

    // Stale competitors: one-line each
    for (const c of stale) {
      const { topic, engagement } = c.latest_post!;
      lines.push(`@${c.account}  ${c.days_since_last_post}天前「${topic.length > 12 ? topic.slice(0, 12) + '…' : topic}」互动${fmtEngagement(engagement)}`);
    }

    // Inactive competitors: collapsed into one line
    if (inactive.length > 0) {
      const names = inactive.map(c => c.account).join('、');
      const hasFetchFailed = inactive.some(c => c.days_since_last_post === FETCH_FAILED_DAYS);
      const suffix = hasFetchFailed ? '（含拉取失败）' : '';
      lines.push(`💤 ${inactive.length}个账号超过${STALE_THRESHOLD_DAYS}天未更新${suffix}（${names}）`);
    }

    lines.push('💬 /comp [账号] 详细分析 · /comp all 完整列表');
    lines.push('');
  }

  // Queue items (topics ready for review) — only show active pending items
  const allPending = queueItems.filter(i => i.status === 'pending');
  const activePending = allPending.filter(i => hoursSinceCreated(i) < PENDING_EXPIRE_HOURS);
  const stalePending = allPending.filter(i => hoursSinceCreated(i) >= PENDING_EXPIRE_HOURS);
  const expired = queueItems.filter(i => i.status === 'expired');

  if (activePending.length > 0) {
    // Sort: clickbait items (⚠️ in trend_hook) moved to the end
    const sortedPending = [...activePending].sort((a, b) => {
      const aCb = a.trend_hook.includes('⚠️') ? 1 : 0;
      const bCb = b.trend_hook.includes('⚠️') ? 1 : 0;
      return aCb - bCb;
    });
    const displayPending = Number.isFinite(limits.maxActivePending)
      ? sortedPending.slice(0, limits.maxActivePending)
      : sortedPending;
    lines.push(`━━ AI 今日推荐选题（${displayPending.length}个）━━`);
    displayPending.forEach((item, idx) => {
      lines.push(`${idx + 1}️⃣  ${item.topic}`);
      lines.push(`   ${item.trend_hook}`);
    });
    lines.push('📋 回复 1~N 选择 · /idea [方向] 手动出题');
    lines.push('');
  }

  // Stale + expired: one-line summary only, no repeated nagging
  const suppressedCount = stalePending.length + expired.length;
  if (suppressedCount > 0) {
    lines.push(`💤 ${suppressedCount} 条旧选题已超${PENDING_EXPIRE_HOURS}h未处理，不再提醒（/post 可查看）`);
    lines.push('');
  }

  // ─── 💡 助手建议 (proactive advice) ────────────────────────────────────────
  try {
    const advice = enrichment?.proactiveAdvice ?? generateProactiveAdvice({
      trends,
      queueItems,
      strategy: null,  // lazy-load handled by caller or falls back to null
    });
    const adviceSection = formatAdviceSection(advice);
    if (adviceSection) {
      lines.push(adviceSection);
      lines.push('');
    }
  } catch (err) {
    console.warn(`[brief-generator] proactive advice generation failed: ${(err as Error).message}`);
  }

  // ─── Enrichment sections (new: 生图Prompt, 视频分镜, 人设建议) ────────────
  // 只使用 48h 内活跃的 pending items，expired 内容不参与 LLM 上下文
  const enrichItems = (enrichment?.fullQueueItems ?? allPending)
    .filter(i => i.status === 'pending' && hoursSinceCreated(i) < PENDING_EXPIRE_HOURS);
  const firstPending = enrichItems[0] ?? null;

  // 🎨 今日生图 Prompt
  if (firstPending) {
    const imagePrompt = firstPending.image_prompts?.[0]
      ?? firstPending.content?.xhs?.cover_images?.[0]
      ?? null;
    if (imagePrompt) {
      lines.push('━━ 🎨 今日生图 Prompt ━━');
      lines.push(imagePrompt);
      lines.push('');
    }
  }

  // 🎬 今日视频分镜 (structured: topic + identity + shot-by-shot storyboard)
  // Supports both douyin and XHS video_post formats
  if (firstPending) {
    const douyin = firstPending.content?.douyin;
    const xhs = firstPending.content?.xhs;
    const isXhsVideo = !!(xhs?.shots && xhs.shots.length > 0);

    // Prefer douyin storyboard; fall back to XHS video storyboard
    const storyboard = (douyin && (douyin.shots?.length > 0 || douyin.key_captions.length > 0 || douyin.bgm_suggestion || douyin.script))
      ? { platform: 'douyin' as const, source: douyin }
      : isXhsVideo
        ? { platform: 'xhs' as const, source: xhs! }
        : null;

    if (storyboard) {
      const src = storyboard.source;
      const platformLabel = storyboard.platform === 'xhs' ? '小红书视频' : '抖音视频';
      lines.push(`━━ 🎬 今日${platformLabel}分镜 ━━`);
      lines.push(`📌 选题：${firstPending.topic}`);
      if (firstPending.identity_mode) {
        lines.push(`🎭 身份：${firstPending.identity_mode}`);
      }
      if (src.total_duration) {
        lines.push(`⏱ 时长：${src.total_duration}`);
      }
      if (src.pacing) {
        const pacingLabel: Record<string, string> = { slow: '慢节奏', medium: '中速', fast: '快节奏', variable: '变速' };
        lines.push(`🎵 节奏：${pacingLabel[src.pacing] ?? src.pacing}`);
      }
      lines.push('');

      // Structured shot-by-shot storyboard (primary)
      if (src.shots && src.shots.length > 0) {
        lines.push('📋 分镜表：');
        src.shots.forEach((shot) => {
          const cameraIcon: Record<string, string> = {
            static: '📐', pan: '↔️', tilt: '↕️', push_in: '🔍', pull_out: '🔭',
            tracking: '🏃', dolly: '🛤️', crane: '🏗️', orbit: '🔄', handheld: '✋',
            whip_pan: '💨', drone: '🚁', zoom_in: '🔎', zoom_out: '👁️',
          };
          const transitionIcon: Record<string, string> = {
            cut: '✂️', dissolve: '🌊', wipe: '🧹', match_cut: '🔗', whip: '💨',
            fade: '🌅', smash: '💥', zoom: '🔍', mask: '🎭', none: '🏁',
          };
          const icon = cameraIcon[shot.camera_move] ?? '🎬';
          const tIcon = transitionIcon[shot.transition] ?? '→';
          lines.push(`  ${icon} #${shot.index} [${shot.time_range}] ${shot.shot_size} · ${shot.camera_move} · ${shot.camera_angle}`);
          lines.push(`     📝 ${shot.description}`);
          if (shot.text_overlay) lines.push(`     💬 "${shot.text_overlay}"`);
          lines.push(`     ${tIcon} → ${shot.transition} | 😐 ${shot.mood}`);
          // Show Seedance fields in brief (condensed: video_prompt truncated, others on one line)
          if (shot.video_prompt) {
            const vpShort = shot.video_prompt.length > 80 ? shot.video_prompt.slice(0, 80) + '…' : shot.video_prompt;
            lines.push(`     🎬 ${vpShort}`);
          }
        });
        lines.push('');
      } else if (storyboard.platform === 'douyin' && douyin!.key_captions.length > 0) {
        // Fallback: key_captions with scene labels (legacy, douyin only)
        const sceneLabels = ['开场', '铺垫', '高潮', '收尾', '彩蛋', '转场'];
        douyin!.key_captions.forEach((cap, idx) => {
          const label = idx < sceneLabels.length ? sceneLabels[idx] : `P${idx + 1}`;
          lines.push(`${idx + 1}. [${label}] ${cap}`);
        });
        lines.push('');
      }
      if (src.bgm_suggestion) {
        lines.push(`🎵 BGM: ${src.bgm_suggestion}`);
      }
      // Script excerpt (first 200 chars)
      const scriptText = storyboard.platform === 'xhs' ? xhs!.script : douyin!.script;
      if (scriptText && scriptText.length > 0) {
        const excerpt = scriptText.length > 200
          ? scriptText.slice(0, 200) + '…'
          : scriptText;
        lines.push(`📝 脚本摘要：${excerpt}`);
      }
      lines.push('🎬 /video 完整脚本 · /edit 分镜 调整');
      lines.push('');
    }
  }

  // 💡 人设建议
  if (enrichment?.personaReport) {
    lines.push(formatAlignmentBriefSection(enrichment.personaReport));
    lines.push('');
  }

  // 💡 今日灵感（from content-browse sub-skill）
  try {
    const inspoState = readJSON<{ last_refreshed_at: string | null; feed_highlights?: Array<{ title: string; likes: number; topic: string }> }>(
      PATHS.inspirationState,
      { last_refreshed_at: null },
    );
    if (inspoState.last_refreshed_at && inspoState.feed_highlights && inspoState.feed_highlights.length > 0) {
      // Only show if refreshed today
      const refreshDate = inspoState.last_refreshed_at.slice(0, 10);
      if (refreshDate === date) {
        lines.push('━━ 💡 今日灵感 ━━');
        for (const h of inspoState.feed_highlights.slice(0, 3)) {
          lines.push(`  ${h.topic}：「${h.title}」❤️${h.likes}`);
        }
        lines.push('');
      }
    }
  } catch (err) {
    console.warn(`[brief-generator] inspiration-state loading failed: ${(err as Error).message}`);
  }

  // 📝 用户反馈（aggregated from recent performance entries）
  try {
    const perfLog = readJSON<PerformanceLog>(PATHS.performanceLog, { entries: [], last_updated: '' });
    const recentEntries = (perfLog.entries ?? []).slice(-5);
    const insights = aggregateCommentInsights(recentEntries, 8, 3);
    if (insights && insights.topKeywords.length > 0) {
      lines.push('━━ 📝 用户反馈 ━━');
      lines.push(`  热词: ${insights.topKeywords.join('、')}`);
      if (insights.constructiveFeedback.length > 0) {
        lines.push(`  建议: ${insights.constructiveFeedback.join('；')}`);
      }
      lines.push('');
    }
  } catch (err) {
    console.warn(`[brief-generator] performance-log loading failed: ${(err as Error).message}`);
  }

  // ✅ 审核共识（from review feedback on queue items）
  try {
    const reviewed = queueItems.filter(
      i => i.review_feedback && i.review_feedback.length > 0,
    ).slice(-10);

    if (reviewed.length > 0) {
      const approveReasons: string[] = [];
      const discardReasons: string[] = [];
      let deviationTags: Record<string, number> = {};
      const directions = new Set<string>();

      for (const item of reviewed) {
        for (const fb of item.review_feedback!) {
          if (fb.decision === 'approved' && fb.reason_summary) {
            approveReasons.push(fb.reason_summary);
          }
          if (fb.decision === 'discarded' && fb.reason_summary) {
            discardReasons.push(fb.reason_summary);
          }
          for (const tag of fb.persona_deviation_tags ?? []) {
            deviationTags = { ...deviationTags, [tag]: (deviationTags[tag] ?? 0) + 1 };
          }
          for (const d of fb.improvement_directions ?? []) {
            directions.add(d);
          }
        }
      }

      const reviewLines: string[] = ['━━ ✅ 审核共识 ━━'];
      if (approveReasons.length > 0) {
        const topApprove = [...new Set(approveReasons)].slice(-limits.maxReviewReasons);
        reviewLines.push(`通过理由：${topApprove.join('；')}`);
      }
      if (discardReasons.length > 0) {
        const topDiscard = [...new Set(discardReasons)].slice(-limits.maxReviewReasons);
        reviewLines.push(`淘汰原因：${topDiscard.join('；')}`);
      }
      if (Object.keys(deviationTags).length > 0) {
        const topTags = Object.entries(deviationTags)
          .sort((a, b) => b[1] - a[1])
          .slice(0, limits.maxReviewReasons)
          .map(([t]) => t);
        reviewLines.push(`偏移标签：${topTags.join('、')}`);
      }
      if (directions.size > 0) {
        reviewLines.push(`改进方向：${[...directions].slice(-limits.maxReviewReasons).join('；')}`);
      }
      lines.push(reviewLines.join('\n'));
      lines.push('');
    }
  } catch (err) {
    console.warn(`[brief-generator] review feedback loading failed: ${(err as Error).message}`);
  }

  // 👁️ 受众感知（from audience perception store）
  try {
    const perceptionCtx = buildAudiencePerceptionContext({ maxEntries: 5, maxChars: 300 });
    if (perceptionCtx) {
      lines.push('━━ 👁️ 受众感知 ━━');
      lines.push(perceptionCtx);
      lines.push('');
    }
  } catch (err) {
    console.warn(`[brief-generator] audience perception loading failed: ${(err as Error).message}`);
  }

  // ─── 📚 爆款知识库 ──────────────────────────────────────────────────────
  try {
    const kbStats = enrichment?.viralKbStats;
    if (kbStats && kbStats.total > 0) {
      const kbLines: string[] = ['━━ 📚 爆款知识库 ━━'];
      // Stats line
      const parts = [`总条目 ${kbStats.total}`];
      if (kbStats.formula_count > 0) parts.push(`通用公式 ${kbStats.formula_count}`);
      if (kbStats.queue_length > 0) parts.push(`待拆解 ${kbStats.queue_length}`);
      kbLines.push(`📊 ${parts.join(' · ')}`);
      kbLines.push('');

      // Top entries with dissection details
      const topEntries = enrichment?.viralKbTopEntries;
      if (topEntries && topEntries.length > 0) {
        kbLines.push('🔥 近期爆款经验：');
        for (const [idx, e] of topEntries.slice(0, limits.maxViralEntries).entries()) {
          const likesStr = e.likes >= 10000
            ? `${(e.likes / 10000).toFixed(1)}w`
            : e.likes >= 1000
              ? `${(e.likes / 1000).toFixed(1)}k`
              : `${e.likes}`;
          const titleStr = e.title.length > 20 ? e.title.slice(0, 20) + '…' : e.title;
          kbLines.push(`${idx + 1}. 「${titleStr}」❤️${likesStr}`);

          // Show dissection details if available
          if (e.dissection_status === 'done' && e.dissection) {
            const hookType = e.dissection.hook_type;
            const emotionArc = e.dissection.emotion_arc;
            kbLines.push(`   🎯 钩子：${hookType}  📈 情绪：${emotionArc}`);
            if (e.dissection.summary) {
              const summaryShort = e.dissection.summary.length > 30
                ? e.dissection.summary.slice(0, 30) + '…'
                : e.dissection.summary;
              kbLines.push(`   💡 可复用：${summaryShort}`);
            }
          }
        }
        kbLines.push('');
      }

      // Recently promoted formulas with trigger words
      const formulas = enrichment?.viralKbFormulas;
      if (formulas && formulas.length > 0) {
        const promotedFormulas = formulas.filter(f => f.injected_to_templates);
        if (promotedFormulas.length > 0) {
          for (const f of promotedFormulas.slice(0, limits.maxViralFormulas)) {
            kbLines.push(`🔮 通用公式: [${f.content_type}+${f.hook_type}] × ${f.platform} (${f.occurrence_count}x↑)`);
            if (f.trigger_words && f.trigger_words.length > 0) {
              kbLines.push(`   触发词：${f.trigger_words.join('、')}`);
            }
            if (f.formula_summary) {
              const fmtSummary = f.formula_summary.length > 40
                ? f.formula_summary.slice(0, 40) + '…'
                : f.formula_summary;
              kbLines.push(`   公式：${fmtSummary}`);
            }
          }
        }
      }

      kbLines.push('📖 /kb [关键词] 搜索 · /formula 公式详解');
      lines.push(kbLines.join('\n'));
      lines.push('');
    }
  } catch (err) {
    console.warn(`[brief-generator] viral-kb loading failed: ${(err as Error).message}`);
  }

  // 🔍 候选对标（from discovery-engine account discovery）
  const candidateCtx = buildCandidateContext(enrichment?.identityKeys);
  if (candidateCtx) {
    lines.push(candidateCtx);
    lines.push('');
  }

  // ⚠️ 人设漂移预警（from personality-drift engine, P4-2）
  try {
    const { buildDriftBriefSection } = require('../engines/personality-drift');
    const driftSection = buildDriftBriefSection();
    if (driftSection) {
      lines.push(driftSection);
      lines.push('');
    }
  } catch (err) {
    console.warn(`[brief-generator] personality-drift loading failed: ${(err as Error).message}`);
  }

  // 🔍 关键词追踪（from keyword-tracker, P4-1）
  try {
    const { buildKeywordContext } = require('../ops/keyword-tracker');
    const keywordSection = buildKeywordContext();
    if (keywordSection) {
      lines.push(keywordSection);
      lines.push('');
    }
  } catch (err) {
    console.warn(`[brief-generator] keyword-tracker loading failed: ${(err as Error).message}`);
  }

  // 🏥 链路健康（only shown when warnings or missing items exist）
  try {
    let healthReport = enrichment?.healthReport ?? null;
    if (!healthReport) {
      // Try loading from persisted report file
      const savedReport = readJSON<HealthReport | null>(PATHS.healthReport, null);
      // Only use if generated today
      if (savedReport?.timestamp?.slice(0, 10) === date) {
        healthReport = savedReport;
      }
    }
    if (healthReport && (healthReport.summary.warn > 0 || healthReport.summary.missing > 0)) {
      const statusIcon: Record<string, string> = { ok: '✅', warn: '⚠️', missing: '❌' };
      const alertItems = healthReport.items.filter(i => i.status !== 'ok');
      lines.push('━━ 🏥 链路健康 ━━');
      for (const item of alertItems) {
        lines.push(`${statusIcon[item.status]} ${item.name}：${item.detail}`);
      }
      lines.push('');
    }
  } catch (err) {
    console.warn(`[brief-generator] health report loading failed: ${(err as Error).message}`);
  }

  // ─── Actions (simplified — detailed commands are in each section above) ──────

  lines.push('━━ 快捷操作 ━━');
  if (activePending.length > 0) {
    lines.push('回复 1~N 选择选题 · /post 查看详情 · 跳过 今天不发');
  } else {
    lines.push('/idea [方向] 手动出选题 · /brief 刷新简报');
  }

  return lines.join('\n');
}

// ─── Content package formatting ──────────────────────────────────────────────

/**
 * Format a complete content package for human publishing.
 */
export function formatContentPackage(item: QueueItem): string {
  const lines: string[] = [
    `📦 内容包 #${item.id}`,
    `模式: ${item.identity_mode} | 选题: ${item.topic}`,
    '',
  ];

  const { xhs } = item.content;
  const isXhsVideo = !!(xhs.shots && xhs.shots.length > 0);
  lines.push(`━━ 小红书 ${isXhsVideo ? '视频脚本' : '图文'} ━━`, `【标题】${xhs.title}`);
  if (isXhsVideo) {
    // XHS video_post format
    if (xhs.opening_hook) lines.push(`【钩子】${xhs.opening_hook}`);
    if (xhs.script) lines.push('【脚本】', xhs.script);
    if (xhs.bgm_suggestion) lines.push(`【BGM】${xhs.bgm_suggestion}`);
    if (xhs.key_captions && xhs.key_captions.length > 0) {
      lines.push('【关键字幕】');
      xhs.key_captions.forEach(c => lines.push(`  - ${c}`));
    }
    if (xhs.total_duration) lines.push(`【总时长】${xhs.total_duration}`);
    if (xhs.pacing) {
      const pacingLabel: Record<string, string> = { slow: '慢节奏', medium: '中速', fast: '快节奏', variable: '变速' };
      lines.push(`【节奏】${pacingLabel[xhs.pacing] ?? xhs.pacing}`);
    }
    if (xhs.shots && xhs.shots.length > 0) {
      lines.push('【分镜表】');
      xhs.shots.forEach((shot) => {
        const textPart = shot.text_overlay ? ` 💬"${shot.text_overlay}"` : '';
        lines.push(`  #${shot.index} [${shot.time_range}] ${shot.shot_size}/${shot.camera_move}/${shot.camera_angle} → ${shot.transition}`);
        lines.push(`    ${shot.description}${textPart} | ${shot.mood}`);
        if (shot.video_prompt) {
          lines.push(`    🎬 video_prompt: ${shot.video_prompt}`);
        }
        if (shot.negative_prompt) {
          lines.push(`    🚫 negative: ${shot.negative_prompt}`);
        }
        if (shot.lighting) {
          lines.push(`    💡 lighting: ${shot.lighting}`);
        }
        if (shot.style) {
          lines.push(`    🎨 style: ${shot.style}`);
        }
      });
    }
  } else {
    // XHS image_post format (default)
    lines.push('【正文】', xhs.body);
  }
  lines.push(`【标签】${xhs.tags.join(' ')}`);
  if (xhs.cover_images.length > 0) {
    lines.push('【封面】');
    xhs.cover_images.forEach((url, i) => lines.push(`  图${i + 1}: ${url}`));
  }
  lines.push('');

  const { douyin } = item.content;
  lines.push('━━ 抖音 视频脚本 ━━', '【脚本】', douyin.script, `【BGM】${douyin.bgm_suggestion}`);
  if (douyin.total_duration) {
    lines.push(`【总时长】${douyin.total_duration}`);
  }
  if (douyin.pacing) {
    const pacingLabel: Record<string, string> = { slow: '慢节奏', medium: '中速', fast: '快节奏', variable: '变速' };
    lines.push(`【节奏】${pacingLabel[douyin.pacing] ?? douyin.pacing}`);
  }
  if (douyin.shots && douyin.shots.length > 0) {
    lines.push('【分镜表】');
    douyin.shots.forEach((shot) => {
      const textPart = shot.text_overlay ? ` 💬"${shot.text_overlay}"` : '';
      lines.push(`  #${shot.index} [${shot.time_range}] ${shot.shot_size}/${shot.camera_move}/${shot.camera_angle} → ${shot.transition}`);
      lines.push(`    ${shot.description}${textPart} | ${shot.mood}`);
      if (shot.video_prompt) {
        lines.push(`    🎬 video_prompt: ${shot.video_prompt}`);
      }
      if (shot.negative_prompt) {
        lines.push(`    🚫 negative: ${shot.negative_prompt}`);
      }
      if (shot.lighting) {
        lines.push(`    💡 lighting: ${shot.lighting}`);
      }
      if (shot.style) {
        lines.push(`    🎨 style: ${shot.style}`);
      }
    });
  }
  if (douyin.key_captions.length > 0) {
    lines.push('【关键字幕】');
    douyin.key_captions.forEach(c => lines.push(`  - ${c}`));
  }
  if (douyin.cover_images.length > 0) {
    lines.push('【封面】');
    douyin.cover_images.forEach((url, i) => lines.push(`  图${i + 1}: ${url}`));
  }
  lines.push('');

  if (item.image_prompts && item.image_prompts.length > 0) {
    lines.push('━━ AI生图提示词 ━━');
    item.image_prompts.forEach((p, i) => lines.push(`提示词${i + 1}: ${p}`));
    lines.push('');
  }

  lines.push('━━ 发布后请回传 ━━', '回复: 已发 xhs {笔记URL}', '回复: 已发 douyin {视频URL}');
  return lines.join('\n');
}

export function pushContentPackage(item: QueueItem): boolean {
  return sendToWechatWork(formatContentPackage(item));
}

export function pushEditResult(item: QueueItem, field: string, oldValue: string, newValue: string): boolean {
  const lines = [
    `✏️ 已修改 #${item.id}`, '',
    `【修改内容】${field}`,
    `  旧: ${oldValue.slice(0, 50)}${oldValue.length > 50 ? '...' : ''}`,
    `  新: ${newValue.slice(0, 50)}${newValue.length > 50 ? '...' : ''}`,
    '', '回复 "OK" 确认 · "再改" 继续调整',
  ];
  return sendToWechatWork(lines.join('\n'));
}

// ─── Strategy section formatting ─────────────────────────────────────────────

export function formatStrategySection(strategy: ContentStrategy | null): string {
  if (!strategy) return '';
  const { performance_summary: ps, next_week_recommendations: rec, status } = strategy;
  const statusLabel = status === 'confirmed' ? '✅ 已确认' : status === 'expired' ? '⌛ 已过期' : '⏳ 待确认';
  const trendIcon = ps.engagement_trend === 'rising' ? '📈' : ps.engagement_trend === 'declining' ? '📉' : '➡️';
  const lines = [
    `━━ 本周策略 ${statusLabel} ━━`,
    `互动趋势: ${trendIcon} ${ps.engagement_trend}  周变化: ${ps.week_over_week_change >= 0 ? '+' : ''}${ps.week_over_week_change}%`,
    `下周方向: ${rec.content_direction}`,
    `推荐模板: ${rec.recommended_templates.join('、')}`,
  ];

  // Task 18: 分流显示运营建议和人设建议
  if (strategy.ops_suggestions && strategy.ops_suggestions.length > 0) {
    lines.push('');
    lines.push('📊 运营建议:');
    for (const s of strategy.ops_suggestions.slice(0, 3)) {
      lines.push(`  • ${s}`);
    }
  }
  if (strategy.persona_suggestions && strategy.persona_suggestions.length > 0) {
    lines.push('');
    lines.push('💅 人设建议:');
    for (const s of strategy.persona_suggestions.slice(0, 3)) {
      lines.push(`  • ${s}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ─── WeChat Work push ─────────────────────────────────────────────────────────
// Uses openclaw message send --channel wecom --target <WECOM_TARGET_ID>
// WECOM_TARGET_ID = enterprise WeChat member userid (e.g. "zhangsan")
// Set via: openclaw.json → skills.entries.alive.env.WECOM_TARGET_ID
// NOTE: For brief delivery, prefer `sendBriefToSession` which outputs to stdout
// and lets the cron runner handle IM delivery — no env vars needed.

export type BriefDeliveryMode = 'session' | 'wecom-target';

/**
 * Output brief to stdout — the cron runner will handle delivery.
 * This is the preferred mode for personas using automation.brief_delivery = 'session'.
 * No longer calls `openclaw message send` directly; delivery is delegated to openclaw.
 */
export function sendBriefToSession(message: string): boolean {
  console.log(message);
  return true;
}

/**
 * Send brief to a specific WeChat Work target via WECOM_TARGET_ID.
 */
export function sendToWechatWork(message: string): boolean {
  const targetId = process.env.WECOM_TARGET_ID ?? '';

  if (!targetId) {
    // Graceful fallback: print to stdout
    console.log('\n[WeChat Work 推送内容]\n' + message + '\n');
    console.log('[brief-generator] WECOM_TARGET_ID not set — printed to stdout only');
    console.log('[brief-generator] 设置方式: openclaw.json → skills.entries.alive.env.WECOM_TARGET_ID = "你的企微userid"');
    return true;
  }

  try {
    execFileSync('openclaw', [
      'message', 'send',
      '--channel', 'wecom',
      '--target', targetId,
      '--message', message,
    ], { timeout: 20_000, encoding: 'utf8' });
    return true;
  } catch (err) {
    console.error('[brief-generator] wecom send failed:', err);
    return false;
  }
}

/**
 * Deliver brief card using the specified mode.
 */
export function deliverBrief(message: string, mode: BriefDeliveryMode): boolean {
  if (mode === 'session') {
    return sendBriefToSession(message);
  }
  return sendToWechatWork(message);
}

/**
 * Unified ops result delivery helper.
 * Outputs to stdout — the cron runner handles IM delivery.
 * Respects `ops.automation.silent_background_jobs` to suppress output.
 */
export function deliverOpsResult(message: string, ops?: { automation?: { silent_background_jobs?: boolean } }): boolean {
  if (ops?.automation?.silent_background_jobs) {
    console.log('[deliverOpsResult] silent_background_jobs=true, skipping IM delivery');
    return false;
  }
  console.log(message);
  return true;
}

// ─── Log ─────────────────────────────────────────────────────────────────────

function logBriefSent(date: string, topicCount: number): void {
  const log = readJSON<OpsBriefLog>(PATHS.opsBriefLog, { entries: [] });
  const entries = Array.isArray(log.entries) ? log.entries : [];
  const entry = { date, sent_at: now().toISOString(), topic_count: topicCount };
  writeJSON(PATHS.opsBriefLog, { entries: [...entries.slice(-29), entry] });
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function sendDailyBrief(
  trends: FilteredTrend[],
  competitors: CompetitorUpdate[],
  queueItems: QueueItem[],
  enrichment?: BriefEnrichment,
  deliveryMode?: BriefDeliveryMode,
): Promise<boolean> {
  const date = now().toISOString().slice(0, 10);
  let card = formatBriefCard(date, trends, competitors, queueItems, enrichment);

  const { loadStrategy } = await import('./strategy-engine');
  const strategy = loadStrategy();
  const strategySection = formatStrategySection(strategy);
  if (strategySection) card = `${card}\n${strategySection}`;

  const mode = deliveryMode ?? 'session';
  const sent = deliverBrief(card, mode);
  if (sent) logBriefSent(date, queueItems.filter(i => i.status === 'pending').length);
  return sent;
}
