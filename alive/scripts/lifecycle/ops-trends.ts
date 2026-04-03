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
import { loadSkillEnvVars, setPersonaName } from '../utils/file-utils';
import { analyzeTrends, buildPersonaIdentities } from '../ops/trend-analyzer';
import { trackCompetitors } from '../ops/competitor-tracker';
import { analyzeNewHits, cleanupOldBreakdowns, trimObservationNotes } from '../ops/competitor-memory';
import { PATHS, readJSON } from '../utils/file-utils';
import { CompetitorLog } from '../utils/types';

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
