// alive/tests/skill-lifecycle.test.ts
// TDD tests for skill lifecycle safety constraints (Task 7.1)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setBasePaths, resetBasePaths, PATHS } from '../scripts/utils/file-utils';
import {
  canInstallMore,
  checkInstallLimit,
  archiveSkill,
  getInstalledSkillCount,
  MAX_INSTALL_PER_NIGHT,
  MAX_TOTAL_SKILLS,
} from '../scripts/hub/skill-lifecycle';

let sandbox: string;
let skillBase: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-lifecycle-'));
  const memoryDir = path.join(sandbox, 'memory');
  skillBase = path.join(sandbox, 'skill');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(path.join(skillBase, 'sub-skills'), { recursive: true });
  setBasePaths(memoryDir, skillBase);
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function createDummySkill(name: string) {
  const skillDir = path.join(skillBase, 'sub-skills', name);
  fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'manifest.json'),
    JSON.stringify({ name, intent_bindings: [{ intent: '創作', action: 'test', priority: 3 }] }),
  );
}

// ──── canInstallMore ────

describe('canInstallMore', () => {
  it('returns true when under the per-night limit', () => {
    expect(canInstallMore(0)).toBe(true);
    expect(canInstallMore(1)).toBe(true);
  });

  it('returns false when at or above the per-night limit', () => {
    expect(canInstallMore(MAX_INSTALL_PER_NIGHT)).toBe(false);
    expect(canInstallMore(MAX_INSTALL_PER_NIGHT + 1)).toBe(false);
  });
});

// ──── checkInstallLimit ────

describe('checkInstallLimit', () => {
  it('allows installation when total installed is under limit', () => {
    createDummySkill('skill-a');
    createDummySkill('skill-b');
    expect(checkInstallLimit()).toBe(true);
  });

  it('blocks installation when total installed reaches limit', () => {
    for (let i = 0; i < MAX_TOTAL_SKILLS; i++) {
      createDummySkill(`skill-${i}`);
    }
    expect(checkInstallLimit()).toBe(false);
  });
});

// ──── getInstalledSkillCount ────

describe('getInstalledSkillCount', () => {
  it('counts skill directories in sub-skills', () => {
    createDummySkill('alpha');
    createDummySkill('beta');
    expect(getInstalledSkillCount()).toBe(2);
  });

  it('excludes .archived directory', () => {
    createDummySkill('alpha');
    // Create .archived dir
    fs.mkdirSync(path.join(skillBase, 'sub-skills', '.archived'), { recursive: true });
    expect(getInstalledSkillCount()).toBe(1);
  });

  it('returns 0 when no skills installed', () => {
    expect(getInstalledSkillCount()).toBe(0);
  });
});

// ──── archiveSkill ────

describe('archiveSkill', () => {
  it('moves skill to .archived directory', () => {
    createDummySkill('old-skill');
    const skillDir = path.join(skillBase, 'sub-skills', 'old-skill');
    expect(fs.existsSync(skillDir)).toBe(true);

    archiveSkill('old-skill');

    expect(fs.existsSync(skillDir)).toBe(false);
    expect(fs.existsSync(path.join(skillBase, 'sub-skills', '.archived', 'old-skill'))).toBe(true);
  });

  it('does not throw when skill does not exist', () => {
    expect(() => archiveSkill('nonexistent')).not.toThrow();
  });

  it('preserves manifest.json in archived location', () => {
    createDummySkill('archive-me');
    archiveSkill('archive-me');

    const archivedManifest = path.join(skillBase, 'sub-skills', '.archived', 'archive-me', 'manifest.json');
    expect(fs.existsSync(archivedManifest)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(archivedManifest, 'utf8'));
    expect(manifest.name).toBe('archive-me');
  });
});
