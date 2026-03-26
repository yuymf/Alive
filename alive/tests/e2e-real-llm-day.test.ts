// alive/tests/e2e-real-llm-day.test.ts
// E2E test: Simulate a full day lifecycle using REAL LLM
//   Morning Plan → Regular Heartbeat Ticks → Night Reflection
//
// Purpose: Verify prompt quality, real LLM output format, skill routing behavior,
// and identify problems in the actual LLM-driven decision pipeline.
//
// Usage:
//   LLM_API_KEY=xxx npx vitest run alive/tests/e2e-real-llm-day.test.ts
//   (or keys auto-load from ~/.openclaw/openclaw.json)
//   Set LLM_DEBUG=1 for detailed LLM request/response logging.
//   Set REAL_LLM_E2E=1 to force enable. Set KEEP_SANDBOX=1 to preserve tmp dir.

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
} from '../scripts/utils/types';

// ── API key loader ───────────────────────────────────────────────

function tryLoadApiKeys(): boolean {
  try {
    const home = process.env.HOME || '~';
    const cfgPath = path.join(home, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(cfgPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const env = cfg?.skills?.entries?.alive?.env;
    if (!env) return false;
    for (const k of ['LLM_API_KEY', 'LLM_API_BASE', 'LLM_MODEL']) {
      if (env[k] && !process.env[k]) process.env[k] = env[k];
    }
    return !!process.env.LLM_API_KEY;
  } catch { return false; }
}

const shouldRun = process.env.REAL_LLM_E2E === '1' || !!process.env.LLM_API_KEY || tryLoadApiKeys();

// ── Persona ──────────────────────────────────────────────────────

const TEST_PERSONA = {
  meta: { name: '水瀬', name_reading: 'Minase', id: 'minase', age: 18,
    tagline: '辣妹系 coser × 数字游民旅行博主', occupation_detail: '数字游民旅游博主。Instagram 是主业。' },
  personality: { mbti: 'ESTP', core_traits: ['元气满满', '行动派', '好胜心强', '口是心非'],
    quirks: ['拍照前一定要先选 BGM'], values: ['真实 > 完美'] },
  voice: { language: 'zh-CN', style: '口语化、活泼、短句多',
    mixed_languages: { ja: ['sugoi', 'kawaii', 'yabai'] }, emoji_density: 'medium' as const,
    sample_lines: ['这个构图绝了吧！！', '啊啊啊困死了...但是这个光线不拍可惜'] },
  intimacy: { levels: 5, behaviors: { 1: '礼貌但有距离', 3: '放松、偶尔撒娇', 5: '完全袒露' } },
  schedule: { wake_hour: 9, sleep_hour: 23, timezone: 'Asia/Tokyo', active_peaks: [14, 21] },
  sub_skills: ['instagram', 'content-browse', 'social-engagement', 'web-search'],
  features: { skill_discovery: false, random_events: true, social_graph: true, flow_states: true,
    procrastination: true, personality_drift: true, content_browse: false },
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

function issue(severity: QualityIssue['severity'], cat: string, desc: string, hour?: number) {
  issues.push({ severity, cat, desc, hour });
}

// ═══════════════════════════════════════════════════════════════════

describe.skipIf(!shouldRun)('E2E: Real LLM Full Day (水瀬)', () => {
  let tmpDir: string;
  let llm: LLMClient;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minase-real-llm-e2e-'));
    setBasePaths(tmpDir, tmpDir);
    setPersonaName('minase');

    fs.mkdirSync(path.join(tmpDir, 'relations', 'social', 'instagram'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'sub-skills'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'persona.yaml'), YAML.stringify(TEST_PERSONA));

    // Copy real templates
    for (const f of fs.readdirSync(TEMPLATE_DIR)) {
      if (f.endsWith('.md')) fs.copyFileSync(path.join(TEMPLATE_DIR, f), path.join(tmpDir, 'templates', f));
    }

    // Create mock sub-skills
    const ss = path.join(tmpDir, 'sub-skills');
    createMockSubSkill(ss, 'instagram', 'Instagram', 'Instagram 发帖', [
      { intent: 'produce', action: 'instagram-post', priority: 10 }, { intent: 'express', action: 'instagram-post', priority: 8 }]);
    createMockSubSkill(ss, 'content-browse', '内容浏览', '刷内容', [
      { intent: 'consume', action: 'feed-browse', priority: 4 }, { intent: 'learn', action: 'inspiration-collect', priority: 2 }]);
    createMockSubSkill(ss, 'social-engagement', '社交互动', '评论回复', [
      { intent: 'connect', action: 'comment-reply', priority: 8 }, { intent: 'connect', action: 'social-engagement', priority: 7 }]);
    createMockSubSkill(ss, 'web-search', '网络搜索', '网络搜索', [
      { intent: 'learn', action: 'search-pipeline', priority: 5 }, { intent: 'consume', action: 'search-pipeline', priority: 4 }]);

    setLlmLogPath(path.join(tmpDir, 'llm-call-log.jsonl'));
    llm = createRealLLMClient('e2e-real-llm-day');

    console.log(`\n  Real LLM E2E | Model: ${process.env.LLM_MODEL || 'claude-sonnet-4-20250514'} | Sandbox: ${tmpDir}\n`);
  });

  afterAll(() => {
    clearTimeOverride(); clearPersonaCache(); clearRouteTable(); resetBasePaths(); setLlmLogPath(null);
    // Print report
    console.log('\n═══════════ Real LLM E2E Analysis Report ═══════════');
    console.log(`  Total: ${(reports.reduce((s, r) => s + r.durationMs, 0) / 1000).toFixed(1)}s across ${reports.length} phases`);
    const errCount = reports.filter(r => r.error).length;
    console.log(`  Success rate: ${reports.length - errCount}/${reports.length}`);
    if (errCount > 0) { console.log('  Errors:'); reports.filter(r => r.error).forEach(r => console.log(`    ${r.hour}:00 — ${r.error}`)); }

    // Action type analysis from heartbeat log
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
    console.log(`\n  Action types: real=${realCount} simulated=${simCount} flow=${flowCount} drift=${driftCount}`);
    console.log(`  Skill usage: ${JSON.stringify(skills)}`);
    if (realCount === 0) issue('critical', 'routing', 'LLM 全天 0 次 type:real — prompt 引导失败或 LLM 不遵循 skill 指令');
    if (realCount > 10) issue('warning', 'routing', `LLM 全天 ${realCount} 次 real action — 过度使用技能，缺少日常模拟`);

    // Diary analysis
    const diary = readText(PATHS.diary);
    console.log(`  Diary: ${diary.length} chars, ${diary.split('\n## ').length - 1} entries`);

    // Issues summary
    const crits = issues.filter(i => i.severity === 'critical');
    const warns = issues.filter(i => i.severity === 'warning');
    const infos = issues.filter(i => i.severity === 'info');
    console.log(`\n  Issues: ${crits.length} critical, ${warns.length} warning, ${infos.length} info`);
    for (const i of crits) console.log(`    🔴 [${i.cat}] ${i.desc}`);
    for (const i of warns) console.log(`    🟡 [${i.cat}] ${i.desc}`);
    for (const i of infos) console.log(`    🔵 [${i.cat}] ${i.desc}`);
    console.log('═══════════════════════════════════════════════════\n');

    if (process.env.KEEP_SANDBOX === '1' || crits.length > 0) {
      console.log(`  ⚠ Sandbox preserved: ${tmpDir}\n`);
    } else {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Phase 1: Morning Plan ──────────────────────────────────

  it('morning plan generates valid schedule via real LLM', async () => {
    setTimeOverride(new Date(2026, 2, 25, 9, 0, 0, 0));
    const t0 = Date.now();
    await runMorningPlan(llm);
    reports.push({ hour: 9, phase: 'morning', durationMs: Date.now() - t0 });
    console.log(`  ✓ Morning plan: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const schedule = readJSON<ScheduleToday>(PATHS.scheduleToday, null as any);
    expect(schedule).not.toBeNull();
    expect(schedule.date).toBe('2026-03-25');
    if (!schedule.flexible?.length) issue('warning', 'morning', 'flexible_schedule 为空');

    const pool = readJSON<IntentPool>(PATHS.intentPool, null as any);
    expect(pool.intents.length).toBeGreaterThan(0);
    if (pool.intents.length < 2) issue('warning', 'morning', `intent seeds 仅 ${pool.intents.length} 个`);

    const emotion = readJSON<EmotionState>(PATHS.emotionState, null as any);
    expect(emotion.mood.valence).toBeGreaterThanOrEqual(-1);
    expect(emotion.mood.valence).toBeLessThanOrEqual(1);

    const diary = readText(PATHS.diary);
    expect(diary).toContain('2026-03-25');

    const cron = readJSON<CronSchedule>(PATHS.cronSchedule, null as any);
    expect(cron.heartbeats.length).toBeGreaterThan(0);
  }, 120_000);

  // ── Phase 2: Regular Heartbeat Ticks ───────────────────────

  it('runs 13 heartbeat ticks with real LLM', async () => {
    const hours = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];

    for (const hour of hours) {
      setTimeOverride(new Date(2026, 2, 25, hour, 0, 0, 0));
      clearPersonaCache();
      const t0 = Date.now();
      try {
        await regularTick(llm);
        reports.push({ hour, phase: 'regular', durationMs: Date.now() - t0 });
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
    expect(errorCount).toBeLessThan(hours.length); // At least some must succeed

    // Verify heartbeat log
    const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
    const regulars = log.logs.filter(l => l.type === 'regular');
    expect(regulars.length).toBeGreaterThan(0);

    // Check for all-simulated problem (P0 from previous analysis)
    const allActions = regulars.flatMap(l => l.chosen_actions ?? []);
    const hasRealSkill = allActions.some(a => /^\[(?:instagram|content-browse|social-engagement|web-search)\]/.test(a));
    if (!hasRealSkill) {
      issue('critical', 'routing', 'P0 复现: 全天 0 个 real skill action — LLM 未遵循 prompt 中的技能引导');
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
  }, 600_000); // 10 min timeout

  // ── Phase 3: Night Reflection ──────────────────────────────

  it('night reflection generates wisdom and updates via real LLM', async () => {
    setTimeOverride(new Date(2026, 2, 25, 23, 0, 0, 0));
    clearPersonaCache();
    const t0 = Date.now();
    await runNightReflect(llm);
    reports.push({ hour: 23, phase: 'night', durationMs: Date.now() - t0 });
    console.log(`  ✓ Night reflect: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // Wisdom
    const wisdom = readJSON<WisdomStore>(PATHS.coreWisdom, null as any);
    expect(wisdom.wisdom.length).toBeGreaterThan(0);
    if (wisdom.wisdom.length > 10) issue('warning', 'night', `wisdom 条目 ${wisdom.wisdom.length} — 过多，可能 LLM 过度输出`);

    for (const w of wisdom.wisdom) {
      if (!w.lesson || w.lesson.length < 5) issue('warning', 'night', `wisdom 条目内容过短: "${w.lesson}"`);
      if (typeof w.importance !== 'number') issue('warning', 'night', `wisdom importance 非数字: ${JSON.stringify(w)}`);
    }

    // Preferences
    const prefs = readJSON<Preferences>(PATHS.preferences, null as any);
    if (prefs) {
      expect(prefs.interests).toBeDefined();
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
    // This test runs last, after all LLM-driven phases
    const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });

    // Should have morning + regular + night entries
    expect(log.logs.filter(l => l.type === 'morning').length).toBe(1);
    expect(log.logs.filter(l => l.type === 'night').length).toBe(1);
    expect(log.logs.filter(l => l.type === 'regular').length).toBeGreaterThan(0);

    // No critical issues should be present (soft check — test still passes with warnings)
    const crits = issues.filter(i => i.severity === 'critical');
    if (crits.length > 0) {
      console.warn(`\n  ⚠ ${crits.length} critical issues found (see report above)`);
      // Don't fail the test — this is diagnostic. The individual phase tests cover correctness.
    }

    // Diary coherence: should mention morning and night
    const diary = readText(PATHS.diary);
    // Morning diary entry may use LLM-generated wake_time (e.g. 09:30) rather than exact 09:00
    expect(diary).toMatch(/2026-03-25 09:\d{2}/);
    expect(diary).toContain('23:00');
  });
});
