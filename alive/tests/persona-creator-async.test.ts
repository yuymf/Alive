// alive/tests/persona-creator-async.test.ts
// TDD tests for LLM-powered async persona generation.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PersonaConfig } from '../scripts/utils/types';
import { setBasePaths, resetBasePaths } from '../scripts/utils/file-utils';

// Test sandbox
let tmpDir: string;
let tmpMemory: string;
let tmpSkill: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-persona-async-'));
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

// ── Mock LLM response ───────────────────────────────────────────

const MOCK_LLM_PERSONA = {
  meta: {
    name: '林微澜',
    gender: '女',
    age: 22,
    tagline: '失眠的天文系研究生',
    occupation_detail: '大三在读天文系学生，白天在天文台整理观测数据，晚上独自在宿舍阳台用望远镜看星星。经常因为想太多而失眠。',
  },
  personality: {
    mbti: 'INFP',
    core_traits: ['敏感细腻', '安静', '天马行空', '拖延症'],
    quirks: ['看到好看的星空会停下来拍很久', '喝奶茶只喝三分糖', '睡前必须听白噪音'],
    values: ['真实 > 完美', '自由最可贵'],
    trait_descriptions: '林微澜是那种在人群中不太起眼的人——不是因为不好看，而是她天生存在感就薄。她能安静地在图书馆坐一整天，也能因为窗外飘过一片好看的云而走神半小时。',
    mbti_description: '作为 INFP，她的内心世界比外表丰富得多。决策时更多依赖直觉和内心感受，而不是逻辑分析。社交对她来说是消耗品——和朋友待一下午就需要独处一晚上来充电。',
    domain_knowledge: '天文观测和星空摄影。能辨认主要星座和亮星，了解常见天文现象的原理。对深空天体有浪漫化的理解，经常把星星和人的情感联系在一起。',
    interests_description: '喜欢坂本龙一的音乐和新海诚的动画电影。看太宰治和村上春树的小说。收藏了很多星空壁纸。偶像是科普博主「妈咪说MommyTalk」。',
    description: '林微澜，天文系大三在读，一个总是在深夜清醒、在白天梦游的姑娘。她不是那种会在社交场合发光的人，但如果你和她聊起星星，她的眼睛会亮起来。',
  },
  voice: {
    language: 'zh-CN',
    style: '安静温柔，话不多但每句都有份量。句尾偶尔带\"…\"，像是还有没说完的话。',
    emoji_density: 'low',
    sample_lines: [
      '嗯…今晚天气好的话，应该能看到猎户座。',
      '你知道吗，光年其实是距离单位，不是时间…',
      '困了…但是不想睡。',
      '这首歌好适合现在这个时间…',
      '没事…就是突然想到一些有的没的。',
      '星星的光到达地球的时候，也许它已经不在了。有点浪漫，也有点难过。',
    ],
    expression_features: '说话偏安静，句子不长。紧张时会说"嗯…"来拖延。提到星星和天文时话会突然变多。很少用感叹号。',
    diary_style_guide: '偏散文风格，句子短小有诗意。不用表情符号。经常以对星空的观察作为日记的开头或结尾。',
  },
  intimacy: {
    levels: 5,
    behaviors: {
      1: '礼貌但有距离，回复简短，不主动聊天',
      2: '偶尔分享看到的星空照片，聊一些不太私人的话题',
      3: '会主动说"今晚有流星雨要不要看"，分享失眠的烦恼',
      4: '深夜会发消息说"睡不着…你在吗"，分享内心深处的想法',
      5: '会把最脆弱的一面展示出来，像是"有时候觉得自己就像一颗很远很远的星…"',
    },
  },
  schedule: {
    wake_hour: 10,
    sleep_hour: 2,
    timezone: 'Asia/Shanghai',
    active_peaks: [15, 23],
    time_state_description: '早上很难起来，经常翘第一节课。下午在天文台整理数据时渐入佳境。晚上是属于她的时间——夜越深越清醒，常常凌晨两三点还在阳台看星星。',
  },
  content: {
    behavior_examples: '在阳台用望远镜观测星空、在图书馆看天文论文、窝在被窝里听坂本龙一、给实验数据做可视化、在便利店买半夜的零食、拍星轨延时摄影、给朋友发"你看这颗星好亮"、翻看新海诚电影的截图发呆',
    diary_examples: '凌晨一点半。今晚看到了木星，特别亮。突然想到一个很傻的问题——如果有人在木星上看地球，能看到我吗？\n\n又失眠了。数到第327只羊的时候放弃了。打开窗户，外面有风。猎户座还在老地方。至少星星不会失眠。',
    search_topics: '今晚星空观测条件、猎户座星云最新照片、坂本龙一 Merry Christmas Mr Lawrence、失眠怎么办 知乎、天文摄影入门设备推荐、村上春树新作品',
  },
};

