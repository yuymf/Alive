// alive/tests/e2e-miss-v-full-day.test.ts
// E2E test: Simulate Miss V (V姐) full day lifecycle
//   Morning Plan → Regular Heartbeat Ticks (10:00–00:00) → Night Reflection
//
// Miss V is an ENTJ tri-identity virtual influencer (esports/singer/racer).
// Her day is heavier on professional content creation, ops desk activity,
// and multi-platform engagement (XHS + Douyin).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import YAML from 'yaml';
import { setBasePaths, resetBasePaths, PATHS, readJSON, readText } from '../scripts/utils/file-utils';
import { setTimeOverride, clearTimeOverride } from '../scripts/utils/time-utils';
import { clearPersonaCache } from '../scripts/persona/persona-loader';
import { runMorningPlan } from '../scripts/lifecycle/morning-plan';
import { regularTick } from '../scripts/lifecycle/heartbeat-tick';
import { runNightReflect } from '../scripts/lifecycle/night-reflect';
import { clearRouteTable } from '../scripts/router/skill-router';
import type {
  EmotionState, IntentPool, HeartbeatLog, VitalityState,
  ConfidenceState, FlowState, WisdomStore, CronSchedule,
  ScheduleToday, Preferences, Aspirations, PersonalityDrift,
} from '../scripts/utils/types';

// ── Test persona data (V姐 / Miss V) ─────────────────────────────

const MISS_V_PERSONA = {
  meta: {
    id: 'miss-v',
    name: 'V姐',
    display_name: 'Miss V',
    age: 21,
    zodiac: '天秤座',
    tagline: '不被单一标签定义',
  },
  personality: {
    mbti: 'ENTJ',
    core_traits: [
      '专业硬核，理性共情，解说控场稳且有深度',
      '松弛飒爽，低调贵气，不迎合流量',
      '外冷内热，多面自律，热血敢闯',
    ],
    quirks: ['赛前必听同一首歌', '发帖前反复检查文案克不克制'],
    values: ['实力 > 人设', '克制 > 浮夸'],
  },
  voice: {
    language: 'zh-CN',
    style: '简练有力，克制但有温度，专业术语自然融入，偶尔反差式幽默',
    emoji_density: 'low' as const,
    sample_lines: [
      'BP阶段就已经赢了，团战只是在还债。',
      '今天赛道数据有点意思，明天继续。',
    ],
  },
  intimacy: {
    levels: 5,
    behaviors: {
      1: '专业克制，保持距离',
      3: '适度开放，偶尔分享幕后',
      5: '真实反差，展示柔软一面',
    },
  },
  schedule: {
    wake_hour: 9,
    sleep_hour: 1,
    timezone: 'Asia/Shanghai',
    active_peaks: [14, 21],
  },
  identities: {
    esports_commentator: { weight: 0.40 },
    singer: { weight: 0.25 },
    racer: { weight: 0.20 },
    lifestyle: { weight: 0.15 },
  },
  // Enable sub-skills matching Miss V's profile
  sub_skills: ['ops-desk', 'generate-image', 'xhs-bridge', 'content-browse', 'web-search'],
  features: {
    skill_discovery: false,
    random_events: true,
    social_graph: false,
    flow_states: true,
    procrastination: false,
    personality_drift: true,
  },
  ops: {
    enabled: true,
    brief_time: '08:30',
    trend_score_threshold: 1.8,
    topic_count: 3,
    platforms: {
      xhs: { enabled: true, style: '图文为主，封面强视觉冲击，文案克制有力' },
      douyin: { enabled: true, style: '视频脚本，前3秒必须有冲突感或反差' },
    },
    competitors: [],
    content_templates: [],
  },
};

// ── Mock LLM responses ──────────────────────────────────────────

// NOTE: Miss V's persona has sleep_hour: 1 (1am), but the cron schedule builder uses
// `for (h = wakeHour+1; h < sleepHour; h++)` which breaks for cross-midnight schedules.
// We use sleep_time '23:00' here to stay within the same-day range so regular
// heartbeats are generated. Cross-midnight cron support is a known framework limitation.
const MORNING_PLAN_RESPONSE = JSON.stringify({
  mood_description: '今天有KPL赛事，要好好准备解说稿',
  wake_time: '09:00',
  sleep_time: '23:00',
  flexible_schedule: [
    { activity: '研究BP数据', preferred_time: '10:00-12:00', intent_boost: 3, intent_category: 'learn' },
    { activity: '录制赛前解说', preferred_time: '14:00-16:00', intent_boost: 4, intent_category: 'produce' },
    { activity: '发布XHS内容', preferred_time: '20:00-22:00', intent_boost: 3, intent_category: 'express' },
    { activity: '赛后复盘直播', preferred_time: '22:00-00:00', intent_boost: 2, intent_category: 'connect' },
  ],
  intent_seeds: [
    { category: 'produce', description: '制作一期KPL赛事解说切片', intensity: 8 },
    { category: 'learn', description: '研究今日赛事BP数据', intensity: 7 },
    { category: 'express', description: '发布小红书战术分析帖', intensity: 6 },
    { category: 'connect', description: '跟电竞粉丝互动答疑', intensity: 4 },
  ],
  diary_entry: '今天赛事日。数据先行，结论后说。',
});

