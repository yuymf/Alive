// alive/tests/e2e-miss-v-output-dump.test.ts
// Output inspection: run Miss V's full day with real-ish mock responses
// and dump ALL generated content for human evaluation.

import { describe, it, beforeEach, afterEach } from 'vitest';
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

const MISS_V_PERSONA = {
  meta: { id: 'miss-v', name: 'V姐', display_name: 'Miss V', age: 21, tagline: '不被单一标签定义' },
  personality: {
    mbti: 'ENTJ',
    core_traits: ['专业硬核，理性共情，解说控场稳且有深度', '松弛飒爽，低调贵气，不迎合流量', '外冷内热，多面自律，热血敢闯'],
    quirks: ['赛前必听同一首歌', '发帖前反复检查文案克不克制'],
    values: ['实力 > 人设', '克制 > 浮夸'],
  },
  voice: {
    language: 'zh-CN',
    style: '简练有力，克制但有温度，专业术语自然融入，偶尔反差式幽默',
    emoji_density: 'low' as const,
    sample_lines: ['BP阶段就已经赢了，团战只是在还债。', '今天赛道数据有点意思，明天继续。'],
  },
  intimacy: { levels: 5, behaviors: { 1: '专业克制，保持距离', 3: '适度开放，偶尔分享幕后', 5: '真实反差，展示柔软一面' } },
  schedule: { wake_hour: 9, sleep_hour: 23, timezone: 'Asia/Shanghai', active_peaks: [14, 21] },
  sub_skills: ['ops-desk', 'xhs-bridge', 'content-browse', 'web-search'],
  features: { skill_discovery: false, random_events: true, social_graph: false, flow_states: true, procrastination: false, personality_drift: true },
  ops: {
    enabled: true, brief_time: '08:30', trend_score_threshold: 1.8, topic_count: 3,
    platforms: { xhs: { enabled: true, style: '图文为主，封面强视觉冲击，文案克制有力，适度emoji，精准标签，结尾留互动钩子' }, douyin: { enabled: true, style: '视频脚本，前3秒必须有冲突感或反差，BGM卡点，字幕简洁，结尾引导互动' } },
    competitors: [], content_templates: [],
  },
};

const MORNING_PLAN_RESPONSE = JSON.stringify({
  mood_description: '今天有KPL赛事，专注，数据先行。状态稳。',
  wake_time: '09:00', sleep_time: '23:00',
  flexible_schedule: [
    { activity: '研究赛事BP数据', preferred_time: '10:00-12:00', intent_boost: 3, intent_category: 'learn' },
    { activity: '录制赛前解说视频', preferred_time: '14:00-16:00', intent_boost: 4, intent_category: 'produce' },
    { activity: '发布XHS内容', preferred_time: '20:00-21:00', intent_boost: 3, intent_category: 'express' },
    { activity: '赛后复盘与粉丝互动', preferred_time: '22:00-23:00', intent_boost: 2, intent_category: 'connect' },
  ],
  intent_seeds: [
    { category: 'produce', description: '制作一期KPL赛事赛前解说切片，BP视角深入拆解', intensity: 8 },
    { category: 'learn', description: '研究今日赛事两队近期ban/pick胜率数据', intensity: 7 },
    { category: 'express', description: '发布小红书赛前战术分析图文帖，引导粉丝观赛视角', intensity: 6 },
    { category: 'connect', description: '跟电竞粉丝互动，回答赛后技战术问题', intensity: 4 },
  ],
  diary_entry: '今天赛事日。数据先行，结论后说。赛前把BP思路整理清楚，不临场发挥。这才是专业的意思。',
});

