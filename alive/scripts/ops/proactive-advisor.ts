/**
 * proactive-advisor.ts
 * Rule-based proactive advice engine for ops workflow.
 *
 * Generates suggestions WITHOUT LLM calls — pure rule evaluation over
 * existing data: trends, queue, strategy, audience perception, review history.
 *
 * Designed to be injected into the daily brief as a 💡 助手建议 section,
 * and later surfaced in real-time via heartbeat hooks.
 */

import { PATHS, readJSON } from '../utils/file-utils';
import { now } from '../utils/time-utils';
import type { FilteredTrend } from './trend-analyzer';
import type { QueueItem, ContentStrategy, PerformanceLog, AudiencePerceptionStore } from '../utils/types';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AdviceType =
  | 'hot_opportunity'      // 热点机会：velocity 高且赛道匹配
  | 'rhythm_reminder'      // 节奏提醒：多天未发
  | 'audience_signal'      // 受众信号：新增 desire/resistance
  | 'strategy_nudge'       // 策略微调：互动下滑、连续被否等
  | 'queue_health';        // 队列健康：积压过多/过期未审

export type AdviceUrgency = 'high' | 'medium' | 'low';

export interface ProactiveAdvice {
  type: AdviceType;
  urgency: AdviceUrgency;
  message: string;
  /** Optional slash command the operator can directly execute */
  suggested_action?: string;
}

export interface ProactiveAdvisorContext {
  trends: FilteredTrend[];
  queueItems: QueueItem[];
  strategy: ContentStrategy | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Velocity threshold for "hot opportunity" advice */
const HOT_OPPORTUNITY_VELOCITY = 2.5;

/** Days without publishing to trigger rhythm reminder */
const RHYTHM_REMINDER_DAYS = 3;

/** Max consecutive discards before strategy nudge */
const CONSECUTIVE_DISCARD_THRESHOLD = 2;

/** Pending queue items threshold for queue health warning */
const QUEUE_BACKLOG_THRESHOLD = 5;

// ─── Rule Evaluators ──────────────────────────────────────────────────────────

/**
 * Rule 1: Hot Opportunity — high-velocity trend matching persona tracks.
 */
function checkHotOpportunities(trends: FilteredTrend[]): ProactiveAdvice[] {
  const advice: ProactiveAdvice[] = [];
  const hotTrends = trends.filter(t => t.velocity_score >= HOT_OPPORTUNITY_VELOCITY);

  for (const t of hotTrends.slice(0, 2)) {
    const identityLabel = t.identity_mode ?? '日常';
    advice.push({
      type: 'hot_opportunity',
      urgency: t.velocity_score >= 3.5 ? 'high' : 'medium',
      message: `🔥 「${t.keyword}」正在起势（${t.velocity_score.toFixed(1)}x），可用 ${identityLabel} 身份切入`,
      suggested_action: `/idea ${t.keyword}`,
    });
  }

  return advice;
}

/**
 * Rule 2: Rhythm Reminder — too many days since last publish.
 */
function checkPublishingRhythm(queueItems: QueueItem[]): ProactiveAdvice[] {
  const published = queueItems
    .filter(i => i.status === 'published' && i.published_at)
    .sort((a, b) => new Date(b.published_at!).getTime() - new Date(a.published_at!).getTime());

  if (published.length === 0) {
    // No publishing history at all — check if there are pending items
    const hasPending = queueItems.some(i => i.status === 'pending');
    if (hasPending) {
      return [{
        type: 'rhythm_reminder',
        urgency: 'medium',
        message: '📅 还没有发布记录，队列里有待审选题哦',
        suggested_action: '/post',
      }];
    }
    return [];
  }

  const lastPublishDate = new Date(published[0].published_at!);
  const daysSince = Math.floor((now().getTime() - lastPublishDate.getTime()) / (1000 * 60 * 60 * 24));

  if (daysSince >= RHYTHM_REMINDER_DAYS) {
    const urgency: AdviceUrgency = daysSince >= 5 ? 'high' : 'medium';
    return [{
      type: 'rhythm_reminder',
      urgency,
      message: `📅 已经 ${daysSince} 天没更新了，粉丝可能在等新内容`,
      suggested_action: '/idea',
    }];
  }

  return [];
}

/**
 * Rule 3: Consecutive Discards — operator keeps rejecting, suggest direction change.
 */
function checkConsecutiveDiscards(queueItems: QueueItem[]): ProactiveAdvice[] {
  // Look at the most recent N items by updated_at
  const recentItems = [...queueItems]
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 10);

  let consecutiveDiscards = 0;
  for (const item of recentItems) {
    if (item.status === 'discarded') {
      consecutiveDiscards++;
    } else {
      break;
    }
  }

  if (consecutiveDiscards >= CONSECUTIVE_DISCARD_THRESHOLD) {
    // Try to extract discard reasons for context
    const discardReasons: string[] = [];
    for (const item of recentItems.slice(0, consecutiveDiscards)) {
      const lastFb = item.review_feedback?.slice(-1)[0];
      if (lastFb?.reason_summary) discardReasons.push(lastFb.reason_summary);
    }

    const reasonHint = discardReasons.length > 0
      ? `（原因：${discardReasons.slice(0, 2).join('；')}）`
      : '';

    return [{
      type: 'strategy_nudge',
      urgency: consecutiveDiscards >= 3 ? 'high' : 'medium',
      message: `⚠️ 最近 ${consecutiveDiscards} 个选题都被否了${reasonHint}，方向上有变化吗？`,
      suggested_action: '/idea',
    }];
  }

