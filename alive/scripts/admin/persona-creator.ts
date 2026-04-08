// alive/scripts/admin/persona-creator.ts
// Persona creation engine — generates new persona YAML files.
// Supports two modes:
//   1. Quick mode: name + tagline → fully random persona
//   2. Guided mode: step-by-step user input → persona with AI fill-in

import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import type { PersonaConfig } from '../utils/types';
import { callLLMJSON } from '../utils/llm-client';
import { readTemplate } from '../utils/file-utils';

// ── Random Pools (Chinese) ───────────────────────────────────────

const SURNAMES = [
  '林', '陈', '沈', '苏', '叶', '顾', '白', '秦', '夏', '温',
  '江', '柳', '宋', '唐', '方', '许', '谢', '冯', '卢', '萧',
  '褚', '慕', '司', '季', '纪', '程', '梁', '楚', '霍', '池',
];

const GIVEN_NAMES_FEMALE = [
  '雨薇', '诗涵', '梦琪', '晓萌', '若曦', '清欢', '念安', '微澜', '子衿', '落落',
  '小鱼', '一一', '锦书', '半夏', '初晴', '念念', '可可', '糖糖', '毛毛', '豆豆',
  '语冰', '知意', '如是', '见秋', '轻寒', '映雪', '拾光', '栖迟', '未央', '扶苏',
];

const GIVEN_NAMES_MALE = [
  '子墨', '逸尘', '清川', '知远', '怀瑾', '予安', '时年', '长青', '九歌', '惊蛰',
  '一辰', '向晚', '鹿鸣', '拾一', '念北', '栖桐', '默笙', '临风', '朝暮', '浮生',
  '明澈', '无忧', '乐天', '随风', '归尘', '若水', '承影', '枕石', '凌霄', '寻欢',
];

const MBTI_TYPES = [
  'ESTP', 'ENFP', 'INTJ', 'INFP', 'ENTP', 'ISFJ', 'ENTJ', 'INTP',
  'ESFP', 'ISTJ', 'ENFJ', 'ISTP', 'ESFJ', 'INFJ', 'ISFP', 'ESTJ',
];

const CORE_TRAITS_POOL = [
  // 外向/活力
  '元气满满', '话痨', '社牛', '自来熟', '人来疯', '热心肠', '爱操心',
  // 内向/安静
  '慢热', '话少', '社恐', '安静', '内敛', '敏感细腻', '观察力强',
  // 积极
  '乐观', '行动派', '好胜心强', '有责任感', '热血', '目标明确',
  // 性格特点
  '口是心非', '刀子嘴豆腐心', '毒舌', '傲娇', '嘴硬', '爱逞强',
  '温柔', '体贴', '治愈系', '暖心', '包容', '有耐心',
  '好奇心旺盛', '三分钟热度', '拖延症', '完美主义',
  '直觉型', '天马行空', '理性', '务实', '大大咧咧', '不拘小节',
  '文艺', '浪漫', '宅', '吃货', '懒散', '佛系',
];

const QUIRKS_POOL = [
  '喜欢收集冰箱贴', '看到猫就走不动路', '一紧张就搓手指',
  '喝奶茶只喝三分糖', '睡前必须听白噪音', '出门前要确认三次锁了门',
  '拍照前一定要先选滤镜', '吃饭特别慢', '走路很快',
  '说话时喜欢比划', '看恐怖片会捂眼睛但偷偷看',
  '下雨天会特别开心', '闻到旧书味会安心', '喜欢捏泡泡纸',
  '咖啡只喝冰美式', '睡前一定要刷手机', '起床气很大',
  '喜欢在便利店待很久', '会把喜欢的歌单循环一整天',
  '写东西时嘴里会念念有词', '看到好看的云会停下来拍',
  '习惯性叹气（不是不开心）', '吃辣会流泪但还是要吃',
];

const VALUES_POOL = [
  '真实 > 完美', '不想给别人添麻烦', '讨厌虚伪',
  '朋友之间说真话', '不强迫别人', '做自己最重要',
  '家人最重要', '努力的人最帅', '不亏待自己',
  '做事要有始有终', '约定就一定要守', '不背后说人坏话',
  '钱要花在刀刃上', '知识是最好的投资', '健康第一',
  '自由最可贵', '宁缺毋滥', '对自己好一点',
  '善良不等于好欺负', '认真但不较真',
];

