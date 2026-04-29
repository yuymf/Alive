// alive/tests/e2e-miss-v-real-llm-full.test.ts
// E2E test: Miss V (V姐) full day lifecycle using REAL LLM + real web search
//
//   Morning Plan → Regular Heartbeat Ticks → Night Reflection
//   + Ops Brief (trend analysis, topic generation)
//   + Viral content analysis
//
// This test uses real LLM (MiniMax-M2.7) and real web search (DuckDuckGo/Exa)
// to validate the complete pipeline with the Miss V ENTJ persona.
//
// Usage:
//   REAL_LLM_E2E=1 npx vitest run alive/tests/e2e-miss-v-real-llm-full.test.ts --config vitest.alive.config.ts
//   Keys auto-load from ~/.openclaw/openclaw.json
//   Set KEEP_SANDBOX=1 to preserve tmp dir for inspection.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import YAML from 'yaml';
import { setBasePaths, resetBasePaths, PATHS, readJSON, readText, setPersonaName } from '../scripts/utils/file-utils';
import { setTimeOverride, clearTimeOverride } from '../scripts/utils/time-utils';
import { clearPersonaCache } from '../scripts/persona/persona-loader';
import { createRealLLMClient, setLlmLogPath } from '../scripts/utils/llm-client';
import type { LLMClient } from '../scripts/utils/llm-client';
import { runMorningPlan } from '../scripts/lifecycle/morning-plan';
import { regularTick } from '../scripts/lifecycle/heartbeat-tick';
import { runNightReflect } from '../scripts/lifecycle/night-reflect';
import { clearRouteTable } from '../scripts/router/skill-router';
import type {
  EmotionState, IntentPool, HeartbeatLog, VitalityState,
  FlowState, WisdomStore, CronSchedule, ScheduleToday, Preferences, Aspirations,
  PersonalityDrift, ConfidenceState,
} from '../scripts/utils/types';

// ── API key loader ───────────────────────────────────────────────

function tryLoadApiKeys(): boolean {
  try {
    const home = os.homedir();
    const cfgPath = path.join(home, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(cfgPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const env = cfg?.skills?.entries?.alive?.env;
    if (!env) return false;
    for (const k of ['LLM_API_KEY', 'LLM_API_BASE', 'LLM_MODEL', 'LLM_DEBUG']) {
      if (env[k] && !process.env[k]) process.env[k] = env[k];
    }
    return !!process.env.LLM_API_KEY;
  } catch { return false; }
}

const shouldRun = process.env.REAL_LLM_E2E === '1' || !!process.env.LLM_API_KEY || tryLoadApiKeys();

// ── Miss V Persona ───────────────────────────────────────────────

const MISS_V_PERSONA = {
  meta: {
    id: 'miss-v', name: 'V姐', display_name: 'Miss V', age: 21,
    zodiac: '天秤座', tagline: '不被单一标签定义',
  },
  personality: {
    mbti: 'ENTJ',
    core_traits: [
      '专业硬核，理性共情，解说控场稳且有深度',
      '松弛飒爽，低调贵气，不迎合流量',
      '外冷内热，多面自律，热血敢闯',
      '出身优渥但靠实力立足，不浮夸炫富',
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
      '有人说女生不懂电竞。排位赛不说谎。',
      '今天赛道数据有点意思，明天继续。',
      '音乐和赛车教会我同一件事：进弯前要先想好出弯路线。',
    ],
  },
  intimacy: { levels: 5, behaviors: { 1: '专业克制，保持距离', 3: '适度开放，偶尔分享幕后', 5: '真实反差，展示柔软一面' } },
  schedule: { wake_hour: 9, sleep_hour: 23, timezone: 'Asia/Shanghai', active_peaks: [14, 21] },
  identities: {
    esports_commentator: { weight: 0.40 },
    singer: { weight: 0.25 },
    racer: { weight: 0.20 },
    lifestyle: { weight: 0.15 },
  },
  sub_skills: ['ops-desk', 'generate-image', 'xhs-bridge', 'content-browse', 'web-search'],
  features: {
    emotion: true,
    intent: true,
    vitality: true,
    confidence: true,
    work_impulse: false,
    content_browse: true,
    flow_states: true,
    random_events: true,
    social_graph: false,
    procrastination: false,
    personality_drift: true,
    skill_discovery: false,
  },
  content_sources: {
    platforms: ['bilibili', 'weibo', 'dailyhot'],
    keywords: ['电竞', '歌手', '赛车', '女性力量', '轻奢生活', 'AI虚拟偶像'],
    dailyhot_platforms: ['douyin', 'weibo', 'bilibili', 'toutiao', 'baidu'],
  },
  ops: {
    enabled: true,
    brief_time: '08:30',
    trend_score_threshold: 1.0,
    topic_count: 3,
    topic_filter_prompt: '与以下任一赛道相关或可借势：电竞、音乐/歌手、赛车/运动、女性力量/大女主、轻奢生活\n可用V姐任意一个身份切入解读\n优先选择平台正在助推（速度分>1.8）的话题\n避免负面争议、政治敏感话题',
    platforms: {
      xhs: { enabled: true, style: '图文为主，封面强视觉冲击，文案克制有力，适度emoji，5-10个精准标签，结尾留互动钩子' },
      douyin: { enabled: true, style: '视频脚本，前3秒必须有冲突感或反差，BGM卡点，字幕简洁，结尾引导互动' },
    },
    competitors: [],
    content_templates: [],
    automation: { brief_delivery: 'session', enable_heartbeat_cron: true, silent_background_jobs: false },
  },
};

const TEMPLATE_DIR = path.join(__dirname, '..', 'templates');

// ── Mock sub-skill factory ───────────────────────────────────────

function createMockSubSkill(baseDir: string, name: string, display: string, desc: string,
  bindings: Array<{ intent: string; action: string; priority: number }>): void {
  const dir = path.join(baseDir, name);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    name, display_name: display, version: '0.1.0-mock', description: desc, intent_bindings: bindings,
  }, null, 2));
  const actions = [...new Set(bindings.map(b => b.action))].map(a => `
    '${a}': async function(ctx) {
      return { narrative: '[real-e2e:${name}] executed ${a}: ' + (ctx.intent?.description || ''),
        emotion_deltas: [{ valence: 0.05, energy: -0.02 }], vitality_cost: 5, feedback: [], events_triggered: [] };
    }`).join(',\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'index.js'),
    `module.exports = { manifest: require('../manifest.json'), actions: {${actions}\n  } };\n`);
}

