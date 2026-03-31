/**
 * brief-generator.ts
 * Formats and sends the daily ops brief to WeChat Work via OpenClaw gateway.
 * Also handles /brief command re-generation.
 */

import { execFileSync } from 'child_process';
import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now } from '../utils/time-utils';
import { QueueItem, CompetitorUpdate, OpsBriefLog } from '../utils/types';
import { FilteredTrend } from './trend-analyzer';

// ─── Pure formatting (exported for testing) ──────────────────────────────────

export function formatBriefCard(
  date: string,
  trends: FilteredTrend[],
  competitors: CompetitorUpdate[],
  queueItems: QueueItem[],
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
        lines.push(`@${c.account}  今日「${topic}」互动${engagement}`);
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
    lines.push('━━ 操作 ━━');
    lines.push('回复 1~N 选择 · /post 查看详情 · 跳过 今天不发');
  } else {
    lines.push('━━ 操作 ━━');
    lines.push('/idea [方向] 手动出选题 · /trends 查最新热点');
  }

  return lines.join('\n');
}

// ─── WeChat Work push via OpenClaw gateway ────────────────────────────────────

export function sendToWechatWork(message: string): boolean {
  try {
    execFileSync('openclaw', [
      'wechat', 'send',
      '--message', message,
    ], { timeout: 15_000, encoding: 'utf8' });
    return true;
  } catch (err) {
    console.error('[brief-generator] sendToWechatWork failed:', err);
    return false;
  }
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
): Promise<boolean> {
  const date = now().toISOString().slice(0, 10);
  const card = formatBriefCard(date, trends, competitors, queueItems);
  const sent = sendToWechatWork(card);
  if (sent) logBriefSent(date, queueItems.filter(i => i.status === 'pending').length);
  return sent;
}
