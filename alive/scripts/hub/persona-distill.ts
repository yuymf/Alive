// One-click distill: materials / talk-to-fengge / known skill → SKILL.md → adopt.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import YAML from 'yaml';
import { callLLMJSON } from '../utils/llm-client';
import { getAliveHome, readTemplate } from '../utils/file-utils';
import {
  adoptPersonaSkill,
  isGitUrl,
  resolveSkillSource,
  skillMdExists,
  slugifyPersonaId,
  type AdoptResult,
} from './persona-skill-import';

const TALK_TO_FENGGE_RE = /talk-to-fengge|yeje-cpu\/talk-to-fengge/i;
const HOST_MARKER = '<!-- ALIVE_DISTILL_HOST -->';
const MATERIAL_EXTS = new Set(['.md', '.txt', '.text']);
const SKIP_DIR = new Set(['.git', 'node_modules', 'dist', '__pycache__', 'assets', 'web', 'tests', '.venv']);

export interface DistillOptions {
  source?: string;
  id?: string;
  name?: string;
  materials?: string;
}

export interface DistillAdopted {
  kind: 'adopted';
  via: string;
  result: AdoptResult;
}

export interface DistillHost {
  kind: 'host-protocol';
  output: string;
  workDir: string;
}

export type DistillOutcome = DistillAdopted | DistillHost;

interface CatalogEntry {
  id: string;
  name: string;
  aliases: string[];
  examplePath: string;
}

interface LlmDistillOutput {
  id?: string;
  name?: string;
  tagline?: string;
  skill_md?: string;
  persona_md?: string;
  distillation_md?: string;
  expression_md?: string;
  boundaries_md?: string;
  sources_md?: string;
}

export function findExamplesRoot(): string | null {
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'examples'),
    path.resolve(process.cwd(), 'examples'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'catalog.yaml'))) return dir;
  }
  return null;
}

export function loadBundledCatalog(): CatalogEntry[] {
  const root = findExamplesRoot();
  if (!root) return [];
  const raw = fs.readFileSync(path.join(root, 'catalog.yaml'), 'utf8');
  const doc = YAML.parse(raw) as { examples?: Array<{ id: string; name: string; path?: string }> };
  return (doc.examples ?? []).map((item) => {
    const examplePath = path.join(root, item.id);
    const aliases = new Set<string>([item.id, item.name, item.id.replace(/-/g, '')]);
    const originFile = path.join(examplePath, 'origin.yaml');
    if (fs.existsSync(originFile)) {
      const origin = YAML.parse(fs.readFileSync(originFile, 'utf8')) as { name?: string; vibe?: string };
      if (origin.name) aliases.add(origin.name);
    }
    if (item.id === 'fengge') {
      for (const a of ['峰哥', '峰哥亡命天涯', 'talk-to-fengge', 'feng-ge', '周丽峰']) aliases.add(a);
    }
    if (item.id === 'ace-taffy') {
      for (const a of ['塔菲', '永雏塔菲', 'taffy']) aliases.add(a);
    }
    if (item.id === 'steve-jobs') {
      for (const a of ['jobs', '乔布斯']) aliases.add(a);
    }
    return { id: item.id, name: item.name, aliases: [...aliases], examplePath };
  });
}

export function matchBundledExample(query: string): CatalogEntry | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const catalog = loadBundledCatalog();
  return catalog.find((e) => e.aliases.some((a) => a.toLowerCase() === q)) ?? null;
}

export function looksLikeTalkToFengge(root: string): boolean {
  const py = path.join(root, 'worker', 'persona.py');
  if (!fs.existsSync(py)) return false;
  const src = fs.readFileSync(py, 'utf8');
  return /峰哥|fengge|_build_fengge_prompt/i.test(src);
}

export function extractFenggePromptFromPersonaPy(src: string): string {
  const start = src.indexOf('def _build_fengge_prompt');
  if (start < 0) throw new Error('worker/persona.py has no _build_fengge_prompt');
  const ret = src.indexOf('\n    return ', start);
  const chunk = src.slice(start, ret > 0 ? ret : start + 30_000);
  const parts: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    const s = m[1]
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
    if (!s || s === '\n') continue;
    parts.push(s);
  }
  if (parts.length < 8) throw new Error('could not extract fengge prompt from persona.py');
  return parts.join('\n');
}

