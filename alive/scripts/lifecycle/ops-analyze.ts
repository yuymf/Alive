#!/usr/bin/env node
/**
 * ops-analyze.ts
 * Cron entry: Analyze published content at T+24h.
 * Schedule: Every 4 hours, offset +5min from ops-performance.
 * Framework-generic: exits early if persona.ops.enabled is false/absent.
 * Gate: persona.ops.enabled must be true.
 */

import { createRealLLMClient } from '../utils/llm-client';
import { loadPersona } from '../persona/persona-loader';
import { wallNow } from '../utils/time-utils';
import { analyzePublishedPosts } from '../ops/post-analyzer';

const DEFAULT_DELAY_HOURS = 24;
const DEFAULT_BASELINE_WINDOW_DAYS = 7;

async function main(): Promise<void> {
  const persona = await loadPersona();
  const ops = persona.ops;

  if (!ops?.enabled) {
    console.log(`[${wallNow().toISOString()}] ops-analyze: ops.enabled is false for ${persona.meta.id}, skipping`);
    return;
  }

  if (!ops.strategy_enabled) {
    console.log(`[${wallNow().toISOString()}] ops-analyze: strategy_enabled is false for ${persona.meta.id}, skipping`);
    return;
  }

  const llm = createRealLLMClient('ops-analyze');
  const personaSummary = `${persona.meta.name}：${persona.personality.mbti}，${persona.meta.tagline}`;
  const delayHours = ops.analysis_delay_hours ?? DEFAULT_DELAY_HOURS;
  const baselineWindow = ops.baseline_window_days ?? DEFAULT_BASELINE_WINDOW_DAYS;

  console.log(`[${wallNow().toISOString()}] ops-analyze: starting for ${persona.meta.id}`);

  const count = await analyzePublishedPosts(llm, personaSummary, delayHours, baselineWindow);

  console.log(`[${wallNow().toISOString()}] ops-analyze: analyzed ${count} posts`);
}

main().catch(err => {
  console.error(`[${wallNow().toISOString()}] ops-analyze ERROR:`, err);
  process.exit(1);
});