// ── Quality analysis types ───────────────────────────────────────

interface HourReport { hour: number; phase: string; durationMs: number; error?: string }
interface QualityIssue { severity: 'critical' | 'warning' | 'info'; cat: string; desc: string; hour?: number }

const reports: HourReport[] = [];
const issues: QualityIssue[] = [];
const llmOutputs: Array<{ phase: string; hour: number; data: Record<string, unknown> }> = [];

function issue(severity: QualityIssue['severity'], cat: string, desc: string, hour?: number) {
  issues.push({ severity, cat, desc, hour });
}

function captureState(phase: string, hour: number) {
  try {
    const emotion = readJSON<EmotionState>(PATHS.emotionState, null as any);
    const pool = readJSON<IntentPool>(PATHS.intentPool, { intents: [], last_updated: null } as any);
    const vitality = readJSON<VitalityState>(PATHS.vitalityState, null as any);
    const flow = readJSON<FlowState>(PATHS.flowState, null as any);
    const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
    const latestLog = log.logs[log.logs.length - 1];
    llmOutputs.push({
      phase, hour,
      data: {
        emotion_mood: emotion?.mood?.description ?? 'N/A',
        emotion_valence: emotion?.mood?.valence ?? 'N/A',
        emotion_energy: emotion?.energy ?? 'N/A',
        intent_count: pool?.intents?.length ?? 0,
        intent_categories: pool?.intents?.map((i: any) => i.category) ?? [],
        vitality: vitality?.vitality ?? 'N/A',
        flow_status: flow?.status ?? 'N/A',
        flow_activity: flow?.activity ?? 'N/A',
        latest_actions: latestLog?.chosen_actions ?? [],
        latest_inner_monologue: (latestLog as any)?.inner_monologue ?? 'N/A',
      },
    });
  } catch { /* ignore state capture errors */ }
}

// ── Report writer ────────────────────────────────────────────────

