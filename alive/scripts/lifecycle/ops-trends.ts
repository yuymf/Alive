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
import { analyzeTrends } from '../ops/trend-analyzer';
import { trackCompetitors } from '../ops/competitor-tracker';

async function main(): Promise<void> {
  const persona = await loadPersona();
  const ops = persona.ops;

  if (!ops?.enabled) {
    console.log(`[${wallNow().toISOString()}] ops-trends: ops.enabled is false for ${persona.meta.id}, skipping`);
    return;
  }

  const llm = createRealLLMClient('ops-trends');
  const identities = (persona.personality?.core_traits ?? []).join('、');

  console.log(`[${wallNow().toISOString()}] ops-trends: starting for ${persona.meta.id}`);

  const [trendsResult, competitorsResult] = await Promise.allSettled([
    analyzeTrends(ops, identities, llm),
    Promise.resolve(trackCompetitors(ops)),
  ]);

  const trendCount = trendsResult.status === 'fulfilled' ? trendsResult.value.length : 0;
  const competitorCount = competitorsResult.status === 'fulfilled' ? competitorsResult.value.length : 0;

  console.log(`[${wallNow().toISOString()}] ops-trends: ${trendCount} trends, ${competitorCount} competitors tracked`);
}

main().catch(err => {
  console.error(`[${wallNow().toISOString()}] ops-trends ERROR:`, err);
  process.exit(1);
});
