// Copy the Alive skill into Code Agent skill directories.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { seedPersonaMemory, upsertEnvFile } from './memory';
export { harvestHostLlm } from './host-llm';

export interface SkillTarget {
  id: string;
  dir: string;
  reason: 'always' | 'detected' | 'project' | 'requested';
}

export interface HostAgent {
  id: string;
  label: string;
  skillRel: string[];
  detect: 'always' | 'home';
  detectRel: string[];
}

export const HOST_AGENTS: Record<string, HostAgent> = {
  agents: {
    id: 'agents',
    label: 'Cursor + Codex (~/.agents)',
    skillRel: ['.agents', 'skills', 'alive'],
    detect: 'always',
    detectRel: ['.agents'],
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    skillRel: ['.claude', 'skills', 'alive'],
    detect: 'home',
    detectRel: ['.claude'],
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    skillRel: ['.cursor', 'skills', 'alive'],
    detect: 'home',
    detectRel: ['.cursor'],
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    skillRel: ['.codex', 'skills', 'alive'],
    detect: 'home',
    detectRel: ['.codex'],
  },
  hermes: {
    id: 'hermes',
    label: 'Hermes',
    skillRel: ['.hermes', 'skills', 'alive'],
    detect: 'home',
    detectRel: ['.hermes'],
  },
  openclaw: {
    id: 'openclaw',
    label: 'OpenClaw',
    skillRel: ['.openclaw', 'skills', 'alive'],
    detect: 'home',
    detectRel: ['.openclaw'],
  },
};

export function knownAgentIds(): string[] {
  return Object.keys(HOST_AGENTS);
}

export function parseAgentFlag(raw: string | undefined): string[] {
  if (!raw || raw === 'true') return [];
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function resolveUserSkillTargets(agentIds: string[], home = os.homedir()): SkillTarget[] {
  if (agentIds.length === 0) return detectUserSkillTargets(home);
  const unknown = agentIds.filter((id) => !HOST_AGENTS[id]);
  if (unknown.length > 0) {
    throw new Error(`Unknown agent "${unknown.join(', ')}". Supported: ${knownAgentIds().join(', ')}`);
  }
  return agentIds.map((id) => ({
    id,
    dir: path.join(home, ...HOST_AGENTS[id].skillRel),
    reason: 'requested' as const,
  }));
}

export function detectUserSkillTargets(home = os.homedir()): SkillTarget[] {
  const targets: SkillTarget[] = [];
  for (const host of Object.values(HOST_AGENTS)) {
    if (host.detect === 'always') {
      targets.push({ id: host.id, dir: path.join(home, ...host.skillRel), reason: 'always' });
      continue;
    }
    if (fs.existsSync(path.join(home, ...host.detectRel))) {
      targets.push({ id: host.id, dir: path.join(home, ...host.skillRel), reason: 'detected' });
    }
  }
  return targets;
}

export function allUserSkillTargets(home = os.homedir()): SkillTarget[] {
  return Object.values(HOST_AGENTS).map((host) => ({
    id: host.id,
    dir: path.join(home, ...host.skillRel),
    reason: host.detect === 'always' ? 'always' : 'detected',
  }));
}

export function projectSkillTarget(cwd = process.cwd()): SkillTarget {
  return { id: 'project', dir: path.join(cwd, '.agents', 'skills', 'alive'), reason: 'project' };
}

const SKIP_SKILL_DIRS = new Set(['tests', 'plugin', 'hooks']);

function copyDir(src: string, dest: string, rel = ''): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_SKILL_DIRS.has(entry.name) || entry.name.endsWith('.test.ts')) continue;
    if (rel === 'personas' && !isOfficialPersonaFile(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to, path.posix.join(rel, entry.name));
    else fs.copyFileSync(from, to);
  }
}

function copyJsTree(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyJsTree(from, to);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.json')) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

export function repoRootFromHere(start = __dirname): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'alive', 'SKILL.md'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.resolve(start, '..', '..', '..');
}

export function buildSkill(): string {
  const root = repoRootFromHere();
  execFileSync('npx', ['tsc', '-p', 'tsconfig.json'], {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  return root;
}

const HOST_LAUNCHERS: Array<[string, string]> = [
  ['scripts/host/chat.js', 'dist-alive/scripts/host/chat.js'],
  ['scripts/host/boot.js', 'dist-alive/scripts/host/boot.js'],
  ['scripts/admin/command-handler.js', 'dist-alive/scripts/admin/command-handler.js'],
];

function writeHostLaunchers(dest: string, root: string): void {
  fs.writeFileSync(path.join(dest, '.source-root'), `${root}\n`);
  for (const [rel, target] of HOST_LAUNCHERS) {
    const file = path.join(dest, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const pkg = fs.readFileSync(path.join(__dirname, '..', '..', '.source-root'), 'utf8').trim();
const result = spawnSync(process.execPath, [path.join(pkg, ${JSON.stringify(target)}), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
`,
    );
  }
}

export function installSkillTo(dest: string, root = repoRootFromHere()): void {
  const skillSrc = path.join(root, 'alive');
  const dist = path.join(root, 'dist-alive');
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  copyDir(skillSrc, dest);
  copyJsTree(path.join(dist, 'scripts'), path.join(dest, 'scripts'));
  copyJsTree(path.join(dist, 'sub-skills'), path.join(dest, 'sub-skills'));
  writeHostLaunchers(dest, root);
}

export const DEFAULT_PERSONAS = ['minase', 'guodegang'] as const;

const OFFICIAL_PERSONA_FILES = new Set([
  'minase.yaml',
  'minase-source.png',
  'guodegang.yaml',
]);

function isOfficialPersonaFile(name: string): boolean {
  return OFFICIAL_PERSONA_FILES.has(name);
}

export function initMemory(aliveHome: string, personaId: string, root = repoRootFromHere()): void {
  const memory = path.join(aliveHome, 'personas', personaId);
  fs.mkdirSync(path.join(memory, 'persona'), { recursive: true });
  fs.mkdirSync(path.join(memory, 'state'), { recursive: true });
  fs.mkdirSync(path.join(memory, 'queues'), { recursive: true });
  const yamlSrc = path.join(root, 'alive', 'personas', `${personaId}.yaml`);
  if (fs.existsSync(yamlSrc)) {
    fs.copyFileSync(yamlSrc, path.join(memory, 'persona', 'persona.yaml'));
  }
  seedPersonaMemory(memory);
  upsertEnvFile(path.join(aliveHome, '.env'), { ALIVE_PERSONA: personaId });
}
