// alive/tests/command-handler-create.test.ts
// TDD tests for async persona creation via /alive create command.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setBasePaths, resetBasePaths } from '../scripts/utils/file-utils';

// Test sandbox
let tmpDir: string;
let tmpMemory: string;
let tmpSkill: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-cmd-create-'));
  tmpMemory = path.join(tmpDir, 'memory');
  tmpSkill = path.join(tmpDir, 'skill');
  fs.mkdirSync(tmpMemory, { recursive: true });
  fs.mkdirSync(path.join(tmpSkill, 'personas'), { recursive: true });
  // Copy templates so readTemplate works
  const srcTemplates = path.join(__dirname, '..', 'templates');
  const dstTemplates = path.join(tmpSkill, 'templates');
  fs.mkdirSync(dstTemplates, { recursive: true });
  for (const f of fs.readdirSync(srcTemplates)) {
    if (f.endsWith('.md')) {
      fs.copyFileSync(path.join(srcTemplates, f), path.join(dstTemplates, f));
    }
  }
  setBasePaths(tmpMemory, tmpSkill);
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── Tests: dispatch returns a Promise ────────────────────────────

describe('/alive create (async dispatch)', () => {
  it('dispatch returns a Promise', async () => {
    const { dispatch } = await import('../scripts/admin/command-handler');
    const result = dispatch('/alive create');
    // dispatch must return a Promise (thenable)
    expect(result).toBeInstanceOf(Promise);
    // await to prevent unhandled rejection
    await result;
  });

  it('handleCommand returns a Promise for create subcommand', async () => {
    const { parseCommand, handleCommand } = await import('../scripts/admin/command-handler');
    const cmd = parseCommand('/alive create');
    const result = handleCommand(cmd);
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  it('/alive create calls generatePersonaQuickAsync (not sync)', async () => {
    // Spy on the async generator
    const creatorModule = await import('../scripts/admin/persona-creator');
    const asyncSpy = vi.spyOn(creatorModule, 'generatePersonaQuickAsync')
      .mockResolvedValue({
        meta: { name: '测试角色', id: 'test-char', gender: '女', tagline: '测试' },
        personality: { mbti: 'ENFP', core_traits: ['温柔'], description: '测试描述' },
        voice: { language: 'zh-CN', style: '温柔', emoji_density: 'low', sample_lines: ['你好'] },
        sub_skills: [],
      });
    const syncSpy = vi.spyOn(creatorModule, 'generatePersonaQuick');

    const { dispatch } = await import('../scripts/admin/command-handler');
    const result = await dispatch('/alive create 测试角色 测试定位');

    expect(asyncSpy).toHaveBeenCalled();
    expect(syncSpy).not.toHaveBeenCalled();
    expect(result.output).toContain('测试角色');
  });

  it('/alive create --guided calls generatePersonaGuidedAsync (not sync)', async () => {
    const creatorModule = await import('../scripts/admin/persona-creator');
    const asyncSpy = vi.spyOn(creatorModule, 'generatePersonaGuidedAsync')
      .mockResolvedValue({
        meta: { name: '引导角色', id: 'guided-char', gender: '男', tagline: '引导测试' },
        personality: { mbti: 'INTJ', core_traits: ['理性'], description: '引导测试描述' },
        voice: { language: 'zh-CN', style: '简短', emoji_density: 'low', sample_lines: ['嗯'] },
        sub_skills: [],
      });
    const syncSpy = vi.spyOn(creatorModule, 'generatePersonaGuided');

    const { dispatch } = await import('../scripts/admin/command-handler');
    const result = await dispatch('/alive create --guided --name 引导角色 --tagline 引导测试');

    expect(asyncSpy).toHaveBeenCalled();
    expect(syncSpy).not.toHaveBeenCalled();
    expect(result.output).toContain('引导角色');
  });

  it('/alive create returns persona preview and save path', async () => {
    const creatorModule = await import('../scripts/admin/persona-creator');
    vi.spyOn(creatorModule, 'generatePersonaQuickAsync')
      .mockResolvedValue({
        meta: { name: '林微澜', id: 'lin-weilan', gender: '女', tagline: '天文系学生' },
        personality: { mbti: 'INFP', core_traits: ['安静', '敏感细腻'], description: '天文系学生' },
        voice: { language: 'zh-CN', style: '安静', emoji_density: 'low', sample_lines: ['嗯…', '你好'] },
        sub_skills: [],
      });

    const { dispatch } = await import('../scripts/admin/command-handler');
    const result = await dispatch('/alive create');

    // Should contain preview elements
    expect(result.output).toContain('林微澜');
    expect(result.output).toContain('INFP');
    // Should contain save path info
    expect(result.output).toContain('角色已保存到');
    expect(result.error).toBeFalsy();
  });

  it('non-create commands still work (sync commands return via Promise)', async () => {
    const { dispatch } = await import('../scripts/admin/command-handler');
    const result = await dispatch('/alive help');
    expect(result.output).toContain('Alive Admin Commands');
    expect(result.error).toBeFalsy();
  });
});