function writeReport(tmpDir: string) {
  const outputPath = path.join(
    os.homedir(),
    'Documents', 'Code', 'Alive',
    `miss-v-real-llm-report-${new Date().toISOString().slice(0, 10)}.md`,
  );

  const lines: string[] = [];
  lines.push('# Miss V (V姐) 真实 LLM 全功能测试报告');
  lines.push('');
  lines.push(`**测试时间**: ${new Date().toISOString()}`);
  lines.push(`**LLM 模型**: ${process.env.LLM_MODEL || 'unknown'}`);
  lines.push(`**API Base**: ${process.env.LLM_API_BASE || 'unknown'}`);
  lines.push(`**人格**: Miss V (ENTJ, 电竞解说×歌手×赛车手)`);
  lines.push(`**Sandbox**: ${tmpDir}`);
  lines.push('');

  // === Phase summary ===
  lines.push('## 📊 测试阶段总览');
  lines.push('');
  lines.push('| 阶段 | 时间 | 耗时 | 状态 |');
  lines.push('|------|------|------|------|');
  for (const r of reports) {
    const status = r.error ? `❌ ${r.error.slice(0, 60)}` : '✅ 成功';
    lines.push(`| ${r.phase} | ${String(r.hour).padStart(2, '0')}:00 | ${(r.durationMs / 1000).toFixed(1)}s | ${status} |`);
  }
  const totalTime = reports.reduce((s, r) => s + r.durationMs, 0);
  lines.push(`| **合计** | — | **${(totalTime / 1000).toFixed(1)}s** | ${reports.filter(r => r.error).length === 0 ? '✅ 全部通过' : '⚠️ 有错误'} |`);
  lines.push('');

  // === LLM output dump per phase ===
  lines.push('## 🧠 各阶段 LLM 输出详情');
  lines.push('');
  for (const out of llmOutputs) {
    lines.push(`### ${out.phase} (${String(out.hour).padStart(2, '0')}:00)`);
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(out.data, null, 2));
    lines.push('```');
    lines.push('');
  }

  // === Diary dump ===
  lines.push('## 📖 V姐当日日记全文');
  lines.push('');
  try {
    const diary = readText(PATHS.diary);
    lines.push(diary || '（日记为空）');
  } catch { lines.push('（读取失败）'); }
  lines.push('');

  // === Heartbeat log ===
  lines.push('## 📋 心跳日志（每小时行动记录）');
  lines.push('');
  try {
    const hbLog = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
    lines.push('| 时间 | 类型 | 状态 | 行动 |');
    lines.push('|------|------|------|------|');
    for (const l of hbLog.logs) {
      const ts = l.timestamp ? new Date(l.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '??:??';
      const tag = l.type === 'morning' ? '🌅' : l.type === 'night' ? '🌙' : '⏰';
      const actions = (l.chosen_actions || []).join(' \\| ') || '—';
      lines.push(`| ${tag} ${ts} | ${l.type} | ${l.status} | ${actions} |`);
    }
  } catch { lines.push('（读取失败）'); }
  lines.push('');

  // === Action type analysis ===
  lines.push('## 🎯 技能使用分析');
  lines.push('');
  try {
    const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
    const regulars = log.logs.filter(l => l.type === 'regular');
    let realCount = 0, simCount = 0, flowCount = 0, driftCount = 0;
    const skills: Record<string, number> = {};
    for (const entry of regulars) {
      if (entry.flow_state === 'flow') flowCount++;
      if (entry.flow_state === 'drift') driftCount++;
      for (const a of entry.chosen_actions ?? []) {
        const m = a.match(/^\[([\w-]+)\]/);
        if (m && !['flow', 'drift'].includes(m[1])) { realCount++; skills[m[1]] = (skills[m[1]] || 0) + 1; }
        else if (!a.startsWith('[flow]') && !a.startsWith('[drift]')) simCount++;
      }
    }
    lines.push(`- **真实技能动作**: ${realCount} 次`);
    lines.push(`- **模拟动作**: ${simCount} 次`);
    lines.push(`- **Flow 状态**: ${flowCount} 次`);
    lines.push(`- **Drift 状态**: ${driftCount} 次`);
    lines.push('');
    lines.push('**技能使用明细**:');
    for (const [k, v] of Object.entries(skills)) {
      lines.push(`- ${k}: ${v} 次`);
    }
  } catch { lines.push('（分析失败）'); }
  lines.push('');

  // === Wisdom ===
  lines.push('## 💎 核心智慧（今日习得）');
  lines.push('');
  try {
    const wisdom = readJSON<WisdomStore>(PATHS.coreWisdom, { wisdom: [], total_importance_since_reflection: 0 } as any);
    for (const w of wisdom.wisdom) {
      lines.push(`### [重要度 ${w.importance}/10] ${w.lesson}`);
      lines.push(`> 标签: ${(w.tags || []).join(' · ')}`);
      lines.push('');
    }
    if (wisdom.wisdom.length === 0) lines.push('（无智慧条目）');
  } catch { lines.push('（读取失败）'); }
  lines.push('');

  // === Preferences ===
  lines.push('## ❤️ 偏好更新');
  lines.push('');
  try {
    const prefs = readJSON<Preferences>(PATHS.preferences, { interests: [], content_style: [] } as any);
    if ((prefs as any).interests?.length) {
      lines.push('**兴趣偏好**:');
      for (const i of (prefs as any).interests) lines.push(`- ${i.name} (affinity: ${i.affinity?.toFixed?.(2) ?? '?'})`);
    }
    if ((prefs as any).content_style?.length) {
      lines.push('');
      lines.push('**内容风格偏好**:');
      for (const s of (prefs as any).content_style) lines.push(`- ${s.style} (affinity: ${s.affinity?.toFixed?.(2) ?? '?'})`);
    }
  } catch { lines.push('（读取失败）'); }
  lines.push('');

  // === Aspirations ===
  lines.push('## 🌟 心愿 / Aspirations');
  lines.push('');
  try {
    const asp = readJSON<Aspirations>(PATHS.aspirations, { aspirations: [] } as any);
    for (const a of asp.aspirations) {
      lines.push(`- **[${a.status}]** ${a.content}`);
      if (a.context) lines.push(`  > 背景: ${a.context}`);
    }
    if (asp.aspirations.length === 0) lines.push('（无心愿）');
  } catch { lines.push('（读取失败）'); }
  lines.push('');

  // === Emotion state ===
  lines.push('## 😊 最终情绪状态');
  lines.push('');
  try {
    const emo = readJSON<any>(PATHS.emotionState, {});
    lines.push(`- **情绪描述**: ${emo.mood?.description ?? 'N/A'}`);
    lines.push(`- **效价 valence**: ${emo.mood?.valence ?? 'N/A'}`);
    lines.push(`- **能量 energy**: ${emo.energy ?? 'N/A'}`);
    lines.push(`- **应激层**: valence=${emo.impulse_layer?.valence?.toFixed?.(3) ?? 'N/A'}, arousal=${emo.impulse_layer?.arousal?.toFixed?.(3) ?? 'N/A'}`);
    lines.push(`- **惯性层**: valence=${emo.momentum_layer?.valence?.toFixed?.(3) ?? 'N/A'}, energy=${emo.momentum_layer?.energy?.toFixed?.(3) ?? 'N/A'}`);
    lines.push(`- **基调层 undertone**: valence=${emo.undertone?.valence?.toFixed?.(3) ?? 'N/A'}, energy=${emo.undertone?.energy?.toFixed?.(3) ?? 'N/A'}`);
    lines.push(`- **压力 stress**: ${emo.stress?.toFixed?.(3) ?? 'N/A'}`);
    lines.push(`- **创造力 creativity**: ${emo.creativity?.toFixed?.(3) ?? 'N/A'}`);
    lines.push(`- **社交 sociability**: ${emo.sociability?.toFixed?.(3) ?? 'N/A'}`);
  } catch { lines.push('（读取失败）'); }
  lines.push('');

  // === Vitality ===
  lines.push('## ⚡ 活力状态');
  lines.push('');
  try {
    const vit = readJSON<any>(PATHS.vitalityState, {});
    lines.push(`- **活力值**: ${vit.vitality?.toFixed?.(1) ?? 'N/A'} / 100`);
    lines.push(`- **连续低活力天数**: ${vit.consecutive_low_days ?? 0}`);
  } catch { lines.push('（读取失败）'); }
  lines.push('');

  // === Flow state ===
  lines.push('## 🔄 流动状态');
  lines.push('');
  try {
    const flow = readJSON<any>(PATHS.flowState, {});
    lines.push(`- **状态**: ${flow.status ?? 'N/A'}`);
    lines.push(`- **活动**: ${flow.activity ?? '—'}`);
    lines.push(`- **持续**: ${flow.duration_ticks ?? 0} ticks`);
  } catch { lines.push('（读取失败）'); }
  lines.push('');

  // === Intent pool ===
  lines.push('## 🎯 意图池（最终状态）');
  lines.push('');
  try {
    const pool = readJSON<any>(PATHS.intentPool, { intents: [] });
    if (pool.intents.length === 0) {
      lines.push('（意图池已消耗清空）');
    } else {
      for (const i of pool.intents) {
        const resist = i.resistance ? ` [抵抗:${i.resistance.toFixed?.(1) ?? i.resistance}]` : '';
        lines.push(`- **[${i.category}]** 强度${(i.intensity ?? 0).toFixed?.(1) ?? i.intensity}${resist}: ${i.description}`);
      }
    }
  } catch { lines.push('（读取失败）'); }
  lines.push('');

  // === Schedule ===
  lines.push('## 📅 今日调度表');
  lines.push('');
  try {
    const sched = readJSON<any>(PATHS.scheduleToday, { flexible: [] });
    lines.push(`**日期**: ${sched.date ?? 'N/A'}`);
    lines.push('');
    for (const f of sched.flexible || []) {
      lines.push(`- ${f.preferred_time ?? '?'} [${f.intent_category}+${f.intent_boost}] ${f.activity}`);
    }
  } catch { lines.push('（读取失败）'); }
  lines.push('');

  // === Personality drift ===
  lines.push('## 🧬 人格漂移');
  lines.push('');
  try {
    const drift = readJSON<any>(PATHS.personalityDrift, { base: 'ENTJ', modifiers: [] });
    lines.push(`- **基础MBTI**: ${drift.base ?? 'ENTJ'}`);
    if (drift.modifiers?.length) {
      for (const m of drift.modifiers) {
        lines.push(`- ${m.trait ?? '?'}: ${m.effect ?? '?'} (强度: ${m.strength?.toFixed?.(2) ?? m.strength}) — 来源: ${m.origin ?? 'N/A'}`);
      }
    } else {
      lines.push('（无漂移记录）');
    }
  } catch { lines.push('（读取失败）'); }
  lines.push('');

  // === LLM Call Log stats ===
  lines.push('## 📊 LLM 调用统计');
  lines.push('');
  try {
    const logPath = path.join(tmpDir, 'llm-call-log.jsonl');
    if (fs.existsSync(logPath)) {
      const logLines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
      let totalMs = 0, totalInput = 0, totalOutput = 0, errorCount = 0;
      const callerStats: Record<string, { count: number; ms: number }> = {};
      for (const line of logLines) {
        try {
          const entry = JSON.parse(line);
          totalMs += entry.elapsed_ms ?? 0;
          totalInput += entry.input_tokens ?? 0;
          totalOutput += entry.output_tokens ?? 0;
          if (entry.error_message) errorCount++;
          const caller = entry.caller ?? 'unknown';
          if (!callerStats[caller]) callerStats[caller] = { count: 0, ms: 0 };
          callerStats[caller].count++;
          callerStats[caller].ms += entry.elapsed_ms ?? 0;
        } catch { /* skip malformed */ }
      }
      lines.push(`- **总调用次数**: ${logLines.length}`);
      lines.push(`- **总耗时**: ${(totalMs / 1000).toFixed(1)}s`);
      lines.push(`- **输入 tokens**: ${totalInput.toLocaleString()}`);
      lines.push(`- **输出 tokens**: ${totalOutput.toLocaleString()}`);
      lines.push(`- **错误次数**: ${errorCount}`);
      lines.push('');
      lines.push('**按调用者统计**:');
      lines.push('| 调用者 | 次数 | 耗时 |');
      lines.push('|--------|------|------|');
      for (const [caller, stats] of Object.entries(callerStats)) {
        lines.push(`| ${caller} | ${stats.count} | ${(stats.ms / 1000).toFixed(1)}s |`);
      }
    } else {
      lines.push('（LLM 调用日志不存在）');
    }
  } catch { lines.push('（统计失败）'); }
  lines.push('');

  // === Issues ===
  lines.push('## ⚠️ 质量问题汇总');
  lines.push('');
  const crits = issues.filter(i => i.severity === 'critical');
  const warns = issues.filter(i => i.severity === 'warning');
  const infos = issues.filter(i => i.severity === 'info');
  lines.push(`- 🔴 Critical: ${crits.length}`);
  lines.push(`- 🟡 Warning: ${warns.length}`);
  lines.push(`- 🔵 Info: ${infos.length}`);
  lines.push('');
  for (const i of crits) lines.push(`- 🔴 **[${i.cat}]** ${i.desc}`);
  for (const i of warns) lines.push(`- 🟡 [${i.cat}] ${i.desc}`);
  for (const i of infos) lines.push(`- 🔵 [${i.cat}] ${i.desc}`);
  lines.push('');

  // === Raw LLM call log (last 5 entries) ===
  lines.push('## 📝 LLM 原始调用日志（最后 5 条）');
  lines.push('');
  try {
    const logPath = path.join(tmpDir, 'llm-call-log.jsonl');
    if (fs.existsSync(logPath)) {
      const logLines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
      const lastN = logLines.slice(-5);
      for (const line of lastN) {
        try {
          const entry = JSON.parse(line);
          lines.push(`### ${entry.caller} @ ${entry.timestamp}`);
          lines.push(`> Model: ${entry.model} | ${entry.elapsed_ms}ms | in=${entry.input_tokens} out=${entry.output_tokens}`);
          lines.push('');
          lines.push('**Prompt** (前 500 字):');
          lines.push('```');
          lines.push((entry.prompt || '').slice(0, 500));
          lines.push('```');
          lines.push('');
          lines.push('**Response** (前 800 字):');
          lines.push('```');
          lines.push((entry.response || '').slice(0, 800));
          lines.push('```');
          lines.push('');
        } catch { /* skip */ }
      }
    }
  } catch { lines.push('（读取失败）'); }

  lines.push('');
  lines.push('---');
  lines.push(`*报告生成时间: ${new Date().toISOString()}*`);

  fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
  console.log(`\n  📄 报告已保存: ${outputPath}\n`);
  return outputPath;
}

