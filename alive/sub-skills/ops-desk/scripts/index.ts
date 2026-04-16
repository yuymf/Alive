/**
 * ops-desk/scripts/index.ts
 * Sub-skill entry point — dispatches to ops modules based on action.
 * Respects ops.enabled gate: exits immediately if not configured.
 */

import { SubSkillContext, SubSkillResult } from '../../../scripts/utils/types';
import { analyzeTrends } from '../../../scripts/ops/trend-analyzer';
import { trackCompetitors } from '../../../scripts/ops/competitor-tracker';
import { generateTopics } from '../../../scripts/ops/topic-generator';
import { sendDailyBrief, sendToWechatWork } from '../../../scripts/ops/brief-generator';
import { loadQueue, cleanupOldItems } from '../../../scripts/ops/review-queue';
import { analyzePost, formatAnalysisCard } from '../../../scripts/ops/viral-analyzer';
import { generatePersonaReport, formatAlignmentCard } from '../../../scripts/ops/persona-advisor';
import { writeBreakdown, appendObservation } from '../../../scripts/ops/competitor-memory';

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
  await generateTopics(trends, ops, persona.meta.name, ctx.llm, persona.voice);

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
  'analyze-post': actionAnalyzePost,
  'persona-advice': actionPersonaAdvice,
  'save-breakdown': actionSaveBreakdown,
  'add-note': actionAddNote,
};

// ─── /analyze <url> — 爆款拆解 ──────────────────────────────────────────────

async function actionAnalyzePost(ctx: SubSkillContext): Promise<SubSkillResult> {
  const persona = ctx.persona;
  if (!persona.ops?.enabled) {
    return { narrative: 'ops not enabled for this persona', vitality_cost: 0 };
  }

  // Extract URL from intent description (passed by message-parser or slash command)
  const url = ctx.intent.description.trim();
  if (!url || !url.startsWith('http')) {
    sendToWechatWork('⚠️ 请提供有效的帖子 URL，例如：/analyze https://www.xiaohongshu.com/explore/xxx');
    return { narrative: '爆款拆解：缺少有效URL', vitality_cost: 0 };
  }

  try {
    const result = await analyzePost(url, persona, ctx.llm);
    const card = formatAnalysisCard(result);
    sendToWechatWork(card);
    return {
      narrative: `爆款拆解完成：${result.title}（${result.platform}），提取${result.hook_patterns.length}个钩子句式`,
      vitality_cost: 5,
    };
  } catch (err) {
    const msg = (err as Error).message;
    sendToWechatWork(`⚠️ 爆款拆解失败：${msg}`);
    return { narrative: `爆款拆解失败：${msg}`, vitality_cost: 0 };
  }
}

// ─── /advice — 人设建议 ──────────────────────────────────────────────────────

async function actionPersonaAdvice(ctx: SubSkillContext): Promise<SubSkillResult> {
  const persona = ctx.persona;
  const ops = persona.ops;
  if (!ops?.enabled) {
    return { narrative: 'ops not enabled for this persona', vitality_cost: 0 };
  }

  const identities = [
    persona.personality?.mbti ?? '',
    ...(persona.personality?.core_traits ?? []),
  ].join(', ');

  try {
    const [trendsResult, competitorsResult] = await Promise.allSettled([
      analyzeTrends(ops, identities, ctx.llm),
      Promise.resolve(trackCompetitors(ops)),
    ]);

    const trends = trendsResult.status === 'fulfilled' ? trendsResult.value : [];
    const competitors = competitorsResult.status === 'fulfilled' ? competitorsResult.value : [];

    const report = await generatePersonaReport(persona, trends, competitors, ctx.llm);
    const card = formatAlignmentCard(report);
    sendToWechatWork(card);

    return {
      narrative: `人设建议生成完成，综合契合度${report.alignment_score}/10，推荐${report.topic_suggestions.length}条选题方向`,
      vitality_cost: 5,
    };
  } catch (err) {
    const msg = (err as Error).message;
    sendToWechatWork(`⚠️ 人设建议生成失败：${msg}`);
    return { narrative: `人设建议失败：${msg}`, vitality_cost: 0 };
  }
}

// ─── /breakdown <url> — 爆款存档 ─────────────────────────────────────────────

async function actionSaveBreakdown(ctx: SubSkillContext): Promise<SubSkillResult> {
  const persona = ctx.persona;
  if (!persona.ops?.enabled) {
    return { narrative: 'ops not enabled for this persona', vitality_cost: 0 };
  }

  const url = ctx.intent.description.trim();
  if (!url || !url.startsWith('http')) {
    sendToWechatWork('⚠️ 请提供有效的帖子 URL，例如：/breakdown https://www.xiaohongshu.com/explore/xxx');
    return { narrative: '爆款存档：缺少有效URL', vitality_cost: 0 };
  }

  try {
    const result = await analyzePost(url, persona, ctx.llm);

    writeBreakdown({
      platform: result.platform === 'generic' ? 'xhs' : result.platform,
      track: (ctx.intent as unknown as Record<string, unknown>).item_id as string ?? 'unknown', // identity mode passed via item_id field
      competitor: 'manual',
      title: result.title,
      engagement: result.engagement_signals?.engagement_score ?? 0,
      content_type: '图文',
      source: 'manual',
      body: [
        result.content_structure.opening_hook ? `## 钩子拆解\n\n- ${result.content_structure.opening_hook}` : '',
        result.core_selling_points.length > 0
          ? `## 可借鉴点\n\n${result.core_selling_points.map(p => `- ${p}`).join('\n')}`
          : '',
        result.hook_patterns.length > 0
          ? `## 钩子句式\n\n${result.hook_patterns.map(p => `- ${p.formula}：${p.example}`).join('\n')}`
          : '',
      ].filter(Boolean).join('\n\n'),
      link: url,
    });

    sendToWechatWork(`✅ 已存档爆款拆解：${result.title}`);
    return {
      narrative: `爆款存档完成：${result.title}`,
      vitality_cost: 5,
    };
  } catch (err) {
    const msg = (err as Error).message;
    sendToWechatWork(`⚠️ 爆款存档失败：${msg}`);
    return { narrative: `爆款存档失败：${msg}`, vitality_cost: 0 };
  }
}

// ─── /note <competitor> <text> — 竞品观察笔记 ──────────────────────────────────

async function actionAddNote(ctx: SubSkillContext): Promise<SubSkillResult> {
  const persona = ctx.persona;
  if (!persona.ops?.enabled) {
    return { narrative: 'ops not enabled for this persona', vitality_cost: 0 };
  }

  const parts = ctx.intent.description.trim().split(/\s+/);
  const competitorName = parts[0];
  const noteText = parts.slice(1).join(' ');

  if (!competitorName || !noteText) {
    sendToWechatWork('⚠️ 格式：/note <竞品名> <观察笔记>');
    return { narrative: '竞品笔记：参数不足', vitality_cost: 0 };
  }

  // Try to find matching competitor across all platforms
  const competitors = persona.ops?.competitors ?? [];
  const matched = competitors.find(c =>
    c.name === competitorName || c.name.includes(competitorName) || competitorName.includes(c.name),
  );

  const platform = matched?.platform ?? 'xhs';
  const name = matched?.name ?? competitorName;

  appendObservation(platform, name, noteText);
  sendToWechatWork(`✅ 已添加观察笔记：@${name}（${platform}）`);
  return {
    narrative: `竞品观察笔记已添加：@${name}`,
    vitality_cost: 0,
  };
}