const OCCUPATIONS = [
  { title: '大学生', detail: '大三在读，专业课不多的时候喜欢窝在图书馆或者咖啡厅。没有太多钱但会把零花钱攒着去旅行或者吃好吃的。' },
  { title: '自由插画师', detail: '在家接稿的自由职业者。收入不太稳定但自由度很高。在各平台上有小小的粉丝群。最大的烦恼是 deadline 和灵感枯竭同时来。' },
  { title: '便利店夜班店员', detail: '晚上 10 点到早上 6 点的班。习惯了夜猫子作息。安静的深夜时段会偷偷看书或者刷手机。白天睡觉，生活和别人错开。' },
  { title: '实习编辑', detail: '在一家小出版社实习。每天和文字打交道，偶尔帮忙做新媒体运营。工资不高但喜欢这份安静的工作。' },
  { title: '独立咖啡店店主', detail: '开了一家小小的咖啡店。店里装修是自己设计的，常放爵士或 lo-fi。不以赚大钱为目标，享受和常客聊天的感觉。' },
  { title: '高中生', detail: '高二，功课压力挺大但还是会偷偷在课间画画或者看小说。周末喜欢和朋友出去逛街吃东西。' },
  { title: '程序员', detail: '在一家小公司做前端开发。加班不算太多，但遇到 bug 的时候会钻牛角尖到很晚。下班后喜欢打游戏放松。' },
  { title: '宠物店员', detail: '在宠物店工作，每天被各种猫猫狗狗围绕。工资不高但每天心情都不错。会把店里的宠物都取外号。' },
  { title: '视频博主（小型）', detail: '做生活 vlog 和美食探店的小博主。粉丝不多但都很活跃。每周更新 1-2 条视频，剪辑到半夜是常态。' },
  { title: '花店学徒', detail: '在一家花店学插花。喜欢研究花语和各种搭配。手上经常有被刺扎的小伤口。' },
  { title: '图书管理员', detail: '在区图书馆工作，安安静静的。认识很多来借书的老面孔。闲暇时间很多，基本都用来看书了。' },
  { title: '外卖骑手', detail: '每天在城市里穿梭送外卖。很了解这座城市的大街小巷。虽然辛苦但收入还行，最烦的是差评和恶劣天气。' },
];

const EMOJI_POOL = ['low', 'medium', 'high'] as const;

const LANGUAGE_STYLES = [
  { style: '口语化、活泼、短句多。感叹号随便用但不是每句。偶尔自我吐槽。', density: 'high' as const },
  { style: '温温柔柔的，说话慢慢的。句尾偶尔用「~」，不太用感叹号。', density: 'medium' as const },
  { style: '简短直接，不啰嗦。偶尔蹦出一两个梗。', density: 'low' as const },
  { style: '文艺腔，喜欢用比喻和意象。偶尔引用诗句但不矫情。', density: 'low' as const },
  { style: '嘴贱但不是真的恶意。吐槽型选手，喜欢用反话。', density: 'medium' as const },
  { style: '话多，想到什么说什么。句子之间用省略号连接，经常跑题。', density: 'medium' as const },
  { style: '认真严谨，但偶尔会冒出可爱的一面。用字精准但不装腔作势。', density: 'low' as const },
  { style: '懒洋洋的，说话带拖腔。能用一个字说清的绝不用两个字。', density: 'low' as const },
];

// ── Sample Lines by Style (Chinese) ──────────────────────────────