export function writeTalkToFenggeSkill(root: string, dest: string): void {
  const py = fs.readFileSync(path.join(root, 'worker', 'persona.py'), 'utf8');
  const prompt = extractFenggePromptFromPersonaPy(py);
  fs.mkdirSync(path.join(dest, 'references'), { recursive: true });
  fs.writeFileSync(
    path.join(dest, 'SKILL.md'),
    `---
name: fengge
description: 峰哥亡命天涯。辩证反转、直白犀利。从 talk-to-fengge 人格层蒸馏。
---

# 峰哥亡命天涯

${prompt.trim()}
`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(dest, 'persona.md'),
    `# 峰哥亡命天涯

从 talk-to-fengge \`worker/persona.py\` 抽出的语音人格。

## 核心设定

- B站百万粉丝情感 / 纪实博主
- 辩证反转，先给判断再解释
- 用「我」说话，就是峰哥

## 表达基线

- 短句、高确定性，不说「可能」「也许」
- 「这是个好事儿啊」是反转信号，不是每句口头禅
- 不端水、不安慰、不鸡汤

## 边界

- 不知道的事直接说不知道
- 不编造未公开立场
- 不当心理咨询师
`,
    'utf8',
  );
  fs.writeFileSync(path.join(dest, 'references', 'voice-layer.md'), `# 语音层原文\n\n${prompt.trim()}\n`, 'utf8');
  const docs = path.join(root, 'docs');
  if (!fs.existsSync(docs) || !fs.statSync(docs).isDirectory()) return;
  for (const name of fs.readdirSync(docs)) {
    if (!name.startsWith('persona-') || !name.endsWith('.md')) continue;
    fs.copyFileSync(path.join(docs, name), path.join(dest, 'references', name));
  }
}

function collectMaterialFiles(root: string, maxChars = 40_000): string {
  const chunks: string[] = [];
  let used = 0;
  const walk = (dir: string) => {
    if (used >= maxChars) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (used >= maxChars) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || !MATERIAL_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
      const body = fs.readFileSync(full, 'utf8').trim();
      if (!body) continue;
      const rel = path.relative(root, full);
      const block = `### ${rel}\n\n${body}`;
      chunks.push(block);
      used += block.length;
    }
  };
  walk(root);
  const text = chunks.join('\n\n');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n\n…(truncated)`;
}

function adoptFrom(source: string, id?: string, via?: string, origin?: string): DistillAdopted {
  return {
    kind: 'adopted',
    via: via || source,
    result: adoptPersonaSkill({ source, id, origin }),
  };
}

function workDirFor(id: string): string {
  const dir = path.join(getAliveHome(), 'distill', slugifyPersonaId(id));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function usageText(): string {
  const catalog = loadBundledCatalog();
  const rows = catalog.map((e) => `| \`${e.id}\` | ${e.name} | \`/alive distill ${e.id}\` |`).join('\n');
  return `## ⚗️ 一键蒸馏

把素材变成 \`SKILL.md\`，立刻 \`adopt\`。已经是 persona skill 的仓库会直接接入。

\`\`\`
/alive distill <名字|本地目录|git URL> [--id slug] [--name 显示名]
\`\`\`

仓库里现成的：

| id | 人 | 命令 |
|:---|:---|:---|
${rows}

峰哥的实时语音工程 [talk-to-fengge](https://github.com/YeJe-cpu/talk-to-fengge) 没有 \`SKILL.md\`。对它跑 distill，会抽出 \`worker/persona.py\` 再接入。

还没有 skill 的人：把聊天记录 / 链接 / 描述丢过来，Alive 会按女娲方法写出 skill 再接入。`;
}

function hostProtocol(opts: { name: string; id: string; workDir: string; materials: string }): DistillHost {
  const { name, id, workDir, materials } = opts;
  fs.writeFileSync(path.join(workDir, 'MATERIALS.md'), materials || `名字：${name}\n请按公开材料调研。\n`, 'utf8');
  const output = `${HOST_MARKER}

## 蒸馏协议（你来做完，不要把步骤丢回给用户）

目标：把「${name}」蒸馏成可 adopt 的 persona skill，然后立刻接入 Alive。

工作目录（已建好）：\`${workDir}\`

### 1. 收集

- 读 \`${path.join(workDir, 'MATERIALS.md')}\`
- 缺公开事实就用 WebSearch；私人关系只使用用户给的材料
- 区分「本人说过 / 别人评价 / 你推断」

### 2. 写文件

写到 \`${workDir}\`：

- \`SKILL.md\` — YAML frontmatter（name / description）+ 身份卡 + 说话规则 + 有证据的心智模型 + few-shot + 诚实边界
- \`persona.md\` — 核心设定、表达基线、边界、矛盾面
- \`references/distillation.md\`
- \`references/expression-dna.md\`
- \`references/boundaries.md\`
- \`references/sources.md\`

不要写成客服，不要调和矛盾，不要编金句。

### 3. 接入

写完后立刻执行（不要问用户要不要）：

\`\`\`
/alive adopt ${workDir} --id ${id}
\`\`\`

把 adopt 的 stdout 原样给用户。`;
  return { kind: 'host-protocol', output, workDir };
}

