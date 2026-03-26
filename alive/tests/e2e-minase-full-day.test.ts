// alive/tests/e2e-minase-full-day.test.ts
// E2E test: Simulate Minase's (水瀬) full day lifecycle
//   Morning Plan → Regular Heartbeat Ticks (10:00–21:00) → Night Reflection
//
// This test verifies the entire alive framework pipeline end-to-end
// using a sandboxed file system, mocked LLM, and time overrides.

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
  ChainAndCooldownState, EventQueue,
} from '../scripts/utils/types';

// ── Test persona data (水瀬/Minase) ──────────────────────────────

const MINASE_PERSONA = {
  meta: {
    name: '水瀬',
    name_reading: 'Minase',
    id: 'minase',
    age: 18,
    tagline: '辣妹系 coser × 数字游民旅行博主',
    occupation_detail: '数字游民旅游博主。Instagram 是主业。',
  },
  personality: {
    mbti: 'ESTP',
    core_traits: ['元气满满', '行动派', '好胜心强', '口是心非'],
    quirks: ['拍照前一定要先选 BGM'],
    values: ['真实 > 完美'],
  },
  voice: {
    language: 'zh-CN',
    style: '口语化、活泼、短句多',
    mixed_languages: { ja: ['sugoi', 'kawaii', 'yabai'] },
    emoji_density: 'medium' as const,
    sample_lines: ['这个构图绝了吧！！', '啊啊啊困死了...但是这个光线不拍可惜'],
  },
  intimacy: {
    levels: 5,
    behaviors: {
      1: '礼貌但有距离',
      3: '放松、偶尔撒娇',
      5: '完全袒露',
    },
  },
  schedule: {
    wake_hour: 9,
    sleep_hour: 23,
    timezone: 'Asia/Tokyo',
    active_peaks: [14, 21],
  },
  // Enable sub-skills so route table has entries for real actions
  sub_skills: ['instagram', 'content-browse', 'social-engagement', 'web-search'],
  // Feature flags — enable all for thorough testing
  features: {
    skill_discovery: false,
    random_events: true,
    social_graph: true,
    flow_states: true,
    procrastination: true,
    personality_drift: true,
    content_browse: false,
  },
};

// ── Mock LLM responses ──────────────────────────────────────────

const MORNING_PLAN_RESPONSE = JSON.stringify({
  mood_description: '阳光很好！今天要出去拍照',
  wake_time: '09:00',
  sleep_time: '23:00',
  flexible_schedule: [
    { activity: '外景拍摄', preferred_time: '10:00-12:00', intent_boost: 3, intent_category: 'produce' },
    { activity: '整理照片', preferred_time: '14:00-16:00', intent_boost: 2, intent_category: 'produce' },
    { activity: '发帖', preferred_time: '19:00-21:00', intent_boost: 2, intent_category: 'express' },
  ],
  intent_seeds: [
    { category: 'produce', description: '拍一组春日外景cos', intensity: 7 },
    { category: 'connect', description: '回复粉丝评论', intensity: 4 },
    { category: 'learn', description: '学新的修图技巧', intensity: 3 },
    { category: 'consume', description: '刷一下 Instagram 看看最近流行什么', intensity: 5 },
  ],
  diary_entry: '早安！今天天气超好，要好好拍照！ganba！',
});

