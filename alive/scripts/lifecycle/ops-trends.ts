#!/usr/bin/env node
/**
 * ops-trends.ts
 * Cron entry: hourly trend monitoring + competitor tracking.
 * Framework-generic: exits early if persona.ops.enabled is false/absent.
 * Registered as: alive:ops-trends → ops-trends.js
 */

import { createRealLLMClient } from '../utils/llm-client';
import { loadPersona } from '../persona/persona-loader';
import { wallNow } from '../utils/time-utils';
import { loadSkillEnvVars, setPersonaName, PATHS } from '../utils/file-utils';
import { analyzeTrends, buildPersonaIdentities } from '../ops/trend-analyzer';
import { trackCompetitors } from '../ops/competitor-tracker';
import { analyzeNewHits, cleanupOldBreakdowns, trimObservationNotes } from '../ops/competitor-memory';
import { readJSON } from '../utils/file-utils';
import { CompetitorLog } from '../utils/types';
import { detectViral, TrendLikeItem } from '../ops/viral-detector';
import { addManyToQueue, dequeueItems, upsertEntry, checkFormulaPromotion } from '../ops/viral-kb-store';
import { dissectBatch } from '../ops/content-dissector';
import { sendToWechatWork } from '../ops/brief-generator';
import * as path from 'path';

async function main(): Promise<void> {
  // Load environment variables from openclaw.json (needed for isolated cron sessions)
  loadSkillEnvVars('alive');

  // If --persona <slug> was passed (e.g. from cron), override the persona context
  // so this job operates on the correct persona's memory directory.
  const personaArgIdx = process.argv.indexOf('--persona');
  if (personaArgIdx !== -1 && process.argv[personaArgIdx + 1]) {
    setPersonaName(process.argv[personaArgIdx + 1]);
  }

  const persona = await loadPersona();
  const ops = persona.ops;

  if (!ops?.enabled) {
    console.log(`[${wallNow().toISOString()}] ops-trends: ops.enabled is false for ${persona.meta.id}, skipping`);
    return;
  }

  const llm = createRealLLMClient('ops-trends');
  const identities = buildPersonaIdentities(persona);

  console.log(`[${wallNow().toISOString()}] ops-trends: starting for ${persona.meta.id}`);

  // Periodic cleanup of old breakdowns and observation notes
  cleanupOldBreakdowns();
  trimObservationNotes();

  const [trendsResult, competitorsResult] = await Promise.allSettled([
    analyzeTrends(ops, identities, llm),
    Promise.resolve(trackCompetitors(ops)),
  ]);

  const trendCount = trendsResult.status === 'fulfilled' ? trendsResult.value.length : 0;
  const competitorCount = competitorsResult.status === 'fulfilled' ? competitorsResult.value.length : 0;

  // Auto-analyze high-engagement competitor posts
  if (competitorsResult.status === 'fulfilled' && ops) {
    const competitorLog = readJSON<CompetitorLog>(PATHS.competitorLog, { entries: [], last_updated: '' });
    await analyzeNewHits(competitorsResult.value, ops, competitorLog.entries, llm);
  }

  console.log(`[${wallNow().toISOString()}] ops-trends: ${trendCount} trends, ${competitorCount} competitors tracked`);

  // === 爆款知识库处理 ===
  // Derive the memory base path from any known PATHS property
  const basePath = path.dirname(PATHS.emotionState);

  try {
    const threshold = ops.viral_threshold ?? 5000;
    const batchSize = ops.kb_dissect_batch ?? 3;

    // 1. 构建可供检测的 TrendLikeItem 列表（仅竞品真实帖子，跳过趋势关键词）
    // Trending keywords are 2-5 word labels, not real posts — dissecting them produces hollow analysis.
    // Only competitor posts (source_type: 'competitor') carry real title/description/engagement data.
    // The platform OR filter already restricts to 'xhs' | 'douyin' — no secondary Set filter needed.
    const allItems: TrendLikeItem[] = competitorsResult.status === 'fulfilled'
      ? competitorsResult.value
          .filter(c => (c.platform === 'xhs' || c.platform === 'douyin') && c.latest_post !== null)
          .map(c => ({
            // Use raw account:time as source_id — buildEntryId in viral-kb-store already
            // prepends platform, so we must NOT duplicate it here.
            source_id: `${c.account}:${c.latest_post!.time}`,
            platform: c.platform as 'xhs' | 'douyin',
            title: c.latest_post!.topic,
            description: c.latest_post!.summary,
            likes: c.latest_post!.engagement,
            comments: 0,
            shares: 0,
            source_type: 'competitor' as const,
          }))
      : [];

    // 2. 检测爆款候选
    const candidates = detectViral(allItems, basePath, threshold);
    if (candidates.length > 0) {
      addManyToQueue(basePath, candidates);
      console.log(`[${wallNow().toISOString()}] [viral-kb] ${candidates.length} candidates queued`);
    }

    // 3. 批量拆解
    const llmViral = createRealLLMClient('viral-dissector');
    const toProcess = dequeueItems(basePath, batchSize);
    if (toProcess.length > 0) {
      const personaId = persona.meta.id ?? 'default';
      const entries = await dissectBatch(toProcess, llmViral, personaId);
      for (const entry of entries) {
        upsertEntry(basePath, entry);
        const result = checkFormulaPromotion(basePath, entry, PATHS.personaConfig);
        if (result.promoted && result.formula) {
          console.log(`[${wallNow().toISOString()}] [viral-kb] formula promoted: ${result.formula.content_type} + ${result.formula.hook_type} (${result.formula.platform})`);
          // Push WeChat Work notification on formula promotion
          try {
            const f = result.formula;
            const msg = [
              '🔮 新通用公式升级！',
              `  类型: ${f.content_type} + ${f.hook_type}`,
              `  平台: ${f.platform}`,
              `  累计出现: ${f.occurrence_count} 次`,
              `  公式: ${f.formula_summary}`,
            ].join('\n');
            sendToWechatWork(msg);
          } catch {
            // notification failure is non-fatal
          }
        }
      }
      console.log(`[${wallNow().toISOString()}] [viral-kb] ${entries.length} entries dissected`);
    }
  } catch (err) {
    console.error(`[${wallNow().toISOString()}] [viral-kb] error:`, err);
    // Non-fatal: viral KB errors should not fail the main ops-trends job
  }

  // === 摘要输出（cron deliver 会投递 stdout） ===
  console.log(`\n📊 运营趋势速报`);
  console.log(`- 热点趋势: ${trendCount} 条`);
  console.log(`- 竞品动态: ${competitorCount} 个账号有更新`);
  if (trendsResult.status === 'fulfilled' && trendsResult.value.length > 0) {
    const top = trendsResult.value.slice(0, 3);
    top.forEach((t, i) => console.log(`  ${i + 1}. ${t.keyword}（热度: ${t.velocity_score}）`));
  }
  if (competitorsResult.status === 'fulfilled' && competitorsResult.value.length > 0) {
    const topComp = competitorsResult.value.slice(0, 3);
    topComp.forEach((c) => console.log(`  · ${c.account}: ${c.latest_post?.topic ?? '无最新帖子'}`));
  }
}

main().catch(err => {
  console.error(`[${wallNow().toISOString()}] ops-trends ERROR:`, err);
  process.exit(1);
});