// Miss V heartbeat decisions — professional and focused throughout the day
function makeHeartbeatDecision(hour: number): string {
  const decisions: Record<number, object> = {
    10: {
      inner_monologue: '打开赛事数据库，今天的BP有几个点值得深挖',
      new_impulses: [
        { category: 'learn', description: '分析今日对阵双方的ban/pick胜率数据', intensity: 7 },
      ],
      suppressed_intents: [],
      chosen_actions: [
        { action: '研究两队近期BP数据和胜率曲线', type: 'real', skill: 'web-search', satisfies_intent: 'learn' },
      ],
    },
    11: {
      inner_monologue: '果然，这队的BP思路在版本迭代后已经有明显变化',
      new_impulses: [],
      suppressed_intents: [],
      chosen_actions: [
        { action: '整理BP分析笔记，找出关键战术转变点', type: 'simulated', skill: null, satisfies_intent: null },
      ],
    },
    12: {
      inner_monologue: '吃饭，顺便刷一下今天的热搜看有没有赛事相关话题可以借势',
      new_impulses: [
        { category: 'consume', description: '看热搜有没有可以蹭的赛事话题', intensity: 4 },
      ],
      suppressed_intents: [],
      chosen_actions: [
        { action: '吃饭+刷热榜，发现有赛事话题在发酵', type: 'real', skill: 'content-browse', satisfies_intent: 'consume' },
      ],
    },
    13: {
      inner_monologue: '下午的解说稿需要专注，先把手机放一边',
      new_impulses: [],
      suppressed_intents: [],
      chosen_actions: [
        { action: '闭目养神15分钟，为下午解说准备状态', type: 'simulated', skill: null, satisfies_intent: null },
      ],
    },
    14: {
      inner_monologue: '开始录制赛前解说，BP阶段分析是核心',
      new_impulses: [
        { category: 'produce', description: '录制今日赛事BP解说视频', intensity: 9 },
      ],
      suppressed_intents: [],
      chosen_actions: [
        { action: '开始录制KPL赛前解说视频，深度拆解双方BP思路', type: 'simulated', skill: null, satisfies_intent: null },
      ],
    },
    15: {
      inner_monologue: '第一遍录完了，重听一遍，有两个技术细节要补充',
      new_impulses: [],
      suppressed_intents: [],
      chosen_actions: [
        { action: '回听录音，补录两段技术细节解析', type: 'simulated', skill: null, satisfies_intent: null },
      ],
    },
    16: {
      inner_monologue: '视频内容不错，需要配上XHS图文版本，文字更适合深度内容',
      new_impulses: [
        { category: 'express', description: '把BP分析整理成小红书图文帖', intensity: 6 },
      ],
      suppressed_intents: [],
      chosen_actions: [
        { action: '把解说核心观点整理成小红书图文格式', type: 'real', skill: 'xhs-bridge', satisfies_intent: 'express' },
      ],
    },
    17: {
      inner_monologue: '需要一张配套的赛事分析封面图',
      new_impulses: [],
      suppressed_intents: [],
      chosen_actions: [
        { action: '生成赛事解说主题封面图', type: 'real', skill: 'generate-image', satisfies_intent: 'produce' },
      ],
    },
    18: {
      inner_monologue: '内容基本准备好了，晚上赛事开始前发出去',
      new_impulses: [],
      suppressed_intents: [],
      chosen_actions: [
        { action: '整理一下，准备晚上发布前的最终审核', type: 'simulated', skill: null, satisfies_intent: null },
      ],
    },
    19: {
      inner_monologue: '赛事马上开始了，发布赛前分析内容，让粉丝跟着思路看比赛',
      new_impulses: [
        { category: 'express', description: '赛前发布BP分析，引导粉丝观赛视角', intensity: 8 },
      ],
      suppressed_intents: [],
      chosen_actions: [
        { action: '发布赛前BP解说视频+小红书图文，附上观赛指南', type: 'real', skill: 'ops-desk', satisfies_intent: 'express' },
      ],
    },
    20: {
      inner_monologue: '帖子发出去了，数据不错。看比赛，专注',
      new_impulses: [],
      suppressed_intents: [],
      chosen_actions: [
        { action: '全神贯注看比赛，同步记录关键时刻和战术亮点', type: 'simulated', skill: null, satisfies_intent: null },
      ],
    },
    21: {
      inner_monologue: '比赛精彩，记录下来的亮点已经够做一期复盘了',
      new_impulses: [
        { category: 'produce', description: '记录赛中精彩瞬间，备用素材', intensity: 7 },
      ],
      suppressed_intents: [],
      chosen_actions: [
        { action: '整理赛中亮点笔记，计划明天的赛后复盘内容', type: 'simulated', skill: null, satisfies_intent: null },
      ],
    },
    22: {
      inner_monologue: '比赛结束，跟粉丝互动答疑，他们的问题其实很专业',
      new_impulses: [
        { category: 'connect', description: '跟粉丝讨论今天比赛的技战术', intensity: 6 },
      ],
      suppressed_intents: [],
      chosen_actions: [
        { action: '在评论区回复粉丝的战术问题，解答有深度的提问', type: 'simulated', skill: null, satisfies_intent: null },
      ],
    },
    23: {
      inner_monologue: '互动结束了。今天的内容质量还不错，明天继续',
      new_impulses: [],
      suppressed_intents: [],
      chosen_actions: [
        { action: '整理今天的内容数据和粉丝反馈，记录有价值的问题', type: 'simulated', skill: null, satisfies_intent: null },
      ],
    },
    0: {
      inner_monologue: '快睡了，简单复盘一下今天',
      new_impulses: [
        { category: 'rest', description: '准备睡觉，明天还有训练', intensity: 5 },
      ],
      suppressed_intents: [],
      chosen_actions: [
        { action: '写下明天的三件优先事项，然后关灯', type: 'simulated', skill: null, satisfies_intent: null },
      ],
    },
  };

  return JSON.stringify(decisions[hour] ?? {
    inner_monologue: '专注工作中...',
    new_impulses: [],
    suppressed_intents: [],
    chosen_actions: [
      { action: '继续专注手头的工作', type: 'simulated', skill: null, satisfies_intent: null },
    ],
  });
}

