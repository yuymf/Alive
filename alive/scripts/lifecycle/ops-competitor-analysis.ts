#!/usr/bin/env node
/**
 * ops-competitor-analysis.ts
 * Cron entry: 3-layer competitor analysis pipeline.
 *
 * Layer 1: Fetch competitor posts (daily)
 * Layer 2: Per-account LLM analysis (daily)
 * Layer 3: Cross-account positioning analysis (Monday only)
 *
 * Framework-generic: exits early if persona.ops.enabled is false/absent.
 * Registered as: alive:ops-competitor-analysis → ops-competitor-analysis.js
 */

import { createRealLLMClient } from '../utils/llm-client';
import { loadPersona } from '../persona/persona-loader';
import { wallNow, getLocalWeekday } from '../utils/time-utils';
import { resolveCompetitorAccounts } from '../ops/competitor-tracker';
import { fetchCompetitorPosts, loadCompetitorPosts } from '../ops/competitor-fetcher';
import { analyzeCompetitors, saveCompetitorAnalysis } from '../ops/competitor-analyzer';
import { syncCompetitorInsights } from '../ops/competitor-memory';
import { buildCompetitorKeyFromProfile } from '../ops/competitor-keys';
import { analyzePositioning, savePositioningReport } from '../ops/positioning-analyzer';
import { sendBriefToSession } from '../ops/brief-generator';
import { loadQueue } from '../ops/review-queue';
import { loadSkillEnvVars, setPersonaName } from '../utils/file-utils';
import { TaskDeadline } from '../utils/task-deadline';
import { beginOpsRun, finishOpsRun, type OpsRunStatusKind } from '../utils/run-status';
import type { PositioningReport } from '../utils/types';



// ─── Weekly report card formatter ────────────────────────────────────────────

/**
 * Format a PositioningReport as a Chinese text card for WeChat Work.
 */
