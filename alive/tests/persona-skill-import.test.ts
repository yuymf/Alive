import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import YAML from 'yaml';
import {
  adoptPersonaSkill,
  isGitUrl,
  loadSourceSkillContext,
  parsePersonaSkill,
  personaFromSkill,
  slugifyPersonaId,
} from '../scripts/hub/persona-skill-import';
import { dispatch } from '../scripts/admin/command-handler';
import { loadChatContext } from '../scripts/host/chat';
import { clearPersonaCache } from '../scripts/persona/persona-loader';
import { resetBasePaths, setPersonaName } from '../scripts/utils/file-utils';

const TAFFY_SKILL = `---
name: ace-taffy
description: 这是一只塔菲喵，你想要taffy做什么喵
version: "0.2.10"
---

# ace-taffy.skill

只模仿永雏塔菲在公开平台上稳定、可复核的人格和表达方式。
不讨论中之人。默认自称 taffy，句尾可带喵。

## 运行规则

1. 不编造最新动态。
2. 风格上参考塔菲，但不要机械地每句都加喵。
`;

const TAFFY_PERSONA = `# 永雏塔菲 — Persona

## 核心设定

- 虚拟偶像
- 单机游戏主播
- 会主动制造戏剧感

## 表达基线

- 常用自称是 \`taffy\`
- 「今晚来喵！」
- 「雏草姬先坐」
- 「这要出事故了」

## 边界

- 不碰现实身份
- 不复述无法核验的原话
`;

const NUWA_SKILL = `---
name: jobs-perspective
description: Distill how Steve Jobs decides what to cut
---

# Steve Jobs 视角

## 身份卡

- 产品暴君
- 简洁偏执

## 表达DNA

- 短句，非黑即白
- 「Real artists ship」

## 价值观与反模式

- 产品即营销
- 讨厌委员会
`;

function writeSkillDir(root: string, files: Record<string, string>): string {
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  return root;
}

describe('isGitUrl / slugifyPersonaId', () => {
  it('detects github and .git URLs', () => {
    expect(isGitUrl('https://github.com/ly-xxx/ace-taffy-skill')).toBe(true);
    expect(isGitUrl('https://github.com/ly-xxx/ace-taffy-skill.git')).toBe(true);
    expect(isGitUrl('/tmp/ace-taffy')).toBe(false);
    expect(isGitUrl('ace-taffy')).toBe(false);
  });

  it('slugs ascii names and keeps compact chinese', () => {
    expect(slugifyPersonaId('ace-taffy.skill')).toBe('ace-taffy');
    expect(slugifyPersonaId('永雏塔菲')).toBe('永雏塔菲');
  });
});