const SIMULATED_ACTION_RESPONSE = JSON.stringify({
  action: '完成了专业内容',
  type: 'simulated',
  narrative: '专注于内容创作和专业研究',
  diary_entry: '今天的工作很有深度，数据和内容都在积累。',
  emotion_delta: { valence: 0.06, energy: -0.03 },
  new_intents: [],
  relation_updates: [],
});

const NIGHT_REFLECT_RESPONSE = JSON.stringify({
  new_wisdom: [
    { lesson: 'BP解说的核心是把复杂逻辑讲清楚，而不是展示自己懂多少', importance: 8, tags: ['解说', '表达'] },
    { lesson: '赛事日的内容要在开赛前发，开赛后就过期了', importance: 7, tags: ['时机', '内容节奏'] },
    { lesson: '粉丝提问里藏着下一期内容的选题', importance: 6, tags: ['内容策略', '互动'] },
  ],
  preference_updates: [
    { type: 'interests', name: '电竞数据分析', affinity_delta: 1.5, reason: '今天深度BP研究带来成就感' },
    { type: 'content_style', name: '专业深度解析', affinity_delta: 1, reason: '粉丝对专业内容的反馈很好' },
  ],
  aspiration_updates: [
    { action: 'create', content: '做一期完整的赛季BP规律分析，从数据视角还原版本演变', context: '今天研究BP时发现版本变化有系统规律' },
  ],
  personality_drift: null,
  diary_entry: '赛事日。数据充分，内容扎实，粉丝专业。这才是想要的方向。',
});

// ── Minimal templates ────────────────────────────────────────────

