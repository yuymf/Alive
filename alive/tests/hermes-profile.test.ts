import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  inferPersonaId,
  renderHostSoul,
  initHermesProfile,
  initOpenClawAgent,
  repoRootFromHere,
} from '../scripts/host/install';

describe('inferPersonaId', () => {
  const root = repoRootFromHere();

  it('maps nicknames and aliases correctly', () => {
    expect(inferPersonaId('taffy', root)).toBe('ace-taffy');
    expect(inferPersonaId('永雏塔菲', root)).toBe('ace-taffy');
    expect(inferPersonaId('ace-taffy', root)).toBe('ace-taffy');
    expect(inferPersonaId('jobs', root)).toBe('steve-jobs');
    expect(inferPersonaId('feng', root)).toBe('fengge');
  });

  it('detects examples from directory', () => {
    expect(inferPersonaId('steve-jobs', root)).toBe('steve-jobs');
    expect(inferPersonaId('karpathy', root)).toBe('karpathy');
    expect(inferPersonaId('wangxiaobo', root)).toBe('wangxiaobo');
  });

  it('falls back to input or minase', () => {
    expect(inferPersonaId('', root)).toBe('minase');
    expect(inferPersonaId('custom-bot', root)).toBe('custom-bot');
  });
});

describe('renderHostSoul', () => {
  const root = repoRootFromHere();

  it('renders ace-taffy soul with persona rules and alive integration', () => {
    const soul = renderHostSoul('永雏塔菲', 'ace-taffy', '~/.hermes/profiles/taffy/skills/alive', root);
    expect(soul).toContain('永雏塔菲');
    expect(soul).toContain('Alive 数字生命系统集成');
    expect(soul).toContain('chat.js load');
    expect(soul).toContain('chat.js save');
  });

  it('renders generic soul for non-example personas', () => {
    const soul = renderHostSoul('新角色', 'new-character', '/skills/alive', root);
    expect(soul).toContain('新角色');
    expect(soul).toContain('chat.js load');
  });
});

describe('initHermesProfile', () => {
  let tmpHome: string;
  let tmpAlive: string;
  const root = repoRootFromHere();

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-hermes-home-'));
    tmpAlive = path.join(tmpHome, '.alive');
    fs.mkdirSync(path.join(tmpHome, '.hermes'), { recursive: true });
    // mock config.yaml
    fs.writeFileSync(
      path.join(tmpHome, '.hermes', 'config.yaml'),
      'model:\n  default: mock-model\n  provider: openai\n  api_key: mock-key\n',
      'utf8',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('initializes a hermes profile with ace-taffy persona', () => {
    const result = initHermesProfile({
      profileName: 'taffy',
      home: tmpHome,
      aliveHome: tmpAlive,
      root,
    });

    expect(result.profileName).toBe('taffy');
    expect(result.personaId).toBe('ace-taffy');
    expect(fs.existsSync(result.profileDir)).toBe(true);
    expect(fs.existsSync(result.soulPath)).toBe(true);
    expect(fs.existsSync(path.join(result.skillDir, 'SKILL.md'))).toBe(true);

    const soul = fs.readFileSync(result.soulPath, 'utf8');
    expect(soul).toContain('永雏塔菲');
    expect(soul).toContain('chat.js load');

    // Alive memory check
    expect(fs.existsSync(path.join(tmpAlive, 'personas', 'ace-taffy', 'persona', 'persona.yaml'))).toBe(true);
    const envContent = fs.readFileSync(path.join(tmpAlive, '.env'), 'utf8');
    expect(envContent).toContain('ALIVE_PERSONA=ace-taffy');
  });
});

describe('initOpenClawAgent', () => {
  let tmpHome: string;
  let tmpAlive: string;
  const root = repoRootFromHere();

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-openclaw-home-'));
    tmpAlive = path.join(tmpHome, '.alive');
    fs.mkdirSync(path.join(tmpHome, '.openclaw'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('initializes an openclaw agent workspace and skill', () => {
    const result = initOpenClawAgent({
      agentName: 'miss-v',
      personaId: 'minase',
      home: tmpHome,
      aliveHome: tmpAlive,
      root,
    });

    expect(result.agentName).toBe('miss-v');
    expect(fs.existsSync(result.workspaceDir)).toBe(true);
    expect(fs.existsSync(result.identityPath)).toBe(true);
    expect(fs.existsSync(result.soulPath)).toBe(true);
    expect(fs.existsSync(path.join(result.skillDir, 'SKILL.md'))).toBe(true);

    const soul = fs.readFileSync(result.soulPath, 'utf8');
    expect(soul).toContain('chat.js load');
  });
});