export function formatWeeklyReportCard(report: PositioningReport): string {
  const lines: string[] = [];

  // Header
  lines.push(`📊 周度竞品定位分析  ${report.report_period}`);
  lines.push('');

  // Competitor matrix
  lines.push('━━ 竞品定位矩阵 ━━');
  for (const entry of report.competitor_matrix) {
    const engStr = entry.avg_engagement >= 1000
      ? `avg ${(entry.avg_engagement / 1000).toFixed(1)}k互动`
      : `avg ${entry.avg_engagement}互动`;
    lines.push(`@${entry.account_name}（${entry.platform}）${engStr}`);
    lines.push(`  定位: ${entry.content_focus}`);
    if (entry.strengths.length > 0) {
      lines.push(`  优势: ${entry.strengths.join('、')}`);
    }
    if (entry.weaknesses.length > 0) {
      lines.push(`  弱势: ${entry.weaknesses.join('、')}`);
    }
  }
  lines.push('');

  // Gap analysis
  lines.push('━━ 定位空白分析 ━━');
  if (report.gap_analysis.underserved_niches.length > 0) {
    lines.push(`🟢 蓝海机会: ${report.gap_analysis.underserved_niches.join('、')}`);
  }
  if (report.gap_analysis.oversaturated_areas.length > 0) {
    lines.push(`🔴 红海警告: ${report.gap_analysis.oversaturated_areas.join('、')}`);
  }
  if (report.gap_analysis.miss_v_advantages.length > 0) {
    lines.push(`⭐ 独特优势: ${report.gap_analysis.miss_v_advantages.join('、')}`);
  }
  lines.push('');

  // Recommendations
  lines.push('━━ 差异化建议 ━━');
  for (const rec of report.recommendations) {
    const icon = rec.priority === 'high' ? '🔥' : '💡';
    const priorityLabel = rec.priority === 'high' ? '(high priority)' : '(medium priority)';
    lines.push(`${icon} [${rec.identity_mode}] ${rec.recommendation} ${priorityLabel}`);
    if (rec.rationale) {
      lines.push(`   原因: ${rec.rationale}`);
    }
  }
  lines.push('');

  // Weekly direction
  lines.push('━━ 本周方向 ━━');
  if (report.weekly_direction.focus_identities.length > 0) {
    lines.push(`重点身份: ${report.weekly_direction.focus_identities.join('、')}`);
  }
  if (report.weekly_direction.avoid_topics.length > 0) {
    lines.push(`避开: ${report.weekly_direction.avoid_topics.join('、')}`);
  }
  if (report.weekly_direction.suggested_templates.length > 0) {
    lines.push(`推荐模板: ${report.weekly_direction.suggested_templates.join('、')}`);
  }

  return lines.join('\n');
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

export async function runCompetitorAnalysisPipeline(isMondayOverride?: boolean): Promise<void> {
  loadSkillEnvVars('alive');
  process.env.ALIVE_CRON = process.env.ALIVE_CRON ?? '1';

  const personaArgIdx = process.argv.indexOf('--persona');

  if (personaArgIdx !== -1 && process.argv[personaArgIdx + 1]) {
    setPersonaName(process.argv[personaArgIdx + 1]);
  }

  const run = beginOpsRun('ops-competitor-analysis');
  const warnings: string[] = [];
  let finalStatus: OpsRunStatusKind = 'success';

  // 1. Load persona

  const persona = await loadPersona();
  const ops = persona.ops;


  // 2. Exit early if ops is disabled
  if (!ops?.enabled) {
    console.log(
      `[${wallNow().toISOString()}] ops-competitor-analysis: ops.enabled is false for ${persona.meta.id}, skipping`,
    );
    finishOpsRun(run, 'skipped', { warnings: ['ops.enabled is false'] });
    return;
  }

  const deadline = TaskDeadline.fromEnv('ops-competitor-analysis', 'ALIVE_OPS_COMPETITOR_BUDGET_MS', 480_000);
  const llm = createRealLLMClient('ops-competitor-analysis');

  const profiles = ops.competitors ?? [];

  // 3. Resolve competitor accounts
  const accounts = resolveCompetitorAccounts(ops);

  // Resolve bilibili accounts from competitors[] profiles
  const bilibiliAccounts = (ops.competitors ?? [])
    .filter(c => c.platform === 'bilibili')
    .map(c => ({
      mid: c.url?.match(/space\.bilibili\.com\/(\d+)/)?.[1] ?? '',
      name: c.name,
    }))
    .filter(e => e.mid !== '');

  const accountsWithBilibili = { ...accounts, bilibili: bilibiliAccounts };

  console.log(
    `[${wallNow().toISOString()}] ops-competitor-analysis: starting for ${persona.meta.id} ` +
    `(${accounts.xhs.length} xhs-search, ${accounts.xhsUserIds.size} xhs-precise, ${accounts.douyin.length} douyin, ${bilibiliAccounts.length} bilibili accounts)`,
  );

  // ── Layer 1: Fetch posts ──────────────────────────────────────────────────
  const xhsOnly = process.argv.includes('--xhs-only');
  const fetchPlatforms: Array<'bilibili' | 'douyin' | 'xhs'> = xhsOnly ? ['xhs'] : ['bilibili', 'douyin'];
  if (!xhsOnly && (process.env.ALIVE_OPS_COMPETITOR_ENABLE_XHS === '1' || process.argv.includes('--include-xhs'))) {
    fetchPlatforms.push('xhs');
  } else if (!xhsOnly && (accounts.xhs.length > 0 || accounts.xhsUserIds.size > 0)) {
    warnings.push('XHS realtime fetch disabled in main competitor cron; use dedicated xhs fetch window');
  }

  const fetchResult = await fetchCompetitorPosts(accountsWithBilibili, profiles, '', {

    platforms: fetchPlatforms,
    deadline,
    skipXhsFallback: true,
  });
  if (fetchResult.failed.length > 0) finalStatus = 'degraded_success';
  console.log(
    `[${wallNow().toISOString()}] ops-competitor-analysis: Layer 1 done — ` +
    `${fetchResult.success.length} fetched/usable, ${fetchResult.failed.length} failed/skipped`,
  );

  if (xhsOnly) {
    finishOpsRun(run, finalStatus, {
      warnings,
      outputs: { fetched: fetchResult.success.length, failed: fetchResult.failed.length, platforms: fetchPlatforms },
    });
    return;
  }

  if (!deadline.shouldStart(180_000, 'Layer 2 competitor analysis')) {

    finishOpsRun(run, 'skipped_due_to_budget', {
      warnings,
      outputs: { fetched: fetchResult.success.length, failed: fetchResult.failed.length },
    });
    return;
  }

  // ── Layer 2: Per-account analysis ─────────────────────────────────────────
  const postsStore = loadCompetitorPosts();

  const analyzedStore = await analyzeCompetitors(postsStore, profiles, llm);
  const configuredSupported = profiles
    .filter(profile => profile.platform === 'xhs' || profile.platform === 'douyin' || profile.platform === 'bilibili')
    .map(profile => buildCompetitorKeyFromProfile(profile));
  const fetchedPosts = configuredSupported.filter(key => (postsStore.accounts[key] ?? []).length > 0);
  const analyzedKeys = Object.keys(analyzedStore.analyses);
  const coverage = {
    configured_supported: configuredSupported,
    fetched_posts: fetchedPosts,
    missing_posts: configuredSupported.filter(key => !fetchedPosts.includes(key)),
    analyzed: analyzedKeys,
    failed_analysis: [...(analyzedStore.failed_analysis ?? [])],
    insufficient_data: [...analyzedStore.insufficient_data],
  };
  const analysisStore = {
    ...analyzedStore,
    failed_analysis: coverage.failed_analysis,
    coverage,
  };
  saveCompetitorAnalysis(analysisStore);

  const analyzedCount = analyzedKeys.length;
  console.log(
    `[${wallNow().toISOString()}] ops-competitor-analysis: Layer 2 done — ` +
    `${analyzedCount} accounts analyzed, ${analysisStore.insufficient_data.length} insufficient data, ` +
    `${coverage.missing_posts.length} missing posts, ${coverage.failed_analysis.length} failed analysis`,
  );
  if (coverage.missing_posts.length > 0) {
    console.log(`[${wallNow().toISOString()}] ops-competitor-analysis: missing posts → ${coverage.missing_posts.join(', ')}`);
  }
  if (coverage.failed_analysis.length > 0) {
    console.log(`[${wallNow().toISOString()}] ops-competitor-analysis: failed analysis → ${coverage.failed_analysis.join(', ')}`);
  }

  // ── Layer 2.5: Sync insights to MD knowledge surface ─────────────────────
  const syncResult = syncCompetitorInsights(profiles, analysisStore);
  console.log(
    `[${wallNow().toISOString()}] ops-competitor-analysis: Layer 2.5 done — ` +
    `${syncResult.updated} profiles updated, ` +
    `${syncResult.takeaways} takeaways, ${syncResult.avoids} avoids, ${syncResult.observations} observations synced`,
  );

  // ── Layer 3: Positioning (Monday only) ────────────────────────────────────
  const isMonday = isMondayOverride ?? (getLocalWeekday() === 1);
  if (!isMonday || analyzedCount === 0) {
    console.log(
      `[${wallNow().toISOString()}] ops-competitor-analysis: Layer 3 skipped ` +
      `(isMonday=${isMonday}, analyzedCount=${analyzedCount})`,
    );
    finishOpsRun(run, finalStatus, {
      warnings,
      outputs: {
        fetched: fetchResult.success.length,
        failed: fetchResult.failed.length,
        analyzed: analyzedCount,
        missing_posts: coverage.missing_posts.length,
        failed_analysis: coverage.failed_analysis.length,
      },
    });
    return;
  }


  // Load published items from review queue for context
  const queue = await loadQueue();
  const publishedItems = queue.items.filter(item => item.status === 'published');

  const report = await analyzePositioning(analysisStore, persona, publishedItems, llm);
  if (!report) {
    console.log(
      `[${wallNow().toISOString()}] ops-competitor-analysis: Layer 3 returned no report, skipping`,
    );
    finishOpsRun(run, finalStatus, {
      warnings,
      outputs: {
        fetched: fetchResult.success.length,
        failed: fetchResult.failed.length,
        analyzed: analyzedCount,
        positioning_report: false,
      },
    });
    return;
  }


  savePositioningReport(report);

  // Push weekly report card to WeChat Work
  const card = formatWeeklyReportCard(report);
  const sent = sendBriefToSession(card);
  console.log(
    `[${wallNow().toISOString()}] ops-competitor-analysis: Layer 3 done — ` +
    `positioning report saved, stdout delivery ${sent ? 'succeeded' : 'failed'}`,
  );
  finishOpsRun(run, finalStatus, {
    warnings,
    outputs: {
      fetched: fetchResult.success.length,
      failed: fetchResult.failed.length,
      analyzed: analyzedCount,
      positioning_report: true,
      delivered: sent,
    },
  });
}


// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  runCompetitorAnalysisPipeline().catch(err => {
    console.error(`[${wallNow().toISOString()}] ops-competitor-analysis ERROR:`, err);
    process.exit(1);
  });
}