function makeDecision(hour: number): string {
  const d: Record<number, object> = {
    10: {
      inner_monologue: '打开赛事数据库，今天这场的BP有几个点值得深挖。这队最近换了打法，版本适应比我想的快。',
      new_impulses: [{ category: 'learn', description: '深入分析双方近期ban/pick胜率与版本适应节奏', intensity: 7 }],
      suppressed_intents: [],
      chosen_actions: [{ action: '系统研究两队近期BP数据、胜率曲线和版本对应调整', type: 'real', skill: 'web-search', satisfies_intent: 'learn' }],
    },
    11: {
      inner_monologue: '数据确认了猜想：他们在版本迭代后ban位思路变了，但pick端还在用上个版本的惯性。这就是今天的切入点。',
      new_impulses: [],
      suppressed_intents: [],
      chosen_actions: [{ action: '整理BP分析笔记，梳理版本迭代前后ban位策略变化与pick端惯性滞后', type: 'simulated', skill: null, satisfies_intent: null }],
    },
    12: {
      inner_monologue: '吃饭顺便刷热搜。KPL话题今天有在发酵，但角度都很浅，还有空间。',
      new_impulses: [{ category: 'consume', description: '监测KPL相关热榜话题，判断借势空间', intensity: 4 }],
      suppressed_intents: [],
      chosen_actions: [{ action: '刷热榜，确认KPL赛事话题热度与当前舆论角度', type: 'real', skill: 'content-browse', satisfies_intent: 'consume' }],
    },
    13: {
      inner_monologue: '下午要专注录制，先整理一下思路框架。三段结构：版本背景 → BP推演 → 预判结论。',
      new_impulses: [],
      suppressed_intents: [],
      chosen_actions: [{ action: '闭目整理解说框架，确定三段式结构逻辑', type: 'simulated', skill: null, satisfies_intent: null }],
    },
    14: {
      inner_monologue: '开始录制。BP阶段分析是核心，不能含糊，每一个ban位选择背后都有逻辑链。',
      new_impulses: [{ category: 'produce', description: '完成高质量KPL赛前BP解说视频', intensity: 9 }],
      suppressed_intents: [],
      chosen_actions: [{ action: '录制KPL赛前解说视频，系统拆解双方BP思路与对抗逻辑', type: 'simulated', skill: null, satisfies_intent: null }],
    },
    15: {
      inner_monologue: '第一遍录完。回听发现第二段节奏有点断，ban位推演那里逻辑跳了，要补一句过渡。',
      new_impulses: [],
      suppressed_intents: [],
      chosen_actions: [{ action: '回听录音，补录过渡段，确保ban位推演逻辑链完整', type: 'simulated', skill: null, satisfies_intent: null }],
    },
    16: {
      inner_monologue: '视频内容不错，但深度分析更适合图文形式。小红书粉丝可以反复看，视频太快了。把核心观点整理成图文版。',
      new_impulses: [{ category: 'express', description: '将BP分析核心观点整理成XHS图文，方便粉丝深度阅读', intensity: 6 }],
      suppressed_intents: [],
      chosen_actions: [{ action: '整理解说核心逻辑，撰写小红书图文版BP分析帖', type: 'real', skill: 'xhs-bridge', satisfies_intent: 'express' }],
    },
    17: {
      inner_monologue: '图文稿写好了。配一张赛事封面，颜色要冷一些，和今天的内容调性匹配。',
      new_impulses: [],
      suppressed_intents: [],
      chosen_actions: [{ action: '规划赛事分析封面图风格：冷色调，解说台视角，信息可视化', type: 'simulated', skill: null, satisfies_intent: null }],
    },
    18: {
      inner_monologue: '内容准备好了。发布时间定在19点，开赛前一小时，流量窗口最好。',
      new_impulses: [],
      suppressed_intents: [],
      chosen_actions: [{ action: '最终审核视频+图文内容，确认发布时间为19:00', type: 'simulated', skill: null, satisfies_intent: null }],
    },
    19: {
      inner_monologue: '发出去了。配文写的是"看这场比赛之前，先看这个"。能不能留住人就看开头15秒。',
      new_impulses: [{ category: 'express', description: '赛前内容发布，引导粉丝带着思路框架看比赛', intensity: 8 }],
      suppressed_intents: [],
      chosen_actions: [{ action: '发布赛前BP解说视频+小红书图文，配文精准引导观赛视角', type: 'real', skill: 'ops-desk', satisfies_intent: 'express' }],
    },
    20: {
      inner_monologue: '帖子数据不错。现在专注看比赛。分析的准不准，比赛会给答案。',
      new_impulses: [],
      suppressed_intents: [],
      chosen_actions: [{ action: '全神贯注观看比赛，同步记录关键时刻与战术验证节点', type: 'simulated', skill: null, satisfies_intent: null }],
    },
    21: {
      inner_monologue: '比赛结束。第三局ban位推演基本准了，但pick端有一个我没预判到的对应选择，值得复盘。',
      new_impulses: [{ category: 'produce', description: '记录赛中验证节点与预判偏差，准备明天赛后复盘内容', intensity: 7 }],
      suppressed_intents: [],
      chosen_actions: [{ action: '整理赛中亮点与预判偏差记录，规划明天赛后深度复盘内容', type: 'simulated', skill: null, satisfies_intent: null }],
    },
    22: {
      inner_monologue: '评论区里有几个问题问得很专业，比我预想的深。这种粉丝值得认真回。',
      new_impulses: [{ category: 'connect', description: '认真回复高质量战术提问，建立专业互动氛围', intensity: 6 }],
      suppressed_intents: [],
      chosen_actions: [{ action: '在评论区逐一回复深度战术问题，保持专业且有温度的互动口吻', type: 'simulated', skill: null, satisfies_intent: null }],
    },
  };
  return JSON.stringify(d[hour] ?? {
    inner_monologue: '专注工作中，思路在推进。',
    new_impulses: [], suppressed_intents: [],
    chosen_actions: [{ action: '继续专注手头工作', type: 'simulated', skill: null, satisfies_intent: null }],
  });
}

