#!/usr/bin/env node
/**
 * ops-command-handler.ts
 * CLI entry point for ops slash commands dispatched from OpenClaw plugin.
 *
 * Usage:  node ops-command-handler.js <command> [args...]
 *
 * Commands:
 *   brief              — 生成并返回今日运营简报
 *   trends             — 刷新热点趋势
 *   idea [方向]         — 手动出选题
 *   post [N]           — 查看选题详情
 *   analyze <url>      — 爆款拆解
 *   advice             — 人设建议
 *   status             — 查看队列状态
 *   help               — 显示帮助
 *
 * Output goes to stdout (OpenClaw captures it as the command reply).
 * All console.log is redirected to stderr so only the final result goes to stdout.
 */

// Redirect console.log to stderr so debug/info logs don't pollute stdout
const _origLog = console.log;
console.log = (...args: unknown[]) => console.error(...args);

import { createRealLLMClient } from '../utils/llm-client';
import { loadPersona } from '../persona/persona-loader';
import { loadSkillEnvVars } from '../utils/file-utils';
import { analyzeTrends, buildPersonaIdentities, FilteredTrend } from '../ops/trend-analyzer';
import { trackCompetitors } from '../ops/competitor-tracker';
import { generateTopics } from '../ops/topic-generator';
import { formatBriefCard, formatContentPackage, BriefEnrichment } from './brief-generator';
import { loadQueue, cleanupOldItems } from './review-queue';
import { generatePersonaReport, formatAlignmentCard } from './persona-advisor';
import { analyzePost, formatAnalysisCard } from './viral-analyzer';
import { handleReviewMessage } from './ops-review-handler';
import { setActiveReviewItem } from './review-session';
import { runHealthCheck, formatHealthReport } from './health-check';
import { now } from '../utils/time-utils';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function printAndExit(text: string, code = 0): never {
  process.stdout.write(text);
  process.exit(code);
}

// ─── Command: /brief ──────────────────────────────────────────────────────────

async function cmdBrief(): Promise<string> {
  loadSkillEnvVars('alive');
  const persona = await loadPersona();
  const ops = persona.ops;
  if (!ops?.enabled) return '⚠️ ops 未启用，请在 persona.yaml 中设置 ops.enabled: true';

  const llm = createRealLLMClient('ops-brief-cmd');
  const identities = buildPersonaIdentities(persona);
  const imageStyle = (persona as { image_style?: { base_prompt?: string } }).image_style?.base_prompt ?? '';

  await cleanupOldItems();

  // Trends + competitors in parallel; competitors failure is non-fatal
  let trends: FilteredTrend[] = [];
  let competitors: import('../utils/types').CompetitorUpdate[] = [];
  try {
    const [trendsResult, competitorsResult] = await Promise.allSettled([
      analyzeTrends(ops, identities, llm),
      Promise.resolve(trackCompetitors(ops)),
    ]);
    trends = trendsResult.status === 'fulfilled' ? trendsResult.value : [];
    competitors = competitorsResult.status === 'fulfilled' ? competitorsResult.value : [];
  } catch {
    // If even allSettled somehow throws, continue with empty data
  }

  await generateTopics(trends, ops, persona.meta.name, imageStyle, llm);

  const queue = await loadQueue();
  const pending = queue.items.filter(i => i.status === 'pending');

  // Persona alignment report (best-effort)
  let personaReport = null;
  try {
    personaReport = await generatePersonaReport(persona, trends, competitors, llm);
  } catch {
    // skip
  }

  const enrichment: BriefEnrichment = { personaReport, fullQueueItems: pending };
  const date = now().toISOString().slice(0, 10);
  return formatBriefCard(date, trends, competitors, pending, enrichment);
}

// ─── Command: /trends ─────────────────────────────────────────────────────────