const MINIMAL_TEMPLATES: Record<string, string> = {
  'morning-plan-prompt.md': `
# Morning Plan for {persona.meta.name}
Current time: {current_time}
Weekday: {weekday_name}
Yesterday: {yesterday_summary}
Aspirations: {aspirations_summary}
World: {world_summary}
Events: {overnight_events}
Schedule: {rigid_schedule_template}
Return JSON with: mood_description, wake_time, sleep_time, flexible_schedule, intent_seeds, diary_entry.
`,
  'heartbeat-prompt.md': `
# Heartbeat for {persona.meta.name}
Time: {current_time}
Emotion: {emotion_summary}
Schedule: {schedule_context}
Recent: {recent_tick_summaries}
{last_inner_monologue}
Perception: {perception_summary}
Intents: {intent_pool_summary}
Personality: {personality_context}
Vitality: {vitality_context}
Confidence: {confidence_context}
Voice: {voice_directive}
Skills: {skill_hint}
Return JSON with: inner_monologue, new_impulses, suppressed_intents, chosen_actions.
`,
  'night-reflect-prompt.md': `
# Night Reflection for {persona.meta.name}
Time: {current_time}
Diary: {today_diary}
Summary: {today_heartbeat_summary}
Wisdom: {core_wisdom}
Preferences: {preferences_summary}
Aspirations: {aspirations_summary}
Return JSON with: new_wisdom, preference_updates, aspiration_updates, personality_drift, diary_entry.
`,
  'simulated-action.md': `
# Simulated Action for {persona.meta.name}
Action: {action_description}
Emotion: {emotion_summary}
Time: {current_time}
Schedule: {schedule_context}
{recent_diary_context}
Voice: {voice_directive}
Return JSON with: action, type, narrative, diary_entry, emotion_delta, new_intents, relation_updates.
`,
  'personality.md': '{persona.meta.name} personality template',
  'soul-injection.md': '{persona.meta.name} soul injection',
  'reflection-prompt.md': 'Reflection prompt for {persona.meta.name}',
  'diary-entry.md': 'Diary entry template for {persona.meta.name}',
  'flow-evolution-prompt.md': `
# Flow Evolution for {persona.meta.name}
Activity: {activity}, Duration: {duration} ticks
Emotion: {emotion_summary}, Vitality: {vitality}
Return JSON with: micro_activity, diary_line.
`,
};

// ── Helper: Create sandboxed environment ─────────────────────────

let tmpDir: string;

/** Create a mock sub-skill directory with manifest.json and scripts/index.js */
function createMockSubSkill(
  baseDir: string,
  skillName: string,
  displayName: string,
  description: string,
  intentBindings: Array<{ intent: string; action: string; priority: number }>,
): void {
  const skillDir = path.join(baseDir, skillName);
  fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });

  fs.writeFileSync(path.join(skillDir, 'manifest.json'), JSON.stringify({
    name: skillName,
    display_name: displayName,
    version: '0.1.0-mock',
    description,
    intent_bindings: intentBindings,
  }, null, 2));

  const actionNames = [...new Set(intentBindings.map(b => b.action))];
  const actionsCode = actionNames.map(action => `
    '${action}': async function(ctx) {
      return {
        narrative: '[mock:${skillName}] 执行了 ${action}: ' + (ctx.intent ? ctx.intent.description : ''),
        emotion_deltas: [{ valence: 0.06, energy: -0.03 }],
        vitality_cost: 5,
        feedback: [],
        events_triggered: [],
      };
    }`).join(',\n');

  fs.writeFileSync(path.join(skillDir, 'scripts', 'index.js'), `
module.exports = {
  manifest: require('../manifest.json'),
  actions: {${actionsCode}
  },
};
`);
}

function setupSandbox() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miss-v-e2e-fullday-'));
  setBasePaths(tmpDir, tmpDir);

  fs.mkdirSync(path.join(tmpDir, 'relations', 'social', 'xhs'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'sub-skills'), { recursive: true });

  fs.writeFileSync(
    path.join(tmpDir, 'persona.yaml'),
    YAML.stringify(MISS_V_PERSONA),
  );

  for (const [name, content] of Object.entries(MINIMAL_TEMPLATES)) {
    fs.writeFileSync(path.join(tmpDir, 'templates', name), content);
  }

  // Create mock sub-skills for Miss V's skill set
  const subSkillsDir = path.join(tmpDir, 'sub-skills');

  createMockSubSkill(subSkillsDir, 'ops-desk', 'Ops Desk 内容运营',
    '内容草稿生成、发布到小红书+抖音', [
      { intent: 'produce', action: 'generate-topics', priority: 7 },
      { intent: 'express', action: 'generate-topics', priority: 6 },
      { intent: 'consume', action: 'refresh-trends', priority: 3 },
    ]);

  createMockSubSkill(subSkillsDir, 'generate-image', 'AI图片生成',
    '生成角色形象/内容封面图', [
      { intent: 'produce', action: 'generate', priority: 6 },
    ]);

  createMockSubSkill(subSkillsDir, 'xhs-bridge', '小红书桥接',
    '搜索、发布小红书内容', [
      { intent: 'express', action: 'publish-note', priority: 8 },
      { intent: 'consume', action: 'search-feed', priority: 4 },
    ]);

  createMockSubSkill(subSkillsDir, 'content-browse', '内容浏览与灵感采集',
    '刷内容、采集热榜灵感', [
      { intent: 'consume', action: 'feed-browse', priority: 4 },
      { intent: 'learn', action: 'inspiration-collect', priority: 4 },
    ]);

  createMockSubSkill(subSkillsDir, 'web-search', '网络搜索研究',
    '网络搜索、赛事数据查询', [
      { intent: 'learn', action: 'search-pipeline', priority: 5 },
      { intent: 'consume', action: 'search-pipeline', priority: 3 },
    ]);
}

