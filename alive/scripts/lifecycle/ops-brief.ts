#!/usr/bin/env node
/**
 * ops-brief.ts
 * Cron entry: daily brief generation + WeChat Work push.
 * Framework-generic: exits early if persona.ops.enabled is false/absent.
 * Registered as: alive:ops-brief → ops-brief.js (runs at ops.brief_time - 10min)
 */

import { createRealLLMClient } from '../utils/llm-client';
import { loadPersona } from '../persona/persona-loader';
import { wallNow } from '../utils/time-utils';
import { loadSkillEnvVars, setPersonaName } from '../utils/file-utils';
import { analyzeTrends, buildPersonaIdentities } from '../ops/trend-analyzer';
import { trackCompetitors } from '../ops/competitor-tracker';
import { generateTopics } from '../ops/topic-generator';
import { sendDailyBrief } from '../ops/brief-generator';
import { loadQueue, cleanupOldItems, PENDING_EXPIRE_HOURS, hoursSinceCreated } from '../ops/review-queue';
import { generatePersonaReport } from '../ops/persona-advisor';
import { getIdentityKeys } from '../utils/types';

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
    console.log(`[${wallNow().toISOString()}] ops-brief: ops.enabled is false for ${persona.meta.id}, skipping`);
    return;
  }

  const llm = createRealLLMClient('ops-brief');
  const identities = buildPersonaIdentities(persona);
  const identityKeys = getIdentityKeys(persona);
  const imageStyle = (persona as { image_style?: { base_prompt?: string } }).image_style?.base_prompt ?? '';

  console.log(`[${wallNow().toISOString()}] ops-brief: starting for ${persona.meta.id}`);

  await cleanupOldItems();

  const [trendsResult, competitorsResult] = await Promise.allSettled([
    analyzeTrends(ops, identities, llm),
    Promise.resolve(trackCompetitors(ops)),
  ]);

  const trends = trendsResult.status === 'fulfilled' ? trendsResult.value : [];
  const competitors = competitorsResult.status === 'fulfilled' ? competitorsResult.value : [];

  console.log(`[${wallNow().toISOString()}] ops-brief: trends=${trends.length}, calling generateTopics...`);
  await generateTopics(trends, ops, persona.meta.name, imageStyle, llm);

  const queue = await loadQueue();
  const pending = queue.items.filter(i => i.status === 'pending');
  // 只将 48h 内活跃的 pending items 传入 LLM 上下文，expired 内容不参与
  const activePending = pending.filter(i => hoursSinceCreated(i) < PENDING_EXPIRE_HOURS);
  console.log(`[${wallNow().toISOString()}] ops-brief: after generateTopics, pending=${pending.length} items (active=${activePending.length})`);

  // Generate persona alignment report for brief enrichment
  let personaReport = null;
  try {
    personaReport = await generatePersonaReport(persona, trends, competitors, llm);
  } catch (err) {
    console.error(`[${wallNow().toISOString()}] ops-brief: persona report failed:`, (err as Error).message);
  }

  const deliveryMode = ops.automation?.brief_delivery ?? 'wecom-target';

  const sent = await sendDailyBrief(trends, competitors, activePending, {
    personaReport,
    fullQueueItems: activePending,
    identityKeys,
  }, deliveryMode);

  console.log(`[${wallNow().toISOString()}] ops-brief: brief sent=${sent} (mode=${deliveryMode}), ${activePending.length} active pending topics`);
}

main().catch(err => {
  console.error(`[${wallNow().toISOString()}] ops-brief ERROR:`, err);
  process.exit(1);
});