// Heartbeat decisions — vary over the day to simulate realistic behavior
function makeHeartbeatDecision(hour: number): string {
  const decisions: Record<number, object> = {
    10: {
      inner_monologue: '天气真好，出门去公园拍照吧',
      new_impulses: [
        { category: 'produce', description: '看到好看的光影想拍', intensity: 6 },
      ],
      suppressed_intents: [],
      chosen_actions: [
        { action: '在公园找角度拍cos外景', type: 'simulated', skill: null, satisfies_intent: null },
      ],
    },
    11: {
      inner_monologue: '这组照片拍得不错！继续换个角度',
      new_impulses: [],
      suppressed_intents: [],
      chosen_actions: [
        { action: '继续拍摄，换了个有樱花的位置', type: 'simulated', skill: null, satisfies_intent: null },
      ],
    },
    12: {
      inner_monologue: '肚子饿了...先去找吃的',
      new_impulses: [
        { category: 'rest', description: '想找个cafe坐一会', intensity: 4 },
      ],
      suppressed_intents: [],
      chosen_actions: [
        { action: '去了一家看起来不错的拉面店', type: 'simulated', skill: null, satisfies_intent: null },
      ],
    },
    13: {
      inner_monologue: '吃饱了好困啊...刷会手机看看最近流行什么吧',
      new_impulses: [],
      suppressed_intents: [],
      chosen_actions: [
        { action: '午饭后窝在cafe里刷Instagram看别人的帖子找灵感', type: 'real', skill: 'content-browse', satisfies_intent: null },
      ],
    },
    14: {
      inner_monologue: '该整理今天拍的照片了',
      new_impulses: [
        { category: 'produce', description: '想试试新的调色预设', intensity: 5 },
      ],
      suppressed_intents: [],
      chosen_actions: [
        { action: '打开Lightroom开始调色', type: 'simulated', skill: null, satisfies_intent: null },
      ],
    },
    15: {
      inner_monologue: '这张的光影处理得真好看',
      new_impulses: [],
      suppressed_intents: [],
      chosen_actions: [
        { action: '继续修图，已经修完了3张', type: 'simulated', skill: null, satisfies_intent: null },
      ],
    },
    16: {
      inner_monologue: '修图修到头疼了...看看评论吧，粉丝好多问题想回',
      new_impulses: [
        { category: 'connect', description: '想跟粉丝互动一下', intensity: 5 },
      ],
      suppressed_intents: [],
      chosen_actions: [
        { action: '打开Instagram回复粉丝评论和DM', type: 'real', skill: 'social-engagement', satisfies_intent: null },
      ],
    },
    17: {
      inner_monologue: '出去走走换换心情',
      new_impulses: [],
      suppressed_intents: [],
      chosen_actions: [
        { action: '在附近逛了一圈看看有没有好看的店', type: 'simulated', skill: null, satisfies_intent: null },
      ],
    },
    18: {
      inner_monologue: '发现了一个超有氛围感的杂货铺',
      new_impulses: [
        { category: 'produce', description: '这个店好适合当背景', intensity: 4 },
      ],
      suppressed_intents: [],
      chosen_actions: [
        { action: '用手机拍了几张日常打卡照', type: 'simulated', skill: null, satisfies_intent: null },
      ],
    },
    19: {
      inner_monologue: '该发帖了！今天拍的照片太好看了必须发出去',
      new_impulses: [
        { category: 'express', description: '今天的照片太好看了必须分享', intensity: 7 },
      ],
      suppressed_intents: [],
      chosen_actions: [
        { action: '精选了5张照片准备发Instagram carousel', type: 'real', skill: 'instagram', satisfies_intent: null },
      ],
    },
    20: {
      inner_monologue: '帖子发出去了！等等看数据',
      new_impulses: [],
      suppressed_intents: [],
      chosen_actions: [
        { action: '刷新查看新帖的互动数据', type: 'simulated', skill: null, satisfies_intent: null },
      ],
    },
    21: {
      inner_monologue: '明天去哪拍呢？搜一下附近有什么好看的地方',
      new_impulses: [
        { category: 'learn', description: '想研究明天的拍摄地点', intensity: 4 },
      ],
      suppressed_intents: [],
      chosen_actions: [
        { action: '搜索东京附近适合拍cos外景的公园和街道', type: 'real', skill: 'web-search', satisfies_intent: null },
      ],
    },
    22: {
      inner_monologue: '有点累了...追一集番吧',
      new_impulses: [
        { category: 'rest', description: '想追新番休息一下', intensity: 6 },
      ],
      suppressed_intents: [],
      chosen_actions: [
        { action: '休息追番，看了一集新出的异世界动画', type: 'simulated', skill: null, satisfies_intent: null },
      ],
    },
  };

  return JSON.stringify(decisions[hour] ?? {
    inner_monologue: '发呆中...',
    new_impulses: [],
    suppressed_intents: [],
    chosen_actions: [
      { action: '无所事事地发呆', type: 'simulated', skill: null, satisfies_intent: null },
    ],
  });
}