function teardownSandbox() {
  clearTimeOverride();
  clearPersonaCache();
  clearRouteTable();
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function setSimulatedTime(year: number, month: number, day: number, hour: number, minute = 0) {
  setTimeOverride(new Date(year, month - 1, day, hour, minute, 0, 0));
}

// ── Build mock LLM ──────────────────────────────────────────────

function createDaySimulationLLM() {
  let currentHour = 9;

  return {
    setHour(h: number) { currentHour = h; },

    client: {
      async callJSON<T>(prompt: string): Promise<T> {
        const p = prompt.toLowerCase();

        if (p.includes('morning plan') || p.includes('morning_plan') || p.includes('wake_time')) {
          return JSON.parse(MORNING_PLAN_RESPONSE) as T;
        }

        if (p.includes('night reflection') || p.includes('night_reflect') || p.includes('new_wisdom')) {
          return JSON.parse(NIGHT_REFLECT_RESPONSE) as T;
        }

        if (p.includes('simulated action') || p.includes('action_description')) {
          return JSON.parse(SIMULATED_ACTION_RESPONSE) as T;
        }

        if (p.includes('flow evolution') || p.includes('micro_activity')) {
          return JSON.parse(JSON.stringify({
            micro_activity: '进入深度工作状态，思路越来越清晰',
            diary_line: '还在继续深挖...这个分析角度很有价值。',
          })) as T;
        }

        if (p.includes('heartbeat') || p.includes('inner_monologue') || p.includes('chosen_actions')) {
          return JSON.parse(makeHeartbeatDecision(currentHour)) as T;
        }

        return JSON.parse('{}') as T;
      },

      async call(prompt: string): Promise<string> {
        return 'V姐今天的赛事内容表现专业，数据扎实。';
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// E2E Test Suite — Miss V Full Day
// ═══════════════════════════════════════════════════════════════════

describe('E2E: V姐 (Miss V) Full Day Simulation', () => {
  let llmHelper: ReturnType<typeof createDaySimulationLLM>;

  beforeEach(() => {
    setupSandbox();
    llmHelper = createDaySimulationLLM();
  });

  afterEach(() => {
    teardownSandbox();
  });

  // ── Phase 1: Morning Plan ────────────────────────────────────

  describe('Phase 1: Morning Plan (09:00)', () => {
    it('generates schedule with ENTJ esports-focused intent seeds', async () => {
      setSimulatedTime(2026, 4, 1, 9, 0);
      llmHelper.setHour(9);

      await runMorningPlan(llmHelper.client);

      // Verify schedule was created
      const schedule = readJSON<ScheduleToday>(PATHS.scheduleToday, null as any);
      expect(schedule).not.toBeNull();
      expect(schedule.date).toBe('2026-04-01');
      expect(schedule.flexible.length).toBeGreaterThanOrEqual(3);
      // First activity should be learning/research (ENTJ's morning focus)
      expect(['learn', 'produce'].includes(schedule.flexible[0].intent_category)).toBe(true);

      // Verify intent pool has esports and produce intents
      const intentPool = readJSON<IntentPool>(PATHS.intentPool, null as any);
      expect(intentPool.intents.length).toBe(4);
      const categories = intentPool.intents.map(i => i.category);
      expect(categories).toContain('produce');
      expect(categories).toContain('learn');

      // ENTJ baseline: higher energy and confidence
      const emotion = readJSON<EmotionState>(PATHS.emotionState, null as any);
      expect(emotion.mood.valence).toBeGreaterThan(0);
      expect(emotion.energy).toBeGreaterThanOrEqual(0.5);

      // Vitality morning recovery
      const vitality = readJSON<VitalityState>(PATHS.vitalityState, null as any);
      expect(vitality.vitality).toBeGreaterThanOrEqual(70);

      // Heartbeat log: morning entry
      const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, null as any);
      expect(log.logs.length).toBe(1);
      expect(log.logs[0].type).toBe('morning');
      expect(log.logs[0].status).toBe('completed');

      // Diary has a V姐-style entry
      const diary = readText(PATHS.diary);
      expect(diary).toContain('2026-04-01');
      // The morning plan diary_entry gets written
      expect(diary.length).toBeGreaterThan(0);

      // Flow state reset for new day
      const flow = readJSON<FlowState>(PATHS.flowState, null as any);
      expect(flow.status).toBe('none');

      // Cron schedule created
      const cron = readJSON<CronSchedule>(PATHS.cronSchedule, null as any);
      expect(cron.date).toBe('2026-04-01');
      expect(cron.heartbeats.some(h => h.type === 'morning')).toBe(true);
      expect(cron.heartbeats.some(h => h.type === 'night')).toBe(true);
    });
  });

  // ── Phase 2: Active Day Ticks ─────────────────────────────────

  describe('Phase 2: Heartbeat Ticks across active hours (10:00–23:00)', () => {
    beforeEach(async () => {
      setSimulatedTime(2026, 4, 1, 9, 0);
      llmHelper.setHour(9);
      await runMorningPlan(llmHelper.client);
    });

    it('executes all ticks without errors and builds up diary entries', async () => {
      // Miss V is active 10:00–22:00 as regular ticks; 23:00 = night reflect
      // (cross-midnight cron not supported by framework — sleep_hour capped at 23)
      const hours = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];

      for (const hour of hours) {
        setSimulatedTime(2026, 4, 1, hour, 0);
        llmHelper.setHour(hour);
        clearPersonaCache();
        await regularTick(llmHelper.client);
      }

      const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, null as any);
      const regularLogs = log.logs.filter(l => l.type === 'regular');
      expect(regularLogs.length).toBe(hours.length);
      expect(regularLogs.every(l => l.status === 'completed')).toBe(true);

      // Diary should have substantial entries across the day
      const diary = readText(PATHS.diary);
      const diaryEntries = diary.split('\n## ').filter(Boolean);
      expect(diaryEntries.length).toBeGreaterThan(5);

      // Vitality decreases over the day
      const vitality = readJSON<VitalityState>(PATHS.vitalityState, null as any);
      expect(vitality.vitality).toBeLessThan(80);
    });

    it('vitality drains progressively and diary tracks time', async () => {
      const tickHours = [10, 14, 18, 22];
      const vitalitySnapshots: number[] = [];

      for (const hour of tickHours) {
        setSimulatedTime(2026, 4, 1, hour, 0);
        llmHelper.setHour(hour);
        clearPersonaCache();
        await regularTick(llmHelper.client);

        const v = readJSON<VitalityState>(PATHS.vitalityState, { vitality: 0, last_updated: null, consecutive_low_days: 0 });
        vitalitySnapshots.push(v.vitality);
      }

      // Overall downward trend (with small tolerance for rest actions)
      for (let i = 1; i < vitalitySnapshots.length; i++) {
        expect(vitalitySnapshots[i]).toBeLessThanOrEqual(vitalitySnapshots[i - 1] + 5);
      }

      // Diary should contain hourly timestamps
      const diary = readText(PATHS.diary);
      for (const hour of tickHours) {
        const hourStr = hour.toString().padStart(2, '0') + ':00';
        expect(diary).toContain(hourStr);
      }
    });

    it('professional esports focus generates learn and produce intents', async () => {
      // Hour 10 adds a learn intent (BP research), hour 14 adds produce (recording)
      for (const hour of [10, 14]) {
        setSimulatedTime(2026, 4, 1, hour, 0);
        llmHelper.setHour(hour);
        clearPersonaCache();
        await regularTick(llmHelper.client);
      }

      const pool = readJSON<IntentPool>(PATHS.intentPool, { intents: [], last_updated: null });
      const categories = pool.intents.map(i => i.category);
      expect(categories).toContain('learn');
      expect(categories).toContain('produce');
    });

    it('real skill actions are routed through sub-skills', async () => {
      // Hours with real skills: 10 (web-search), 12 (content-browse), 16 (xhs-bridge)
      const skillHours = [10, 12, 16];

      for (const hour of skillHours) {
        setSimulatedTime(2026, 4, 1, hour, 0);
        llmHelper.setHour(hour);
        clearPersonaCache();
        await regularTick(llmHelper.client);
      }

      const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, null as any);
      const regularLogs = log.logs.filter(l => l.type === 'regular');
      const logsWithActions = regularLogs.filter(l => l.chosen_actions && l.chosen_actions.length > 0);

      // At least some ticks should have real skill execution recorded
      const realSkillActions = logsWithActions.flatMap(l => l.chosen_actions ?? [])
        .filter(a => /^\[(?:ops-desk|generate-image|xhs-bridge|content-browse|web-search|mock:|fallback:)/.test(a));
      expect(realSkillActions.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Phase 3: Night Reflection ────────────────────────────────

  describe('Phase 3: Night Reflection (23:00)', () => {
    beforeEach(async () => {
      setSimulatedTime(2026, 4, 1, 9, 0);
      llmHelper.setHour(9);
      await runMorningPlan(llmHelper.client);

      for (const hour of [10, 14, 19, 22]) {
        setSimulatedTime(2026, 4, 1, hour, 0);
        llmHelper.setHour(hour);
        clearPersonaCache();
        await regularTick(llmHelper.client);
      }
    });

    it('generates professional wisdom, content strategy preferences, and aspirations', async () => {
      // Night reflect runs at sleep_hour (same-day 23:00 — cross-midnight cron not supported)
      setSimulatedTime(2026, 4, 1, 23, 0);
      llmHelper.setHour(23);
      clearPersonaCache();

      await runNightReflect(llmHelper.client);

      // Wisdom: 3 esports/content lessons
      const wisdom = readJSON<WisdomStore>(PATHS.coreWisdom, null as any);
      expect(wisdom.wisdom.length).toBe(3);
      expect(wisdom.wisdom[0].lesson).toContain('BP解说');
      expect(wisdom.wisdom[1].lesson).toContain('赛事日');
      expect(wisdom.wisdom[2].lesson).toContain('粉丝');
      expect(wisdom.total_importance_since_reflection).toBe(0);

      // Preferences updated with esports affinity
      const prefs = readJSON<Preferences>(PATHS.preferences, null as any);
      expect(prefs.interests.length).toBeGreaterThanOrEqual(1);
      expect(prefs.interests.find(i => i.name === '电竞数据分析')).toBeDefined();
      expect(prefs.content_style.find(s => s.style === '专业深度解析')).toBeDefined();

      // Aspiration: comprehensive BP analysis series
      const aspirations = readJSON<Aspirations>(PATHS.aspirations, null as any);
      expect(aspirations.aspirations.length).toBe(1);
      expect(aspirations.aspirations[0].content).toContain('BP');
      expect(aspirations.aspirations[0].status).toBe('active');

      // Night log entry
      const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, null as any);
      const nightLogs = log.logs.filter(l => l.type === 'night');
      expect(nightLogs.length).toBe(1);
      expect(nightLogs[0].status).toBe('completed');

      // Emotion reset for sleep
      const emotion = readJSON<EmotionState>(PATHS.emotionState, null as any);
      expect(emotion.mood.description).toBe('准备睡觉了');
      expect(emotion.energy).toBe(0.3);

      // Flow state reset
      const flow = readJSON<FlowState>(PATHS.flowState, null as any);
      expect(flow.status).toBe('none');

      // Diary captures the reflect summary
      const diary = readText(PATHS.diary);
      expect(diary).toContain('赛事日');
    });
  });

  // ── Phase 4: Full Day End-to-End ─────────────────────────────

  describe('Phase 4: Full Day (Morning → Ticks → Night)', () => {
    it('runs the complete V姐 daily lifecycle without errors', async () => {
      // === MORNING (09:00) ===
      setSimulatedTime(2026, 4, 1, 9, 0);
      llmHelper.setHour(9);
      await runMorningPlan(llmHelper.client);

      const morningVitality = readJSON<VitalityState>(PATHS.vitalityState, null as any).vitality;
      const morningIntentCount = readJSON<IntentPool>(PATHS.intentPool, null as any).intents.length;

      // === REGULAR TICKS (10:00–22:00) — 13 ticks ===
      const tickHours = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
      for (const hour of tickHours) {
        setSimulatedTime(2026, 4, 1, hour, 0);
        llmHelper.setHour(hour);
        clearPersonaCache();
        await regularTick(llmHelper.client);
      }

      const afterTicksVitality = readJSON<VitalityState>(PATHS.vitalityState, null as any).vitality;

      // Vitality should have decreased after 13 active ticks
      expect(afterTicksVitality).toBeLessThan(morningVitality);
      expect(morningIntentCount).toBe(4); // 4 seeds from morning plan

      // === NIGHT REFLECTION (23:00) ===
      setSimulatedTime(2026, 4, 1, 23, 0);
      llmHelper.setHour(23);
      clearPersonaCache();
      await runNightReflect(llmHelper.client);

      // === VERIFY FULL DAY RESULTS ===

      // Heartbeat log: 1 morning + 13 regular + 1 night = 15 entries
      const finalLog = readJSON<HeartbeatLog>(PATHS.heartbeatLog, null as any);
      expect(finalLog.logs.length).toBe(15);
      expect(finalLog.logs.filter(l => l.type === 'morning').length).toBe(1);
      expect(finalLog.logs.filter(l => l.type === 'regular').length).toBe(13);
      expect(finalLog.logs.filter(l => l.type === 'night').length).toBe(1);
      expect(finalLog.logs.every(l => l.status === 'completed')).toBe(true);

      // Diary should be substantial
      const diary = readText(PATHS.diary);
      expect(diary.length).toBeGreaterThan(500);
      expect(diary).toContain('2026-04-01');

      // Wisdom was created
      const wisdom = readJSON<WisdomStore>(PATHS.coreWisdom, null as any);
      expect(wisdom.wisdom.length).toBe(3);

      // Aspirations created
      const aspirations = readJSON<Aspirations>(PATHS.aspirations, null as any);
      expect(aspirations.aspirations.length).toBe(1);

      // Preferences updated with esports content focus
      const prefs = readJSON<Preferences>(PATHS.preferences, null as any);
      expect(prefs.interests.length).toBeGreaterThanOrEqual(1);
      expect(prefs.interests.find(i => i.name === '电竞数据分析')).toBeDefined();

      // Emotion in sleep state
      const finalEmotion = readJSON<EmotionState>(PATHS.emotionState, null as any);
      expect(finalEmotion.mood.description).toBe('准备睡觉了');

      // Personality drift handled gracefully
      const drift = readJSON<any>(PATHS.personalityDrift, { base: 'ENTJ', modifiers: [] });
      expect(drift.base).toBe('ENTJ');

      // Skill routing verification
      const allRegularLogs = finalLog.logs.filter(l => l.type === 'regular');
      const logsWithActions = allRegularLogs.filter(l => l.chosen_actions && l.chosen_actions.length > 0);
      const realSkillActions = logsWithActions.flatMap(l => l.chosen_actions ?? [])
        .filter(a => /^\[(?:ops-desk|generate-image|xhs-bridge|content-browse|web-search|mock:|fallback:)/.test(a));
      expect(realSkillActions.length).toBeGreaterThanOrEqual(1);

      // Diary contains evidence of skill execution
      const hasSkillTrace = diary.includes('[mock:') || diary.includes('simulated-fallback') || diary.includes('real,');
      expect(hasSkillTrace).toBe(true);
    });

    it('cron schedule covers wake-to-sleep range (09:00–23:00)', async () => {
      setSimulatedTime(2026, 4, 1, 9, 0);
      llmHelper.setHour(9);
      await runMorningPlan(llmHelper.client);

      const cron = readJSON<CronSchedule>(PATHS.cronSchedule, null as any);

      expect(cron.heartbeats.some(h => h.type === 'morning')).toBe(true);
      expect(cron.heartbeats.some(h => h.type === 'night')).toBe(true);
      expect(cron.heartbeats.filter(h => h.type === 'regular').length).toBeGreaterThan(0);

      // All heartbeats should have valid time format
      for (const hb of cron.heartbeats) {
        expect(hb.time).toMatch(/^\d{2}:\d{2}$/);
      }
    });

    it('undertone carries tonight intensity into tomorrow baseline', async () => {
      // Full day
      setSimulatedTime(2026, 4, 1, 9, 0);
      llmHelper.setHour(9);
      await runMorningPlan(llmHelper.client);

      for (const hour of [10, 14, 19]) {
        setSimulatedTime(2026, 4, 1, hour, 0);
        llmHelper.setHour(hour);
        clearPersonaCache();
        await regularTick(llmHelper.client);
      }

      setSimulatedTime(2026, 4, 1, 23, 0);
      llmHelper.setHour(23);
      clearPersonaCache();
      await runNightReflect(llmHelper.client);

      const sleepEmotion = readJSON<EmotionState>(PATHS.emotionState, null as any);
      expect(sleepEmotion.undertone).toBeDefined();
      expect(sleepEmotion.undertone.valence).toBeDefined();
      expect(sleepEmotion.undertone.energy).toBeDefined();
    });

    it('intent pool evolves throughout the day from seed to experienced', async () => {
      setSimulatedTime(2026, 4, 1, 9, 0);
      llmHelper.setHour(9);
      await runMorningPlan(llmHelper.client);

      const seedIntentCount = readJSON<IntentPool>(PATHS.intentPool, null as any).intents.length;

      // Run several ticks that inject impulses
      for (const hour of [10, 12, 16, 19, 21]) {
        setSimulatedTime(2026, 4, 1, hour, 0);
        llmHelper.setHour(hour);
        clearPersonaCache();
        await regularTick(llmHelper.client);
      }

      const evolvedPool = readJSON<IntentPool>(PATHS.intentPool, null as any);
      // Intent pool should have evolved — seeds + new impulses
      expect(evolvedPool.intents.length).toBeGreaterThan(0);
      // The pool should have at least produce and learn intents from V姐's day
      const evolvedCategories = evolvedPool.intents.map(i => i.category);
      const hasEsportsCategories = evolvedCategories.includes('produce') || evolvedCategories.includes('learn');
      expect(hasEsportsCategories).toBe(true);
    });
  });
});
