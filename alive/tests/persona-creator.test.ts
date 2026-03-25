// alive/tests/persona-creator.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  generatePersonaQuick,
  generatePersonaGuided,
  personaToYAML,
  savePersona,
  formatPersonaPreview,
  getAvailableMBTI,
  getTraitPool,
  getScheduleTypes,
} from '../scripts/admin/persona-creator';
import { parseCommand, handleCommand } from '../scripts/admin/command-handler';
import { setBasePaths, resetBasePaths } from '../scripts/utils/file-utils';

// Test sandbox
let tmpDir: string;
let tmpMemory: string;
let tmpSkill: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-persona-create-'));
  tmpMemory = path.join(tmpDir, 'memory');
  tmpSkill = path.join(tmpDir, 'skill');
  fs.mkdirSync(tmpMemory, { recursive: true });
  fs.mkdirSync(path.join(tmpSkill, 'personas'), { recursive: true });
  setBasePaths(tmpMemory, tmpSkill);
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('generatePersonaQuick', () => {
  it('generates a valid persona with default random values', () => {
    const persona = generatePersonaQuick();
    expect(persona.meta.name).toBeTruthy();
    expect(persona.meta.tagline).toBeTruthy();
    expect(persona.meta.id).toBeTruthy();
    expect(persona.personality.mbti).toMatch(/^[A-Z]{4}$/);
    expect(persona.personality.core_traits.length).toBeGreaterThanOrEqual(3);
    expect(persona.voice.language).toBe('zh-CN');
    expect(persona.voice.sample_lines.length).toBeGreaterThanOrEqual(3);
    expect(persona.schedule).toBeDefined();
    expect(persona.intimacy).toBeDefined();
    expect(persona.intimacy!.levels).toBe(5);
  });

  it('uses provided name and tagline', () => {
    const persona = generatePersonaQuick({ name: '小红', tagline: '爱画画的大学生' });
    expect(persona.meta.name).toBe('小红');
    expect(persona.meta.tagline).toBe('爱画画的大学生');
  });

  it('generates different personas on multiple calls', () => {
    const personas = Array.from({ length: 5 }, () => generatePersonaQuick());
    const names = new Set(personas.map(p => p.meta.name));
    // At least some should be different (random generation)
    expect(names.size).toBeGreaterThanOrEqual(2);
  });
});

describe('generatePersonaGuided', () => {
  it('creates persona from minimal guided input', () => {
    const persona = generatePersonaGuided({
      name: '测试角色',
      tagline: '测试用途',
    });
    expect(persona.meta.name).toBe('测试角色');
    expect(persona.meta.tagline).toContain('测试用途');
    expect(persona.personality.mbti).toMatch(/^[A-Z]{4}$/);
  });

  it('respects provided MBTI', () => {
    const persona = generatePersonaGuided({
      name: '测试',
      tagline: '测试',
      mbti: 'INFJ',
    });
    expect(persona.personality.mbti).toBe('INFJ');
  });

  it('respects provided core traits', () => {
    const persona = generatePersonaGuided({
      name: '测试',
      tagline: '测试',
      coreTraits: ['温柔', '安静', '文艺'],
    });
    expect(persona.personality.core_traits).toEqual(['温柔', '安静', '文艺']);
  });

  it('respects provided schedule type', () => {
    const persona = generatePersonaGuided({
      name: '测试',
      tagline: '测试',
      scheduleType: 'night',
    });
    expect(persona.schedule!.wake_hour).toBe(12);
    expect(persona.schedule!.sleep_hour).toBe(3);
  });

  it('respects provided age', () => {
    const persona = generatePersonaGuided({
      name: '测试',
      tagline: '测试',
      age: 25,
    });
    expect(persona.meta.age).toBe(25);
  });
});

describe('personaToYAML', () => {
  it('serializes persona to valid YAML string', () => {
    const persona = generatePersonaQuick({ name: '小鱼', tagline: '测试角色' });
    const yaml = personaToYAML(persona);
    expect(yaml).toContain('小鱼');
    expect(yaml).toContain('测试角色');
    expect(yaml).toContain('Alive 角色预设');
    expect(yaml).toContain('由 /alive create 自动生成');
  });
});