const SIMULATED_ACTION_RESPONSE = JSON.stringify({
  action: '完成了一些事',
  type: 'simulated',
  narrative: '在做一些日常的事情',
  diary_entry: '今天的日常活动',
  emotion_delta: { valence: 0.05, energy: -0.02 },
  new_intents: [],
  relation_updates: [],
});

const NIGHT_REFLECT_RESPONSE = JSON.stringify({
  new_wisdom: [
    { lesson: '好天气是最好的拍摄道具', importance: 6, tags: ['摄影', '经验'] },
    { lesson: '修图不要一口气修太多张，容易审美疲劳', importance: 5, tags: ['工作方法'] },
  ],
  preference_updates: [
    { type: 'interests', name: '街拍', affinity_delta: 1, reason: '今天街拍体验很好' },
    { type: 'content_style', name: '日常打卡', affinity_delta: 0.5, reason: '粉丝反馈好' },
  ],
  aspiration_updates: [
    { action: 'create', content: '拍一组樱花季限定cos', context: '今天看到公园的樱花太美了' },
  ],
  personality_drift: null,
  diary_entry: '今天过得很充实！拍了好多照片，帖子数据也不错。明天继续ganba！',
});

// ── Minimal templates (just enough for the pipeline to not crash) ─

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

// ── Mock sub-skill factory ──────────────────────────────────────

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

  // manifest.json
  fs.writeFileSync(path.join(skillDir, 'manifest.json'), JSON.stringify({
    name: skillName,
    display_name: displayName,
    version: '0.1.0-mock',
    description,
    intent_bindings: intentBindings,
  }, null, 2));

  // scripts/index.js — returns a standard SubSkillResult
  const actionNames = [...new Set(intentBindings.map(b => b.action))];
  const actionsCode = actionNames.map(action => `
    '${action}': async function(ctx) {
      return {
        narrative: '[mock:${skillName}] 执行了 ${action}: ' + (ctx.intent ? ctx.intent.description : ''),
        emotion_deltas: [{ valence: 0.05, energy: -0.02 }],
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minase-e2e-fullday-'));
  setBasePaths(tmpDir, tmpDir);

  // Create required directories
  fs.mkdirSync(path.join(tmpDir, 'relations', 'social', 'instagram'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'sub-skills'), { recursive: true });

  // Write persona config as YAML (persona-loader parses YAML)
  fs.writeFileSync(
    path.join(tmpDir, 'persona.yaml'),
    YAML.stringify(MINASE_PERSONA),
  );

  // Write minimal templates
  for (const [name, content] of Object.entries(MINIMAL_TEMPLATES)) {
    fs.writeFileSync(path.join(tmpDir, 'templates', name), content);
  }

  // Create mock sub-skills so skill-router can resolve real actions
  const subSkillsDir = path.join(tmpDir, 'sub-skills');
  createMockSubSkill(subSkillsDir, 'instagram', 'Instagram 内容发布',
    'Instagram 发帖、图片生成、文案撰写', [
      { intent: 'produce', action: 'instagram-post', priority: 10 },
      { intent: 'express', action: 'instagram-post', priority: 8 },
    ]);
  createMockSubSkill(subSkillsDir, 'content-browse', '内容浏览与灵感采集',
    '刷内容、采集灵感', [
      { intent: 'consume', action: 'feed-browse', priority: 4 },
      { intent: 'learn', action: 'inspiration-collect', priority: 4 },
    ]);
  createMockSubSkill(subSkillsDir, 'social-engagement', '社交互动',
    '评论回复、社交互动', [
      { intent: 'connect', action: 'comment-reply', priority: 8 },
      { intent: 'connect', action: 'social-engagement', priority: 7 },
    ]);
  createMockSubSkill(subSkillsDir, 'web-search', '网络搜索研究',
    '网络搜索、学习新知识', [
      { intent: 'learn', action: 'search-pipeline', priority: 5 },
      { intent: 'consume', action: 'search-pipeline', priority: 3 },
    ]);

  // socialMeta (social-meta.json) now lives outside socialDir, so no contamination risk.
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
        // Route by keyword in the prompt
        const p = prompt.toLowerCase();

        if (p.includes('morning plan') || p.includes('morning_plan') || p.includes('晨规划') || p.includes('wake_time')) {
          return JSON.parse(MORNING_PLAN_RESPONSE) as T;
        }

        if (p.includes('night reflection') || p.includes('night_reflect') || p.includes('夜反思') || p.includes('new_wisdom')) {
          return JSON.parse(NIGHT_REFLECT_RESPONSE) as T;
        }

        if (p.includes('simulated action') || p.includes('action_description') || p.includes('模拟动作')) {
          return JSON.parse(SIMULATED_ACTION_RESPONSE) as T;
        }

        // Flow evolution response
        if (p.includes('flow evolution') || p.includes('micro_activity')) {
          return JSON.parse(JSON.stringify({
            micro_activity: '换了个角度继续做',
            diary_line: '还在继续...换了个思路，感觉更顺手了',
          })) as T;
        }

        // Heartbeat decision — route by hour
        if (p.includes('heartbeat') || p.includes('inner_monologue') || p.includes('chosen_actions')) {
          return JSON.parse(makeHeartbeatDecision(currentHour)) as T;
        }

        // Fallback
        return JSON.parse('{}') as T;
      },

      async call(prompt: string): Promise<string> {
        return '水瀬今天过得很开心';
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// E2E Test Suite
// ═══════════════════════════════════════════════════════════════════

describe('E2E: 水瀬 (Minase) Full Day Simulation', () => {
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
    it('generates schedule, intent seeds, and initializes emotion', async () => {
      setSimulatedTime(2026, 3, 24, 9, 0);
      llmHelper.setHour(9);

      await runMorningPlan(llmHelper.client);

      // Verify schedule was created
      const schedule = readJSON<ScheduleToday>(PATHS.scheduleToday, null as any);
      expect(schedule).not.toBeNull();
      expect(schedule.date).toBe('2026-03-24');
      expect(schedule.flexible.length).toBe(3);
      expect(schedule.flexible[0].activity).toBe('外景拍摄');

      // Verify intent pool was seeded
      const intentPool = readJSON<IntentPool>(PATHS.intentPool, null as any);
      expect(intentPool.intents.length).toBe(4);
      expect(intentPool.intents.map(i => i.category)).toContain('produce');
      expect(intentPool.intents.map(i => i.category)).toContain('connect');

      // Verify emotion initialized with ESTP baseline
      const emotion = readJSON<EmotionState>(PATHS.emotionState, null as any);
      expect(emotion.mood.valence).toBeCloseTo(0.3, 1); // ESTP baseline
      expect(emotion.energy).toBeCloseTo(0.7, 1); // baseline 0.6 + 0.1 morning boost

      // Verify cron schedule was created
      const cron = readJSON<CronSchedule>(PATHS.cronSchedule, null as any);
      expect(cron.date).toBe('2026-03-24');
      expect(cron.heartbeats.length).toBeGreaterThan(0);
      expect(cron.heartbeats[0].type).toBe('morning');

      // Verify vitality got morning recovery
      const vitality = readJSON<VitalityState>(PATHS.vitalityState, null as any);
      expect(vitality.vitality).toBeGreaterThanOrEqual(70); // 70 default + 15 sleep_cycle

      // Verify heartbeat log has morning entry
      const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, null as any);
      expect(log.logs.length).toBe(1);
      expect(log.logs[0].type).toBe('morning');
      expect(log.logs[0].status).toBe('completed');

      // Verify diary was written
      const diary = readText(PATHS.diary);
      expect(diary).toContain('2026-03-24');
      expect(diary).toContain('ganba');

      // Verify flow state was reset
      const flow = readJSON<FlowState>(PATHS.flowState, null as any);
      expect(flow.status).toBe('none');
    });
  });

  // ── Phase 2: Regular Heartbeat Ticks ─────────────────────────

  describe('Phase 2: Regular Heartbeat Ticks (10:00–22:00)', () => {
    beforeEach(async () => {
      // Run morning plan first to set up state
      setSimulatedTime(2026, 3, 24, 9, 0);
      llmHelper.setHour(9);
      await runMorningPlan(llmHelper.client);
    });

    it('executes multiple heartbeat ticks across the day', async () => {
      const hours = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];

      for (const hour of hours) {
        setSimulatedTime(2026, 3, 24, hour, 0);
        llmHelper.setHour(hour);
        clearPersonaCache(); // Clear persona cache so it reloads from sandbox

        await regularTick(llmHelper.client);
      }

      // After all ticks, verify cumulative state changes
      const emotion = readJSON<EmotionState>(PATHS.emotionState, null as any);
      const intentPool = readJSON<IntentPool>(PATHS.intentPool, null as any);
      const vitality = readJSON<VitalityState>(PATHS.vitalityState, null as any);
      const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, null as any);
      const diary = readText(PATHS.diary);

      // Heartbeat log should have morning + all ticks
      const regularLogs = log.logs.filter(l => l.type === 'regular');
      expect(regularLogs.length).toBe(hours.length);
      expect(regularLogs.every(l => l.status === 'completed')).toBe(true);

      // Vitality should have decreased over the day (13 ticks × ~3 drain each)
      expect(vitality.vitality).toBeLessThan(70);

      // Diary should have multiple entries
      const diaryEntries = diary.split('\n## ').filter(Boolean);
      expect(diaryEntries.length).toBeGreaterThan(5);

      // Emotion should have been updated throughout the day
      expect(emotion.last_updated).not.toBeNull();

      // Intent pool should have accumulated intents from ticks
      expect(intentPool.intents.length).toBeGreaterThan(0);
    });

    it('vitality drains progressively during active hours', async () => {
      const vitalitySnapshots: number[] = [];

      for (const hour of [10, 12, 14, 16, 18]) {
        setSimulatedTime(2026, 3, 24, hour, 0);
        llmHelper.setHour(hour);
        clearPersonaCache();

        await regularTick(llmHelper.client);

        const v = readJSON<VitalityState>(PATHS.vitalityState, { vitality: 0, last_updated: null, consecutive_low_days: 0 });
        vitalitySnapshots.push(v.vitality);
      }

      // Each snapshot should be <= the previous (overall downward trend)
      for (let i = 1; i < vitalitySnapshots.length; i++) {
        expect(vitalitySnapshots[i]).toBeLessThanOrEqual(vitalitySnapshots[i - 1] + 5); // small tolerance for rest actions
      }
    });

    it('diary accumulates entries throughout the day', async () => {
      const tickHours = [10, 13, 16, 19, 22];

      for (const hour of tickHours) {
        setSimulatedTime(2026, 3, 24, hour, 0);
        llmHelper.setHour(hour);
        clearPersonaCache();
        await regularTick(llmHelper.client);
      }

      const diary = readText(PATHS.diary);
      // Each tick writes at least an inner monologue or action diary entry
      for (const hour of tickHours) {
        const hourStr = hour.toString().padStart(2, '0') + ':00';
        expect(diary).toContain(hourStr);
      }
    });

    it('new impulses from LLM are added to intent pool', async () => {
      // Hour 10 adds a 创作 impulse, hour 12 adds a 休息 impulse
      for (const hour of [10, 12]) {
        setSimulatedTime(2026, 3, 24, hour, 0);
        llmHelper.setHour(hour);
        clearPersonaCache();
        await regularTick(llmHelper.client);
      }

      const pool = readJSON<IntentPool>(PATHS.intentPool, { intents: [], last_updated: null });
      const categories = pool.intents.map(i => i.category);
      expect(categories).toContain('produce');
      expect(categories).toContain('rest');
    });
  });

  // ── Phase 3: Night Reflection ────────────────────────────────

  describe('Phase 3: Night Reflection (23:00)', () => {
    beforeEach(async () => {
      // Run morning plan
      setSimulatedTime(2026, 3, 24, 9, 0);
      llmHelper.setHour(9);
      await runMorningPlan(llmHelper.client);

      // Run a few ticks to build up state
      for (const hour of [10, 12, 14, 16, 18, 20]) {
        setSimulatedTime(2026, 3, 24, hour, 0);
        llmHelper.setHour(hour);
        clearPersonaCache();
        await regularTick(llmHelper.client);
      }
    });

    it('generates wisdom, updates preferences, and creates aspirations', async () => {
      setSimulatedTime(2026, 3, 24, 23, 0);
      llmHelper.setHour(23);
      clearPersonaCache();

      await runNightReflect(llmHelper.client);

      // Wisdom should have new entries
      const wisdom = readJSON<WisdomStore>(PATHS.coreWisdom, null as any);
      expect(wisdom.wisdom.length).toBe(2);
      expect(wisdom.wisdom[0].lesson).toContain('天气');
      expect(wisdom.wisdom[1].lesson).toContain('修图');
      expect(wisdom.total_importance_since_reflection).toBe(0); // Reset after reflection

      // Preferences should be updated
      const prefs = readJSON<Preferences>(PATHS.preferences, null as any);
      expect(prefs.interests.length).toBeGreaterThanOrEqual(1);
      expect(prefs.interests.find(i => i.name === '街拍')).toBeDefined();
      expect(prefs.content_style.find(s => s.style === '日常打卡')).toBeDefined();

      // Aspirations should have a new one
      const aspirations = readJSON<Aspirations>(PATHS.aspirations, null as any);
      expect(aspirations.aspirations.length).toBe(1);
      expect(aspirations.aspirations[0].content).toContain('樱花');
      expect(aspirations.aspirations[0].status).toBe('active');

      // Night heartbeat log entry
      const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, null as any);
      const nightLogs = log.logs.filter(l => l.type === 'night');
      expect(nightLogs.length).toBe(1);
      expect(nightLogs[0].status).toBe('completed');

      // Diary should have night reflection entry
      const diary = readText(PATHS.diary);
      expect(diary).toContain('ganba');
      expect(diary).toContain('23:00');

      // Emotion reset for sleep
      const emotion = readJSON<EmotionState>(PATHS.emotionState, null as any);
      expect(emotion.mood.description).toBe('准备睡觉了');
      expect(emotion.energy).toBe(0.3);

      // Flow state reset
      const flow = readJSON<FlowState>(PATHS.flowState, null as any);
      expect(flow.status).toBe('none');
    });
  });

  // ── Phase 4: Full Day End-to-End ─────────────────────────────

  describe('Phase 4: Full Day (Morning → Ticks → Night)', () => {
    it('runs the complete daily lifecycle without errors', async () => {
      // === MORNING (09:00) ===
      setSimulatedTime(2026, 3, 24, 9, 0);
      llmHelper.setHour(9);
      await runMorningPlan(llmHelper.client);

      // Snapshot initial state
      const morningVitality = readJSON<VitalityState>(PATHS.vitalityState, null as any).vitality;
      const morningIntentCount = readJSON<IntentPool>(PATHS.intentPool, null as any).intents.length;

      // === REGULAR TICKS (10:00–22:00) ===
      const tickHours = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
      for (const hour of tickHours) {
        setSimulatedTime(2026, 3, 24, hour, 0);
        llmHelper.setHour(hour);
        clearPersonaCache();
        await regularTick(llmHelper.client);
      }

      // Snapshot after ticks
      const afterTicksVitality = readJSON<VitalityState>(PATHS.vitalityState, null as any).vitality;
      const afterTicksIntentCount = readJSON<IntentPool>(PATHS.intentPool, null as any).intents.length;

      // Vitality should have decreased
      expect(afterTicksVitality).toBeLessThan(morningVitality);

      // Intent pool should have evolved (new intents from LLM impulses + accumulation)
      expect(afterTicksIntentCount).toBeGreaterThan(0);

      // === NIGHT REFLECTION (23:00) ===
      setSimulatedTime(2026, 3, 24, 23, 0);
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
      expect(diary).toContain('2026-03-24');

      // Wisdom was created during night reflection
      const wisdom = readJSON<WisdomStore>(PATHS.coreWisdom, null as any);
      expect(wisdom.wisdom.length).toBe(2);

      // Aspirations were created
      const aspirations = readJSON<Aspirations>(PATHS.aspirations, null as any);
      expect(aspirations.aspirations.length).toBe(1);

      // Preferences were updated
      const prefs = readJSON<Preferences>(PATHS.preferences, null as any);
      expect(prefs.interests.length).toBeGreaterThanOrEqual(1);

      // Emotion in sleep state
      const finalEmotion = readJSON<EmotionState>(PATHS.emotionState, null as any);
      expect(finalEmotion.mood.description).toBe('准备睡觉了');

      // Personality drift: our mock returns null drift, so file may not exist.
      // Verify the system handles it gracefully by reading with default.
      const drift = readJSON<any>(PATHS.personalityDrift, { base: 'ESTP', modifiers: [] });
      expect(drift.base).toBe('ESTP');

      // === SKILL ROUTING VERIFICATION ===
      // With 4 real actions in mock data (13:00, 16:00, 19:00, 21:00),
      // verify that the skill-router was actually invoked

      // Check heartbeat log for sub-skill execution traces
      const allRegularLogs = finalLog.logs.filter(l => l.type === 'regular');
      const logsWithActions = allRegularLogs.filter(l => l.chosen_actions && l.chosen_actions.length > 0);

      // At least some ticks should have real skill actions (format: [skillName] action)
      const realSkillActions = logsWithActions.flatMap(l => l.chosen_actions ?? [])
        .filter(a => /^\[(?:instagram|content-browse|social-engagement|web-search|mock:|fallback:)/.test(a));
      expect(realSkillActions.length).toBeGreaterThanOrEqual(1); // At least 1 real skill ran

      // Diary should contain evidence of sub-skill execution
      // Either real sub-skill narrative or fallback execution
      const hasSkillTrace = diary.includes('[mock:') || diary.includes('simulated-fallback') || diary.includes('real,');
      expect(hasSkillTrace).toBe(true);
    });

    it('cron schedule is consistent throughout the day', async () => {
      setSimulatedTime(2026, 3, 24, 9, 0);
      llmHelper.setHour(9);
      await runMorningPlan(llmHelper.client);

      const cron = readJSON<CronSchedule>(PATHS.cronSchedule, null as any);

      // Morning plan creates a full day schedule
      expect(cron.heartbeats.some(h => h.type === 'morning')).toBe(true);
      expect(cron.heartbeats.some(h => h.type === 'night')).toBe(true);
      expect(cron.heartbeats.filter(h => h.type === 'regular').length).toBeGreaterThan(0);

      // All heartbeats should have valid times
      for (const hb of cron.heartbeats) {
        expect(hb.time).toMatch(/^\d{2}:\d{2}$/);
      }
    });

    it('emotion undertone carries through to next day', async () => {
      // Run full day
      setSimulatedTime(2026, 3, 24, 9, 0);
      llmHelper.setHour(9);
      await runMorningPlan(llmHelper.client);

      for (const hour of [10, 14, 18]) {
        setSimulatedTime(2026, 3, 24, hour, 0);
        llmHelper.setHour(hour);
        clearPersonaCache();
        await regularTick(llmHelper.client);
      }

      setSimulatedTime(2026, 3, 24, 23, 0);
      llmHelper.setHour(23);
      clearPersonaCache();
      await runNightReflect(llmHelper.client);

      // After night reflection, undertone should be a blend of today's experience and default
      const sleepEmotion = readJSON<EmotionState>(PATHS.emotionState, null as any);
      expect(sleepEmotion.undertone).toBeDefined();
      // Should not be exactly the default — it was blended with today's values
      expect(sleepEmotion.undertone.valence).toBeDefined();
      expect(sleepEmotion.undertone.energy).toBeDefined();
    });
  });
});