// ── Tests: generatePersonaQuickAsync ─────────────────────────────

describe('generatePersonaQuickAsync', () => {
  it('calls LLM and returns a valid PersonaConfig with all high-fidelity fields', async () => {
    // Mock callLLMJSON to return our mock persona
    vi.spyOn(await import('../scripts/utils/llm-client'), 'callLLMJSON')
      .mockResolvedValue(MOCK_LLM_PERSONA);

    const { generatePersonaQuickAsync } = await import('../scripts/admin/persona-creator');

    const persona = await generatePersonaQuickAsync({ name: '林微澜', tagline: '失眠的天文系研究生' });

    // Basic fields
    expect(persona.meta.name).toBe('林微澜');
    expect(persona.meta.tagline).toContain('天文');
    expect(persona.meta.id).toBeTruthy();
    expect(persona.personality.mbti).toMatch(/^[A-Z]{4}$/);
    expect(persona.voice.language).toBe('zh-CN');

    // High-fidelity fields that the old sync generator leaves empty
    expect(persona.personality.trait_descriptions).toBeTruthy();
    expect(persona.personality.trait_descriptions!.length).toBeGreaterThan(30);
    expect(persona.personality.mbti_description).toBeTruthy();
    expect(persona.personality.domain_knowledge).toBeTruthy();
    expect(persona.personality.interests_description).toBeTruthy();
    expect(persona.personality.description).toBeTruthy();
    // Description should NOT be the old mechanical template
    expect(persona.personality.description).not.toMatch(/^.+，.+。[A-Z]{4} 性格，/);

    expect(persona.voice.expression_features).toBeTruthy();
    expect(persona.voice.diary_style_guide).toBeTruthy();
    expect(persona.voice.sample_lines.length).toBeGreaterThanOrEqual(5);

    expect(persona.schedule?.time_state_description).toBeTruthy();
    expect(persona.intimacy?.levels).toBe(5);

    expect(persona.content?.behavior_examples).toBeTruthy();
    expect(persona.content?.diary_examples).toBeTruthy();
    expect(persona.content?.search_topics).toBeTruthy();
  });

  it('generates a fully random persona when no options provided', async () => {
    vi.spyOn(await import('../scripts/utils/llm-client'), 'callLLMJSON')
      .mockResolvedValue(MOCK_LLM_PERSONA);

    const { generatePersonaQuickAsync } = await import('../scripts/admin/persona-creator');

    const persona = await generatePersonaQuickAsync();
    expect(persona.meta.name).toBeTruthy();
    expect(persona.personality.mbti).toBeTruthy();
    expect(persona.personality.trait_descriptions).toBeTruthy();
  });

  it('falls back to sync generator when LLM call fails', async () => {
    vi.spyOn(await import('../scripts/utils/llm-client'), 'callLLMJSON')
      .mockRejectedValue(new Error('API timeout'));

    const { generatePersonaQuickAsync } = await import('../scripts/admin/persona-creator');

    const persona = await generatePersonaQuickAsync({ name: '测试角色' });

    // Should still return a valid persona (from sync fallback)
    expect(persona.meta.name).toBe('测试角色');
    expect(persona.personality.mbti).toMatch(/^[A-Z]{4}$/);
    expect(persona.voice.language).toBe('zh-CN');
    expect(persona.voice.sample_lines.length).toBeGreaterThanOrEqual(3);
    // But high-fidelity fields may be empty (sync generator doesn't fill them)
  });

  it('populates meta.id using generateId', async () => {
    vi.spyOn(await import('../scripts/utils/llm-client'), 'callLLMJSON')
      .mockResolvedValue(MOCK_LLM_PERSONA);

    const { generatePersonaQuickAsync } = await import('../scripts/admin/persona-creator');

    const persona = await generatePersonaQuickAsync();
    expect(persona.meta.id).toBeTruthy();
    expect(typeof persona.meta.id).toBe('string');
  });

  it('always sets sub_skills to empty array', async () => {
    vi.spyOn(await import('../scripts/utils/llm-client'), 'callLLMJSON')
      .mockResolvedValue(MOCK_LLM_PERSONA);

    const { generatePersonaQuickAsync } = await import('../scripts/admin/persona-creator');

    const persona = await generatePersonaQuickAsync();
    expect(persona.sub_skills).toEqual([]);
  });
});

