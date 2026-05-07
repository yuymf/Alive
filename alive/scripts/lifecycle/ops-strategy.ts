#!/usr/bin/env node
/**
 * ops-strategy.ts
 * Cron entry: Weekly strategy computation.
 * Schedule: Configurable via ops.strategy_day + ops.strategy_time (default: Monday 08:00).
 * Gate: persona.ops.enabled must be true.
 */

import { createRealLLMClient } from '../utils/llm-client';
import { loadPersona } from '../persona/persona-loader';
import { wallNow } from '../utils/time-utils';
import { loadSkillEnvVars, setPersonaName } from '../utils/file-utils';
import { computeStrategy, loadStrategy } from '../ops/strategy-engine';
import { sendBriefToSession } from '../ops/brief-generator';

async function main(): Promise<void> {
  loadSkillEnvVars('alive');

  const personaArgIdx = process.argv.indexOf('--persona');
  if (personaArgIdx !== -1 && process.argv[personaArgIdx + 1]) {
    setPersonaName(process.argv[personaArgIdx + 1]);
  }

  const persona = await loadPersona();
  const ops = persona.ops;

  if (!ops?.enabled) {
    console.log(`[${wallNow().toISOString()}] ops-strategy: ops.enabled is false for ${persona.meta.id}, skipping`);
    return;
  }

  if (!ops.strategy_enabled) {
    console.log(`[${wallNow().toISOString()}] ops-strategy: strategy_enabled is false for ${persona.meta.id}, skipping`);
    return;
  }

  const llm = createRealLLMClient('ops-strategy');
  const personaSummary = `${persona.meta.name}：${persona.personality.mbti}，${persona.meta.tagline}`;

  // Build target mix from ops.content_templates identity_modes
  const targetMix: Record<string, number> = {};
  const templates = persona.ops?.content_templates;
  if (templates && templates.length > 0) {
    const allModes = templates.map(t => t.identity_mode).filter(Boolean) as string[];
    const uniqueModes = [...new Set(allModes)];
    if (uniqueModes.length > 0) {
      const weight = Math.round(100 / uniqueModes.length);
      for (const mode of uniqueModes) {
        targetMix[mode] = weight;
      }
    }
  }

  console.log(`[${wallNow().toISOString()}] ops-strategy: starting for ${persona.meta.id}`);

  const success = await computeStrategy(llm, personaSummary, targetMix);

  if (success) {
    const strategy = loadStrategy();
    if (strategy) {
      const trendIcon = strategy.performance_summary.engagement_trend === 'rising'
        ? '📈上升'
        : strategy.performance_summary.engagement_trend === 'declining'
          ? '📉下降'
          : '➡️稳定';

      const summary = [
        `📊 本周内容策略已生成`,
        ``,
        `表现概览: ${strategy.performance_summary.total_posts}篇, 趋势${trendIcon}`,
        `最佳模板: ${strategy.performance_summary.best_performing_template}`,
        `人设健康: ${strategy.persona_health.overall_score}/10`,
        ``,
        `内容方向: ${strategy.next_week_recommendations.content_direction}`,
        ``,
        `⚠️ 请用 /alive ops confirm-strategy 确认后生效`,
      ].join('\n');
      sendBriefToSession(summary);
    }
  }

  console.log(`[${wallNow().toISOString()}] ops-strategy: success=${success}`);
}

main().catch(err => {
  console.error(`[${wallNow().toISOString()}] ops-strategy ERROR:`, err);
  process.exit(1);
});
