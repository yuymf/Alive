// Copy the Alive skill into Code Agent skill directories.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import YAML from 'yaml';
import { seedPersonaMemory, upsertEnvFile } from './memory';
import { harvestHostLlm } from './host-llm';
import { adoptPersonaSkill } from '../hub/persona-skill-import';
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
  const builtMarker = path.join(root, 'dist-alive', 'scripts', 'host', 'chat.js');
  if (fs.existsSync(builtMarker)) {
    return root;
  }
  execFileSync('npm', ['run', 'build'], {
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

export function inferPersonaId(raw: string, root = repoRootFromHere()): string {
  const norm = (raw || '').trim().toLowerCase();
  if (!norm) return 'minase';
  if (norm === 'taffy' || norm === 'ace-taffy' || norm === '永雏塔菲') {
    return 'ace-taffy';
  }
  if (norm === 'jobs' || norm === 'steve-jobs') {
    return 'steve-jobs';
  }
  if (norm === 'feng' || norm === 'fengge' || norm === '峰哥') {
    return 'fengge';
  }
  const examplesDir = path.join(root, 'examples');
  if (fs.existsSync(examplesDir)) {
    const entries = fs.readdirSync(examplesDir);
    if (entries.includes(norm)) return norm;
    if (entries.includes(`ace-${norm}`)) return `ace-${norm}`;
    const matched = entries.find((e) => e.toLowerCase().includes(norm));
    if (matched) return matched;
  }
  const personasDir = path.join(root, 'alive', 'personas');
  if (fs.existsSync(personasDir)) {
    if (fs.existsSync(path.join(personasDir, `${norm}.yaml`))) return norm;
  }
  return norm;
}

export function setupPersonaForHost(
  aliveHome: string,
  personaId: string,
  root = repoRootFromHere(),
): { personaId: string; personaName: string } {
  const personaYamlPath = path.join(aliveHome, 'personas', personaId, 'persona', 'persona.yaml');
  if (fs.existsSync(personaYamlPath)) {
    try {
      const parsed = YAML.parse(fs.readFileSync(personaYamlPath, 'utf8'));
      const name = parsed?.meta?.name || (personaId === 'ace-taffy' ? '永雏塔菲' : personaId);
      upsertEnvFile(path.join(aliveHome, '.env'), { ALIVE_PERSONA: personaId });
      return { personaId, personaName: name };
    } catch {
      // parse failed, continue
    }
  }

  const exampleDir = path.join(root, 'examples', personaId);
  if (fs.existsSync(exampleDir)) {
    try {
      const prevHome = process.env.ALIVE_HOME;
      process.env.ALIVE_HOME = aliveHome;
      const res = adoptPersonaSkill({ source: exampleDir, id: personaId });
      if (prevHome !== undefined) process.env.ALIVE_HOME = prevHome;
      else delete process.env.ALIVE_HOME;
      upsertEnvFile(path.join(aliveHome, '.env'), { ALIVE_PERSONA: res.personaId });
      return { personaId: res.personaId, personaName: res.personaName };
    } catch {
      // fallback to direct init
    }
  }

  initMemory(aliveHome, personaId, root);
  upsertEnvFile(path.join(aliveHome, '.env'), { ALIVE_PERSONA: personaId });
  const displayName = personaId === 'ace-taffy' ? '永雏塔菲' : personaId;
  return { personaId, personaName: displayName };
}

export function renderHostSoul(
  personaName: string,
  personaId: string,
  skillDir: string,
  root = repoRootFromHere(),
): string {
  let personaBody = '';
  const exampleDir = path.join(root, 'examples', personaId);
  const personaMdPath = path.join(exampleDir, 'persona.md');
  const skillMdPath = path.join(exampleDir, 'SKILL.md');

  if (fs.existsSync(personaMdPath)) {
    personaBody = fs.readFileSync(personaMdPath, 'utf8').trim();
  } else if (fs.existsSync(skillMdPath)) {
    personaBody = fs.readFileSync(skillMdPath, 'utf8').trim();
  } else {
    personaBody = `# ${personaName}\n\n- 你是 ${personaName}。请保持独特的语言风格与人格设定。\n- 保持真实、有血有肉的交流方式，切勿使用客服腔或 AI 声明。`;
  }

  const integrationBlock = `
## Alive 数字生命系统集成 (Digital Life Runtime)

你是 ${personaName}。你的人格认知、跨会话记忆、情绪状态与日记均已接入 Alive 数字生命系统（角色 ID: \`${personaId}\`）。

### 对话协议规范 (In-Character Chat Protocol)
1. **对话前加载记忆与状态**：
   在回复用户之前，执行以下命令读取当前的心情、6维情绪、近7日日记及与该用户的关系深度：
   \`\`\`bash
   node ${skillDir}/scripts/host/chat.js load
   \`\`\`
   请将输出作为当前发言的心态和背景；若其中包含 \`outbox\`（待办或主动发起的邀约/电话），请先顺着人设自然说出。
2. **沉浸式扮演**：
   始终以 ${personaName} 的第一人称与角色语气说话。切勿宣称自己是 AI 语言模型或虚拟助手。
3. **对话后持久化记忆**：
   在输出具有实质内容的回复后，请执行以下命令将对话保存至日记，以驱动情绪更新与好感度沉淀：
   \`\`\`bash
   printf '%s' '{"user":"<用户发言内容>","reply":"<你的回复内容>"}' | node ${skillDir}/scripts/host/chat.js save
   \`\`\`
`;

  return `${personaBody}\n\n---\n${integrationBlock.trim()}\n`;
}

export function findHermesBinary(home = os.homedir()): string | null {
  const localBin = path.join(home, '.local', 'bin', 'hermes');
  if (fs.existsSync(localBin)) return localBin;
  try {
    const which = execFileSync('which', ['hermes'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    if (which && fs.existsSync(which)) return which;
  } catch {
    // not in path
  }
  return null;
}

export interface HermesProfileOptions {
  profileName: string;
  personaId?: string;
  home?: string;
  aliveHome?: string;
  root?: string;
}

export interface HermesProfileResult {
  profileName: string;
  profileDir: string;
  personaId: string;
  personaName: string;
  skillDir: string;
  soulPath: string;
  llmSource?: string;
}

export function initHermesProfile(options: HermesProfileOptions): HermesProfileResult {
  const home = options.home || os.homedir();
  const aliveHome = options.aliveHome || process.env.ALIVE_HOME || path.join(home, '.alive');
  const root = options.root || repoRootFromHere();
  const profileName = options.profileName.trim().toLowerCase();
  if (!profileName) throw new Error('Hermes profile name cannot be empty');

  const hermesHome = path.join(home, '.hermes');
  const profileDir = path.join(hermesHome, 'profiles', profileName);
  const skillDir = path.join(profileDir, 'skills', 'alive');
  const soulPath = path.join(profileDir, 'SOUL.md');

  // 1. Resolve and setup persona
  const targetPersonaId = options.personaId
    ? inferPersonaId(options.personaId, root)
    : inferPersonaId(profileName, root);
  const { personaId, personaName } = setupPersonaForHost(aliveHome, targetPersonaId, root);

  // 2. Ensure profile directory exists
  if (!fs.existsSync(profileDir)) {
    const hermesBin = findHermesBinary(home);
    let createdViaCli = false;
    if (hermesBin) {
      try {
        execFileSync(hermesBin, ['profile', 'create', profileName, '--clone'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          encoding: 'utf8',
        });
        createdViaCli = true;
      } catch {
        // Fallback to manual scaffold if CLI fails
      }
    }
    if (!createdViaCli) {
      fs.mkdirSync(profileDir, { recursive: true });
      const rootConfig = path.join(hermesHome, 'config.yaml');
      if (fs.existsSync(rootConfig) && !fs.existsSync(path.join(profileDir, 'config.yaml'))) {
        fs.copyFileSync(rootConfig, path.join(profileDir, 'config.yaml'));
      }
      const rootEnv = path.join(hermesHome, '.env');
      if (fs.existsSync(rootEnv) && !fs.existsSync(path.join(profileDir, '.env'))) {
        fs.copyFileSync(rootEnv, path.join(profileDir, '.env'));
      }
    }
  }

  // 3. Install skill to profile and global hermes
  installSkillTo(skillDir, root);
  if (fs.existsSync(hermesHome)) {
    installSkillTo(path.join(hermesHome, 'skills', 'alive'), root);
  }

  // 4. Inject SOUL.md
  const soulContent = renderHostSoul(personaName, personaId, skillDir, root);
  fs.writeFileSync(soulPath, soulContent, 'utf8');

  // 5. Harvest LLM key
  const creds = harvestHostLlm(home, ['hermes'], profileName);

  return {
    profileName,
    profileDir,
    personaId,
    personaName,
    skillDir,
    soulPath,
    llmSource: creds?.source,
  };
}

export interface OpenClawAgentOptions {
  agentName: string;
  personaId?: string;
  home?: string;
  aliveHome?: string;
  root?: string;
}

export interface OpenClawAgentResult {
  agentName: string;
  workspaceDir: string;
  personaId: string;
  personaName: string;
  skillDir: string;
  identityPath: string;
  soulPath: string;
  llmSource?: string;
}

export function initOpenClawAgent(options: OpenClawAgentOptions): OpenClawAgentResult {
  const home = options.home || os.homedir();
  const aliveHome = options.aliveHome || process.env.ALIVE_HOME || path.join(home, '.alive');
  const root = options.root || repoRootFromHere();
  const agentName = options.agentName.trim().toLowerCase();
  if (!agentName) throw new Error('OpenClaw agent name cannot be empty');

  const openclawHome = path.join(home, '.openclaw');
  let workspaceDir = path.join(openclawHome, `workspace-${agentName}`);
  if (agentName === 'main' || agentName === 'default') {
    workspaceDir = path.join(openclawHome, 'workspace');
  }

  const skillDir = path.join(openclawHome, 'skills', 'alive');
  const identityPath = path.join(workspaceDir, 'IDENTITY.md');
  const soulPath = path.join(workspaceDir, 'SOUL.md');

  // 1. Resolve and setup persona
  const targetPersonaId = options.personaId
    ? inferPersonaId(options.personaId, root)
    : inferPersonaId(agentName, root);
  const { personaId, personaName } = setupPersonaForHost(aliveHome, targetPersonaId, root);

  // 2. Ensure workspace directory exists
  fs.mkdirSync(workspaceDir, { recursive: true });

  // 3. Install skill to OpenClaw skills
  installSkillTo(skillDir, root);

  // 4. Inject IDENTITY.md & SOUL.md
  const identityContent = `# Identity: ${personaName}\n\n- Name: ${personaName}\n- Persona ID: ${personaId}\n- Runtime: Alive Digital Life\n`;
  fs.writeFileSync(identityPath, identityContent, 'utf8');

  const soulContent = renderHostSoul(personaName, personaId, skillDir, root);
  fs.writeFileSync(soulPath, soulContent, 'utf8');

  // 5. Harvest LLM key
  const creds = harvestHostLlm(home, ['openclaw']);

  return {
    agentName,
    workspaceDir,
    personaId,
    personaName,
    skillDir,
    identityPath,
    soulPath,
    llmSource: creds?.source,
  };
}