// ── Tests: generatePersonaGuidedAsync ────────────────────────────

describe('generatePersonaGuidedAsync', () => {
  it('calls LLM with user constraints and returns a valid PersonaConfig', async () => {
    vi.spyOn(await import('../scripts/utils/llm-client'), 'callLLMJSON')
      .mockResolvedValue(MOCK_LLM_PERSONA);

    const { generatePersonaGuidedAsync } = await import('../scripts/admin/persona-creator');

    const persona = await generatePersonaGuidedAsync({
      name: '林微澜',
      tagline: '失眠的天文系研究生',
      age: 22,
      gender: 'female',
      mbti: 'INFP',
      coreTraits: ['敏感细腻', '安静', '天马行空'],
      occupation: '天文系学生',
      voiceStyle: '安静温柔',
      scheduleType: 'night',
    });

    // Basic fields
    expect(persona.meta.name).toBe('林微澜');
    expect(persona.meta.id).toBeTruthy();
    expect(persona.personality.mbti).toMatch(/^[A-Z]{4}$/);
    expect(persona.voice.language).toBe('zh-CN');

    // High-fidelity fields
    expect(persona.personality.trait_descriptions).toBeTruthy();
    expect(persona.personality.mbti_description).toBeTruthy();
    expect(persona.personality.domain_knowledge).toBeTruthy();
    expect(persona.personality.description).toBeTruthy();
    expect(persona.voice.expression_features).toBeTruthy();
    expect(persona.voice.diary_style_guide).toBeTruthy();
    expect(persona.schedule?.time_state_description).toBeTruthy();
    expect(persona.content?.behavior_examples).toBeTruthy();
  });

  it('injects user constraints as hard constraints into the prompt', async () => {
    let capturedPrompt = '';
    vi.spyOn(await import('../scripts/utils/llm-client'), 'callLLMJSON')
      .mockImplementation(async (prompt: string) => {
        capturedPrompt = prompt;
        return MOCK_LLM_PERSONA;
      });

    const { generatePersonaGuidedAsync } = await import('../scripts/admin/persona-creator');

    await generatePersonaGuidedAsync({
      name: '林微澜',
      tagline: '失眠的天文系研究生',
      mbti: 'INFP',
      gender: 'female',
    });

    // User constraints should appear in the prompt
    expect(capturedPrompt).toContain('林微澜');
    expect(capturedPrompt).toContain('失眠的天文系研究生');
    expect(capturedPrompt).toContain('INFP');
    // Gender constraint should be in the prompt
    expect(capturedPrompt).toMatch(/女|female/i);
  });

  it('falls back to sync guided generator when LLM call fails', async () => {
    vi.spyOn(await import('../scripts/utils/llm-client'), 'callLLMJSON')
      .mockRejectedValue(new Error('API rate limit'));

    const { generatePersonaGuidedAsync } = await import('../scripts/admin/persona-creator');

    const persona = await generatePersonaGuidedAsync({
      name: '测试角色',
      tagline: '测试定位',
      mbti: 'ENTJ',
    });

    // Should still return a valid persona (from sync fallback)
    expect(persona.meta.name).toBe('测试角色');
    expect(persona.personality.mbti).toBe('ENTJ');
    expect(persona.voice.language).toBe('zh-CN');
    expect(persona.voice.sample_lines.length).toBeGreaterThanOrEqual(3);
  });

  it('always sets sub_skills to empty array and fixed values', async () => {
    vi.spyOn(await import('../scripts/utils/llm-client'), 'callLLMJSON')
      .mockResolvedValue(MOCK_LLM_PERSONA);

    const { generatePersonaGuidedAsync } = await import('../scripts/admin/persona-creator');

    const persona = await generatePersonaGuidedAsync({
      name: '测试',
      tagline: '测试',
    });

    expect(persona.sub_skills).toEqual([]);
    expect(persona.intimacy?.levels).toBe(5);
    expect(persona.schedule?.timezone).toBe('Asia/Shanghai');
  });
});