const SAMPLE_LINES_BY_STYLE: Record<string, string[]> = {
  '活泼': [
    '哈哈哈哈等等这个也太好笑了吧！！',
    '啊啊啊啊啊我好兴奋！！',
    '冲冲冲！今天状态超好的！',
    '这也太可爱了吧不行我要截图',
    '完了完了迟到了！跑——',
    '对对对！就是这个感觉！',
    '嘿嘿，被你发现了～',
  ],
  '温柔': [
    '慢慢来就好～不着急的',
    '今天天气真好呢…想出门走走',
    '嗯…辛苦了，先休息一会儿吧',
    '我帮你泡杯茶好不好～',
    '有点困了…但还想再聊一会儿',
    '好的呀，我等你～',
    '这个好好看…像画一样',
  ],
  '简短': [
    '行。',
    '真的假的？',
    '笑死。',
    '就这？',
    '可以，没问题。',
    '懂了。',
    '挺好的。',
  ],
  '文艺': [
    '窗外下起了小雨，适合发呆的天气。',
    '突然想到一句话——"所有的相遇都是久别重逢"。',
    '这杯咖啡的味道，像秋天傍晚的风。',
    '翻了翻旧照片，有些画面比记忆更清晰。',
    '晚安…今夜星光很温柔。',
    '有些话，想说的时候已经不用说了。',
  ],
  '毒舌': [
    '你认真的？这审美我真的一言难尽…',
    '啧，又来了。',
    '不是我说，你这理由也太敷衍了吧？',
    '行吧行吧，你开心就好（笑）',
    '哦？然后呢？',
    '别看我，我什么都没说。',
    '这种事…怎么说呢，算了不说了。',
  ],
  '话多': [
    '等等等等你听我说！就是那个…那个什么来着…',
    '天哪我刚刚看到一个超级好笑的事情，就是——啊不对先说另一个——',
    '所以然后就…嗯…我说到哪了？',
    '对了对了！我突然想起来了！',
    '你知道吗就是那种感觉…怎么形容呢…就很微妙那种？',
    '啊跑题了跑题了，回到刚才的话题——',
  ],
  '认真': [
    '我觉得这个问题可以从两个角度来看。',
    '嗯…让我想想。',
    '客观来说，确实是这样没错。',
    '有道理。不过我补充一点——',
    '这个数据好像不太对？我再确认一下。',
    '好，我记下来了。',
  ],
  '懒散': [
    '嗯…',
    '随便吧。',
    '好累…不想动…',
    '都行。你决定就好。',
    '……zZZ',
    '哈…啊…（打哈欠）',
    '能躺着就不站着。',
  ],
};

// Style keywords → sample line group mapping
function matchSampleLineGroup(style: string): string {
  const mapping: [string[], string][] = [
    [['活泼', '口语化', '短句', '感叹号', '自我吐槽'], '活泼'],
    [['温柔', '慢慢', '句尾', '～'], '温柔'],
    [['简短', '直接', '不啰嗦'], '简短'],
    [['文艺', '比喻', '意象', '诗句'], '文艺'],
    [['嘴贱', '吐槽', '反话', '毒舌'], '毒舌'],
    [['话多', '省略号', '跑题', '想到什么'], '话多'],
    [['认真', '严谨', '精准'], '认真'],
    [['懒', '拖腔', '一个字'], '懒散'],
  ];
  for (const [keywords, group] of mapping) {
    if (keywords.some(kw => style.includes(kw))) return group;
  }
  return '活泼'; // default
}

// ── Intimacy Presets ─────────────────────────────────────────────

const INTIMACY_PRESETS: Record<number, string>[] = [
  {
    1: '礼貌但有距离，用敬语，不分享私事',
    2: '友善、偶尔开玩笑、分享公开的事',
    3: '放松、偶尔撒娇、分享烦恼',
    4: '亲近、会吐槽、会撒娇、会分享脆弱的一面',
    5: '完全袒露、会发脾气也会示弱、像最好的朋友',
  },
  {
    1: '客气有礼，话不多',
    2: '开始聊日常，偶尔用表情包',
    3: '会主动找你聊天，分享心情',
    4: '说话不会太拘束，会吐真心话',
    5: '无话不谈，有什么说什么',
  },
  {
    1: '高冷脸，简短回复',
    2: '偶尔主动说话，但还是有点别扭',
    3: '嘴上不承认但行动上很关心',
    4: '表面嫌弃实际超贴心',
    5: '只在你面前才会卸下防备',
  },
];

// ── Schedule Presets ─────────────────────────────────────────────

const SCHEDULE_PRESETS = [
  { wake: 7, sleep: 23, peaks: [10, 15], label: '早起型' },
  { wake: 8, sleep: 0, peaks: [14, 21], label: '正常型' },
  { wake: 10, sleep: 1, peaks: [15, 22], label: '晚起型' },
  { wake: 12, sleep: 3, peaks: [18, 0], label: '夜猫子型' },
  { wake: 6, sleep: 22, peaks: [9, 14], label: '养生型' },
];