describe('parsePersonaSkill + personaFromSkill', () => {
  it('reads 永雏塔菲-style skill as a living persona', () => {
    const dir = writeSkillDir(fs.mkdtempSync(path.join(os.tmpdir(), 'alive-skill-')), {
      'SKILL.md': TAFFY_SKILL,
      'persona.md': TAFFY_PERSONA,
      'references/expression-dna.md': '# dna\n喵 is a tail particle.\n',
    });
    const parsed = parsePersonaSkill(dir);
    expect(parsed.skillName).toBe('ace-taffy');
    expect(parsed.displayName).toBe('永雏塔菲');
    expect(parsed.tagline).toContain('塔菲');

    const persona = personaFromSkill(parsed, dir);
    expect(persona.meta.id).toBe('ace-taffy');
    expect(persona.meta.name).toBe('永雏塔菲');
    expect(persona.personality.core_traits).toEqual(expect.arrayContaining(['虚拟偶像']));
    expect(persona.voice.sample_lines.length).toBeGreaterThanOrEqual(3);
    expect(persona.sub_skills).toContain('web-search');
    expect(persona.sub_skills).toContain('voice-call');
    expect(persona.source_skill?.name).toBe('ace-taffy');
    expect(persona.conversation_style?.mode).toBe('topic-driver');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('strips Nuwa 「思维操作系统」 titles', () => {
    const dir = writeSkillDir(fs.mkdtempSync(path.join(os.tmpdir(), 'alive-nuwa-title-')), {
      'SKILL.md': `---
name: steve-jobs-perspective
description: 产品判断
---

# Steve Jobs · 思维操作系统

## 身份卡

- 产品暴君
- 简洁偏执
`,
    });
    expect(parsePersonaSkill(dir).displayName).toBe('Steve Jobs');
    expect(parsePersonaSkill(dir).tagline).toBe('产品判断');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('strips trailing 视角 from 峰哥 titles', () => {
    const dir = writeSkillDir(fs.mkdtempSync(path.join(os.tmpdir(), 'alive-fengge-title-')), {
      'SKILL.md': `---
name: feng-ge-perspective
description: 街头社会学家
---

# 峰哥亡命天涯视角

## 身份卡

- 辩证反转
`,
    });
    expect(parsePersonaSkill(dir).displayName).toBe('峰哥亡命天涯');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads folded YAML description as tagline', () => {
    const dir = writeSkillDir(fs.mkdtempSync(path.join(os.tmpdir(), 'alive-fold-')), {
      'SKILL.md': `---
name: wangxiaobo-perspective
description: >-
  以王小波的自由精神与黑色幽默进行写作。当用户明确要求使用这一人物的视角时使用。
---

# 王小波视角写作 Skill

## 核心设定

- 黑色幽默
- 特立独行
`,
    });
    const parsed = parsePersonaSkill(dir);
    expect(parsed.displayName).toBe('王小波');
    expect(parsed.tagline).toContain('自由精神');
    expect(parsed.tagline).not.toBe('>-');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads a Nuwa-style perspective skill', () => {
    const dir = writeSkillDir(fs.mkdtempSync(path.join(os.tmpdir(), 'alive-nuwa-')), {
      'SKILL.md': NUWA_SKILL,
    });
    const parsed = parsePersonaSkill(dir);
    const persona = personaFromSkill(parsed, dir);
    expect(persona.meta.name).toMatch(/Steve Jobs|jobs-perspective/i);
    expect(persona.personality.values).toEqual(expect.arrayContaining(['产品即营销']));
    expect(persona.voice.sample_lines.some((l) => l.includes('Real artists ship'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('adoptPersonaSkill', () => {
  const prevHome = process.env.ALIVE_HOME;
  const prevPersona = process.env.ALIVE_PERSONA;
  let tmp = '';

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.ALIVE_HOME;
    else process.env.ALIVE_HOME = prevHome;
    if (prevPersona === undefined) delete process.env.ALIVE_PERSONA;
    else process.env.ALIVE_PERSONA = prevPersona;
    resetBasePaths();
    clearPersonaCache();
  });

  function boot() {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-adopt-home-'));
    process.env.ALIVE_HOME = tmp;
    delete process.env.ALIVE_PERSONA;
    resetBasePaths();
    setPersonaName('default');
    clearPersonaCache();
  }

  it('writes persona.yaml, skill-source, and seeds memory', () => {
    boot();
    const skillDir = writeSkillDir(path.join(tmp, 'incoming'), {
      'SKILL.md': TAFFY_SKILL,
      'persona.md': TAFFY_PERSONA,
      'references/boundaries.md': '# 边界\n不碰中之人。\n',
    });
    const result = adoptPersonaSkill({ source: skillDir });
    expect(result.personaId).toBe('ace-taffy');
    expect(result.personaName).toBe('永雏塔菲');
    const yaml = YAML.parse(fs.readFileSync(result.savedPath, 'utf8')) as { meta: { name: string } };
    expect(yaml.meta.name).toBe('永雏塔菲');
    expect(fs.existsSync(path.join(tmp, 'personas', 'ace-taffy', 'skill-source', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'personas', 'ace-taffy', 'skill-source', 'persona.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'personas', 'ace-taffy', 'skill-source', 'references', 'boundaries.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'personas', 'ace-taffy', 'state', 'emotion-state.json'))).toBe(true);
    expect(fs.readFileSync(path.join(tmp, '.env'), 'utf8')).toContain('ALIVE_PERSONA=ace-taffy');
  });

  it('copies nested references/research markdown', () => {
    boot();
    const skillDir = writeSkillDir(path.join(tmp, 'nested-skill'), {
      'SKILL.md': NUWA_SKILL,
      'references/research/01-writings.md': '# writings\n公开采访。\n',
    });
    const result = adoptPersonaSkill({ source: skillDir, id: 'jobs-nested' });
    expect(fs.existsSync(path.join(tmp, 'personas', 'jobs-nested', 'skill-source', 'references', 'research', '01-writings.md'))).toBe(true);
    expect(result.personaId).toBe('jobs-nested');
  });

  it('chat load includes original skill rules after adopt', () => {
    boot();
    const skillDir = writeSkillDir(path.join(tmp, 'incoming'), {
      'SKILL.md': TAFFY_SKILL,
      'persona.md': TAFFY_PERSONA,
    });
    adoptPersonaSkill({ source: skillDir });
    resetBasePaths();
    clearPersonaCache();
    const ctx = loadChatContext();
    expect(ctx.personaName).toBe('永雏塔菲');
    expect(ctx.markdown).toContain('Source Skill');
    expect(ctx.markdown).toContain('ace-taffy');
    expect(ctx.markdown).toContain('不讨论中之人');
    expect(ctx.markdown).toContain('虚拟偶像');
    expect(loadSourceSkillContext()).toContain('SKILL.md');
  });

  it('/alive adopt without source prints usage; with path adopts', async () => {
    boot();
    const usage = await dispatch('/alive adopt');
    expect(usage.error).toBeUndefined();
    expect(usage.output).toContain('Persona Skill');
    expect(usage.output).toContain('ace-taffy');

    const skillDir = writeSkillDir(path.join(tmp, 'incoming'), {
      'SKILL.md': TAFFY_SKILL,
      'persona.md': TAFFY_PERSONA,
    });
    const result = await dispatch(`/alive adopt ${skillDir} --id taffy`);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('永雏塔菲');
    expect(result.output).toContain('taffy');
    expect(fs.existsSync(path.join(tmp, 'personas', 'taffy', 'persona', 'persona.yaml'))).toBe(true);
  });

  it('adopts every bundled example from examples/', () => {
    boot();
    const examplesRoot = path.resolve(__dirname, '..', '..', 'examples');
    const ids = fs.readdirSync(examplesRoot).filter((name) =>
      fs.existsSync(path.join(examplesRoot, name, 'SKILL.md')),
    );
    expect(ids).toEqual(expect.arrayContaining(['fengge', 'ace-taffy', 'steve-jobs', 'wangxiaobo', 'wangyangming', 'karpathy']));
    for (const id of ids) {
      const result = adoptPersonaSkill({ source: path.join(examplesRoot, id), id });
      expect(result.personaId).toBe(id);
      expect(result.personaName.length).toBeGreaterThan(1);
      expect(fs.existsSync(path.join(tmp, 'personas', id, 'skill-source', 'SKILL.md'))).toBe(true);
    }
  });
});