// ── Tests: validateLLMOutput / partial fields ────────────────────

describe('validateLLMOutput & partial field handling', () => {
  it('falls back to sync when LLM returns missing critical fields (no meta.name)', async () => {
    const partialOutput = {
      ...MOCK_LLM_PERSONA,
      meta: { ...MOCK_LLM_PERSONA.meta, name: '' },
    };
    vi.spyOn(await import('../scripts/utils/llm-client'), 'callLLMJSON')
      .mockResolvedValue(partialOutput);

    const { generatePersonaQuickAsync } = await import('../scripts/admin/persona-creator');

    const persona = await generatePersonaQuickAsync({ name: '回退测试' });

    // Should have fallen back to sync — sync generator uses the provided name
    expect(persona.meta.name).toBe('回退测试');
    // Sync generator does NOT fill high-fidelity fields
    expect(persona.personality.trait_descriptions).toBeFalsy();
  });

  it('falls back to sync when LLM returns missing core_traits', async () => {
    const partialOutput = {
      ...MOCK_LLM_PERSONA,
      personality: { ...MOCK_LLM_PERSONA.personality, core_traits: [] },
    };
    vi.spyOn(await import('../scripts/utils/llm-client'), 'callLLMJSON')
      .mockResolvedValue(partialOutput);

    const { generatePersonaGuidedAsync } = await import('../scripts/admin/persona-creator');

    const persona = await generatePersonaGuidedAsync({ name: '回退测试', tagline: '测试' });

    // Should have fallen back to sync
    expect(persona.meta.name).toBe('回退测试');
    expect(persona.personality.core_traits.length).toBeGreaterThan(0);
  });

  it('falls back to sync when LLM returns missing sample_lines', async () => {
    const partialOutput = {
      ...MOCK_LLM_PERSONA,
      voice: { ...MOCK_LLM_PERSONA.voice, sample_lines: [] },
    };
    vi.spyOn(await import('../scripts/utils/llm-client'), 'callLLMJSON')
      .mockResolvedValue(partialOutput);

    const { generatePersonaQuickAsync } = await import('../scripts/admin/persona-creator');

    const persona = await generatePersonaQuickAsync({ name: '回退测试' });

    // Should have fallen back to sync
    expect(persona.meta.name).toBe('回退测试');
    expect(persona.voice.sample_lines.length).toBeGreaterThanOrEqual(3);
  });

  it('handles LLM output with missing optional fields (no intimacy, schedule, content)', async () => {
    const minimalOutput = {
      meta: MOCK_LLM_PERSONA.meta,
      personality: MOCK_LLM_PERSONA.personality,
      voice: MOCK_LLM_PERSONA.voice,
      // no intimacy, schedule, or content
    };
    vi.spyOn(await import('../scripts/utils/llm-client'), 'callLLMJSON')
      .mockResolvedValue(minimalOutput);

    const { generatePersonaQuickAsync } = await import('../scripts/admin/persona-creator');

    const persona = await generatePersonaQuickAsync();

    // Core fields should still be present
    expect(persona.meta.name).toBe('林微澜');
    expect(persona.personality.mbti).toBe('INFP');
    expect(persona.voice.sample_lines.length).toBeGreaterThan(0);

    // Optional fields should be undefined
    expect(persona.intimacy).toBeUndefined();
    expect(persona.schedule).toBeUndefined();
    expect(persona.content).toBeUndefined();
    expect(persona.sub_skills).toEqual([]);
  });
});