async function cmdTrends(): Promise<string> {
  loadSkillEnvVars('alive');
  const persona = await loadPersona();
  const ops = persona.ops;
  if (!ops?.enabled) return '⚠️ ops 未启用';

  const llm = createRealLLMClient('ops-trends-cmd');
  const identities = buildPersonaIdentities(persona);

  const trends = await analyzeTrends(ops, identities, llm);

  if (trends.length === 0) return '📊 暂无通过过滤的热点话题';

  const lines = ['📊 当前热点趋势', ''];
  for (const t of trends.slice(0, 10)) {
    const icon = t.velocity_score >= 2.0 ? '🔥' : '⚡';
    lines.push(`${icon} ${t.keyword}  ${t.platform}  ${t.velocity_score.toFixed(1)}x`);
  }
  return lines.join('\n');
}

// ─── Command: /idea ───────────────────────────────────────────────────────────

async function cmdIdea(direction?: string): Promise<string> {
  loadSkillEnvVars('alive');
  const persona = await loadPersona();
  const ops = persona.ops;
  if (!ops?.enabled) return '⚠️ ops 未启用';

  const llm = createRealLLMClient('ops-idea-cmd');
  const identities = buildPersonaIdentities(persona);
  const imageStyle = (persona as { image_style?: { base_prompt?: string } }).image_style?.base_prompt ?? '';

  // Get current trends
  let trends: FilteredTrend[] = [];
  try {
    trends = await analyzeTrends(ops, identities, llm);
  } catch {
    // proceed without trends
  }

  // Optionally override filter prompt with user-specified direction
  const effectiveOps = direction
    ? { ...ops, topic_filter_prompt: `${ops.topic_filter_prompt}\n用户指定方向：${direction}` }
    : ops;

  await generateTopics(trends, effectiveOps, persona.meta.name, imageStyle, llm);

  const queue = await loadQueue();
  const pending = queue.items.filter(i => i.status === 'pending');

  if (pending.length === 0) return '💡 暂未生成新选题，请稍后重试';

  const lines = [`💡 已生成 ${pending.length} 个选题`, ''];
  pending.forEach((item, idx) => {
    lines.push(`${idx + 1}️⃣  ${item.topic}`);
    lines.push(`   ${item.trend_hook}`);
  });
  lines.push('', '回复 /post N 查看详情');
  return lines.join('\n');
}

// ─── Command: /post ───────────────────────────────────────────────────────────

async function cmdPost(indexStr?: string): Promise<string> {
  const queue = await loadQueue();
  const pending = queue.items.filter(i => i.status === 'pending');

  if (pending.length === 0) return '📭 队列中没有待审核的选题，试试 /brief 或 /idea';

  if (!indexStr) {
    // Show list
    const lines = [`📋 待审核选题（${pending.length}个）`, ''];
    pending.forEach((item, idx) => {
      lines.push(`${idx + 1}️⃣  ${item.topic}`);
      lines.push(`   ${item.trend_hook}`);
    });
    lines.push('', '回复 /post N 查看第 N 个选题详情');
    return lines.join('\n');
  }

  const idx = parseInt(indexStr, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= pending.length) {
    return `⚠️ 无效编号，请输入 1~${pending.length}`;
  }

  // Set this item as the active review item for subsequent natural-language messages
  setActiveReviewItem(pending[idx].id);

  return formatContentPackage(pending[idx]);
}

// ─── Command: /analyze ────────────────────────────────────────────────────────

async function cmdAnalyze(url?: string): Promise<string> {
  if (!url || !url.startsWith('http')) {
    return '⚠️ 请提供有效的帖子 URL\n用法：/analyze https://www.xiaohongshu.com/explore/xxx';
  }

  loadSkillEnvVars('alive');
  const persona = await loadPersona();
  if (!persona.ops?.enabled) return '⚠️ ops 未启用';

  const llm = createRealLLMClient('ops-analyze-cmd');

  try {
    const result = await analyzePost(url, persona, llm);
    return formatAnalysisCard(result);
  } catch (err) {
    return `⚠️ 爆款拆解失败：${(err as Error).message}`;
  }
}

// ─── Command: /advice ─────────────────────────────────────────────────────────

