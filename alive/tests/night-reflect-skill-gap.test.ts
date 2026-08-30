import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setBasePaths, resetBasePaths } from '../scripts/utils/file-utils';
import { recordSkillNeed, getPendingNeeds } from '../scripts/hub/skill-need-tracker';
import type { SkillAcquisitionPlan } from '../scripts/utils/types';
import { evaluateSkillNeeds, discoverAndInstall } from '../scripts/hub/skill-discovery';

let sandbox: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-night-skill-'));
  fs.mkdirSync(path.join(sandbox, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'skill', 'sub-skills'), { recursive: true });
  setBasePaths(path.join(sandbox, 'memory'), path.join(sandbox, 'skill'));
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function makeMockLlm(response: unknown) {
  return {
    callJSON: vi.fn().mockResolvedValue(response),
    call: vi.fn().mockResolvedValue(JSON.stringify(response)),
  };
}

function seedPendingNeeds(count: number) {
  for (let i = 0; i < count; i++) {
    recordSkillNeed({
      intent_category: 'produce',
      description: `skill need ${i}`,
      wished_skill_name: `skill-${i}`,
      source: 'wished',
      original_action: `action-${i}`,
      intensity: 7,
    });
  }
}

describe('evaluateSkillNeeds', () => {
  it('calls LLM with pending needs and returns acquisition plans', async () => {
    seedPendingNeeds(2);
    const plans: SkillAcquisitionPlan[] = [
      { need_id: getPendingNeeds()[0].id, search_query: 'music generation tool', priority: 1, rationale: 'high demand' },
    ];
    const llm = makeMockLlm({ skill_acquisition_plans: plans });
    const result = await evaluateSkillNeeds(llm);
    expect(result).toHaveLength(1);
    expect(result[0].search_query).toBe('music generation tool');
  });

  it('returns empty array when no pending needs exist', async () => {
    const llm = makeMockLlm({});
    const result = await evaluateSkillNeeds(llm);
    expect(result).toEqual([]);
    expect(llm.callJSON).not.toHaveBeenCalled();
  });

  it('limits plans to top 2 by priority', async () => {
    seedPendingNeeds(5);
    const needs = getPendingNeeds();
    const plans: SkillAcquisitionPlan[] = [
      { need_id: needs[0].id, search_query: 'q1', priority: 3, rationale: 'low' },
      { need_id: needs[1].id, search_query: 'q2', priority: 1, rationale: 'high' },
      { need_id: needs[2].id, search_query: 'q3', priority: 2, rationale: 'medium' },
    ];
    const llm = makeMockLlm({ skill_acquisition_plans: plans });
    const result = await evaluateSkillNeeds(llm);
    expect(result).toHaveLength(2);
    expect(result[0].priority).toBe(1);
    expect(result[1].priority).toBe(2);
  });
});

describe('discoverAndInstall', () => {
  it('is a no-op without a skill marketplace', async () => {
    seedPendingNeeds(1);
    const plans: SkillAcquisitionPlan[] = [
      { need_id: getPendingNeeds()[0].id, search_query: 'music tool', priority: 1, rationale: 'needed' },
    ];
    await discoverAndInstall(plans, makeMockLlm({}));
    expect(getPendingNeeds()).toHaveLength(1);
  });
});