const SIMULATED_ACTION_RESPONSE = JSON.stringify({
  action: '完成专业内容工作', type: 'simulated',
  narrative: '专注状态下推进内容创作，逻辑清晰，细节到位。没有分心，没有将就。',
  diary_entry: '数据在手，逻辑清晰。这种状态才是对的。不急，一步一步来。',
  emotion_delta: { valence: 0.08, energy: -0.04 },
  new_intents: [], relation_updates: [],
});

const NIGHT_REFLECT_RESPONSE = JSON.stringify({
  new_wisdom: [
    { lesson: 'BP解说的核心是把复杂逻辑讲清楚，而不是展示自己懂多少', importance: 8, tags: ['解说', '表达', '克制'] },
    { lesson: '赛事日的内容要在开赛前发，开赛后流量窗口就关了', importance: 7, tags: ['时机', '内容节奏', '运营'] },
    { lesson: '粉丝提问里藏着下一期的选题，认真回复不只是互动，是在做选题调研', importance: 6, tags: ['内容策略', '互动', '选题'] },
  ],
  preference_updates: [
    { type: 'interests', name: '电竞数据分析', affinity_delta: 1.5, reason: '今天深度BP研究带来成就感，数据印证直觉的感觉很好' },
    { type: 'interests', name: '赛事内容节奏策略', affinity_delta: 1, reason: '赛前发布时机验证了内容节奏的重要性' },
    { type: 'content_style', name: '专业深度解析', affinity_delta: 1.2, reason: '今天粉丝对专业内容的反馈质量远高于日常帖' },
  ],
  aspiration_updates: [
    { action: 'create', content: '做一期完整的赛季BP规律分析，从数据视角还原版本演变脉络', context: '今天研究BP时发现版本变化有系统规律，但现有内容都是孤立解读，没人做过系统梳理' },
  ],
  personality_drift: null,
  diary_entry: '赛事日收尾。数据充分，内容扎实，粉丝专业。今天第三局的pick我没全部猜准，但逻辑框架是对的，执行细节差了一层。明天复盘这个偏差。\n\nBP阶段就已经赢了——不只是比赛里的道理。',
});

const TEMPLATES: Record<string, string> = {
  'morning-plan-prompt.md': `# Morning Plan for {persona.meta.name}\nPersonality: {personality_context}\nSchedule config: wake {schedule.wake_hour}:00, sleep {schedule.sleep_hour}:00\nReturn JSON with: mood_description, wake_time, sleep_time, flexible_schedule, intent_seeds, diary_entry.`,
  'heartbeat-prompt.md': `# Heartbeat for {persona.meta.name} — {current_time}\nEmotion: {emotion_summary}\nVitality: {vitality_context}\nSchedule: {schedule_context}\nIntents: {intent_pool_summary}\nVoice: {voice_directive}\nReturn JSON with: inner_monologue, new_impulses, suppressed_intents, chosen_actions.`,
  'night-reflect-prompt.md': `# Night Reflection for {persona.meta.name}\nDiary: {today_diary}\nWisdom so far: {core_wisdom}\nReturn JSON with: new_wisdom, preference_updates, aspiration_updates, personality_drift, diary_entry.`,
  'simulated-action.md': `# Simulated Action for {persona.meta.name}\nAction: {action_description}\nReturn JSON with: action, type, narrative, diary_entry, emotion_delta, new_intents, relation_updates.`,
  'personality.md': '{persona.meta.name} — {persona.personality.mbti}',
  'soul-injection.md': '{persona.meta.name}',
  'reflection-prompt.md': 'Reflection for {persona.meta.name}',
  'diary-entry.md': 'Diary template',
  'flow-evolution-prompt.md': `# Flow Evolution\nActivity: {activity}, Duration: {duration}\nReturn JSON with: micro_activity, diary_line.`,
};

