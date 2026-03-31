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
import { analyzeTrends } from '../ops/trend-analyzer';
import { trackCompetitors } from '../ops/competitor-tracker';
import { generateTopics } from '../ops/topic-generator';
import { sendDailyBrief } from '../ops/brief-generator';
import { loadQueue, cleanupOldItems } from '../ops/review-queue';

async function main(): Promise<void> {
  const persona = await loadPersona();
  const ops = persona.ops;

  if (!ops?.enabled) {
    console.log(`[${wallNow().toISOString()}] ops-brief: ops.enabled is false for ${persona.meta.id}, skipping`);
    return;
  }

  const llm = createRealLLMClient('ops-brief');
  const identities = (persona.personality?.core_traits ?? []).join('、');
  const imageStyle = (persona as { image_style?: { base_prompt?: string } }).image_style?.base_prompt ?? '';

  console.log(`[${wallNow().toISOString()}] ops-brief: starting for ${persona.meta.id}`);

  await cleanupOldItems();

  const [trendsResult, competitorsResult] = await Promise.allSettled([
    analyzeTrends(ops, identities, llm),
    Promise.resolve(trackCompetitors(ops)),
  ]);

  const trends = trendsResult.status === 'fulfilled' ? trendsResult.value : [];
  const competitors = competitorsResult.status === 'fulfilled' ? competitorsResult.value : [];

  await generateTopics(trends, ops, persona.meta.name, imageStyle, llm);

  const queue = await loadQueue();
  const pending = queue.items.filter(i => i.status === 'pending');
  const sent = await sendDailyBrief(trends, competitors, pending);

  console.log(`[${wallNow().toISOString()}] ops-brief: brief sent=${sent}, ${pending.length} pending topics`);
}

main().catch(err => {
  console.error(`[${wallNow().toISOString()}] ops-brief ERROR:`, err);
  process.exit(1);
});
