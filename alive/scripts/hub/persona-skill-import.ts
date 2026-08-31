// Adopt a Nuwa / persona SKILL.md into an Alive persona.
// Chat-only skills get emotion, memory, heartbeat, and platform actions.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { PersonaConfig } from '../utils/types';
import { PATHS } from '../utils/file-utils';
import { savePersona } from '../admin/persona-creator';

const SKILL_MD = 'SKILL.md';
const PERSONA_MD = 'persona.md';
const REFERENCES_DIR = 'references';
const DEFAULT_TRAITS = ['有主见', '表达鲜明', '有边界', '会行动'];
const LIFE_SUB_SKILLS = ['web-search', 'content-browse', 'social-engagement', 'send-message', 'voice-call'];

export interface AdoptOptions {
  source: string;
  id?: string;
  origin?: string;
}

export interface AdoptResult {
  personaId: string;
  personaName: string;
  savedPath: string;
  origin: string;
  skillName: string;
}

export interface ParsedPersonaSkill {
  skillName: string;
  displayName: string;
  tagline: string;
  body: string;
  personaMd: string;
  skillMdPath: string;
  root: string;
}

export function isGitUrl(source: string): boolean {
  const s = source.trim();
  if (/^git@[\w.-]+:/.test(s)) return true;
  if (!/^https?:\/\//i.test(s)) return false;
  if (/\.git$/i.test(s)) return true;
  return /^(https?:\/\/)(github\.com|gitlab\.com|gitee\.com)\//i.test(s);
}

export function slugifyPersonaId(raw: string): string {
  const ascii = raw
    .trim()
    .toLowerCase()
    .replace(/\.skill$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii) return ascii.slice(0, 48);
  const compact = raw.trim().replace(/\s+/g, '-').slice(0, 48);
  return compact || 'persona';
}

function parseFrontmatter(raw: string): { matter: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { matter: {}, body: raw };
  const matter: Record<string, string> = {};
  const lines = match[1].split('\n');
  let i = 0;
  while (i < lines.length) {
    const eq = lines[i].match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!eq) {
      i++;
      continue;
    }
    let val = eq[2].replace(/^["']|["']$/g, '').trim();
    if (val === '|' || val === '>' || val === '>-' || val === '|-') {
      const block: string[] = [];
      i++;
      while (i < lines.length && (/^\s+/.test(lines[i]) || lines[i].trim() === '')) {
        block.push(lines[i].replace(/^\s+/, ''));
        i++;
      }
      matter[eq[1]] = block.join(' ').trim();
      continue;
    }
    matter[eq[1]] = val;
    i++;
  }
  return { matter, body: match[2] };
}

function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = t.match(/^(.+?[。！？.!?])(?:\s|$)/);
  return m?.[1] ?? t;
}

function firstHeading(md: string): string {
  const m = md.match(/^#\s+(.+)$/m);
  if (!m) return '';
  return m[1]
    .replace(/\.skill$/i, '')
    .replace(/\s*[—–·\-]\s*思维操作系统.*$/u, '')
    .replace(/\s*思维操作系统.*$/u, '')
    .replace(/视角写作\s*Skill$/i, '')
    .replace(/\s+Skill$/i, '')
    .replace(/视角$/, '')
    .replace(/\s*[—–-]\s*.+$/, '')
    .trim();
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

function extractSection(md: string, titles: string[]): string {
  const wanted = new Set(titles.map((t) => t.toLowerCase()));
  const buf: string[] = [];
  let collecting = false;
  for (const line of md.split('\n')) {
    const heading = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (heading) {
      if (collecting) break;
      collecting = wanted.has(heading[1].toLowerCase());
      continue;
    }
    if (collecting) buf.push(line);
  }
  return buf.join('\n').trim();
}

function bullets(md: string): string[] {
  return md
    .split('\n')
    .map((line) => line.match(/^\s*[-*]\s+(.+)$/)?.[1]?.trim())
    .filter((v): v is string => Boolean(v))
    .map((v) => v.replace(/^[\s`"'「」]+|[\s`"'「」]+$/g, ''))
    .filter((v) => v.length >= 2 && v.length <= 40);
}

function quotedLines(md: string): string[] {
  const found: string[] = [];
  const re = /[「“"]([^」”"]{4,60})[」”"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) found.push(m[1].trim());
  return [...new Set(found)];
}

function inferMbti(text: string): string {
  return text.match(/\b([EI][NS][TF][JP])\b/)?.[1] ?? 'ENFP';
}

function inferLanguage(text: string): string {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return cjk > 20 ? 'zh-CN' : 'en-US';
}

function findSkillMd(root: string): string {
  const direct = path.join(root, SKILL_MD);
  if (fs.existsSync(direct)) return direct;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const nested = path.join(root, entry.name, SKILL_MD);
    if (fs.existsSync(nested)) return nested;
  }
  throw new Error(`No ${SKILL_MD} found in ${root}`);
}

export function parsePersonaSkill(root: string): ParsedPersonaSkill {
  const skillMdPath = findSkillMd(root);
  const skillRoot = path.dirname(skillMdPath);
  const raw = fs.readFileSync(skillMdPath, 'utf8');
  const { matter, body } = parseFrontmatter(raw);
  const personaPath = path.join(skillRoot, PERSONA_MD);
  const personaMd = fs.existsSync(personaPath) ? fs.readFileSync(personaPath, 'utf8') : '';
  const combined = `${personaMd}\n${body}`;
  const skillName = (matter.name || firstHeading(body) || path.basename(skillRoot)).trim();
  const displayName = firstHeading(personaMd) || firstHeading(body) || skillName;
  const tagline = clip(
    firstSentence(matter.description || '') || bullets(combined)[0] || `${displayName} persona skill`,
    80,
  );
  return { skillName, displayName, tagline, body, personaMd, skillMdPath, root: skillRoot };
}

export function personaFromSkill(parsed: ParsedPersonaSkill, origin: string, id?: string): PersonaConfig {
  const combined = `${parsed.personaMd}\n${parsed.body}`;
  const traitSection = extractSection(combined, ['核心设定', '身份卡', '性格', '特质', 'Core', 'Identity']);
  const valueSection = extractSection(combined, ['边界', '价值观与反模式', '价值观', 'Boundaries', 'Values']);
  const voiceSection = extractSection(combined, ['表达基线', '表达DNA', '表达', '语气', 'Voice', 'Expression']);
  const traits = bullets(traitSection).slice(0, 5);
  const values = bullets(valueSection).slice(0, 6);
  const samples = quotedLines(combined).slice(0, 8);
  const fallbackLine = `${parsed.displayName}在。`;
  const sampleLines = (samples.length >= 3 ? samples : [...samples, fallbackLine, `${parsed.displayName}，开始。`, '先把这件事做成节目。']).slice(0, 10);
  const coreTraits = (traits.length >= 2 ? traits : DEFAULT_TRAITS).slice(0, 5);
  const performer = /主播|偶像|vtuber|直播|streamer|idol/i.test(combined);

  return {
    meta: {
      name: parsed.displayName,
      name_reading: parsed.skillName,
      id: slugifyPersonaId(id || parsed.skillName || parsed.displayName),
      tagline: parsed.tagline,
      occupation_detail: clip(extractSection(combined, ['核心设定', '身份卡', '职业', '定位']) || parsed.tagline, 600),
    },
    personality: {
      mbti: inferMbti(combined),
      core_traits: coreTraits,
      values: values.length ? values : ['公开人格可复核', '不编造未证实事实', '不碰现实身份'],
      description: clip(parsed.personaMd || parsed.body, 1200),
      trait_descriptions: clip(traitSection || parsed.tagline, 800),
    },
    voice: {
      language: inferLanguage(combined),
      style: clip(voiceSection || parsed.tagline, 280),
      emoji_density: performer ? 'high' : 'medium',
      sample_lines: sampleLines,
      style_description: clip(voiceSection, 600),
      diary_style_guide: '按原始 persona skill 的自称、口癖和边界写日记，不要写成客服或说明书。',
    },
    intimacy: {
      levels: 5,
      behaviors: {
        1: '礼貌、保持公开营业距离',
        3: '能开玩笑，记得对方提过的事',
        5: '更松、更熟，但仍守 skill 边界',
      },
    },
    schedule: {
      wake_hour: performer ? 11 : 9,
      sleep_hour: performer ? 2 : 23,
      timezone: 'Asia/Shanghai',
      active_peaks: performer ? [15, 21] : [14, 21],
    },
    conversation_style: {
      mode: performer ? 'topic-driver' : 'balanced',
      traits: ['先接住情绪再给判断', '用自己的经历展开，不等人提问'],
      anti_patterns: ['客服腔', '百科说明书', '每句堆口癖'],
    },
    sub_skills: [...LIFE_SUB_SKILLS],
    features: {
      content_browse: true,
    },
    source_skill: {
      name: parsed.skillName,
      origin,
      adopted_at: new Date().toISOString(),
    },
  };
}

function copyMarkdownTree(src: string, dest: string): void {
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyMarkdownTree(from, to);
    else if (entry.isFile() && entry.name.endsWith('.md')) fs.copyFileSync(from, to);
  }
}

export function listMarkdownRel(dir: string, prefix = ''): string[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(full).isDirectory()) out.push(...listMarkdownRel(full, rel));
    else if (name.endsWith('.md')) out.push(rel);
  }
  return out;
}

function copySkillSource(skillRoot: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const skillMd = path.join(skillRoot, SKILL_MD);
  if (fs.existsSync(skillMd)) fs.copyFileSync(skillMd, path.join(dest, SKILL_MD));
  const personaMd = path.join(skillRoot, PERSONA_MD);
  if (fs.existsSync(personaMd)) fs.copyFileSync(personaMd, path.join(dest, PERSONA_MD));
  copyMarkdownTree(path.join(skillRoot, REFERENCES_DIR), path.join(dest, REFERENCES_DIR));
}

export function skillMdExists(root: string): boolean {
  try {
    findSkillMd(root);
    return true;
  } catch {
    return false;
  }
}

export function resolveSkillSource(source: string): { root: string; cleanup?: string; origin: string } {
  return isGitUrl(source) ? cloneGitSource(source) : resolveLocalSource(source);
}

function resolveLocalSource(source: string): { root: string; cleanup?: string; origin: string } {
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Skill path not found: ${source}`);
  }
  const root = fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  return { root, origin: root };
}

function cloneGitSource(url: string): { root: string; cleanup: string; origin: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-adopt-'));
  execFileSync('git', ['clone', '--depth', '1', '--single-branch', url, tmp], {
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { root: tmp, cleanup: tmp, origin: url };
}

export function adoptPersonaSkill(options: AdoptOptions): AdoptResult {
  const source = options.source.trim();
  if (!source) throw new Error('adopt needs a local skill directory or a git URL');

  const resolved = isGitUrl(source) ? cloneGitSource(source) : resolveLocalSource(source);
  try {
    const parsed = parsePersonaSkill(resolved.root);
    const origin = options.origin || resolved.origin;
    const persona = personaFromSkill(parsed, origin, options.id);
    const savedPath = savePersona(persona);
    const personaId = persona.meta.id!;
    const memoryRoot = path.dirname(path.dirname(savedPath));
    copySkillSource(parsed.root, path.join(memoryRoot, 'skill-source'));
    return {
      personaId,
      personaName: persona.meta.name,
      savedPath,
      origin,
      skillName: parsed.skillName,
    };
  } finally {
    if (resolved.cleanup) fs.rmSync(resolved.cleanup, { recursive: true, force: true });
  }
}

function clipBlock(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}\n\n…(truncated)`;
}

/** Full skill rules for host chat. */
export function loadSourceSkillContext(maxChars = 16_000): string {
  const dir = PATHS.skillSourceDir;
  if (!fs.existsSync(dir)) return '';
  const parts: string[] = [];
  for (const name of [SKILL_MD, PERSONA_MD]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    parts.push(`### ${name}\n\n${fs.readFileSync(file, 'utf8').trim()}`);
  }
  const refs = path.join(dir, REFERENCES_DIR);
  if (fs.existsSync(refs)) {
    const names = listMarkdownRel(refs);
    if (names.length) parts.push(`### references\n${names.map((n) => `- ${n}`).join('\n')}`);
  }
  return clipBlock(parts.join('\n\n'), maxChars);
}

/** Shorter excerpt for heartbeat prompts. */
export function loadSourceSkillBrief(maxChars = 3_000): string {
  const dir = PATHS.skillSourceDir;
  const personaMd = path.join(dir, PERSONA_MD);
  const skillMd = path.join(dir, SKILL_MD);
  const file = fs.existsSync(personaMd) ? personaMd : skillMd;
  if (!fs.existsSync(file)) return '';
  return clipBlock(fs.readFileSync(file, 'utf8'), maxChars);
}
