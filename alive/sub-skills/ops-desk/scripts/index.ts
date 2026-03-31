/**
 * ops-desk/scripts/index.ts
 * Sub-skill entry point — dispatches to ops modules based on action.
 * Respects ops.enabled gate: exits immediately if not configured.
 */

import { SubSkillContext, SubSkillResult } from '../../../scripts/utils/types';
import { analyzeTrends } from '../../../scripts/ops/trend-analyzer';
import { trackCompetitors } from '../../../scripts/ops/competitor-tracker';
import { generateTopics } from '../../../scripts/ops/topic-generator';
import { sendDailyBrief } from '../../../scripts/ops/brief-generator';
import { loadQueue, cleanupOldItems } from '../../../scripts/ops/review-queue';

async function actionRefreshTrends(ctx: SubSkillContext): Promise<SubSkillResult> {
  const persona = ctx.persona;
  const ops = persona.ops;
  if (!ops?.enabled) {
    return { narrative: 'ops not enabled for this persona', vitality_cost: 0 };
  }

  const identities = [
    persona.personality?.mbti ?? '',
    ...(persona.personality?.core_traits ?? []),
  ].join(', ');

  const trends = await analyzeTrends(ops, identities, ctx.llm);
  return {
    narrative: `热点监控完成，${trends.length} 个话题通过速度分过滤`,
    vitality_cost: 5,
  };
}

async function actionGenerateTopics(ctx: SubSkillContext): Promise<SubSkillResult> {
  const persona = ctx.persona;
  const ops = persona.ops;
  if (!ops?.enabled) {
    return { narrative: 'ops not enabled for this persona', vitality_cost: 0 };
  }

  const identities = (persona.personality?.core_traits ?? []).join('、');
  const imageStyle = (persona as { image_style?: { base_prompt?: string } }).image_style?.base_prompt ?? '';

  const [trendsResult] = await Promise.allSettled([
    analyzeTrends(ops, identities, ctx.llm),
    trackCompetitors(ops), // side effect: persist competitor log; result intentionally discarded
  ]);

  const trends = trendsResult.status === 'fulfilled' ? trendsResult.value : [];

  await cleanupOldItems();
  await generateTopics(trends, ops, persona.meta.name, imageStyle, ctx.llm);

  const queue = await loadQueue();
  const pending = queue.items.filter(i => i.status === 'pending');
  await sendDailyBrief(trends, [], pending); // competitors not passed; brief shows trend+queue only

  return {
    narrative: `运营工作台：生成 ${pending.length} 条选题草案，已推送企业微信简报`,
    vitality_cost: 10,
  };
}

export const actions: Record<string, (ctx: SubSkillContext) => Promise<SubSkillResult>> = {
  'refresh-trends': actionRefreshTrends,
  'generate-topics': actionGenerateTopics,
};