describe('formatPersonaPreview', () => {
  it('generates a markdown preview', () => {
    const persona = generatePersonaQuick({ name: '预览角色', tagline: '预览测试' });
    const preview = formatPersonaPreview(persona);
    expect(preview).toContain('预览角色');
    expect(preview).toContain('预览测试');
    expect(preview).toContain('MBTI');
    expect(preview).toContain('示例台词');
    expect(preview).toContain('人物简介');
  });
});

describe('getAvailableMBTI', () => {
  it('returns all 16 MBTI types', () => {
    const types = getAvailableMBTI();
    expect(types).toHaveLength(16);
    expect(types).toContain('INFJ');
    expect(types).toContain('ESTP');
  });
});

describe('getTraitPool', () => {
  it('returns a non-empty trait pool', () => {
    const traits = getTraitPool();
    expect(traits.length).toBeGreaterThan(10);
    expect(traits).toContain('温柔');
    expect(traits).toContain('元气满满');
  });
});

describe('getScheduleTypes', () => {
  it('returns schedule type options', () => {
    const types = getScheduleTypes();
    expect(types.length).toBe(5);
    expect(types.map(t => t.key)).toContain('early');
    expect(types.map(t => t.key)).toContain('night');
  });
});

describe('/alive create command', () => {
  it('parseCommand handles /alive create', () => {
    const cmd = parseCommand('/alive create');
    expect(cmd.subcommand).toBe('create');
    expect(cmd.args).toEqual([]);
  });

  it('parseCommand handles /alive create with name and tagline', () => {
    const cmd = parseCommand('/alive create 小鱼 "爱吃甜食的插画师"');
    expect(cmd.subcommand).toBe('create');
    expect(cmd.args).toEqual(['小鱼', '爱吃甜食的插画师']);
  });

  it('parseCommand handles /alive create --guided', () => {
    const cmd = parseCommand('/alive create --guided');
    expect(cmd.subcommand).toBe('create');
    expect(cmd.flags['guided']).toBe('true');
  });

  it('parseCommand handles guided mode with full flags', () => {
    const cmd = parseCommand('/alive create --guided --name "陈小鱼" --tagline "爱画画" --mbti ENFP --traits "温柔,文艺"');
    expect(cmd.subcommand).toBe('create');
    expect(cmd.flags['guided']).toBe('true');
    expect(cmd.flags['name']).toBe('陈小鱼');
    expect(cmd.flags['tagline']).toBe('爱画画');
    expect(cmd.flags['mbti']).toBe('ENFP');
    expect(cmd.flags['traits']).toBe('温柔,文艺');
  });

  it('handleCommand for create returns persona preview (quick mode)', async () => {
    const cmd = parseCommand('/alive create 测试角色 "随机生成测试"');
    const result = await handleCommand(cmd);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('测试角色');
    expect(result.output).toContain('随机生成测试');
    expect(result.output).toContain('角色已保存到');
  });

  it('handleCommand for create --guided without name returns questionnaire', async () => {
    const cmd = parseCommand('/alive create --guided');
    const result = await handleCommand(cmd);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('引导模式');
    expect(result.output).toContain('参数说明');
    expect(result.output).toContain('MBTI 可选值');
  });

  it('handleCommand for create --guided with name+tagline generates persona', async () => {
    const cmd = parseCommand('/alive create --guided --name "引导角色" --tagline "引导测试" --mbti INTJ');
    const result = await handleCommand(cmd);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('引导角色');
    expect(result.output).toContain('角色已保存到');
  });

  it('pure random create generates and saves successfully', async () => {
    const cmd = parseCommand('/alive create');
    const result = await handleCommand(cmd);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('新角色预览');
    expect(result.output).toContain('角色已保存到');
  });
});

// ── Edge Cases & Boundary Tests ────────────────────────────────────

