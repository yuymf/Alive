// Copy the Alive skill into Code Agent skill directories.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { seedPersonaMemory, upsertEnvFile } from './memory';

export interface SkillTarget {
  id: string;
  dir: string;
  reason: 'always' | 'detected' | 'project';
}

export function detectUserSkillTargets(home = os.homedir()): SkillTarget[] {
  const targets: SkillTarget[] = [
    { id: 'agents', dir: path.join(home, '.agents', 'skills', 'alive'), reason: 'always' },
  ];
  const optional: Array<[string, string[]]> = [
    ['claude', ['.claude']],
    ['cursor', ['.cursor']],
    ['codex', ['.codex']],
  ];
  for (const [id, rel] of optional) {
    const hostRoot = path.join(home, ...rel);
    if (fs.existsSync(hostRoot)) {
      targets.push({ id, dir: path.join(hostRoot, 'skills', 'alive'), reason: 'detected' });
    }
  }
  return targets;
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

export function installSkillTo(dest: string, root = repoRootFromHere()): void {
  const skillSrc = path.join(root, 'alive');
  const dist = path.join(root, 'dist-alive');
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  copyDir(skillSrc, dest);
  copyJsTree(path.join(dist, 'scripts'), path.join(dest, 'scripts'));
  copyJsTree(path.join(dist, 'sub-skills'), path.join(dest, 'sub-skills'));
}

export const DEFAULT_PERSONAS = ['minase', 'miss-v', 'xingtong', 'guodegang'] as const;

const OFFICIAL_PERSONA_FILES = new Set([
  'minase.yaml',
  'minase-source.png',
  'miss-v.yaml',
  'miss-v-source.png',
  'xingtong.yaml',
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
  const envPath = path.join(aliveHome, '.env');
  if (!fs.existsSync(envPath)) {
    upsertEnvFile(envPath, {
      ALIVE_PERSONA: personaId,
      LLM_API_KEY: '',
      LLM_API_BASE: '',
      LLM_MODEL: '',
    });
  } else {
    upsertEnvFile(envPath, { ALIVE_PERSONA: personaId });
  }
}
