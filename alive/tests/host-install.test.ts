import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectUserSkillTargets, projectSkillTarget, initMemory, installSkillTo, repoRootFromHere, resolveUserSkillTargets, parseAgentFlag, knownAgentIds, allUserSkillTargets } from '../scripts/host/install';
import { dispatch } from '../scripts/admin/command-handler';
import { resetBasePaths, setPersonaName } from '../scripts/utils/file-utils';
import { clearPersonaCache } from '../scripts/persona/persona-loader';

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

  it('adds claude/cursor/codex/hermes/openclaw only when those homes exist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-hosts-'));
    fs.mkdirSync(path.join(tmp, '.claude'));
    fs.mkdirSync(path.join(tmp, '.cursor'));
    fs.mkdirSync(path.join(tmp, '.hermes'));
    fs.mkdirSync(path.join(tmp, '.openclaw'));
    const targets = detectUserSkillTargets(tmp);
    expect(targets.map((t) => t.id)).toEqual(['agents', 'claude', 'cursor', 'hermes', 'openclaw']);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('resolveUserSkillTargets', () => {
  it('parses comma-separated --agent ids', () => {
    expect(parseAgentFlag('hermes,openclaw')).toEqual(['hermes', 'openclaw']);
    expect(parseAgentFlag(' Hermes , Cursor ')).toEqual(['hermes', 'cursor']);
    expect(parseAgentFlag('true')).toEqual([]);
    expect(knownAgentIds()).toEqual(['agents', 'claude', 'cursor', 'codex', 'hermes', 'openclaw']);
  });

  it('installs only the requested agents', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-hosts-'));
    const targets = resolveUserSkillTargets(['hermes', 'openclaw'], tmp);
    expect(targets).toEqual([
      { id: 'hermes', dir: path.join(tmp, '.hermes', 'skills', 'alive'), reason: 'requested' },
      { id: 'openclaw', dir: path.join(tmp, '.openclaw', 'skills', 'alive'), reason: 'requested' },
    ]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('rejects unknown agents', () => {
    expect(() => resolveUserSkillTargets(['windsurf'], '/tmp')).toThrow(/Unknown agent "windsurf"/);
  });

  it('lists every known host for uninstall', () => {
    const targets = allUserSkillTargets('/home/me');
    expect(targets.map((t) => t.id)).toEqual(knownAgentIds());
    expect(targets.find((t) => t.id === 'hermes')?.dir).toBe(path.join('/home/me', '.hermes', 'skills', 'alive'));
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

  it('status reads ALIVE_HOME after init', async () => {
    const prevHome = process.env.ALIVE_HOME;
    const prevPersona = process.env.ALIVE_PERSONA;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-home-'));
    try {
      process.env.ALIVE_HOME = tmp;
      delete process.env.ALIVE_PERSONA;
      resetBasePaths();
      setPersonaName('default');
      clearPersonaCache();
      initMemory(tmp, 'minase', repoRootFromHere());
      const result = await dispatch('/alive status');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('Status');
      expect(result.output).toMatch(/水瀬|Minase|minase/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (prevHome === undefined) delete process.env.ALIVE_HOME;
      else process.env.ALIVE_HOME = prevHome;
      if (prevPersona === undefined) delete process.env.ALIVE_PERSONA;
      else process.env.ALIVE_PERSONA = prevPersona;
      resetBasePaths();
      clearPersonaCache();
    }
  });
});

describe('installSkillTo', () => {
  it('copies SKILL.md and only official personas', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-skill-'));
    const dest = path.join(tmp, 'alive');
    installSkillTo(dest, repoRootFromHere());
    expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'scripts', 'host', 'chat.js'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'scripts', 'host', 'boot.js'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'scripts', 'admin', 'command-handler.js'))).toBe(true);
    expect(fs.existsSync(path.join(dest, '.source-root'))).toBe(false);
    expect(fs.readFileSync(path.join(dest, 'scripts', 'host', 'chat.js'), 'utf8')).not.toContain('.source-root');

    expect(fs.existsSync(path.join(dest, 'personas', 'minase.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'personas', 'guodegang.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'personas', 'miss-v.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'personas', 'xingtong.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'personas', 'test.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'tests'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'hooks'))).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