  return [];
}

/**
 * Rule 4: Strategy Engagement Trend — declining engagement needs attention.
 */
function checkStrategyTrend(strategy: ContentStrategy | null): ProactiveAdvice[] {
  if (!strategy) return [];

  if (strategy.performance_summary.engagement_trend === 'declining') {
    const direction = strategy.next_week_recommendations?.content_direction;
    const hint = direction ? `，可以试试：${direction}` : '';
    return [{
      type: 'strategy_nudge',
      urgency: 'medium',
      message: `📉 互动趋势在下滑（周环比 ${strategy.performance_summary.week_over_week_change}%）${hint}`,
    }];
  }

  return [];
}

/**
 * Rule 5: Audience Desire Signals — new audience desires detected.
 */
function checkAudienceSignals(): ProactiveAdvice[] {
  try {
    const store = readJSON<AudiencePerceptionStore>(
      PATHS.audiencePerception,
      { entries: [], last_updated: '' },
    );
    if (!store.entries || store.entries.length === 0) return [];

    // Aggregate recent desire signals (last 5 entries)
    const recent = store.entries.slice(-5);
    const desireFreq = new Map<string, number>();
    for (const entry of recent) {
      for (const d of entry.desire_signals ?? []) {
        desireFreq.set(d, (desireFreq.get(d) ?? 0) + 1);
      }
    }

    // Surface desires that appear in >= 2 entries
    const strongDesires = [...desireFreq.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([d]) => d);

    if (strongDesires.length > 0) {
      return [{
        type: 'audience_signal',
        urgency: 'low',
        message: `👥 受众最近在要求更多「${strongDesires.join('、')}」类内容`,
      }];
    }
  } catch {
    // audience perception not available
  }

  return [];
}

/**
 * Rule 6: Queue Health — too many pending items backlogged.
 */
function checkQueueHealth(queueItems: QueueItem[]): ProactiveAdvice[] {
  const pending = queueItems.filter(i => i.status === 'pending');
  if (pending.length >= QUEUE_BACKLOG_THRESHOLD) {
    return [{
      type: 'queue_health',
      urgency: 'medium',
      message: `📋 队列里积压了 ${pending.length} 个选题，建议抽空审一下`,
      suggested_action: '/post',
    }];
  }
  return [];
}

/**
 * Rule 7: Performance highlight — recent viral/above_avg content success.
 */
function checkRecentSuccess(): ProactiveAdvice[] {
  try {
    const perfLog = readJSON<PerformanceLog>(PATHS.performanceLog, { entries: [], last_updated: '' });
    if (!perfLog.entries || perfLog.entries.length === 0) return [];

    // Check entries from last 7 days
    const sevenDaysAgo = new Date(now().getTime() - 7 * 24 * 60 * 60 * 1000);
    const recent = perfLog.entries.filter(e => new Date(e.published_at) >= sevenDaysAgo);

    // Find entries with very high engagement (top performers)
    const sorted = [...recent].sort((a, b) => b.peak_metrics.likes - a.peak_metrics.likes);
    const top = sorted[0];

    if (top && top.peak_metrics.likes >= 1000) {
      const likesStr = top.peak_metrics.likes >= 10000
        ? `${(top.peak_metrics.likes / 10000).toFixed(1)}w`
        : `${top.peak_metrics.likes}`;
      return [{
        type: 'strategy_nudge',
        urgency: 'low',
        message: `🎉 最近发布的「${top.topic.slice(0, 15)}」效果不错（❤️${likesStr}），可以考虑延续同类方向`,
        suggested_action: `/idea ${top.identity_mode}`,
      }];
    }
  } catch {
    // performance log not available
  }
  return [];
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Generate proactive advice based on current ops context.
 * Returns sorted by urgency (high → medium → low), deduped by type.
 */
export function generateProactiveAdvice(ctx: ProactiveAdvisorContext): ProactiveAdvice[] {
  const { trends, queueItems, strategy } = ctx;

  const allAdvice: ProactiveAdvice[] = [
    ...checkHotOpportunities(trends),
    ...checkPublishingRhythm(queueItems),
    ...checkConsecutiveDiscards(queueItems),
    ...checkStrategyTrend(strategy),
    ...checkAudienceSignals(),
    ...checkQueueHealth(queueItems),
    ...checkRecentSuccess(),
  ];

  // Dedup by type: keep only the highest-urgency advice per type
  const urgencyOrder: Record<AdviceUrgency, number> = { high: 3, medium: 2, low: 1 };
  const bestByType = new Map<AdviceType, ProactiveAdvice>();

  for (const a of allAdvice) {
    const existing = bestByType.get(a.type);
    if (!existing || urgencyOrder[a.urgency] > urgencyOrder[existing.urgency]) {
      bestByType.set(a.type, a);
    }
  }

  // Sort by urgency desc, cap at 4 to avoid overwhelming
  return [...bestByType.values()]
    .sort((a, b) => urgencyOrder[b.urgency] - urgencyOrder[a.urgency])
    .slice(0, 4);
}

/**
 * Format proactive advice into a brief section string.
 * Returns empty string if no advice to show.
 */
export function formatAdviceSection(advice: ProactiveAdvice[]): string {
  if (advice.length === 0) return '';

  const lines = ['━━ 💡 助手建议 ━━'];
  for (const a of advice) {
    let line = a.message;
    if (a.suggested_action) {
      line += `  → ${a.suggested_action}`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}