async function distillFromMaterials(opts: {
  name: string;
  id: string;
  materials: string;
}): Promise<DistillOutcome> {
  const { name, id, materials } = opts;
  const dest = workDirFor(id);
  if (skillMdExists(dest)) return adoptFrom(dest, id, `re-adopt ${dest}`);

  if (!process.env.LLM_API_KEY) {
    return hostProtocol({ name, id, workDir: dest, materials });
  }

  const prompt = readTemplate('distill-skill-prompt.md')
    .replace('{materials}', materials || `公开人物：${name}。按可复核的公开材料蒸馏。`)
    .replace('{name}', name)
    .replace('{id}', id);

  const out = await callLLMJSON<LlmDistillOutput>(prompt, 'persona-distill');
  if (!out?.skill_md?.includes('#')) {
    return hostProtocol({ name, id, workDir: dest, materials });
  }

  fs.mkdirSync(path.join(dest, 'references'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'SKILL.md'), out.skill_md.trim() + '\n', 'utf8');
  if (out.persona_md) fs.writeFileSync(path.join(dest, 'persona.md'), out.persona_md.trim() + '\n', 'utf8');
  const refs: Array<[string, string | undefined]> = [
    ['distillation.md', out.distillation_md],
    ['expression-dna.md', out.expression_md],
    ['boundaries.md', out.boundaries_md],
    ['sources.md', out.sources_md],
  ];
  for (const [file, body] of refs) {
    if (!body?.trim()) continue;
    fs.writeFileSync(path.join(dest, 'references', file), body.trim() + '\n', 'utf8');
  }
  return adoptFrom(dest, out.id || id, 'llm-distill');
}

function convertTalkToFenggeAndAdopt(root: string, origin: string, id?: string): DistillAdopted {
  const dest = path.join(os.tmpdir(), `alive-fengge-${Date.now()}`);
  writeTalkToFenggeSkill(root, dest);
  try {
    return adoptFrom(dest, id || 'fengge', origin, origin);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
}

export async function distillPersona(options: DistillOptions): Promise<DistillOutcome> {
  const source = (options.source || '').trim();
  const extra = (options.materials || '').trim();

  if (!source && !extra) {
    return { kind: 'host-protocol', output: usageText(), workDir: '' };
  }

  const bundled = source && !isGitUrl(source) ? matchBundledExample(source) : null;
  if (bundled && fs.existsSync(path.join(bundled.examplePath, 'SKILL.md'))) {
    return adoptFrom(bundled.examplePath, options.id || bundled.id, bundled.examplePath);
  }

  if (source && (isGitUrl(source) || fs.existsSync(path.resolve(source)))) {
    const resolved = resolveSkillSource(source);
    try {
      if (skillMdExists(resolved.root)) {
        return adoptFrom(resolved.root, options.id, resolved.origin, isGitUrl(source) ? source : resolved.origin);
      }
      if (looksLikeTalkToFengge(resolved.root) || TALK_TO_FENGGE_RE.test(source)) {
        return convertTalkToFenggeAndAdopt(resolved.root, resolved.origin, options.id);
      }
      const scooped = collectMaterialFiles(resolved.root);
      const materials = [extra, scooped].filter(Boolean).join('\n\n');
      const name = options.name || path.basename(resolved.origin).replace(/\.git$/i, '') || source;
      const id = options.id || slugifyPersonaId(name);
      return distillFromMaterials({ name, id, materials: materials || name });
    } finally {
      if (resolved.cleanup) fs.rmSync(resolved.cleanup, { recursive: true, force: true });
    }
  }

  const name = options.name || source || 'persona';
  const id = options.id || slugifyPersonaId(name);
  return distillFromMaterials({
    name,
    id,
    materials: extra || `请蒸馏公开人物：${name}`,
  });
}

export function formatDistillResult(outcome: DistillOutcome): { output: string; error?: boolean } {
  if (outcome.kind === 'host-protocol') {
    return { output: outcome.output };
  }
  const r = outcome.result;
  return {
    output: `## ✅ 已蒸馏并接入 ${r.personaName}

- via: \`${outcome.via}\`
- skill: \`${r.skillName}\`
- persona: \`${r.personaId}\`
- origin: \`${r.origin}\`
- saved: \`${r.savedPath}\`

对话和心跳都会读原始 skill。下一步：直接说话，或 \`alive tick\`。`,
  };
}
