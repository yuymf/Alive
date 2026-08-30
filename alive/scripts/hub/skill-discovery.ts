// alive/scripts/hub/skill-discovery.ts
// Skill Gap Analysis + Discovery orchestration for night-reflect.
// Design ref: D10

import { getPendingNeeds, buildPendingNeedsHint } from './skill-need-tracker';
import type { SkillAcquisitionPlan } from '../utils/types';
import { SKILL_LIFECYCLE_CONFIG } from '../config';

const MAX_PLANS = SKILL_LIFECYCLE_CONFIG.MAX_PLANS;

interface LlmLike {
  callJSON<T>(prompt: string): Promise<T>;
  call(prompt: string): Promise<string>;
}

// ─── evaluateSkillNeeds ─────────────────────────────────

/**
 * Evaluate pending skill needs and return acquisition plans.
 * If no pending needs, returns [] without calling LLM.
 * Plans are sorted by priority and limited to MAX_PLANS.
 */
export async function evaluateSkillNeeds(
  llm: LlmLike,
): Promise<SkillAcquisitionPlan[]> {
  const pending = getPendingNeeds();
  if (pending.length === 0) return [];

  try {
    const needsSummary = pending.map(n => ({
      id: n.id,
      description: n.description,
      wished_skill_name: n.wished_skill_name,
      occurrences: n.occurrences,
      intensity_peak: n.intensity_peak,
      intent_category: n.intent_category,
    }));

    const prompt = buildEvalPrompt(needsSummary);
    const response = await llm.callJSON<{ skill_acquisition_plans: SkillAcquisitionPlan[] }>(prompt);

    const plans = (response.skill_acquisition_plans ?? [])
      .sort((a, b) => a.priority - b.priority)
      .slice(0, MAX_PLANS);

    return plans;
  } catch (err) {
    console.error(`[skill-discovery] evaluateSkillNeeds failed: ${(err as Error).message}`);
    return [];
  }
}

// ─── discoverAndInstall ─────────────────────────────────

/** Marketplace install removed. Capability gaps stay in local skill-needs.json. */
export async function discoverAndInstall(
  _plans: SkillAcquisitionPlan[],
  _llm: LlmLike,
): Promise<void> {
  return;
}

/**
 * Build the skill needs hint for night-reflect prompt injection.
 */
export function buildSkillNeedsForPrompt(): string {
  const pending = getPendingNeeds();
  if (pending.length === 0) return '目前没有发现能力缺口。';

  return pending.map(n => {
    const name = n.wished_skill_name ?? n.description;
    return `- [${n.id}] ${name}（出现 ${n.occurrences} 次，最高强度 ${n.intensity_peak}，来源: ${n.source}）`;
  }).join('\n');
}

// ─── Prompt builder ─────────────────────────────────────

function buildEvalPrompt(needs: Array<{
  id: string;
  description: string;
  wished_skill_name: string | null;
  occurrences: number;
  intensity_peak: number;
  intent_category: string;
}>): string {
  return `You are evaluating skill needs for an AI character's growth.

## Pending Skill Needs

${JSON.stringify(needs, null, 2)}

## Task

Evaluate each skill need and decide which ones are worth pursuing.
Consider: frequency (occurrences), intensity, and relevance to the character's growth.

For each need worth pursuing, generate a search query that would find a relevant skill package.
Sort by priority (1 = highest).
Maximum 2 plans.

## Output Format (JSON only)

{
  "skill_acquisition_plans": [
    {
      "need_id": "the id from the needs list",
      "search_query": "keyword query to find relevant skill",
      "priority": 1,
      "rationale": "why this is worth learning"
    }
  ]
}

Return ONLY valid JSON.`;
}