describe('generatePersonaQuick — edge cases', () => {
  it('generates valid persona with empty options object', () => {
    const persona = generatePersonaQuick({});
    expect(persona.meta.name).toBeTruthy();
    expect(persona.meta.id).toBeTruthy();
    expect(persona.personality.mbti).toMatch(/^[A-Z]{4}$/);
  });

  it('generates valid persona with name-only (no tagline)', () => {
    const persona = generatePersonaQuick({ name: '测试名' });
    expect(persona.meta.name).toBe('测试名');
    expect(persona.meta.tagline).toBeTruthy(); // should auto-generate
  });

  it('generates valid persona with tagline-only (no name)', () => {
    const persona = generatePersonaQuick({ tagline: '自定义定位' });
    expect(persona.meta.name).toBeTruthy(); // should auto-generate
    expect(persona.meta.tagline).toBe('自定义定位');
  });

  it('handles very long name gracefully', () => {
    const longName = '超级无敌长长长长长长长的角色名字';
    const persona = generatePersonaQuick({ name: longName });
    expect(persona.meta.name).toBe(longName);
    expect(persona.meta.id).toBeTruthy();
  });

  it('handles special characters in name', () => {
    const persona = generatePersonaQuick({ name: '角色·测试（001）' });
    expect(persona.meta.name).toBe('角色·测试（001）');
    expect(persona.meta.id).toBeTruthy();
  });

  it('handles emoji in tagline', () => {
    const persona = generatePersonaQuick({ tagline: '🎨 爱画画的 💫 小精灵' });
    expect(persona.meta.tagline).toBe('🎨 爱画画的 💫 小精灵');
  });

  it('core_traits length is within valid range (3-4)', () => {
    // Run multiple times to verify the range
    for (let i = 0; i < 20; i++) {
      const persona = generatePersonaQuick();
      expect(persona.personality.core_traits.length).toBeGreaterThanOrEqual(3);
      expect(persona.personality.core_traits.length).toBeLessThanOrEqual(4);
    }
  });

  it('quirks length is within valid range (2-3)', () => {
    for (let i = 0; i < 20; i++) {
      const persona = generatePersonaQuick();
      expect(persona.personality.quirks!.length).toBeGreaterThanOrEqual(2);
      expect(persona.personality.quirks!.length).toBeLessThanOrEqual(3);
    }
  });

  it('values length is within valid range (2-3)', () => {
    for (let i = 0; i < 20; i++) {
      const persona = generatePersonaQuick();
      expect(persona.personality.values!.length).toBeGreaterThanOrEqual(2);
      expect(persona.personality.values!.length).toBeLessThanOrEqual(3);
    }
  });

  it('sample_lines has exactly 5 lines', () => {
    const persona = generatePersonaQuick();
    expect(persona.voice.sample_lines).toHaveLength(5);
  });

  it('schedule has valid hours', () => {
    for (let i = 0; i < 20; i++) {
      const persona = generatePersonaQuick();
      expect(persona.schedule!.wake_hour).toBeGreaterThanOrEqual(0);
      expect(persona.schedule!.wake_hour).toBeLessThanOrEqual(23);
      expect(persona.schedule!.sleep_hour).toBeGreaterThanOrEqual(0);
      expect(persona.schedule!.sleep_hour).toBeLessThanOrEqual(23);
    }
  });

  it('emoji_density is one of low/medium/high', () => {
    for (let i = 0; i < 20; i++) {
      const persona = generatePersonaQuick();
      expect(['low', 'medium', 'high']).toContain(persona.voice.emoji_density);
    }
  });

  it('intimacy has exactly 5 levels and all keys 1-5', () => {
    const persona = generatePersonaQuick();
    expect(persona.intimacy!.levels).toBe(5);
    const keys = Object.keys(persona.intimacy!.behaviors).map(Number).sort();
    expect(keys).toEqual([1, 2, 3, 4, 5]);
  });

  it('sub_skills is always empty array on generation', () => {
    const persona = generatePersonaQuick();
    expect(persona.sub_skills).toEqual([]);
  });
});