async function cmdAdvice(): Promise<string> {
  loadSkillEnvVars('alive');
  const persona = await loadPersona();
  const ops = persona.ops;
  if (!ops?.enabled) return '⚠️ ops 未启用';

  const llm = createRealLLMClient('ops-advice-cmd');
  const identities = buildPersonaIdentities(persona);

  // Each step is independently fault-tolerant
  let trends: FilteredTrend[] = [];
  let competitors: import('../utils/types').CompetitorUpdate[] = [];

  const [trendsResult, competitorsResult] = await Promise.allSettled([
    analyzeTrends(ops, identities, llm),
    Promise.resolve(trackCompetitors(ops)),
  ]);
  trends = trendsResult.status === 'fulfilled' ? trendsResult.value : [];
  competitors = competitorsResult.status === 'fulfilled' ? competitorsResult.value : [];

  try {
    const report = await generatePersonaReport(persona, trends, competitors, llm);
    const card = formatAlignmentCard(report);
    // Append note if data was partial
    const warnings: string[] = [];
    if (trendsResult.status === 'rejected') warnings.push('热点数据获取失败');
    if (competitorsResult.status === 'rejected') warnings.push('竞品数据获取失败');
    return warnings.length > 0 ? `${card}\n\n⚠️ 部分数据缺失：${warnings.join('、')}` : card;
  } catch (err) {
    return `⚠️ 人设建议生成失败：${(err as Error).message}`;
  }
}

// ─── Command: /status ─────────────────────────────────────────────────────────

async function cmdStatus(): Promise<string> {
  const queue = await loadQueue();
  const pending = queue.items.filter(i => i.status === 'pending').length;
  const published = queue.items.filter(i => i.status === 'published').length;
  const discarded = queue.items.filter(i => i.status === 'discarded').length;

  return [
    '📊 运营工作台状态',
    '',
    `⏳ 待审核: ${pending}`,
    `✅ 已发布: ${published}`,
    `🗑️ 已弃置: ${discarded}`,
    `📦 队列总量: ${queue.items.length}`,
  ].join('\n');
}

// ─── Command: /help ───────────────────────────────────────────────────────────

function cmdHelp(): string {
  return [
    '🛠 运营工作台命令',
    '',
    '/brief          — 生成今日运营简报（热点+选题+建议）',
    '/trends         — 查看当前热点趋势',
    '/idea [方向]     — 手动生成选题（可指定方向）',
    '/post [N]       — 查看选题列表 / 第N个选题详情',
    '/analyze <URL>  — 爆款帖子拆解分析',
    '/advice         — 人设契合度建议',
    '/status         — 查看队列状态',
    '/help           — 显示本帮助',
  ].join('\n');
}

// ─── CLI Dispatcher ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command) {
    printAndExit(cmdHelp());
  }

  let result: string;
  try {
    switch (command.toLowerCase()) {
      case 'brief':
        result = await cmdBrief();
        break;
      case 'trends':
        result = await cmdTrends();
        break;
      case 'idea':
        result = await cmdIdea(args.join(' ') || undefined);
        break;
      case 'post':
        result = await cmdPost(args[0]);
        break;
      case 'analyze':
        result = await cmdAnalyze(args[0]);
        break;
      case 'advice':
        result = await cmdAdvice();
        break;
      case 'status':
        result = await cmdStatus();
        break;
      case 'health': {
        const report = await runHealthCheck();
        result = formatHealthReport(report);
        break;
      }
      case 'message': {
        // Free-text review message handler
        const messageText = args.join(' ');
        if (!messageText) {
          result = '⚠️ 请提供消息内容';
          break;
        }
        loadSkillEnvVars('alive');
        const llm = createRealLLMClient('ops-review-msg');
        result = await handleReviewMessage(messageText, llm);
        break;
      }
      case 'help':
        result = cmdHelp();
        break;
      default:
        result = `⚠️ 未知命令: ${command}\n\n${cmdHelp()}`;
    }
  } catch (err) {
    result = `❌ 命令执行失败: ${(err as Error).message}`;
  }

  printAndExit(result);
}

main().catch(err => {
  console.error(`ops-command-handler ERROR: ${err}`);
  process.exit(1);
});
