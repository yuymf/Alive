import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dispatch } from '../scripts/admin/command-handler';
import {
  distillPersona,
  extractFenggePromptFromPersonaPy,
  looksLikeTalkToFengge,
  matchBundledExample,
  writeTalkToFenggeSkill,
} from '../scripts/hub/persona-distill';
import { clearPersonaCache } from '../scripts/persona/persona-loader';
import { resetBasePaths, setPersonaName } from '../scripts/utils/file-utils';

const FENGGE_PY = `
def _build_fengge_prompt() -> str:
    parts = [
        "你是峰哥的 AI 分身。",
        "",
        "## 铁律（违反任何一条都不像我）",
        "1. 用「我」说话，你就是峰哥。",
        "2. 说话简练。",
        "",
        "## 我是谁（对方问到再说，不要主动介绍）",
        "峰哥，本名周丽峰。",
        "",
        "## 我说话的方式",
        "- 短句断开。",
        "- 「这是个好事儿啊」",
        "",
        "## 对话示例（模仿这个风格和长度）",
        "粉丝：我被绿了。",
        "我：这不好事吗？早发现比晚发现强。",
    ]
    return "\\n".join(parts)
`;

describe('talk-to-fengge conversion', () => {
  it('extracts the inline prompt from persona.py', () => {
    const prompt = extractFenggePromptFromPersonaPy(FENGGE_PY);
    expect(prompt).toContain('你是峰哥的 AI 分身');
    expect(prompt).toContain('这是个好事儿啊');
    expect(prompt).toContain('早发现比晚发现强');
  });

  it('detects a talk-to-fengge tree and writes a skill', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-ttf-'));
    fs.mkdirSync(path.join(root, 'worker'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'worker', 'persona.py'), FENGGE_PY);
    fs.writeFileSync(path.join(root, 'docs', 'persona-speech-habits.md'), '# 口头禅\n对吧？\n');
    expect(looksLikeTalkToFengge(root)).toBe(true);
    const dest = path.join(root, 'out');
    writeTalkToFenggeSkill(root, dest);
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toContain('峰哥亡命天涯');
    expect(fs.existsSync(path.join(dest, 'references', 'persona-speech-habits.md'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'references', 'voice-layer.md'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('distillPersona', () => {
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
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-distill-home-'));
    process.env.ALIVE_HOME = tmp;
    delete process.env.ALIVE_PERSONA;
    resetBasePaths();
    setPersonaName('default');
    clearPersonaCache();
  }

  it('matches bundled 峰哥', () => {
    const hit = matchBundledExample('峰哥');
    expect(hit?.id).toBe('fengge');
    expect(fs.existsSync(path.join(hit!.examplePath, 'SKILL.md'))).toBe(true);
  });

  it('distill 峰哥 adopts the bundled example', async () => {
    boot();
    const outcome = await distillPersona({ source: '峰哥' });
    expect(outcome.kind).toBe('adopted');
    if (outcome.kind !== 'adopted') return;
    expect(outcome.result.personaId).toBe('fengge');
    expect(outcome.result.personaName).toContain('峰哥');
    expect(fs.existsSync(path.join(tmp, 'personas', 'fengge', 'skill-source', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'personas', 'fengge', 'skill-source', 'references', 'research', '03-expression-dna.md'))).toBe(true);
  });

  it('distill of a talk-to-fengge tree converts then adopts', async () => {
    boot();
    const root = path.join(tmp, 'talk-to-fengge');
    fs.mkdirSync(path.join(root, 'worker'), { recursive: true });
    fs.writeFileSync(path.join(root, 'worker', 'persona.py'), FENGGE_PY);
    const outcome = await distillPersona({ source: root, id: 'fengge-voice' });
    expect(outcome.kind).toBe('adopted');
    if (outcome.kind !== 'adopted') return;
    expect(outcome.result.personaId).toBe('fengge-voice');
    const skill = fs.readFileSync(path.join(tmp, 'personas', 'fengge-voice', 'skill-source', 'SKILL.md'), 'utf8');
    expect(skill).toContain('你是峰哥的 AI 分身');
  });

  it('empty distill prints usage; unknown name without key returns host protocol', async () => {
    boot();
    delete process.env.LLM_API_KEY;
    const usage = await dispatch('/alive distill');
    expect(usage.error).toBeUndefined();
    expect(usage.output).toContain('一键蒸馏');
    expect(usage.output).toContain('峰哥');

    const host = await dispatch('/alive distill 某个没人蒸馏过的网红');
    expect(host.error).toBeUndefined();
    expect(host.output).toContain('ALIVE_DISTILL_HOST');
    expect(host.output).toContain('/alive adopt');
  });
});
