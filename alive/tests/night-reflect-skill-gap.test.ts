// alive/tests/night-reflect-skill-gap.test.ts
// TDD tests for Skill Gap Analysis phase in night-reflect (Task 6.2)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setBasePaths, resetBasePaths, PATHS, writeJSON, readJSON } from '../scripts/utils/file-utils';
import { recordSkillNeed, getPendingNeeds } from '../scripts/hub/skill-need-tracker';
import type { SkillNeed, SkillNeedsStore, SkillAcquisitionPlan } from '../scripts/utils/types';

// Mock external modules
vi.mock('../scripts/hub/skill-hub-client', () => ({
  searchClawHub: vi.fn().mockResolvedValue([]),
  searchSkillsHub: vi.fn().mockResolvedValue([]),
  installClawHubSkill: vi.fn().mockResolvedValue({ success: true, output: 'installed' }),
}));

vi.mock('../scripts/hub/skill-adapter', () => ({
  generateAdaptedSkill: vi.fn().mockResolvedValue({ success: true, skillDir: '/tmp/adapted' }),
}));

vi.mock('../scripts/router/skill-router', () => ({
  resolveRoute: vi.fn().mockReturnValue(null),
  resolveRouteBySkillName: vi.fn().mockReturnValue(null),
  buildContext: vi.fn(),
  executeSubSkill: vi.fn(),
  getRouteTable: vi.fn().mockReturnValue([]),
  clearRouteTable: vi.fn(),
}));

import { searchClawHub, searchSkillsHub, installClawHubSkill } from '../scripts/hub/skill-hub-client';
import { generateAdaptedSkill } from '../scripts/hub/skill-adapter';
import { clearRouteTable } from '../scripts/router/skill-router';
import { evaluateSkillNeeds, discoverAndInstall } from '../scripts/hub/skill-discovery';

const mockSearchClawHub = vi.mocked(searchClawHub);
const mockSearchSkillsHub = vi.mocked(searchSkillsHub);
const mockInstallClawHub = vi.mocked(installClawHubSkill);
const mockAdapt = vi.mocked(generateAdaptedSkill);
const mockClearRouteTable = vi.mocked(clearRouteTable);

let sandbox: string;

beforeEach(() => {
  vi.clearAllMocks();
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-night-skill-'));
  const memoryDir = path.join(sandbox, 'memory');
  const skillDir = path.join(sandbox, 'skill');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(path.join(skillDir, 'sub-skills'), { recursive: true });
  setBasePaths(memoryDir, skillDir);
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
      intent_category: '創作',
      description: `skill need ${i}`,
      wished_skill_name: `skill-${i}`,
      source: 'wished',
      original_action: `action-${i}`,
      intensity: 7,
    });
  }
}

// ──── evaluateSkillNeeds ────

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
    // LLM should NOT be called
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
    expect(result[0].priority).toBe(1); // highest priority first
    expect(result[1].priority).toBe(2);
  });
});

// ──── discoverAndInstall ────

describe('discoverAndInstall', () => {
  it('searches ClawHub then SkillsHub in cascade for each plan', async () => {
    seedPendingNeeds(1);
    const needs = getPendingNeeds();
    const plans: SkillAcquisitionPlan[] = [
      { need_id: needs[0].id, search_query: 'music tool', priority: 1, rationale: 'needed' },
    ];

    mockSearchClawHub.mockResolvedValue([
      { name: 'music-gen', slug: 'music-gen', description: 'Music generator', source: 'clawhub' },
    ]);

    const llm = makeMockLlm({});
    await discoverAndInstall(plans, llm);

    expect(mockSearchClawHub).toHaveBeenCalledWith('music tool');
    expect(mockInstallClawHub).toHaveBeenCalledWith('music-gen');
  });

  it('falls back to SkillsHub when ClawHub returns no results', async () => {
    seedPendingNeeds(1);
    const needs = getPendingNeeds();
    const plans: SkillAcquisitionPlan[] = [
      { need_id: needs[0].id, search_query: 'video editor', priority: 1, rationale: 'needed' },
    ];

    mockSearchClawHub.mockResolvedValue([]);
    mockSearchSkillsHub.mockResolvedValue([
      { name: 'video-edit', slug: 'video-edit', description: 'Video editor', source: 'skillshub' },
    ]);

    const llm = makeMockLlm({});
    await discoverAndInstall(plans, llm);

    expect(mockSearchSkillsHub).toHaveBeenCalledWith('video editor');
    // skillshub results go through adapter
    expect(mockAdapt).toHaveBeenCalled();
  });

  it('updates need status to installed on success', async () => {
    seedPendingNeeds(1);
    const needs = getPendingNeeds();
    const plans: SkillAcquisitionPlan[] = [
      { need_id: needs[0].id, search_query: 'music', priority: 1, rationale: 'test' },
    ];

    mockSearchClawHub.mockResolvedValue([
      { name: 'music', slug: 'music', description: 'Music', source: 'clawhub' },
    ]);
    mockInstallClawHub.mockResolvedValue({ success: true, output: 'ok' });

    const llm = makeMockLlm({});
    await discoverAndInstall(plans, llm);

    // After install, need should no longer be pending
    expect(getPendingNeeds()).toHaveLength(0);
  });

  it('updates need status to failed on install failure', async () => {
    seedPendingNeeds(1);
    const needs = getPendingNeeds();
    const plans: SkillAcquisitionPlan[] = [
      { need_id: needs[0].id, search_query: 'bad-skill', priority: 1, rationale: 'test' },
    ];

    mockSearchClawHub.mockResolvedValue([
      { name: 'bad', slug: 'bad', description: 'Bad', source: 'clawhub' },
    ]);
    mockInstallClawHub.mockResolvedValue({ success: false, error: 'network error' });

    const llm = makeMockLlm({});
    await discoverAndInstall(plans, llm);

    // After failure, need should be marked failed (no longer pending)
    expect(getPendingNeeds()).toHaveLength(0);
  });

  it('calls clearRouteTable after any successful install', async () => {
    seedPendingNeeds(1);
    const needs = getPendingNeeds();
    const plans: SkillAcquisitionPlan[] = [
      { need_id: needs[0].id, search_query: 'music', priority: 1, rationale: 'test' },
    ];

    mockSearchClawHub.mockResolvedValue([
      { name: 'music', slug: 'music', description: 'Music', source: 'clawhub' },
    ]);
    mockInstallClawHub.mockResolvedValue({ success: true, output: 'ok' });

    const llm = makeMockLlm({});
    await discoverAndInstall(plans, llm);

    expect(mockClearRouteTable).toHaveBeenCalled();
  });
});
