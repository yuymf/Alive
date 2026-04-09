#!/usr/bin/env node
/**
 * ops-tags.ts
 * Cron entry: twice-daily Tag Engine run (10:00 + 20:00).
 * Exits early if persona.ops.enabled is false/absent.
 * Registered as: alive:ops-tags → ops-tags.js
 */

import { loadSkillEnvVars, setPersonaName } from '../utils/file-utils';
import { loadPersona } from '../persona/persona-loader';
import { wallNow } from '../utils/time-utils';
import { runTagEngine } from '../ops/tag-engine';

async function main(): Promise<void> {
  // Load environment variables from openclaw.json (needed for isolated cron sessions)
  loadSkillEnvVars('alive');

  // If --persona <slug> was passed (e.g. from cron), override persona context
  const personaArgIdx = process.argv.indexOf('--persona');
  if (personaArgIdx !== -1 && process.argv[personaArgIdx + 1]) {
    setPersonaName(process.argv[personaArgIdx + 1]);
  }

  const persona = await loadPersona();
  const ops = persona.ops;

  if (!ops?.enabled) {
    console.log(`[${wallNow().toISOString()}] ops-tags: ops.enabled is false for ${persona.meta.id}, skipping`);
    return;
  }

  console.log(`[${wallNow().toISOString()}] ops-tags: starting for ${persona.meta.id}`);

  const stats = await runTagEngine(ops);

  console.log(`[${wallNow().toISOString()}] ops-tags: ${stats.mode} complete`);
  console.log(`\n🏷️  Tag词表更新`);
  console.log(`- 模式: ${stats.mode === 'cold_start' ? '冷启动' : '日常维护'}`);
  console.log(`- 活跃词: ${stats.activeCount} 个`);
  console.log(`- 沉睡词: ${stats.dormantCount} 个`);
}

main().catch(err => {
  console.error(`[${wallNow().toISOString()}] ops-tags ERROR:`, err);
  process.exit(1);
});