describe('generatePersonaGuided — edge cases', () => {
  it('falls back to random MBTI for invalid MBTI string', () => {
    const persona = generatePersonaGuided({
      name: '测试',
      tagline: '测试',
      mbti: 'XXXX',
    });
    // Should fall back to a valid MBTI
    expect(persona.personality.mbti).toMatch(/^[A-Z]{4}$/);
    expect(persona.personality.mbti).not.toBe('XXXX');
  });

  it('falls back to random MBTI for empty string', () => {
    const persona = generatePersonaGuided({
      name: '测试',
      tagline: '测试',
      mbti: '',
    });
    expect(persona.personality.mbti).toMatch(/^[A-Z]{4}$/);
  });

  it('accepts lowercase MBTI and uppercases it', () => {
    const persona = generatePersonaGuided({
      name: '测试',
      tagline: '测试',
      mbti: 'enfp',
    });
    expect(persona.personality.mbti).toBe('ENFP');
  });

  it('falls back to random traits when only 1 trait provided', () => {
    const persona = generatePersonaGuided({
      name: '测试',
      tagline: '测试',
      coreTraits: ['温柔'],
    });
    // Should fall back to random since < 2 traits
    expect(persona.personality.core_traits.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps user traits when exactly 2 provided', () => {
    const persona = generatePersonaGuided({
      name: '测试',
      tagline: '测试',
      coreTraits: ['温柔', '文艺'],
    });
    expect(persona.personality.core_traits).toEqual(['温柔', '文艺']);
  });

  it('uses custom occupation with auto-generated detail', () => {
    const persona = generatePersonaGuided({
      name: '测试',
      tagline: '测试',
      occupation: '天文学家',
    });
    expect(persona.meta.tagline).toContain('天文学家');
    expect(persona.meta.occupation_detail).toBeTruthy();
  });

  it('uses custom occupation with custom detail', () => {
    const persona = generatePersonaGuided({
      name: '测试',
      tagline: '测试',
      occupation: '天文学家',
      occupationDetail: '在天文台工作，每天观测星星。',
    });
    expect(persona.meta.occupation_detail).toBe('在天文台工作，每天观测星星。');
  });

  it('uses custom voice style', () => {
    const persona = generatePersonaGuided({
      name: '测试',
      tagline: '测试',
      voiceStyle: '说话像古人一样文绉绉的。',
    });
    expect(persona.voice.style).toBe('说话像古人一样文绉绉的。');
  });

  it('all schedule types produce valid configs', () => {
    const scheduleTypes = ['early', 'normal', 'late', 'night', 'healthy'] as const;
    for (const type of scheduleTypes) {
      const persona = generatePersonaGuided({
        name: '测试',
        tagline: '测试',
        scheduleType: type,
      });
      expect(persona.schedule!.wake_hour).toBeGreaterThanOrEqual(0);
      expect(persona.schedule!.sleep_hour).toBeGreaterThanOrEqual(0);
      expect(persona.schedule!.timezone).toBe('Asia/Shanghai');
    }
  });

  it('invalid schedule type falls back to random', () => {
    const persona = generatePersonaGuided({
      name: '测试',
      tagline: '测试',
      scheduleType: 'invalid' as any,
    });
    expect(persona.schedule!.wake_hour).toBeDefined();
    expect(persona.schedule!.sleep_hour).toBeDefined();
  });

  it('tagline is included in meta.tagline with occupation', () => {
    const persona = generatePersonaGuided({
      name: '测试',
      tagline: '喜欢画画',
      occupation: '大学生',
    });
    expect(persona.meta.tagline).toContain('大学生');
    expect(persona.meta.tagline).toContain('喜欢画画');
  });
});

describe('personaToYAML — edge cases', () => {
  it('contains ISO timestamp', () => {
    const persona = generatePersonaQuick({ name: '时间测试' });
    const yaml = personaToYAML(persona);
    // Should contain a date-like pattern
    expect(yaml).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('handles special YAML characters in values', () => {
    const persona = generatePersonaQuick({
      name: '特殊字符: 测试',
      tagline: 'tagline with "quotes" and \'apostrophes\'',
    });
    const yaml = personaToYAML(persona);
    // Should not throw and should contain the name
    expect(yaml).toContain('特殊字符');
    expect(yaml).toBeTruthy();
  });

  it('output is parseable back to object', () => {
    const YAML_LIB = require('yaml');
    const persona = generatePersonaQuick({ name: '往返测试' });
    const yaml = personaToYAML(persona);
    // Strip comment header lines
    const yamlBody = yaml.split('\n').filter((l: string) => !l.startsWith('#')).join('\n');
    const parsed = YAML_LIB.parse(yamlBody);
    expect(parsed.meta.name).toBe('往返测试');
    expect(parsed.personality.mbti).toBe(persona.personality.mbti);
  });
});

describe('savePersona — edge cases', () => {
  it('does not overwrite existing file (second save differs from first)', () => {
    const persona1 = generatePersonaQuick({ name: '重名边界' });
    const persona2 = generatePersonaQuick({ name: '重名边界' });
    // Force same ID so they would target the same filename
    persona2.meta.id = persona1.meta.id;

    const path1 = savePersona(persona1);
    const path2 = savePersona(persona2);

    // Two saves with same ID should produce different files
    expect(path1).not.toBe(path2);
    expect(fs.existsSync(path1)).toBe(true);
    expect(fs.existsSync(path2)).toBe(true);
  });

  it('saved file contains valid YAML content', () => {
    const persona = generatePersonaQuick({ name: '内容验证' });
    const savedPath = savePersona(persona);
    const content = fs.readFileSync(savedPath, 'utf8');
    expect(content).toContain('内容验证');
    expect(content).toContain('Alive 角色预设');
  });
});

describe('formatPersonaPreview — edge cases', () => {
  it('handles persona with no quirks', () => {
    const persona = generatePersonaQuick();
    persona.personality.quirks = [];
    const preview = formatPersonaPreview(persona);
    expect(preview).toContain('N/A');
  });

  it('handles persona with no values', () => {
    const persona = generatePersonaQuick();
    persona.personality.values = [];
    const preview = formatPersonaPreview(persona);
    expect(preview).toContain('N/A');
  });

  it('handles persona with no schedule', () => {
    const persona = generatePersonaQuick();
    (persona as any).schedule = undefined;
    const preview = formatPersonaPreview(persona);
    expect(preview).toContain('N/A');
  });

  it('handles persona with no emoji_density', () => {
    const persona = generatePersonaQuick();
    (persona.voice as any).emoji_density = undefined;
    const preview = formatPersonaPreview(persona);
    expect(preview).toContain('medium'); // should show default
  });
});

describe('/alive create command — edge cases', () => {
  it('handles create with only name (no tagline)', async () => {
    const cmd = parseCommand('/alive create 只有名字');
    const result = await handleCommand(cmd);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('只有名字');
    expect(result.output).toContain('角色已保存到');
  });

  it('handles create --guided with only --name (missing --tagline) returns error', async () => {
    const cmd = parseCommand('/alive create --guided --name "缺少定位"');
    const result = await handleCommand(cmd);
    expect(result.error).toBe(true);
    expect(result.output).toContain('一句话定位');
  });

  it('handles create --guided with only --tagline (missing --name) returns questionnaire', async () => {
    // When --name is absent, hasAnswers is false, so it returns the questionnaire
    const cmd = parseCommand('/alive create --guided --tagline "缺少名字"');
    const result = await handleCommand(cmd);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('引导模式');
  });

  it('handles create --guided with all possible flags', async () => {
    const cmd = parseCommand('/alive create --guided --name "全参数" --tagline "全参数测试" --age 22 --gender female --mbti INFJ --traits "温柔,安静,文艺" --occupation "花店学徒" --occupation-detail "在花店工作" --voice-style "温温柔柔说话" --schedule early');
    const result = await handleCommand(cmd);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('全参数');
    expect(result.output).toContain('角色已保存到');
  });

  it('handles Chinese commas in traits flag', async () => {
    const cmd = parseCommand('/alive create --guided --name "逗号测试" --tagline "测试" --traits "温柔，文艺，安静"');
    const result = await handleCommand(cmd);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('逗号测试');
  });

  it('parseCommand handles /alive create with Chinese quotes', () => {
    // Test that Chinese quotes in the raw command don't break anything
    const cmd = parseCommand('/alive create 小鱼 爱画画的大学生');
    expect(cmd.subcommand).toBe('create');
    expect(cmd.args[0]).toBe('小鱼');
  });

  it('multiple random creates produce different files', async () => {
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const cmd = parseCommand('/alive create');
      const result = await handleCommand(cmd);
      expect(result.error).toBeUndefined();
      // Extract saved path
      const match = result.output.match(/角色已保存到: `(.+?)`/);
      expect(match).toBeTruthy();
      results.push(match![1]);
    }
    // All paths should be unique
    const uniquePaths = new Set(results);
    expect(uniquePaths.size).toBe(3);
  });
});