// ── Helpers ──────────────────────────────────────────────────────

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN<T>(arr: readonly T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

function generateId(name: string): string {
  // Convert Chinese name to pinyin-like slug
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
    .replace(/[\u4e00-\u9fff]+/g, (match) => {
      // Use a simple hash for Chinese chars to create a stable slug
      let hash = 0;
      for (const ch of match) {
        hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
      }
      return Math.abs(hash).toString(36).slice(0, 6);
    })
    || `persona-${Date.now().toString(36)}`;
}

// ── Core Generator ───────────────────────────────────────────────

export interface QuickCreateOptions {
  name?: string;
  tagline?: string;
}

export interface GuidedCreateOptions {
  name: string;
  tagline: string;
  age?: number;
  gender?: 'female' | 'male' | 'other';
  mbti?: string;
  coreTraits?: string[];
  occupation?: string;
  occupationDetail?: string;
  voiceStyle?: string;
  scheduleType?: 'early' | 'normal' | 'late' | 'night' | 'healthy';
}

/**
 * Generate a fully random persona. If name/tagline provided, use those.
 * Otherwise, generate random name + tagline.
 */
export function generatePersonaQuick(options: QuickCreateOptions = {}): PersonaConfig {
  const gender = Math.random() > 0.5 ? 'female' : 'male';
  const surname = pick(SURNAMES);
  const givenName = pick(gender === 'female' ? GIVEN_NAMES_FEMALE : GIVEN_NAMES_MALE);
  const name = options.name || `${surname}${givenName}`;

  const occupation = pick(OCCUPATIONS);
  const tagline = options.tagline || `${occupation.title}`;

  const mbti = pick(MBTI_TYPES);
  const coreTraits = pickN(CORE_TRAITS_POOL, 3 + Math.floor(Math.random() * 2));
  const quirks = pickN(QUIRKS_POOL, 2 + Math.floor(Math.random() * 2));
  const values = pickN(VALUES_POOL, 2 + Math.floor(Math.random() * 2));

  const langStyle = pick(LANGUAGE_STYLES);
  const schedulePreset = pick(SCHEDULE_PRESETS);
  const intimacyBehaviors = pick(INTIMACY_PRESETS);

  const sampleGroup = matchSampleLineGroup(langStyle.style);
  const sampleLines = pickN(SAMPLE_LINES_BY_STYLE[sampleGroup] ?? SAMPLE_LINES_BY_STYLE['活泼'], 5);

  const id = generateId(name);

  const genderLabel = gender === 'female' ? '女' : '男';

  const persona: PersonaConfig = {
    meta: {
      name,
      id,
      gender: genderLabel,
      tagline: `${tagline}`,
      occupation_detail: occupation.detail,
    },
    personality: {
      mbti,
      core_traits: coreTraits,
      quirks,
      values,
      description: `${name}，${tagline}。${mbti} 性格，${coreTraits.slice(0, 3).join('、')}。${quirks[0]}。`,
    },
    voice: {
      language: 'zh-CN',
      style: langStyle.style,
      emoji_density: langStyle.density,
      sample_lines: sampleLines,
    },
    intimacy: {
      levels: 5,
      behaviors: intimacyBehaviors,
    },
    schedule: {
      wake_hour: schedulePreset.wake,
      sleep_hour: schedulePreset.sleep,
      timezone: 'Asia/Shanghai',
      active_peaks: schedulePreset.peaks,
    },
    sub_skills: [],
  };

  return persona;
}

/**
 * Generate a persona from guided user input.
 * Fills in any missing fields with random values.
 */
export function generatePersonaGuided(options: GuidedCreateOptions): PersonaConfig {
  const { name, tagline, age, gender, mbti, coreTraits, occupation, occupationDetail, voiceStyle, scheduleType } = options;

  // Resolve MBTI
  const resolvedMbti = mbti && MBTI_TYPES.includes(mbti.toUpperCase())
    ? mbti.toUpperCase()
    : pick(MBTI_TYPES);

  // Resolve core traits
  const resolvedTraits = (coreTraits && coreTraits.length >= 2)
    ? coreTraits
    : pickN(CORE_TRAITS_POOL, 3 + Math.floor(Math.random() * 2));

  // Resolve occupation
  let resolvedOccupation: string;
  let resolvedOccupationDetail: string;
  if (occupation) {
    resolvedOccupation = occupation;
    resolvedOccupationDetail = occupationDetail || `${occupation}。`;
  } else {
    const randOcc = pick(OCCUPATIONS);
    resolvedOccupation = randOcc.title;
    resolvedOccupationDetail = randOcc.detail;
  }

  // Resolve voice style
  const resolvedLangStyle = voiceStyle
    ? { style: voiceStyle, density: pick(EMOJI_POOL) }
    : pick(LANGUAGE_STYLES);

  // Resolve schedule
  const scheduleMap: Record<string, typeof SCHEDULE_PRESETS[number]> = {
    early: SCHEDULE_PRESETS[0],
    normal: SCHEDULE_PRESETS[1],
    late: SCHEDULE_PRESETS[2],
    night: SCHEDULE_PRESETS[3],
    healthy: SCHEDULE_PRESETS[4],
  };
  const resolvedSchedule = (scheduleType && scheduleMap[scheduleType])
    ? scheduleMap[scheduleType]
    : pick(SCHEDULE_PRESETS);

  const quirks = pickN(QUIRKS_POOL, 2 + Math.floor(Math.random() * 2));
  const values = pickN(VALUES_POOL, 2 + Math.floor(Math.random() * 2));
  const intimacyBehaviors = pick(INTIMACY_PRESETS);

  const sampleGroup = matchSampleLineGroup(resolvedLangStyle.style);
  const sampleLines = pickN(SAMPLE_LINES_BY_STYLE[sampleGroup] ?? SAMPLE_LINES_BY_STYLE['活泼'], 5);

  const id = generateId(name);

  const genderLabel = gender === 'male' ? '男' : gender === 'female' ? '女' : undefined;

  const persona: PersonaConfig = {
    meta: {
      name,
      id,
      ...(age !== undefined && { age }),
      ...(genderLabel && { gender: genderLabel }),
      tagline: `${resolvedOccupation} · ${tagline}`,
      occupation_detail: resolvedOccupationDetail,
    },
    personality: {
      mbti: resolvedMbti,
      core_traits: resolvedTraits,
      quirks,
      values,
      description: `${name}，${resolvedOccupation}。${resolvedMbti} 性格，${resolvedTraits.slice(0, 3).join('、')}。${tagline}。`,
    },
    voice: {
      language: 'zh-CN',
      style: resolvedLangStyle.style,
      emoji_density: resolvedLangStyle.density as 'low' | 'medium' | 'high',
      sample_lines: sampleLines,
    },
    intimacy: {
      levels: 5,
      behaviors: intimacyBehaviors,
    },
    schedule: {
      wake_hour: resolvedSchedule.wake,
      sleep_hour: resolvedSchedule.sleep,
      timezone: 'Asia/Shanghai',
      active_peaks: resolvedSchedule.peaks,
    },
    sub_skills: [],
  };

  return persona;
}

/**
 * Serialize PersonaConfig to YAML string with nice formatting.
 */
export function personaToYAML(persona: PersonaConfig): string {
  const header = `# Alive 角色预设 — ${persona.meta.name}\n# 由 /alive create 自动生成\n# 生成时间: ${new Date().toISOString().slice(0, 19)}\n\n`;
  const yamlStr = YAML.stringify(persona, {
    indent: 2,
    lineWidth: 120,
    defaultStringType: 'QUOTE_DOUBLE',
    defaultKeyType: 'PLAIN',
  });
  return header + yamlStr;
}

/**
 * Save persona to alive/personas/ directory.
 * Returns the file path of the saved persona.
 */
export function savePersona(persona: PersonaConfig): string {
  // Determine personas dir: try installed skill path, fallback to source tree
  const personasDir = resolvePersonasDir();
  const filename = `${persona.meta.id || persona.meta.name.toLowerCase().replace(/\s+/g, '-')}.yaml`;
  const filePath = path.join(personasDir, filename);

  // Don't overwrite existing files — append a number
  let finalPath = filePath;
  let counter = 1;
  while (fs.existsSync(finalPath)) {
    const base = filename.replace('.yaml', '');
    finalPath = path.join(personasDir, `${base}-${counter}.yaml`);
    counter++;
  }

  fs.mkdirSync(personasDir, { recursive: true });
  fs.writeFileSync(finalPath, personaToYAML(persona), 'utf8');
  return finalPath;
}

/**
 * Resolve the personas directory path.
 * In development: alive/personas/ in the source tree.
 * In installed mode: ~/.openclaw/skills/alive/personas/
 */
function resolvePersonasDir(): string {
  // Check installed skill path first
  const installedDir = path.join(
    process.env.HOME || '',
    '.openclaw', 'skills', 'alive', 'personas'
  );
  if (fs.existsSync(path.dirname(installedDir))) {
    return installedDir;
  }

  // Fall back to source tree (development mode)
  // Navigate from this file's location to alive/personas/
  const srcDir = path.resolve(__dirname, '..', '..', 'personas');
  return srcDir;
}

/**
 * List available MBTI types for guided mode.
 */
export function getAvailableMBTI(): string[] {
  return [...MBTI_TYPES];
}

/**
 * List available trait pool for guided mode.
 */
export function getTraitPool(): string[] {
  return [...CORE_TRAITS_POOL];
}

/**
 * List available schedule types.
 */
export function getScheduleTypes(): Array<{ key: string; label: string; desc: string }> {
  return [
    { key: 'early', label: '早起型', desc: '7:00 起 / 23:00 睡' },
    { key: 'normal', label: '正常型', desc: '8:00 起 / 0:00 睡' },
    { key: 'late', label: '晚起型', desc: '10:00 起 / 1:00 睡' },
    { key: 'night', label: '夜猫子型', desc: '12:00 起 / 3:00 睡' },
    { key: 'healthy', label: '养生型', desc: '6:00 起 / 22:00 睡' },
  ];
}

/**
 * Format persona preview for display.
 */
export function formatPersonaPreview(persona: PersonaConfig): string {
  const schedule = persona.schedule;
  const scheduleStr = schedule
    ? `${schedule.wake_hour}:00 起 / ${schedule.sleep_hour}:00 睡`
    : 'N/A';

  return `## 🌟 新角色预览

| 字段 | 内容 |
|------|------|
| **名字** | ${persona.meta.name} |
| **性别** | ${persona.meta.gender || 'N/A'} |
| **定位** | ${persona.meta.tagline} |
| **MBTI** | ${persona.personality.mbti} |
| **性格** | ${persona.personality.core_traits.join('、')} |
| **小癖好** | ${(persona.personality.quirks ?? []).join('、') || 'N/A'} |
| **价值观** | ${(persona.personality.values ?? []).join('、') || 'N/A'} |
| **说话风格** | ${persona.voice.style} |
| **作息** | ${scheduleStr} |
| **Emoji** | ${persona.voice.emoji_density || 'medium'} |

### 📝 示例台词
${persona.voice.sample_lines.map(l => `> ${l}`).join('\n')}

### 📖 人物简介
> ${persona.personality.description || 'N/A'}`;
}

// ── LLM Output Type ─────────────────────────────────────────────

/** Shape returned by the LLM from persona-generate-prompt.md */
interface LLMPersonaOutput {
  meta: {
    name: string;
    gender: string;
    age?: number;
    tagline: string;
    occupation_detail?: string;
  };
  personality: {
    mbti: string;
    core_traits: string[];
    quirks?: string[];
    values?: string[];
    trait_descriptions?: string;
    mbti_description?: string;
    domain_knowledge?: string;
    interests_description?: string;
    description?: string;
  };
  voice: {
    language?: string;
    style: string;
    emoji_density?: 'low' | 'medium' | 'high';
    sample_lines: string[];
    expression_features?: string;
    diary_style_guide?: string;
  };
  intimacy?: {
    levels?: number;
    behaviors: Record<number | string, string>;
  };
  schedule?: {
    wake_hour: number;
    sleep_hour: number;
    timezone?: string;
    active_peaks: number[];
    time_state_description?: string;
  };
  content?: {
    behavior_examples?: string;
    diary_examples?: string;
    search_topics?: string;
  };
}

// ── Async LLM-Powered Generator ─────────────────────────────────

/**
 * Build the generation-mode description section for the prompt.
 */
function buildModeSection(options: QuickCreateOptions): string {
  if (options.name || options.tagline) {
    return '**快速模式**：用户提供了部分信息（名字和/或定位标签），请以此为基础丰富完善整个角色。';
  }
  return '**全随机模式**：用户没有提供任何信息，请完全自由发挥，创造一个独特有趣的角色。';
}

/**
 * Build the seed-info section for the prompt.
 */
function buildSeedSection(options: QuickCreateOptions): string {
  const parts: string[] = [];
  if (options.name) parts.push(`- 名字：${options.name}`);
  if (options.tagline) parts.push(`- 定位/标签：${options.tagline}`);
  if (parts.length === 0) return '（无种子信息，完全自由创造）';
  return parts.join('\n');
}

/**
 * Build the user-constraints section for the prompt.
 */
function buildConstraintSection(options: QuickCreateOptions): string {
  const constraints: string[] = [];
  if (options.name) constraints.push(`- 角色名必须为「${options.name}」`);
  if (options.tagline) constraints.push(`- tagline 必须包含「${options.tagline}」的核心含义`);
  if (constraints.length === 0) return '（无硬约束）';
  return constraints.join('\n');
}

/**
 * Validate that the LLM output contains all critical required fields.
 * Throws if any required field is missing, causing fallback to sync generator.
 */
function validateLLMOutput(output: LLMPersonaOutput): void {
  if (!output.meta?.name) throw new Error('LLM output missing meta.name');
  if (!output.personality?.mbti) throw new Error('LLM output missing personality.mbti');
  if (!output.personality?.core_traits?.length) throw new Error('LLM output missing core_traits');
  if (!output.voice?.sample_lines?.length) throw new Error('LLM output missing sample_lines');
  if (!output.voice?.style) throw new Error('LLM output missing voice.style');
}

/**
 * Map raw LLM output to a fully valid PersonaConfig.
 * Ensures required fields are present and fixed values are set.
 */
function mapLLMOutputToPersona(llmOutput: LLMPersonaOutput): PersonaConfig {
  const name = llmOutput.meta.name;
  const id = generateId(name);

  // Normalise intimacy behaviors keys to numbers
  const rawBehaviors = llmOutput.intimacy?.behaviors ?? {};
  const behaviors: Record<number, string> = {};
  for (const [key, val] of Object.entries(rawBehaviors)) {
    behaviors[Number(key)] = val;
  }

  return {
    meta: {
      name,
      id,
      gender: llmOutput.meta.gender,
      age: llmOutput.meta.age,
      tagline: llmOutput.meta.tagline,
      occupation_detail: llmOutput.meta.occupation_detail,
    },
    personality: {
      mbti: llmOutput.personality.mbti,
      core_traits: llmOutput.personality.core_traits,
      quirks: llmOutput.personality.quirks,
      values: llmOutput.personality.values,
      trait_descriptions: llmOutput.personality.trait_descriptions,
      mbti_description: llmOutput.personality.mbti_description,
      domain_knowledge: llmOutput.personality.domain_knowledge,
      interests_description: llmOutput.personality.interests_description,
      description: llmOutput.personality.description,
    },
    voice: {
      language: 'zh-CN', // fixed
      style: llmOutput.voice.style,
      emoji_density: llmOutput.voice.emoji_density,
      sample_lines: llmOutput.voice.sample_lines,
      expression_features: llmOutput.voice.expression_features,
      diary_style_guide: llmOutput.voice.diary_style_guide,
    },
    intimacy: llmOutput.intimacy ? {
      levels: 5, // fixed
      behaviors,
    } : undefined,
    schedule: llmOutput.schedule ? {
      wake_hour: llmOutput.schedule.wake_hour,
      sleep_hour: llmOutput.schedule.sleep_hour,
      timezone: 'Asia/Shanghai', // fixed
      active_peaks: llmOutput.schedule.active_peaks,
      time_state_description: llmOutput.schedule.time_state_description,
    } : undefined,
    content: llmOutput.content ? {
      behavior_examples: llmOutput.content.behavior_examples,
      diary_examples: llmOutput.content.diary_examples,
      search_topics: llmOutput.content.search_topics,
    } : undefined,
    sub_skills: [], // always empty for generated personas
  };
}

/**
 * Generate a persona using LLM (async).
 * Falls back to the synchronous `generatePersonaQuick()` if the LLM call fails.
 */
export async function generatePersonaQuickAsync(options: QuickCreateOptions = {}): Promise<PersonaConfig> {
  try {
    // 1. Load prompt template
    const template = readTemplate('persona-generate-prompt.md');

    // 2. Fill placeholders
    const prompt = template
      .replace('{generation_mode}', buildModeSection(options))
      .replace('{seed_info}', buildSeedSection(options))
      .replace('{user_constraints}', buildConstraintSection(options));

    // 3. Call LLM
    const llmOutput = await callLLMJSON<LLMPersonaOutput>(prompt, 'persona-creator');

    // 4. Validate critical fields before mapping
    validateLLMOutput(llmOutput);

    // 5. Map to PersonaConfig
    return mapLLMOutputToPersona(llmOutput);
  } catch (err) {
    // Fallback to sync generator
    console.warn(`[persona-creator] LLM generation failed, falling back to sync: ${(err as Error).message}`);
    return generatePersonaQuick(options);
  }
}

// ── Guided Async Helpers ─────────────────────────────────────────

/**
 * Build the generation-mode section for guided mode.
 */
function buildGuidedModeSection(options: GuidedCreateOptions): string {
  return '**引导模式**：用户提供了详细的角色参数（名字、定位、性别、MBTI 等），请严格遵守这些约束，在此基础上丰富完善角色的所有维度。';
}

/**
 * Build the seed-info section for guided mode.
 */
function buildGuidedSeedSection(options: GuidedCreateOptions): string {
  const parts: string[] = [];
  parts.push(`- 名字：${options.name}`);
  parts.push(`- 定位/标签：${options.tagline}`);
  if (options.age !== undefined) parts.push(`- 年龄：${options.age}`);
  if (options.gender) {
    const genderLabel = options.gender === 'female' ? '女' : options.gender === 'male' ? '男' : options.gender;
    parts.push(`- 性别：${genderLabel}`);
  }
  if (options.mbti) parts.push(`- MBTI：${options.mbti.toUpperCase()}`);
  if (options.coreTraits?.length) parts.push(`- 核心性格：${options.coreTraits.join('、')}`);
  if (options.occupation) parts.push(`- 职业：${options.occupation}`);
  if (options.occupationDetail) parts.push(`- 职业细节：${options.occupationDetail}`);
  if (options.voiceStyle) parts.push(`- 说话风格：${options.voiceStyle}`);
  if (options.scheduleType) parts.push(`- 作息类型：${options.scheduleType}`);
  return parts.join('\n');
}

/**
 * Build the user-constraints section for guided mode.
 * All user-provided fields become hard constraints.
 */
function buildGuidedConstraintSection(options: GuidedCreateOptions): string {
  const constraints: string[] = [];
  constraints.push(`- 角色名必须为「${options.name}」`);
  constraints.push(`- tagline 必须包含「${options.tagline}」的核心含义`);
  if (options.gender) {
    const genderLabel = options.gender === 'female' ? '女' : options.gender === 'male' ? '男' : options.gender;
    constraints.push(`- 性别必须为「${genderLabel}」`);
  }
  if (options.age !== undefined) constraints.push(`- 年龄必须为 ${options.age}`);
  if (options.mbti) constraints.push(`- MBTI 类型必须为「${options.mbti.toUpperCase()}」`);
  if (options.coreTraits?.length) constraints.push(`- 核心性格必须包含：${options.coreTraits.join('、')}`);
  if (options.occupation) constraints.push(`- 职业/身份必须为「${options.occupation}」`);
  if (options.voiceStyle) constraints.push(`- 说话风格必须符合「${options.voiceStyle}」`);
  if (options.scheduleType) {
    const scheduleLabels: Record<string, string> = {
      early: '早起型', normal: '正常型', late: '晚起型', night: '夜猫子型', healthy: '养生型',
    };
    constraints.push(`- 作息类型必须为「${scheduleLabels[options.scheduleType] ?? options.scheduleType}」`);
  }
  return constraints.join('\n');
}

/**
 * Generate a persona from guided user input using LLM (async).
 * Falls back to the synchronous `generatePersonaGuided()` if the LLM call fails.
 */
export async function generatePersonaGuidedAsync(options: GuidedCreateOptions): Promise<PersonaConfig> {
  try {
    // 1. Load prompt template
    const template = readTemplate('persona-generate-prompt.md');

    // 2. Fill placeholders with guided-mode specific content
    const prompt = template
      .replace('{generation_mode}', buildGuidedModeSection(options))
      .replace('{seed_info}', buildGuidedSeedSection(options))
      .replace('{user_constraints}', buildGuidedConstraintSection(options));

    // 3. Call LLM
    const llmOutput = await callLLMJSON<LLMPersonaOutput>(prompt, 'persona-creator');

    // 4. Validate critical fields before mapping
    validateLLMOutput(llmOutput);

    // 5. Map to PersonaConfig
    return mapLLMOutputToPersona(llmOutput);
  } catch (err) {
    // Fallback to sync generator
    console.warn(`[persona-creator] LLM guided generation failed, falling back to sync: ${(err as Error).message}`);
    return generatePersonaGuided(options);
  }
}
