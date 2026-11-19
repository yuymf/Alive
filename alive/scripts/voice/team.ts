import * as fs from 'fs';
import * as path from 'path';
import { repoRootFromHere } from '../host/install';
import { DEFAULT_AGENT_NAME } from './config';

export interface TeamMember {
  id: string;
  agent_name: string;
  voice: string;
  cloned: boolean;
  worker_port: number;
}

export interface TeamConfig {
  members: TeamMember[];
}

function teamYamlPath(root = repoRootFromHere()): string {
  return path.join(root, 'alive', 'voice', 'team.yaml');
}

function parseMembers(raw: string): TeamMember[] {
  const members: TeamMember[] = [];
  let cur: Partial<TeamMember> | null = null;
  const flush = () => {
    if (!cur) return;
    if (!cur.id || !cur.agent_name || !cur.voice || cur.cloned === undefined || !cur.worker_port) {
      throw new Error(`team.yaml member incomplete: ${JSON.stringify(cur)}`);
    }
    members.push({
      id: cur.id,
      agent_name: cur.agent_name,
      voice: cur.voice,
      cloned: cur.cloned,
      worker_port: cur.worker_port,
    });
    cur = null;
  };
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.split('#', 1)[0].trimEnd();
    const s = line.trim();
    if (!s || s === 'members:' || s === '---') continue;
    if (s.startsWith('- ')) {
      flush();
      cur = {};
      const rest = s.slice(2).trim();
      if (!rest) continue;
      assign(cur, rest);
      continue;
    }
    if (!cur) continue;
    assign(cur, s);
  }
  flush();
  return members;
}

function assign(cur: Partial<TeamMember>, s: string): void {
  const i = s.indexOf(':');
  if (i < 0) return;
  const key = s.slice(0, i).trim();
  const val = s.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  if (key === 'id') cur.id = val;
  else if (key === 'agent_name') cur.agent_name = val;
  else if (key === 'voice') cur.voice = val;
  else if (key === 'cloned') cur.cloned = val.toLowerCase() === 'true';
  else if (key === 'worker_port') cur.worker_port = Number(val);
}

export function loadTeam(root = repoRootFromHere()): TeamConfig {
  const file = teamYamlPath(root);
  if (!fs.existsSync(file)) {
    throw new Error(`team.yaml not found: ${file}`);
  }
  return { members: parseMembers(fs.readFileSync(file, 'utf8')) };
}

export function resolveTeamMember(persona: string | undefined, root = repoRootFromHere()): TeamMember {
  const team = loadTeam(root);
  const wanted = (persona || '').trim();
  if (!wanted) {
    const fallback = team.members.find((m) => m.agent_name === DEFAULT_AGENT_NAME) || team.members[0];
    if (!fallback) throw new Error('team.yaml has no members');
    return fallback;
  }
  const hit = team.members.find((m) => m.id === wanted || m.agent_name === wanted);
  if (!hit) throw new Error(`unknown persona: ${wanted}`);
  return hit;
}