function createMockSubSkill(dir: string, name: string, bindings: Array<{intent: string; action: string; priority: number}>) {
  const d = path.join(dir, name);
  fs.mkdirSync(path.join(d, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ name, version: '0.1.0-mock', description: name, intent_bindings: bindings }, null, 2));
  const actions = [...new Set(bindings.map(b => b.action))]
    .map(a => `'${a}': async(ctx) => ({ narrative: '[mock:${name}] 执行了 ${a}: '+(ctx.intent?.description||''), emotion_deltas:[{valence:0.06,energy:-0.03}], vitality_cost:5, feedback:[], events_triggered:[] })`)
    .join(',\n    ');
  fs.writeFileSync(path.join(d, 'scripts', 'index.js'), `module.exports = { manifest: require('../manifest.json'), actions: {\n    ${actions}\n  } };`);
}

let tmpDir: string;
let currentHour = 9;

function setupSandbox() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miss-v-dump-'));
  setBasePaths(tmpDir, tmpDir);
  fs.mkdirSync(path.join(tmpDir, 'relations', 'social'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'sub-skills'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'persona.yaml'), YAML.stringify(MISS_V_PERSONA));
  for (const [k, v] of Object.entries(TEMPLATES)) fs.writeFileSync(path.join(tmpDir, 'templates', k), v);

  const ss = path.join(tmpDir, 'sub-skills');
  createMockSubSkill(ss, 'ops-desk', [{ intent: 'produce', action: 'generate-topics', priority: 7 }, { intent: 'express', action: 'generate-topics', priority: 6 }]);
  createMockSubSkill(ss, 'xhs-bridge', [{ intent: 'express', action: 'publish-note', priority: 8 }, { intent: 'consume', action: 'search-feed', priority: 4 }]);
  createMockSubSkill(ss, 'content-browse', [{ intent: 'consume', action: 'feed-browse', priority: 4 }, { intent: 'learn', action: 'inspiration-collect', priority: 4 }]);
  createMockSubSkill(ss, 'web-search', [{ intent: 'learn', action: 'search-pipeline', priority: 5 }, { intent: 'consume', action: 'search-pipeline', priority: 3 }]);
}

