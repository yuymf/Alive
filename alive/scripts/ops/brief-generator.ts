/**
 * brief-generator.ts
 * Formats and sends the daily ops brief to WeChat Work via OpenClaw gateway.
 * Also handles /brief command re-generation.
 */

import { execFileSync } from 'child_process';
import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now } from '../utils/time-utils';
import { QueueItem, CompetitorUpdate, OpsBriefLog, ContentStrategy, PersonaAlignmentReport, CompetitorAnalysisStore } from '../utils/types';
import { FilteredTrend } from './trend-analyzer';
import { formatAlignmentBriefSection } from './persona-advisor';

// ─── Brief Enrichment (optional, backward-compatible) ────────────────────────

export interface BriefEnrichment {
  /** Persona alignment report for 💡人设建议 section */
  personaReport?: PersonaAlignmentReport | null;
  /** Full queue items for 🎨生图Prompt + 🎬视频分镜 extraction */
  fullQueueItems?: readonly QueueItem[];
  /** Competitor analysis store for enriched competitor insights */
  competitorAnalysis?: CompetitorAnalysisStore | null;
}

// ─── Pure formatting (exported for testing) ──────────────────────────────────

export function formatBriefCard(
  date: string,
  trends: FilteredTrend[],
  competitors: CompetitorUpdate[],
  queueItems: QueueItem[],
  enrichment?: BriefEnrichment,
): string {
  const lines: string[] = [`📊 今日简报  ${date}`, ''];

  // Trends
  if (trends.length > 0) {
    lines.push('━━ 平台正在助推 ━━');
    for (const t of trends.slice(0, 5)) {
      const icon = t.velocity_score >= 2.0 ? '🔥' : '⚡';
      lines.push(`${icon} ${t.keyword}  ${t.platform}  ${t.velocity_score.toFixed(1)}x`);
    }
    lines.push('');
  }

  // Competitors
  if (competitors.length > 0) {
    lines.push('━━ 竞品动态 ━━');
    for (const c of competitors) {
      if (!c.latest_post) {
        lines.push(`@${c.account}  ${c.days_since_last_post}天未更新`);
      } else {
        const { topic, engagement } = c.latest_post;
        const analysisKey = `${c.account}:${c.platform}`;
        const analysis = enrichment?.competitorAnalysis?.analyses?.[analysisKey];
        if (analysis?.key_insight) {
          lines.push(`@${c.account}  核心洞察：${analysis.key_insight} | 最新「${topic}」互动${engagement}`);
        } else {
          lines.push(`@${c.account}  今日「${topic}」互动${engagement}`);
        }
      }
    }
    lines.push('');
  }

  // Queue items (topics ready for review)
  const pending = queueItems.filter(i => i.status === 'pending');
  if (pending.length > 0) {
    lines.push(`━━ AI 今日推荐选题（${pending.length}个）━━`);
    pending.forEach((item, idx) => {
      lines.push(`${idx + 1}️⃣  ${item.topic}`);
      lines.push(`   ${item.trend_hook}`);
    });
    lines.push('');
  }

  // ─── Enrichment sections (new: 生图Prompt, 视频分镜, 人设建议) ────────────

  const enrichItems = enrichment?.fullQueueItems
    ?? pending;
  const firstPending = enrichItems.find(i => i.status === 'pending');

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

  // 🎬 今日视频分镜
  if (firstPending) {
    const douyin = firstPending.content?.douyin;
    if (douyin && (douyin.key_captions.length > 0 || douyin.bgm_suggestion)) {
      lines.push('━━ 🎬 今日视频分镜 ━━');
      if (douyin.key_captions.length > 0) {
        douyin.key_captions.forEach((cap, idx) => lines.push(`  ${idx + 1}. ${cap}`));
      }
      if (douyin.bgm_suggestion) {
        lines.push(`  🎵 BGM: ${douyin.bgm_suggestion}`);
      }
      lines.push('');
    }
  }

  // 💡 人设建议
  if (enrichment?.personaReport) {
    lines.push(formatAlignmentBriefSection(enrichment.personaReport));
    lines.push('');
  }

  // ─── Actions ────────────────────────────────────────────────────────────────

  if (pending.length > 0) {
    lines.push('━━ 操作 ━━');
    lines.push('回复 1~N 选择 · /post 查看详情 · 跳过 今天不发');
  } else {
    lines.push('━━ 操作 ━━');
    lines.push('/idea [方向] 手动出选题 · /trends 查最新热点');
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
  lines.push('━━ 小红书 图文 ━━', `【标题】${xhs.title}`, '【正文】', xhs.body, `【标签】${xhs.tags.join(' ')}`);
  if (xhs.cover_images.length > 0) {
    lines.push('【封面】');
    xhs.cover_images.forEach((url, i) => lines.push(`  图${i + 1}: ${url}`));
  }
  lines.push('');

  const { douyin } = item.content;
  lines.push('━━ 抖音 视频脚本 ━━', '【脚本】', douyin.script, `【BGM】${douyin.bgm_suggestion}`);
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
    '',
  ];
  return lines.join('\n');
}

// ─── WeChat Work push ─────────────────────────────────────────────────────────
// Uses openclaw message send --channel wecom --target <WECOM_TARGET_ID>
// WECOM_TARGET_ID = enterprise WeChat member userid (e.g. "zhangsan")
// Set via: openclaw.json → skills.entries.alive.env.WECOM_TARGET_ID

export type BriefDeliveryMode = 'session' | 'wecom-target';

/**
 * Send brief to the current/last OpenClaw session (no channel/target needed).
 * This is the preferred mode for personas using automation.brief_delivery = 'session'.
 */
export function sendBriefToSession(message: string): boolean {
  // openclaw message send requires -t (target); for session delivery, use the
  // OPENCLAW_SESSION_TARGET env var set by the cron runner, or fall back to stdout.
  const sessionTarget = process.env.OPENCLAW_SESSION_TARGET ?? '';
  if (!sessionTarget) {
    console.log('\n[Session 投递内容]\n' + message + '\n');
    console.log('[brief-generator] OPENCLAW_SESSION_TARGET not set — printed to stdout only');
    return true;
  }
  try {
    execFileSync('openclaw', [
      'message', 'send',
      '-t', sessionTarget,
      '--message', message,
    ], { timeout: 20_000, encoding: 'utf8' });
    return true;
  } catch (err) {
    console.error('[brief-generator] session send failed:', err);
    // Fallback: print to stdout so cron deliver can pick it up
    console.log('\n[Session 投递内容（fallback）]\n' + message + '\n');
    return false;
  }
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

// ─── Log ─────────────────────────────────────────────────────────────────────

function logBriefSent(date: string, topicCount: number): void {
  const log = readJSON<OpsBriefLog>(PATHS.opsBriefLog, { entries: [] });
  const entry = { date, sent_at: now().toISOString(), topic_count: topicCount };
  writeJSON(PATHS.opsBriefLog, { entries: [...log.entries.slice(-29), entry] });
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

  const mode = deliveryMode ?? 'wecom-target';
  const sent = deliverBrief(card, mode);
  if (sent) logBriefSent(date, queueItems.filter(i => i.status === 'pending').length);
  return sent;
}
