// alive/tests/skill-need-tracker.test.ts
// TDD tests for skill-need-tracker module (Task 1.1)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setBasePaths, resetBasePaths, PATHS } from '../scripts/utils/file-utils';
import {
  recordSkillNeed,
  getPendingNeeds,
  updateNeedStatus,
  buildPendingNeedsHint,
} from '../scripts/hub/skill-need-tracker';

let sandbox: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-skill-need-'));
  const memoryDir = path.join(sandbox, 'memory');
  const skillDir = path.join(sandbox, 'skill');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  setBasePaths(memoryDir, skillDir);
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// ──── recordSkillNeed ────

describe('recordSkillNeed', () => {
  it('creates a new need with source "unhandled"', () => {
    recordSkillNeed({
      intent_category: 'produce',
      description: 'wanted to generate music but no skill available',
      wished_skill_name: null,
      source: 'unhandled',
      original_action: 'generate-music',
      intensity: 7.0,
    });

    const needs = getPendingNeeds();
    expect(needs).toHaveLength(1);
    expect(needs[0].source).toBe('unhandled');
    expect(needs[0].status).toBe('pending');
    expect(needs[0].occurrences).toBe(1);
    expect(needs[0].intensity_peak).toBe(7.0);
    expect(needs[0].wished_skill_name).toBeNull();
  });

  it('creates a new need with source "wished"', () => {
    recordSkillNeed({
      intent_category: 'produce',
      description: 'wished for music generation',
      wished_skill_name: 'music-gen',
      source: 'wished',
      original_action: 'compose-song',
      intensity: 6.5,
    });

    const needs = getPendingNeeds();
    expect(needs).toHaveLength(1);
    expect(needs[0].source).toBe('wished');
    expect(needs[0].wished_skill_name).toBe('music-gen');
    expect(needs[0].intensity_peak).toBe(6.5);
  });

  it('deduplicates by wished_skill_name — accumulates occurrences and updates last_seen', () => {
    recordSkillNeed({
      intent_category: 'produce',
      description: 'want music gen',
      wished_skill_name: 'music-gen',
      source: 'wished',
      original_action: 'compose',
      intensity: 5.0,
    });

    recordSkillNeed({
      intent_category: 'produce',
      description: 'really want music gen',
      wished_skill_name: 'music-gen',
      source: 'wished',
      original_action: 'compose-v2',
      intensity: 8.0,
    });

    const needs = getPendingNeeds();
    expect(needs).toHaveLength(1);
    expect(needs[0].occurrences).toBe(2);
    expect(needs[0].intensity_peak).toBe(8.0);
  });

  it('deduplicates without wished_skill_name — matches by description keywords', () => {
    recordSkillNeed({
      intent_category: 'produce',
      description: 'generate background music for video',
      wished_skill_name: null,
      source: 'unhandled',
      original_action: 'gen-bgm',
      intensity: 4.0,
    });

    recordSkillNeed({
      intent_category: 'produce',
      description: 'create background music',
      wished_skill_name: null,
      source: 'unhandled',
      original_action: 'create-bgm',
      intensity: 6.0,
    });

    const needs = getPendingNeeds();
    // Fuzzy match on shared keywords should merge
    expect(needs).toHaveLength(1);
    expect(needs[0].occurrences).toBe(2);
  });

  it('creates separate needs when descriptions share no keywords', () => {
    recordSkillNeed({
      intent_category: 'produce',
      description: 'generate background music',
      wished_skill_name: null,
      source: 'unhandled',
      original_action: 'gen-bgm',
      intensity: 4.0,
    });

    recordSkillNeed({
      intent_category: 'connect',
      description: 'send direct messages on twitter',
      wished_skill_name: null,
      source: 'unhandled',
      original_action: 'dm-twitter',
      intensity: 5.0,
    });

    const needs = getPendingNeeds();
    expect(needs).toHaveLength(2);
  });

  it('intensity_peak takes the historical maximum', () => {
    recordSkillNeed({
      intent_category: 'produce',
      description: 'music',
      wished_skill_name: 'music-gen',
      source: 'wished',
      original_action: 'compose',
      intensity: 9.0,
    });

    recordSkillNeed({
      intent_category: 'produce',
      description: 'music again',
      wished_skill_name: 'music-gen',
      source: 'wished',
      original_action: 'compose',
      intensity: 3.0, // lower than peak
    });

    const needs = getPendingNeeds();
    expect(needs[0].intensity_peak).toBe(9.0); // should keep max
  });
});