function teardown() {
  clearTimeOverride(); clearPersonaCache(); clearRouteTable(); resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const llm = {
  async callJSON<T>(prompt: string): Promise<T> {
    const p = prompt.toLowerCase();
    if (p.includes('wake_time')) return JSON.parse(MORNING_PLAN_RESPONSE) as T;
    if (p.includes('new_wisdom')) return JSON.parse(NIGHT_REFLECT_RESPONSE) as T;
    if (p.includes('action_description') || p.includes('simulated action')) return JSON.parse(SIMULATED_ACTION_RESPONSE) as T;
    if (p.includes('micro_activity')) return JSON.parse(JSON.stringify({ micro_activity: '深度工作状态中，思路越来越清晰', diary_line: '逻辑在推进，没有停下来。' })) as T;
    if (p.includes('inner_monologue') || p.includes('chosen_actions')) return JSON.parse(makeDecision(currentHour)) as T;
    return JSON.parse('{}') as T;
  },
  async call(prompt: string): Promise<string> { return 'V姐今天的工作内容扎实，专业水准稳定。'; },
};

// ═══════════════════════════════════════════════════════════════════

describe('Miss V Full Day — Output Inspection', () => {
  beforeEach(() => { setupSandbox(); });
  afterEach(() => { teardown(); });

  it('runs full day and dumps all generated content', async () => {
    const sep = (title: string) => `\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}`;
    const line = () => '─'.repeat(60);

    // === MORNING ===
    currentHour = 9;
    setTimeOverride(new Date(2026, 3, 1, 9, 0, 0, 0));
    await runMorningPlan(llm);

    // === TICKS ===
    for (const h of [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]) {
      currentHour = h;
      setTimeOverride(new Date(2026, 3, 1, h, 0, 0, 0));
      clearPersonaCache();
      await regularTick(llm);
    }

    // === NIGHT ===
    currentHour = 23;
    setTimeOverride(new Date(2026, 3, 1, 23, 0, 0, 0));
    clearPersonaCache();
    await runNightReflect(llm);

    // ── DUMP ────────────────────────────────────────────────────

    console.log(sep('📖  V姐当日日记全文'));
    console.log(readText(PATHS.diary));

    console.log(sep('📋  心跳日志（每小时行动）'));
    const hbLog = readJSON<any>(PATHS.heartbeatLog, { logs: [] });
    for (const l of hbLog.logs) {
      const ts = new Date(l.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const tag = l.type === 'morning' ? '🌅晨' : l.type === 'night' ? '🌙夜' : '⏰';
      const actions = (l.chosen_actions || []).join(' | ') || '（无动作记录）';
      console.log(`${tag} ${ts}  ${actions}`);
    }

    console.log(sep('💎  核心智慧（今日习得）'));
    const wisdom = readJSON<any>(PATHS.coreWisdom, { wisdom: [] });
    for (const w of wisdom.wisdom) {
      console.log(`\n[重要度 ${w.importance}/10] ${w.lesson}`);
      console.log(`  标签: ${(w.tags || []).join(' · ')}`);
    }

    console.log(sep('❤️  偏好更新'));
    const prefs = readJSON<any>(PATHS.preferences, { interests: [], content_style: [] });
    if (prefs.interests.length) {
      console.log('\n── 兴趣偏好');
      for (const i of prefs.interests) console.log(`  + ${i.name}  (affinity: ${i.affinity?.toFixed(2) ?? '?'})`);
    }
    if (prefs.content_style.length) {
      console.log('\n── 内容风格偏好');
      for (const s of prefs.content_style) console.log(`  + ${s.style}  (affinity: ${s.affinity?.toFixed(2) ?? '?'})`);
    }

    console.log(sep('🌟  心愿 / Aspirations'));
    const asp = readJSON<any>(PATHS.aspirations, { aspirations: [] });
    for (const a of asp.aspirations) {
      console.log(`\n[${a.status}] ${a.content}`);
      if (a.context) console.log(`  背景: ${a.context}`);
    }

    console.log(sep('😊  最终情绪状态'));
    const emo = readJSON<any>(PATHS.emotionState, {});
    console.log(`情绪描述: ${emo.mood?.description ?? JSON.stringify(emo.mood)}`);
    console.log(`能量 energy: ${emo.energy}`);
    console.log(`应激层 impulse_layer: valence=${emo.impulse_layer?.valence?.toFixed(3)}, arousal=${emo.impulse_layer?.arousal?.toFixed(3)}`);
    console.log(`惯性层 momentum_layer: valence=${emo.momentum_layer?.valence?.toFixed(3)}, energy=${emo.momentum_layer?.energy?.toFixed(3)}`);
    console.log(`基调层 undertone: valence=${emo.undertone?.valence?.toFixed(3)}, energy=${emo.undertone?.energy?.toFixed(3)}`);
    console.log(`压力 stress: ${emo.stress?.toFixed(3)}, 创造力 creativity: ${emo.creativity?.toFixed(3)}, 社交 sociability: ${emo.sociability?.toFixed(3)}`);

    console.log(sep('⚡  活力状态'));
    const vit = readJSON<any>(PATHS.vitalityState, {});
    console.log(`活力值: ${vit.vitality?.toFixed(1)} / 100`);
    console.log(`连续低活力天数: ${vit.consecutive_low_days}`);

    console.log(sep('💪  信心状态'));
    const conf = readJSON<any>(PATHS.confidenceState ?? (PATHS as any).confidence, null);
    if (conf) {
      console.log(`信心乘数: ${conf.multiplier?.toFixed(3)}`);
      console.log(`连胜天数: ${conf.streak_days}`);
    } else {
      console.log('（confidence state 文件未生成）');
    }

    console.log(sep('🎯  意图池（当前积累）'));
    const pool = readJSON<any>(PATHS.intentPool, { intents: [] });
    if (pool.intents.length === 0) {
      console.log('（意图池已消耗清空）');
    } else {
      for (const i of pool.intents) {
        const resist = i.resistance ? ` [抵抗:${i.resistance.toFixed(1)}]` : '';
        console.log(`[${i.category}] 强度${(i.intensity ?? 0).toFixed(1)}${resist}: ${i.description}`);
      }
    }

    console.log(sep('📅  今日调度表'));
    const sched = readJSON<any>(PATHS.scheduleToday, { flexible: [] });
    console.log(`日期: ${sched.date}`);
    for (const f of sched.flexible || []) {
      console.log(`  ${f.preferred_time ?? '?'}  [${f.intent_category}+${f.intent_boost}]  ${f.activity}`);
    }

    console.log(sep('🔄  流动状态（flow）'));
    const flow = readJSON<any>(PATHS.flowState, {});
    console.log(`状态: ${flow.status}`);
    console.log(`活动: ${flow.activity ?? '—'}`);
    console.log(`持续: ${flow.duration_ticks ?? 0} ticks`);

    console.log('\n' + line());
    console.log('✅  输出 Dump 完成');
    console.log(line());
  }, 30000);
});
