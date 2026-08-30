import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectUserSkillTargets, projectSkillTarget, initMemory, repoRootFromHere } from '../scripts/host/install';

describe('detectUserSkillTargets', () => {
  it('always installs ~/.agents/skills/alive', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-hosts-'));
    const targets = detectUserSkillTargets(tmp);
    expect(targets[0]).toEqual({
      id: 'agents',
      dir: path.join(tmp, '.agents', 'skills', 'alive'),
      reason: 'always',
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('adds claude/cursor/codex only when those homes exist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-hosts-'));
    fs.mkdirSync(path.join(tmp, '.claude'));
    fs.mkdirSync(path.join(tmp, '.cursor'));
    const targets = detectUserSkillTargets(tmp);
    expect(targets.map((t) => t.id)).toEqual(['agents', 'claude', 'cursor']);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('projectSkillTarget', () => {
  it('uses .agents/skills/alive in the project', () => {
    expect(projectSkillTarget('/repo')).toEqual({
      id: 'project',
      dir: path.join('/repo', '.agents', 'skills', 'alive'),
      reason: 'project',
    });
  });
});

describe('initMemory', () => {
  it('writes persona yaml and .env under ALIVE_HOME', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-home-'));
    initMemory(tmp, 'minase', repoRootFromHere());
    expect(fs.existsSync(path.join(tmp, 'personas', 'minase', 'persona', 'persona.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'personas', 'minase', 'state', 'emotion-state.json'))).toBe(true);
    const env = fs.readFileSync(path.join(tmp, '.env'), 'utf8');
    expect(env).toContain('ALIVE_PERSONA=minase');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