// ──── getPendingNeeds ────

describe('getPendingNeeds', () => {
  it('returns only pending needs', () => {
    recordSkillNeed({
      intent_category: 'produce',
      description: 'music gen',
      wished_skill_name: 'music-gen',
      source: 'wished',
      original_action: 'compose',
      intensity: 5.0,
    });

    recordSkillNeed({
      intent_category: 'connect',
      description: 'dm feature',
      wished_skill_name: 'dm-tool',
      source: 'wished',
      original_action: 'dm',
      intensity: 5.0,
    });

    // Mark one as installed
    const all = getPendingNeeds();
    updateNeedStatus(all[0].id, 'installed');

    const pending = getPendingNeeds();
    expect(pending).toHaveLength(1);
    expect(pending[0].wished_skill_name).toBe('dm-tool');
  });

  it('returns empty array when no needs exist', () => {
    expect(getPendingNeeds()).toEqual([]);
  });
});

// ──── updateNeedStatus ────

describe('updateNeedStatus', () => {
  it('changes need status from pending to installed', () => {
    recordSkillNeed({
      intent_category: 'produce',
      description: 'music',
      wished_skill_name: 'music-gen',
      source: 'wished',
      original_action: 'compose',
      intensity: 5.0,
    });

    const needs = getPendingNeeds();
    updateNeedStatus(needs[0].id, 'installed');

    // After status change, it should no longer be pending
    expect(getPendingNeeds()).toHaveLength(0);
  });

  it('changes need status to failed', () => {
    recordSkillNeed({
      intent_category: 'produce',
      description: 'music',
      wished_skill_name: 'music-gen',
      source: 'wished',
      original_action: 'compose',
      intensity: 5.0,
    });

    const needs = getPendingNeeds();
    updateNeedStatus(needs[0].id, 'failed');

    expect(getPendingNeeds()).toHaveLength(0);
  });
});

// ──── buildPendingNeedsHint ────

describe('buildPendingNeedsHint', () => {
  it('generates hint text when pending needs exist', () => {
    recordSkillNeed({
      intent_category: 'produce',
      description: 'generate music',
      wished_skill_name: 'music-gen',
      source: 'wished',
      original_action: 'compose',
      intensity: 7.0,
    });

    recordSkillNeed({
      intent_category: 'connect',
      description: 'send DMs',
      wished_skill_name: 'dm-tool',
      source: 'wished',
      original_action: 'dm',
      intensity: 5.0,
    });

    const hint = buildPendingNeedsHint();
    expect(hint.length).toBeGreaterThan(0);
    // Should mention the skill names or descriptions
    expect(hint).toContain('music-gen');
    expect(hint).toContain('dm-tool');
  });

  it('returns empty string when no pending needs', () => {
    expect(buildPendingNeedsHint()).toBe('');
  });

  it('includes occurrence count in hint', () => {
    recordSkillNeed({
      intent_category: 'produce',
      description: 'music',
      wished_skill_name: 'music-gen',
      source: 'wished',
      original_action: 'compose',
      intensity: 5.0,
    });

    recordSkillNeed({
      intent_category: 'produce',
      description: 'music again',
      wished_skill_name: 'music-gen',
      source: 'wished',
      original_action: 'compose',
      intensity: 6.0,
    });

    const hint = buildPendingNeedsHint();
    // Should indicate this need was seen multiple times
    expect(hint).toMatch(/2/);
  });
});