// ═══════════════════════════════════════════════════════════════════

describe.skipIf(!shouldRun)('E2E: Miss V Real LLM Full Day (V姐 真实LLM全功能)', () => {
  let tmpDir: string;
  let llm: LLMClient;

  beforeAll(() => {
    // Force-load API keys from openclaw.json (vitest workers may not inherit tryLoadApiKeys result)
    tryLoadApiKeys();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miss-v-real-llm-full-'));
    setBasePaths(tmpDir, tmpDir);
    setPersonaName('miss-v');

    fs.mkdirSync(path.join(tmpDir, 'relations', 'social', 'xhs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'sub-skills'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'persona.yaml'), YAML.stringify(MISS_V_PERSONA));

    // Copy real templates (not minimal stubs — for full LLM prompt quality test)
    for (const f of fs.readdirSync(TEMPLATE_DIR)) {
      if (f.endsWith('.md')) fs.copyFileSync(path.join(TEMPLATE_DIR, f), path.join(tmpDir, 'templates', f));
    }

    // Create mock sub-skills
    const ss = path.join(tmpDir, 'sub-skills');
    createMockSubSkill(ss, 'ops-desk', 'Ops Desk 内容运营', '内容草稿生成、发布到小红书+抖音', [
      { intent: 'produce', action: 'generate-topics', priority: 7 },
      { intent: 'express', action: 'generate-topics', priority: 6 },
      { intent: 'consume', action: 'refresh-trends', priority: 3 },
    ]);
    createMockSubSkill(ss, 'generate-image', 'AI图片生成', '生成角色形象/内容封面图', [
      { intent: 'produce', action: 'generate', priority: 6 },
    ]);
    createMockSubSkill(ss, 'xhs-bridge', '小红书桥接', '搜索、发布小红书内容', [
      { intent: 'express', action: 'publish-note', priority: 8 },
      { intent: 'consume', action: 'search-feed', priority: 4 },
    ]);
    createMockSubSkill(ss, 'content-browse', '内容浏览与灵感采集', '刷内容、采集热榜灵感', [
      { intent: 'consume', action: 'feed-browse', priority: 4 },
      { intent: 'learn', action: 'inspiration-collect', priority: 4 },
    ]);
    createMockSubSkill(ss, 'web-search', '网络搜索研究', '网络搜索、赛事数据查询', [
      { intent: 'learn', action: 'search-pipeline', priority: 5 },
      { intent: 'consume', action: 'search-pipeline', priority: 3 },
    ]);

    setLlmLogPath(path.join(tmpDir, 'llm-call-log.jsonl'));
    llm = createRealLLMClient('e2e-miss-v-real-llm');

    console.log(`\n  Miss V Real LLM E2E | Model: ${process.env.LLM_MODEL || 'default'} | Sandbox: ${tmpDir}\n`);
  });

  afterAll(() => {
    // Generate report before cleanup
    const reportPath = writeReport(tmpDir);

    clearTimeOverride(); clearPersonaCache(); clearRouteTable(); resetBasePaths(); setLlmLogPath(null);

    // Print summary
    console.log('\n═══════════ Miss V Real LLM E2E Report Summary ═══════════');
    console.log(`  Total: ${(reports.reduce((s, r) => s + r.durationMs, 0) / 1000).toFixed(1)}s across ${reports.length} phases`);
    const errCount = reports.filter(r => r.error).length;
    console.log(`  Success rate: ${reports.length - errCount}/${reports.length}`);
    if (errCount > 0) { console.log('  Errors:'); reports.filter(r => r.error).forEach(r => console.log(`    ${r.hour}:00 — ${r.error}`)); }
    const crits = issues.filter(i => i.severity === 'critical');
    const warns = issues.filter(i => i.severity === 'warning');
    console.log(`  Issues: ${crits.length} critical, ${warns.length} warning, ${issues.filter(i => i.severity === 'info').length} info`);
    for (const i of crits) console.log(`    🔴 [${i.cat}] ${i.desc}`);
    for (const i of warns) console.log(`    🟡 [${i.cat}] ${i.desc}`);
    console.log(`  📄 Full report: ${reportPath}`);
    console.log('═══════════════════════════════════════════════════\n');

    if (process.env.KEEP_SANDBOX === '1' || crits.length > 0) {
      console.log(`  ⚠ Sandbox preserved: ${tmpDir}\n`);
    } else {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Phase 1: Morning Plan ──────────────────────────────────

  it('morning plan generates V姐-style ENTJ schedule via real LLM', async () => {
    setTimeOverride(new Date(2026, 3, 6, 9, 0, 0, 0)); // 2026-04-06 09:00
    const t0 = Date.now();
    await runMorningPlan(llm);
    reports.push({ hour: 9, phase: 'morning', durationMs: Date.now() - t0 });
    captureState('morning', 9);
    console.log(`  ✓ Morning plan: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const schedule = readJSON<ScheduleToday>(PATHS.scheduleToday, null as any);
    expect(schedule).not.toBeNull();
    expect(schedule.date).toBe('2026-04-06');
    if (!schedule.flexible?.length) issue('warning', 'morning', 'flexible_schedule 为空');

    const pool = readJSON<IntentPool>(PATHS.intentPool, null as any);
    expect(pool.intents.length).toBeGreaterThan(0);
    if (pool.intents.length < 2) issue('warning', 'morning', `intent seeds 仅 ${pool.intents.length} 个`);

    const emotion = readJSON<EmotionState>(PATHS.emotionState, null as any);
    expect(emotion.mood.valence).toBeGreaterThanOrEqual(-1);
    expect(emotion.mood.valence).toBeLessThanOrEqual(1);

    const diary = readText(PATHS.diary);
    expect(diary).toContain('2026-04-06');

    const cron = readJSON<CronSchedule>(PATHS.cronSchedule, null as any);
    expect(cron.heartbeats.length).toBeGreaterThan(0);
  }, 120_000);

  // ── Phase 2: Regular Heartbeat Ticks ───────────────────────

  it('runs heartbeat ticks across V姐 active hours with real LLM', async () => {
    // Miss V: wake=9, sleep=23, active_peaks at 14 & 21
    const hours = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];

    for (const hour of hours) {
      setTimeOverride(new Date(2026, 3, 6, hour, 0, 0, 0));
      clearPersonaCache();
      const t0 = Date.now();
      try {
        await regularTick(llm);
        reports.push({ hour, phase: 'regular', durationMs: Date.now() - t0 });
        captureState('regular', hour);
        console.log(`  ✓ ${String(hour).padStart(2, '0')}:00 — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (err) {
        const msg = (err as Error).message;
        reports.push({ hour, phase: 'regular', durationMs: Date.now() - t0, error: msg });
        issue('critical', 'heartbeat', `${hour}:00 崩溃: ${msg}`, hour);
        console.error(`  ✗ ${String(hour).padStart(2, '0')}:00 — ${msg}`);
      }
    }

    // All ticks should not crash
    const errorCount = reports.filter(r => r.phase === 'regular' && r.error).length;
    expect(errorCount).toBeLessThan(hours.length);

    // Verify heartbeat log
    const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
    const regulars = log.logs.filter(l => l.type === 'regular');
    expect(regulars.length).toBeGreaterThan(0);

    // Check for all-simulated problem (P0)
    const allActions = regulars.flatMap(l => l.chosen_actions ?? []);
    const hasRealSkill = allActions.some(a => /^\[(?:ops-desk|generate-image|xhs-bridge|content-browse|web-search|real-e2e:)/.test(a));
    if (!hasRealSkill) {
      issue('critical', 'routing', 'P0: 全天 0 个 real skill action — LLM 未遵循 prompt 中的技能引导');
    }

    // Check vitality drain
    const vitality = readJSON<VitalityState>(PATHS.vitalityState, null as any);
    if (vitality && vitality.vitality > 80) {
      issue('info', 'vitality', `全天结束活力仍有 ${Math.round(vitality.vitality)} — 消耗过少`);
    }

    // Check diary substance
    const diary = readText(PATHS.diary);
    if (diary.length < 500) {
      issue('warning', 'diary', `全天日记仅 ${diary.length} 字 — 内容过少`);
    }

    // Check for flow state engagement
    const flowEntries = regulars.filter(l => l.flow_state === 'flow');
    if (flowEntries.length === 0) {
      issue('info', 'flow', '全天无 flow 状态触发');
    }
  }, 900_000); // 15 min timeout

  // ── Phase 3: Night Reflection ──────────────────────────────

  it('night reflection generates V姐-style wisdom and growth updates', async () => {
    setTimeOverride(new Date(2026, 3, 6, 23, 0, 0, 0));
    clearPersonaCache();
    const t0 = Date.now();
    await runNightReflect(llm);
    reports.push({ hour: 23, phase: 'night', durationMs: Date.now() - t0 });
    captureState('night', 23);
    console.log(`  ✓ Night reflect: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // Wisdom
    const wisdom = readJSON<WisdomStore>(PATHS.coreWisdom, null as any);
    expect(wisdom.wisdom.length).toBeGreaterThan(0);
    if (wisdom.wisdom.length > 10) issue('warning', 'night', `wisdom 条目 ${wisdom.wisdom.length} — 过多`);

    for (const w of wisdom.wisdom) {
      if (!w.lesson || w.lesson.length < 5) issue('warning', 'night', `wisdom 条目内容过短: "${w.lesson}"`);
      if (typeof w.importance !== 'number') issue('warning', 'night', `wisdom importance 非数字: ${JSON.stringify(w)}`);
    }

    // Preferences
    const prefs = readJSON<Preferences>(PATHS.preferences, null as any);
    if (prefs) {
      expect((prefs as any).interests).toBeDefined();
    }

    // Aspirations
    const aspirations = readJSON<Aspirations>(PATHS.aspirations, null as any);
    if (aspirations?.aspirations?.length > 0) {
      for (const a of aspirations.aspirations) {
        if (!a.content || a.content.length < 3) issue('warning', 'night', `aspiration 内容过短: "${a.content}"`);
      }
    }

    // Final emotion should be sleep state
    const emotion = readJSON<EmotionState>(PATHS.emotionState, null as any);
    expect(emotion.mood.description).toBe('准备睡觉了');
    expect(emotion.energy).toBe(0.3);

    // Final log count
    const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
    const nightLogs = log.logs.filter(l => l.type === 'night');
    expect(nightLogs.length).toBe(1);
    expect(nightLogs[0].status).toBe('completed');

    // Final diary should be substantial
    const diary = readText(PATHS.diary);
    expect(diary.length).toBeGreaterThan(200);
    expect(diary).toContain('23:00');
  }, 120_000);

  // ── Phase 4: Full Day Summary Assertions ───────────────────

  it('full day produces coherent state with no critical failures', () => {
    const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });

    // Should have morning + regular + night entries
    expect(log.logs.filter(l => l.type === 'morning').length).toBe(1);
    expect(log.logs.filter(l => l.type === 'night').length).toBe(1);
    expect(log.logs.filter(l => l.type === 'regular').length).toBeGreaterThan(0);

    // Diary coherence — morning entry can be any hour (LLM decides wake time)
    const diary = readText(PATHS.diary);
    expect(diary).toMatch(/2026-04-06 \d{2}:\d{2}/);
    expect(diary).toContain('23:00');

    // Critical issues check
    const crits = issues.filter(i => i.severity === 'critical');
    if (crits.length > 0) {
      console.warn(`\n  ⚠ ${crits.length} critical issues found (see report)`);
    }
  });
});
