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
 *   review [子命令]     — 批量快速审核
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
import { analyzeTrends, analyzeDirectionalTrends, buildPersonaIdentities, FilteredTrend } from '../ops/trend-analyzer';
import { trackCompetitors } from '../ops/competitor-tracker';
import { generateTopics } from '../ops/topic-generator';
import { formatBriefCard, formatContentPackage, BriefEnrichment } from './brief-generator';
import { loadQueue, cleanupOldItems, markApproved, markDiscarded, addReviewFeedback, getActivePendingItems } from './review-queue';
import { PENDING_EXPIRE_HOURS, hoursSinceCreated } from './review-queue';
import { generatePersonaReport, formatAlignmentCard } from './persona-advisor';
import { analyzePost, formatAnalysisCard } from './viral-analyzer';
import { handleReviewMessage } from './ops-review-handler';
import { setActiveReviewItem } from './review-session';
import { runHealthCheck, formatHealthReport } from './health-check';
import { now } from '../utils/time-utils';
import { getIdentityKeys, QueueItem } from '../utils/types';
import { loadCandidateAccounts } from './discovery-engine';
import { rankCandidates } from './candidate-scorer';
import { getStats, queryAll, loadFormulas } from './viral-kb-store';
import { PATHS } from '../utils/file-utils';
import * as path from 'path';

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
  const identityKeys = getIdentityKeys(persona);

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

  const imageStyle = (persona as { image_style?: { base_prompt?: string } }).image_style?.base_prompt ?? '';
  await generateTopics(trends, ops, persona.meta.name, llm, { style: imageStyle, sample_lines: persona.voice?.sample_lines });

  const queue = await loadQueue();
  const pending = queue.items.filter(i => i.status === 'pending');
  // 只将 48h 内活跃的 pending items 传入 LLM 上下文，expired 内容不参与
  const activePending = pending.filter(i => hoursSinceCreated(i) < PENDING_EXPIRE_HOURS);

  // Persona alignment report (best-effort)
  let personaReport = null;
  try {
    personaReport = await generatePersonaReport(persona, trends, competitors, llm);
  } catch {
    // skip
  }

  const enrichment: BriefEnrichment = { personaReport, fullQueueItems: activePending, identityKeys };

  // Viral KB enrichment (best-effort)
  try {
    const basePath = path.dirname(PATHS.emotionState);
    const kbStats = getStats(basePath);
    if (kbStats.total > 0) {
      enrichment.viralKbStats = kbStats;
      enrichment.viralKbTopEntries = queryAll(basePath, { sort: 'likes', limit: 3 });
      enrichment.viralKbFormulas = loadFormulas(basePath);
    }
  } catch {
    // viral-kb not available, skip
  }
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

  // Group by source_bucket for sectioned display
  // Map internal bucket names to user-facing labels
  const bucketDisplay: Record<string, string> = {
    '赛道 Tag': '🏷️ 推荐流',
    '热榜': '📰 热榜',
    '搜索': '🔍 搜索',
  };
  const bucketOrder = ['赛道 Tag', '搜索', '热榜'] as const;

  // Partition trends into buckets
  const bucketGroups = new Map<string, FilteredTrend[]>();
  for (const t of trends) {
    const b = t.source_bucket ?? '热榜';
    if (!bucketGroups.has(b)) bucketGroups.set(b, []);
    bucketGroups.get(b)!.push(t);
  }

  const lines = ['📊 当前热点趋势（LLM 精选）', ''];

  for (const bucket of bucketOrder) {
    const items = bucketGroups.get(bucket);
    if (!items || items.length === 0) continue;
    const label = bucketDisplay[bucket] ?? `📰 ${bucket}`;
    lines.push(`${label}（${items.length}）`);
    for (const t of items) {
      const icon = t.velocity_score >= 2.0 ? '🔥' : '⚡';
      lines.push(`  ${icon} ${t.keyword}  ${t.platform}  ${t.velocity_score.toFixed(1)}x  p=${t.priority_score.toFixed(1)}`);
    }
    lines.push('');
  }

  // Source distribution summary
  const bucketCounts = new Map<string, number>();
  for (const t of trends) {
    const b = t.source_bucket ?? '热榜';
    bucketCounts.set(b, (bucketCounts.get(b) ?? 0) + 1);
  }
  const distParts = [...bucketCounts.entries()].map(([b, c]) => `${bucketDisplay[b] ?? b}×${c}`);
  lines.push(`来源分布：${distParts.join(' · ')}`);

  // Signal pool overview: show top items per source bucket from the cached signal pool
  try {
    const { readJSON, PATHS } = await import('../utils/file-utils');
    const cache = readJSON<{ signal_pool?: { bucket: string; top: { keyword: string; platform: string; v: string; p: string }[] }[] }>(PATHS.trendsCache, {} as any);
    if (cache?.signal_pool && cache.signal_pool.length > 0) {
      lines.push('', '📋 信号池概览（按来源）');
      for (const group of cache.signal_pool) {
        const label = bucketDisplay[group.bucket] ?? `📰 ${group.bucket}`;
        lines.push(`  ${label}:`);
        for (const t of group.top) {
          lines.push(`    · ${t.keyword}  ${t.platform}  v=${t.v}x  p=${t.p}`);
        }
      }
    }
  } catch {
    // Non-fatal: signal pool overview is optional
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

  // Get current trends — directional search when direction specified
  let trends: FilteredTrend[] = [];
  try {
    if (direction) {
      // Directional pipeline: cache → discovery-pool → platform search → LLM
      trends = await analyzeDirectionalTrends(ops, identities, llm, direction);
    } else {
      trends = await analyzeTrends(ops, identities, llm);
    }
  } catch {
    // proceed without trends
  }

  // Snapshot existing pending IDs before generation to diff later
  const queueBefore = await loadQueue();
  const existingIds = new Set(queueBefore.items.filter(i => i.status === 'pending').map(i => i.id));

  // Optionally override filter prompt with user-specified direction
  const effectiveOps = direction
    ? { ...ops, topic_filter_prompt: `${ops.topic_filter_prompt}\n用户指定方向：${direction}` }
    : ops;

  await generateTopics(trends, effectiveOps, persona.meta.name, llm, persona.voice,
    direction ? { relaxedForDirection: true } : undefined,
  );

  const queueAfter = await loadQueue();
  const allPending = queueAfter.items.filter(i => i.status === 'pending');
  const newItems = allPending.filter(i => !existingIds.has(i.id));

  if (newItems.length === 0) {
    // Provide context-aware message when direction was specified
    if (direction) {
      return `💡 暂未生成新选题——「${direction}」相关身份在当前队列中已较饱和，系统已放宽多样性限制仍无新选题通过。\n可尝试：\n1. 先清理部分待审核选题 (/post N → 修改/发布/弃置)\n2. 指定其他方向：/idea 美食`;
    }
    return '💡 暂未生成新选题（可能与已有选题重复），试试指定新方向：/idea 美食';
  }

  const lines = [`💡 本次新增 ${newItems.length} 个选题（队列共 ${allPending.length} 个待审核）`, ''];
  newItems.forEach((item, idx) => {
    lines.push(`${idx + 1}️⃣  ${item.topic}`);
    lines.push(`   ${item.trend_hook}`);
  });
  if (allPending.length > newItems.length) {
    lines.push('', `📋 队列中还有 ${allPending.length - newItems.length} 个之前的选题`);
  }
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

// ─── Command: /review ──────────────────────────────────────────────────────────

type ReviewVerdict = 'approve' | 'modify' | 'discard';

interface BatchVerdict {
  index: number;
  verdict: ReviewVerdict;
  reason: string;
}

async function cmdReview(subCommand?: string): Promise<string> {
  const queue = await loadQueue();
  const pending = queue.items.filter(i => i.status === 'pending');

  if (pending.length === 0) return '📭 队列中没有待审核的选题，试试 /brief 或 /idea';

  // ── /review approve-all ──
  if (subCommand === 'approve-all') {
    let approved = 0;
    for (const item of pending) {
      const result = await markApproved(item.id);
      if (result) {
        approved++;
        await addReviewFeedback(item.id, {
          decision: 'approved',
          source: 'dashboard',
          reason_summary: '批量审批通过（approve-all）',
        });
      }
    }
    return `✅ 已批量通过 ${approved}/${pending.length} 个选题`;
  }

  // ── /review discard-low ──
  if (subCommand === 'discard-low') {
    loadSkillEnvVars('alive');
    const persona = await loadPersona();
    const llm = createRealLLMClient('ops-review-discard');
    const verdicts = await batchJudge(pending, persona, llm);

    let discarded = 0;
    const discardIds = verdicts
      .filter(v => v.verdict === 'discard')
      .map(v => pending[v.index]?.id)
      .filter(Boolean) as string[];

    if (discardIds.length === 0) {
      return '✅ 没有被判定为"建议弃置"的选题，全部保留';
    }

    for (const id of discardIds) {
      const result = await markDiscarded(id);
      if (result) {
        discarded++;
        await addReviewFeedback(id, {
          decision: 'discarded',
          source: 'dashboard',
          reason_summary: '批量弃置（LLM 判定低匹配）',
        });
      }
    }
    const remaining = pending.length - discarded;
    return `🗑️ 已弃置 ${discarded} 个选题，剩余 ${remaining} 个待审核\n💡 回复 /review 查看剩余选题`;
  }

  // ── /review (default) or /review quick ──
  loadSkillEnvVars('alive');
  const persona = await loadPersona();
  const llm = createRealLLMClient('ops-review-quick');
  const verdicts = await batchJudge(pending, persona, llm);

  // Count by verdict
  const counts = { approve: 0, modify: 0, discard: 0 };
  for (const v of verdicts) counts[v.verdict]++;

  const ICON: Record<ReviewVerdict, string> = {
    approve: '🟢',
    modify: '🟡',
    discard: '🔴',
  };
  const LABEL: Record<ReviewVerdict, string> = {
    approve: '建议发布',
    modify: '需修改',
    discard: '建议弃置',
  };

  const lines = [`📋 快速审核（${pending.length}个选题）`, ''];

  pending.forEach((item, idx) => {
    const v = verdicts.find(vv => vv.index === idx) ?? { verdict: 'modify' as ReviewVerdict, reason: '未判定' };
    lines.push(`${idx + 1}️⃣ ${ICON[v.verdict]} ${item.topic}`);
    lines.push(`   ${v.reason}`);
  });

  lines.push('');
  lines.push(`📊 LLM 判定：${ICON.approve}${LABEL.approve} ${counts.approve} · ${ICON.modify}${LABEL.modify} ${counts.modify} · ${ICON.discard}${LABEL.discard} ${counts.discard}`);
  lines.push('');
  lines.push('💡 /post N 查看详情 · /review approve-all 一键通过 · /review discard-low 弃置🔴项');

  return lines.join('\n');
}

/**
 * Batch-judge all pending items using a single LLM call.
 * Returns an array of { index, verdict, reason }.
 */
async function batchJudge(
  pending: QueueItem[],
  persona: import('../utils/types').PersonaConfig,
  llm: ReturnType<typeof createRealLLMClient>,
): Promise<BatchVerdict[]> {
  if (pending.length === 0) return [];

  const identities = buildPersonaIdentities(persona);
  const identityKeys = getIdentityKeys(persona);
  const personaName = persona.meta?.name ?? '';

  // Build concise item list for LLM
  const itemLines = pending.map((item, idx) => {
    const identityLabel = item.identity_mode || 'default';
    return `${idx + 1}. 「${item.topic}」| 热点钩子: ${item.trend_hook} | 身份: ${identityLabel}`;
  });

  const prompt = `你是一个内容运营专家，正在帮运营快速审核选题。

人设信息：
- 名称：${personaName}
- 身份维度：${identityKeys.join('、')}
- 人设描述：${identities}

待审核选题：
${itemLines.join('\n')}

对每个选题，从"人设匹配度"角度给出快速判定：
- approve：选题与人设高度契合，可以直接发布
- modify：选题方向可以，但需要调整（如标题、角度等）
- discard：选题与人设偏差较大，建议弃置

请用 JSON 格式返回，格式如下：
[{"i":1,"v":"approve","r":"人设匹配，话题新鲜"},{"i":2,"v":"modify","r":"方向可以但标题需调整"},...]

只返回 JSON 数组，不要其他内容。i 是编号（从1开始），v 是判定（approve/modify/discard），r 是一句话理由。`;

  try {
    const result = await llm.callJSON<Array<{ i: number; v: string; r: string }>>(prompt, 2000);
    if (!Array.isArray(result)) return [];

    const validVerdicts: ReviewVerdict[] = ['approve', 'modify', 'discard'];
    return result
      .filter(item => typeof item.i === 'number' && validVerdicts.includes(item.v as ReviewVerdict))
      .map(item => ({
        index: item.i - 1,
        verdict: item.v as ReviewVerdict,
        reason: item.r ?? '',
      }));
  } catch (err) {
    console.error('[cmdReview] LLM batch judge failed:', (err as Error).message);
    // Fallback: return all as "modify" with a note
    return pending.map((_, idx) => ({
      index: idx,
      verdict: 'modify' as ReviewVerdict,
      reason: 'LLM 判定失败，请人工审核',
    }));
  }
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

  const recommendation = buildStatusRecommendation(queue.items, pending, published);

  return [
    '📊 运营工作台状态',
    '',
    `⏳ 待审核: ${pending}`,
    `✅ 已发布: ${published}`,
    `🗑️ 已弃置: ${discarded}`,
    `📦 队列总量: ${queue.items.length}`,
    '',
    `💡 ${recommendation}`,
  ].join('\n');
}

/**
 * Generate a one-line ops recommendation based on current queue state.
 * Prioritizes the most actionable next step.
 */
function buildStatusRecommendation(
  items: QueueItem[],
  pendingCount: number,
  publishedCount: number,
): string {
  // 1. No pending & no published → kick off with /brief
  if (pendingCount === 0 && publishedCount === 0) {
    return '还没有选题，运行 /brief 生成今日简报和新选题';
  }

  // 2. Pending backlog (>=5) → review first
  if (pendingCount >= 5) {
    return `有 ${pendingCount} 个选题待审核，建议 /post 逐个过一遍`;
  }

  // 3. Pending > 0 but no published → review and publish
  if (pendingCount > 0 && publishedCount === 0) {
    return '队列有选题但还没发布，/post 审一下或 /idea 补充新方向';
  }

  // 4. Check days since last publish
  const lastPublished = items
    .filter(i => i.status === 'published' && i.published_at)
    .sort((a, b) => new Date(b.published_at!).getTime() - new Date(a.published_at!).getTime())[0];
  if (lastPublished?.published_at) {
    const daysSince = Math.floor((now().getTime() - new Date(lastPublished.published_at).getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince >= 3) {
      return `已经 ${daysSince} 天没更新了，/idea 出新选题或 /post 审核积压`;
    }
  }

  // 5. Consecutive discards — direction shift needed
  const recentByUpdate = [...items]
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  let consecutiveDiscards = 0;
  for (const item of recentByUpdate) {
    if (item.status === 'discarded') consecutiveDiscards++;
    else break;
  }
  if (consecutiveDiscards >= 2) {
    return `最近 ${consecutiveDiscards} 个选题都被否了，试试 /idea 换个方向`;
  }

  // 6. Default: gentle nudge
  if (pendingCount > 0) {
    return `/post 审核待定选题，或 /idea 探索新方向`;
  }

  return '/brief 刷新今日简报，保持内容节奏';
}

// ─── Command: /candidates ─────────────────────────────────────────────────────

/** Generate a profile/search link based on account name and platform identifier. */
function buildProfileLink(name: string, platform: string, profileUrl?: string): string | null {
  // If we have a direct profile URL from discovery, use it
  if (profileUrl) return profileUrl;
  // Fallback: generate search URL by platform
  const encoded = encodeURIComponent(name);
  const p = platform.toLowerCase();
  if (p.includes('xhs') || p.includes('小红书')) {
    return `https://www.xiaohongshu.com/search_result?keyword=${encoded}`;
  }
  if (p.includes('bilibili') || p.includes('b站')) {
    return `https://search.bilibili.com/upuser?keyword=${encoded}`;
  }
  if (p.includes('douyin') || p.includes('抖音')) {
    return `https://www.douyin.com/search/${encoded}`;
  }
  if (p.includes('weibo') || p.includes('微博')) {
    return `https://s.weibo.com/user?q=${encoded}`;
  }
  return null;
}

async function cmdCandidates(topNStr?: string): Promise<string> {
  loadSkillEnvVars('alive');
  const persona = await loadPersona();
  if (!persona.ops?.enabled) return '⚠️ ops 未启用';

  const identityKeys = getIdentityKeys(persona);

  const store = loadCandidateAccounts();
  const showAll = topNStr === 'all';
  const topN = parseInt(topNStr ?? '5', 10) || 5;
  if (topN < 1) {
    return '⚠️ 请输入有效数量（正整数）或 all';
  }
  const ranked = rankCandidates(store, identityKeys, 'pending');

  if (ranked.length === 0) {
    // Diagnostic: help the operator understand why no candidates exist
    const diagLines = ['🔍 暂无待确认的候选对标账号', '', '可能原因：'];
    const { loadDiscoveryPool } = await import('./discovery-engine');
    const pool = loadDiscoveryPool();
    if (pool.items.length === 0) {
      diagLines.push('1. discovery-pool 为空 — 尚未有高互动内容被发现');
      diagLines.push('   → 等待 content-browse 自动执行，或手动运行 /brief 触发内容浏览');
    } else {
      const noAuthorCount = pool.items.filter(i => !i.author || i.author === '').length;
      diagLines.push(`1. discovery-pool 有 ${pool.items.length} 条内容，但 ${noAuthorCount} 条缺少作者信息`);
      if (noAuthorCount > 0) {
        diagLines.push('   → LLM 摘要可能未提取 author 字段，下次 content-browse 时会自动补充');
      }
    }
    diagLines.push('2. 候选发现需要同一作者至少出现 2 次才会被推荐');
    diagLines.push('   → 多运行几次 /brief 或等待 heartbeat 自动浏览，积累更多数据');
    return diagLines.join('\n');
  }

  const display = showAll ? ranked : ranked.slice(0, topN);
  const MEDALS = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
  const header = showAll ? `🔍 候选对标全览（共 ${display.length} 个）` : `🔍 候选对标排行（Top ${display.length}）`;
  const lines = [header, ''];

  display.forEach((c, idx) => {
    const medal = MEDALS[idx] ?? `${idx + 1}.`;
    const { track_overlap, burst_intensity, frequency, account_freshness, data_stability, composite } = c.score_breakdown;
    lines.push(`${medal} @${c.name}（${c.platform}）  综合分 ${composite.toFixed(2)}`);
    lines.push(`   赛道 ${track_overlap.toFixed(2)} · 爆发 ${burst_intensity.toFixed(2)} · 频率 ${frequency.toFixed(2)} · 新鲜度 ${account_freshness.toFixed(2)} · 稳定性 ${data_stability.toFixed(2)}`);
    if (c.topics.length > 0) {
      lines.push(`   话题: ${c.topics.slice(0, 3).join('、')}  |  峰值互动 ${c.peak_engagement}  |  出现 ${c.appearance_count} 次`);
    }
    const link = buildProfileLink(c.name, c.platform, c.profile_url);
    if (link) lines.push(`   🔗 ${link}`);
    lines.push(`   → /competitor add @${c.name} ${c.platform}`);
    lines.push('');
  });

  lines.push('/competitor add @名称 平台 将候选加入竞品库');
  return lines.join('\n');
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
    '/review [子命令] — 批量快速审核（默认=LLM判定，approve-all=一键通过，discard-low=弃置低分）',
    '/analyze <URL>  — 爆款帖子拆解分析',
    '/advice         — 人设契合度建议',
    '/status         — 查看队列状态',
    '/candidates [N] — 查看 Top-N 候选对标（默认5，all=全部）',
    '/help           — 显示本帮助',
  ].join('\n');
}

// ─── CLI Dispatcher ───────────────────────────────────────────────────────────

/**
 * Dispatch a resolved command + args to the appropriate handler.
 * Used both by main() CLI entry and by the NLU re-dispatch path.
 */
async function dispatchCommand(command: string, args: string[]): Promise<string> {
  switch (command.toLowerCase()) {
    case 'brief':
      return await cmdBrief();
    case 'trends':
      return await cmdTrends();
    case 'idea':
      return await cmdIdea(args.join(' ') || undefined);
    case 'post':
      return await cmdPost(args[0]);
    case 'review':
      return await cmdReview(args[0]);
    case 'analyze':
      return await cmdAnalyze(args[0]);
    case 'advice':
      return await cmdAdvice();
    case 'status':
      return await cmdStatus();
    case 'candidates':
      return await cmdCandidates(args[0]);
    case 'health': {
      const report = await runHealthCheck();
      return formatHealthReport(report);
    }
    case 'help':
      return cmdHelp();
    default:
      return `⚠️ 未知命令: ${command}\n\n${cmdHelp()}`;
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command) {
    printAndExit(cmdHelp());
  }

  let result: string;
  try {
    switch (command.toLowerCase()) {
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
      default:
        // All standard commands go through dispatchCommand
        result = await dispatchCommand(command, args);
    }
  } catch (err) {
    const msg = (err as Error).message ?? '';
    // 只暴露已知的、用户可理解的错误信息
    if (/未启用|未登录|未找到|无效编号|暂无|未知命令|请提供/.test(msg)) {
      result = `⚠️ ${msg}`;
    } else if (/timed? ?out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|fetch failed|网络|network/i.test(msg)) {
      // 超时/网络类错误：给出可操作提示
      console.error(`[ops-command-handler] Timeout/Network error:`, err);
      result = '⚠️ 请求超时或网络异常，请稍后重试';
    } else {
      // 其他内部错误只写日志，不暴露技术细节给用户
      console.error(`[ops-command-handler] Internal error:`, err);
      result = '⚠️ 命令执行遇到问题，请稍后重试';
    }
  }

  printAndExit(result);
}

main().catch(err => {
  console.error(`[ops-command-handler] Fatal error:`, err);
  // 不暴露内部细节，只输出用户友好提示到 stdout
  process.stdout.write('⚠️ 命令执行遇到问题，请稍后重试');
  process.exit(1);
});
