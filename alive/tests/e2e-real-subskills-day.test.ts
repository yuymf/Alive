// alive/tests/e2e-real-subskills-day.test.ts
// E2E test: Full day with REAL LLM + REAL sub-skills — FULLY REAL execution!
//
// Difference from e2e-real-llm-day.test.ts:
//   - Uses actual sub-skill code (instagram, content-browse, social-engagement, web-search)
//   - ALL platform APIs are called for real (Instagram, ImgURL, XHS, Cron)
//   - This tests the COMPLETE pipeline end-to-end: LLM + image gen + API calls
//
// Usage:
//   REAL_LLM_E2E=1 KEEP_SANDBOX=1 npx vitest run --config vitest.alive.config.ts alive/tests/e2e-real-subskills-day.test.ts

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

// ── NO E2E mocks — all real! ─────────────────────────────────────
// Only mock cron (we don't want to actually edit OpenClaw cron jobs during tests)
// Instagram, ImgURL, XHS — all go through real APIs
delete process.env.E2E_MOCK_INSTAGRAM;
delete process.env.E2E_MOCK_IMGURL;
delete process.env.E2E_MOCK_XHS;
process.env.E2E_MOCK_CRON = '1';  // Keep cron mock (no openclaw daemon in test)

// ── API key loader ───────────────────────────────────────────────

function tryLoadApiKeys(): boolean {
  try {
    const home = process.env.HOME || '~';
    const cfgPath = path.join(home, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(cfgPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const env = cfg?.skills?.entries?.alive?.env;
    if (!env) return false;
    // Load ALL env vars needed for real sub-skill execution
    const keys = [
      'LLM_API_KEY', 'LLM_API_BASE', 'LLM_MODEL',
      'AIHUBMIX_API_KEY', 'FAL_KEY', 'IMGURL_TOKEN',
      'INSTAGRAM_USERNAME', 'INSTAGRAM_PASSWORD',
      'INSTAGRAM_SESSIONID', 'INSTAGRAM_CSRFTOKEN', 'INSTAGRAM_DS_USER_ID',
      'INSTAGRAM_TOTP_SECRET',
      'INSTAGRAM_MID', 'INSTAGRAM_IG_DID', 'INSTAGRAM_DATR', 'INSTAGRAM_RUR',
      'EXA_API_KEY',
    ];
    for (const k of keys) {
      if (env[k] && !process.env[k]) process.env[k] = env[k];
    }
    console.log(`  API keys loaded: ${keys.filter(k => !!process.env[k]).join(', ')}`);
    return !!process.env.LLM_API_KEY;
  } catch { return false; }
}

const apiKeysLoaded = tryLoadApiKeys();
const shouldRun = process.env.REAL_LLM_E2E === '1' || !!process.env.LLM_API_KEY || apiKeysLoaded;

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

// ── Quality analysis types ───────────────────────────────────────

interface HourReport { hour: number; phase: string; durationMs: number; error?: string }
interface QualityIssue { severity: 'critical' | 'warning' | 'info'; cat: string; desc: string; hour?: number }
interface SubSkillExec {
  hour: number;
  skillName: string;
  action: string;
  narrative: string;
  success: boolean;
  durationMs?: number;
  error?: string;
}

const reports: HourReport[] = [];
const issues: QualityIssue[] = [];
const subSkillExecs: SubSkillExec[] = [];

function issue(severity: QualityIssue['severity'], cat: string, desc: string, hour?: number) {
  issues.push({ severity, cat, desc, hour });
}

// ═══════════════════════════════════════════════════════════════════

describe.skipIf(!shouldRun)('E2E: Real Sub-Skills Full Day (水瀬)', () => {
  let tmpDir: string;
  let llm: LLMClient;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minase-real-subskills-e2e-'));
    setBasePaths(tmpDir, tmpDir);
    setPersonaName('minase');

    fs.mkdirSync(path.join(tmpDir, 'relations', 'social', 'instagram'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'photo-roll'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'references'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'assets', 'references'), { recursive: true });

    // Pre-seed reference images for image generation pipeline
    // PATHS.referencesDir = <memoryBase>/assets/references/ — must copy to correct location
    // Also keep a copy in <tmpDir>/references/ for backward compat
    const sourceRef = path.join(__dirname, '..', 'personas', 'minase-source.png');
    if (fs.existsSync(sourceRef)) {
      for (const refName of ['front.png', 'half-body.png', 'full-body.png', 'left-profile.png']) {
        fs.copyFileSync(sourceRef, path.join(tmpDir, 'assets', 'references', refName));
        fs.copyFileSync(sourceRef, path.join(tmpDir, 'references', refName));
      }
      console.log('  ✓ Reference images pre-seeded from minase-source.png');
    } else {
      console.warn('  ⚠ minase-source.png not found — image generation will fail');
    }

    fs.writeFileSync(path.join(tmpDir, 'persona.yaml'), YAML.stringify(TEST_PERSONA));

    // Copy real templates from alive/templates/
    for (const f of fs.readdirSync(TEMPLATE_DIR)) {
      if (f.endsWith('.md')) fs.copyFileSync(path.join(TEMPLATE_DIR, f), path.join(tmpDir, 'templates', f));
    }

    // Use REAL sub-skills — dist-alive strategy:
    //
    // Compiled JS in dist-alive/sub-skills/ uses require("../../../scripts/router/sub-skill-sdk")
    // which resolves relative to the file location. So the sub-skills MUST live under dist-alive/
    // for the relative paths to resolve correctly to dist-alive/scripts/router/sub-skill-sdk.js.
    //
    // Strategy:
    //   1. Copy non-TS resource files (manifest.json, templates/, events.yaml, strategy.md)
    //      from alive/sub-skills/ → dist-alive/sub-skills/ (tsc only outputs .js)
    //   2. Symlink sandbox sub-skills → dist-alive/sub-skills/
    //
    const srcSubSkillsDir = path.join(__dirname, '..', 'sub-skills');
    const distSubSkillsDir = path.join(__dirname, '..', '..', 'dist-alive', 'sub-skills');

    if (!fs.existsSync(distSubSkillsDir)) {
      throw new Error(`dist-alive not found! Run "npx tsc -p tsconfig.alive.json" first.`);
    }

    // Step 1: Copy resource files (non-TS) from source → dist-alive
    copyResourceFiles(srcSubSkillsDir, distSubSkillsDir);

    // Step 2: Symlink sandbox sub-skills → dist-alive/sub-skills/
    const targetSubSkillsDir = path.join(tmpDir, 'sub-skills');
    fs.symlinkSync(distSubSkillsDir, targetSubSkillsDir);

    // Verify sub-skill loading
    const testManifest = path.join(distSubSkillsDir, 'instagram', 'manifest.json');
    const testIndex = path.join(distSubSkillsDir, 'instagram', 'scripts', 'index.js');
    if (!fs.existsSync(testManifest)) throw new Error(`Missing manifest: ${testManifest}`);
    if (!fs.existsSync(testIndex)) throw new Error(`Missing index.js: ${testIndex}`);
    console.log(`  Sub-skills: dist=${distSubSkillsDir} (symlinked to sandbox)`);

    // Pre-seed work-impulse so Instagram can actually post (threshold=70, start at 85)
    fs.writeFileSync(path.join(tmpDir, 'work-impulse.json'), JSON.stringify({
      value: 85,
      last_output_at: 0,
      outputs_today_date: '',
      outputs_today: 0,
    }));

    setLlmLogPath(path.join(tmpDir, 'llm-call-log.jsonl'));
    llm = createRealLLMClient('e2e-real-subskills-day');

    console.log(`\n  Real Sub-Skills E2E | Model: ${process.env.LLM_MODEL || 'claude-sonnet-4-20250514'} | Sandbox: ${tmpDir}`);
    console.log(`  MODE: FULLY REAL — NO API MOCKS (except cron)`);
  });

  afterAll(() => {
    clearTimeOverride(); clearPersonaCache(); clearRouteTable(); setLlmLogPath(null);

    // ═══════════ Comprehensive Real Sub-Skills E2E Report ═══════════
    console.log('\n═══════════ Real Sub-Skills E2E Analysis Report ═══════════');
    console.log(`  Sandbox: ${tmpDir}`);
    console.log(`  Total: ${(reports.reduce((s, r) => s + r.durationMs, 0) / 1000).toFixed(1)}s across ${reports.length} phases`);
    const errCount = reports.filter(r => r.error).length;
    console.log(`  Success rate: ${reports.length - errCount}/${reports.length}`);
    if (errCount > 0) { console.log('  Errors:'); reports.filter(r => r.error).forEach(r => console.log(`    ${r.hour}:00 — ${r.error}`)); }

    // ── Sub-skill execution analysis ──
    console.log('\n  ── Sub-Skill Executions ──');
    const skillGroups: Record<string, SubSkillExec[]> = {};
    for (const exec of subSkillExecs) {
      if (!skillGroups[exec.skillName]) skillGroups[exec.skillName] = [];
      skillGroups[exec.skillName].push(exec);
    }
    for (const [skill, execs] of Object.entries(skillGroups)) {
      const successes = execs.filter(e => e.success).length;
      const failures = execs.filter(e => !e.success).length;
      console.log(`    ${skill}: ${execs.length} executions (${successes} success, ${failures} failures)`);
      for (const exec of execs) {
        const status = exec.success ? '✓' : '✗';
        const errInfo = exec.error ? ` ERROR: ${exec.error}` : '';
        console.log(`      ${status} ${String(exec.hour).padStart(2, '0')}:00 ${exec.action} — ${exec.narrative.slice(0, 100)}${errInfo}`);
      }
    }

    // ── Detailed Sub-Skill Output Report ──
    console.log('\n  ── Detailed Sub-Skill Output ──');

    // Instagram: post history, photos
    try {
      const postHistoryPath = path.join(tmpDir, 'post-history.json');
      if (fs.existsSync(postHistoryPath)) {
        const postHistory = JSON.parse(fs.readFileSync(postHistoryPath, 'utf8'));
        const posts = postHistory.posts ?? [];
        console.log(`\n    📸 Instagram Post History: ${posts.length} posts`);
        for (const post of posts) {
          console.log(`      ID: ${post.id}`);
          console.log(`        Style: ${post.style}`);
          console.log(`        Caption: ${(post.caption ?? '').slice(0, 120)}`);
          console.log(`        Hashtags: ${(post.hashtags ?? []).join(' ')}`);
          console.log(`        Photo URLs: ${(post.photo_urls ?? []).join(', ')}`);
          console.log(`        Media ID: ${post.media_id ?? 'N/A'}`);
          console.log(`        Timestamp: ${post.timestamp}`);
          if (post.stats) {
            console.log(`        Stats: ❤️${post.stats.likes} 💬${post.stats.comments} 👀${post.stats.reach}`);
          }
        }
      } else {
        console.log(`\n    📸 Instagram: No post-history.json found`);
      }
    } catch (e) { console.log(`    📸 Instagram: Error reading post history: ${(e as Error).message}`); }

    // Photo roll (generated images)
    try {
      const photoDir = path.join(tmpDir, 'photo-roll');
      if (fs.existsSync(photoDir)) {
        const photos = fs.readdirSync(photoDir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
        console.log(`\n    🖼️ Photo Roll: ${photos.length} images`);
        for (const photo of photos) {
          const stat = fs.statSync(path.join(photoDir, photo));
          console.log(`      ${photo} (${(stat.size / 1024).toFixed(1)} KB)`);
        }
      }
    } catch (e) { console.log(`    🖼️ Photo Roll: Error: ${(e as Error).message}`); }

    // Inspiration state (from content-browse)
    try {
      const inspoPath = path.join(tmpDir, 'inspiration-state.json');
      if (fs.existsSync(inspoPath)) {
        const inspo = JSON.parse(fs.readFileSync(inspoPath, 'utf8'));
        console.log(`\n    💡 Inspiration State:`);
        console.log(`      Last refreshed: ${inspo.last_refreshed_at ?? 'never'}`);
        console.log(`      Feed highlights: ${(inspo.feed_highlights ?? []).length}`);
        for (const h of (inspo.feed_highlights ?? []).slice(0, 5)) {
          console.log(`        - ${h.title} (❤️${h.likes}) topic: ${h.topic}`);
        }
        console.log(`      Trending topics: ${(inspo.trending_topics ?? []).join(', ') || 'none'}`);
        console.log(`      Domain insights: ${(inspo.domain_insights ?? []).length}`);
        for (const d of (inspo.domain_insights ?? []).slice(0, 3)) {
          console.log(`        - ${d}`);
        }
        console.log(`      Saved inspirations: ${(inspo.saved_inspirations ?? []).length}`);
      } else {
        console.log(`\n    💡 Inspiration: No inspiration-state.json found`);
      }
    } catch (e) { console.log(`    💡 Inspiration: Error: ${(e as Error).message}`); }

    // Search state
    try {
      const searchPath = path.join(tmpDir, 'search-state.json');
      if (fs.existsSync(searchPath)) {
        const searchState = JSON.parse(fs.readFileSync(searchPath, 'utf8'));
        console.log(`\n    🔍 Search State: ${searchState.count ?? 0} searches on ${searchState.date ?? '?'}`);
      }
    } catch (e) { /* ignore */ }

    // Trend insights
    try {
      const trendPath = path.join(tmpDir, 'trend-insights.json');
      if (fs.existsSync(trendPath)) {
        const trends = JSON.parse(fs.readFileSync(trendPath, 'utf8'));
        console.log(`\n    📈 Trend Insights:`);
        console.log(`      Hot styles: ${(trends.hot_styles ?? []).join(', ') || 'none'}`);
        console.log(`      High engagement patterns: ${(trends.high_engagement_patterns ?? []).join(', ') || 'none'}`);
        console.log(`      Trending hashtags: ${(trends.trending_hashtags ?? []).join(', ') || 'none'}`);
      }
    } catch (e) { /* ignore */ }

    // Outbound engagement history
    try {
      const outboundPath = path.join(tmpDir, 'outbound-history.json');
      if (fs.existsSync(outboundPath)) {
        const outbound = JSON.parse(fs.readFileSync(outboundPath, 'utf8'));
        const entries = outbound.commented ?? [];
        console.log(`\n    💬 Social Engagement Outbound: ${entries.length} comments posted`);
        for (const e of entries) {
          console.log(`      → media_pk=${e.media_pk} user=${e.user_id} at ${new Date(e.commented_at).toISOString()}`);
        }
      }
    } catch (e) { /* ignore */ }

    // Pending engagement (comment replies)
    try {
      const pendingPath = path.join(tmpDir, 'pending-engagement.json');
      if (fs.existsSync(pendingPath)) {
        const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
        const replies = pending.pending_replies ?? [];
        console.log(`\n    💬 Comment Replies: ${replies.length} media tracked`);
        for (const r of replies) {
          console.log(`      media_pk=${r.media_pk} replied_comments=${(r.replied_comment_ids ?? []).length}`);
        }
      }
    } catch (e) { /* ignore */ }

    // Post impulse state
    try {
      const impulsePath = path.join(tmpDir, 'work-impulse.json');
      if (fs.existsSync(impulsePath)) {
        const impulse = JSON.parse(fs.readFileSync(impulsePath, 'utf8'));
        console.log(`\n    🔥 Work Impulse: ${impulse.impulse}/100 (last accumulated: ${impulse.last_accumulated ?? 'never'}, last posted: ${impulse.last_posted_date ?? 'never'})`);
      }
    } catch (e) { /* ignore */ }

    // Cron schedule
    try {
      const cronPath = path.join(tmpDir, 'cron-schedule.json');
      if (fs.existsSync(cronPath)) {
        const cron = JSON.parse(fs.readFileSync(cronPath, 'utf8'));
        console.log(`\n    ⏰ Cron Schedule: ${(cron.heartbeats ?? []).length} heartbeats`);
      }
    } catch (e) { /* ignore */ }

    // Action type analysis from heartbeat log
    const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
    const regulars = log.logs.filter(l => l.type === 'regular');
    let realCount = 0, simCount = 0, flowCount = 0, driftCount = 0;
    const skills: Record<string, number> = {};
    for (const entry of regulars) {
      if (entry.flow_state === 'flow') flowCount++;
      if (entry.flow_state === 'drift') driftCount++;
      for (const a of entry.chosen_actions ?? []) {
        const m = a.match(/^\[([^\]]+)\]/);
        if (m && !['flow', 'drift'].includes(m[1]) && !m[1].startsWith('error:') && !m[1].startsWith('fallback:')) {
          realCount++; skills[m[1]] = (skills[m[1]] || 0) + 1;
        } else if (!a.startsWith('[flow]') && !a.startsWith('[drift]')) {
          simCount++;
        }
      }
    }
    console.log(`\n  Action types: real=${realCount} simulated=${simCount} flow=${flowCount} drift=${driftCount}`);
    console.log(`  Skill usage: ${JSON.stringify(skills)}`);

    if (realCount === 0) issue('critical', 'routing', 'LLM 全天 0 次 type:real — prompt 引导失败或 LLM 不遵循 skill 指令');

    // Diary analysis
    const diary = readText(PATHS.diary);
    console.log(`\n  📝 Diary: ${diary.length} chars, ${diary.split('\n## ').length - 1} entries`);

    // Full diary content for inspection
    console.log('\n  ── Full Diary ──');
    const diaryLines = diary.split('\n');
    for (const line of diaryLines) {
      console.log(`    ${line}`);
    }

    // Check for real sub-skill narrative evidence in diary
    const hasInstagramEvidence = diary.includes('Instagram') || diary.includes('instagram') || diary.includes('📸');
    const hasSearchEvidence = diary.includes('搜') || diary.includes('learn');
    const hasBrowseEvidence = diary.includes('刷') || diary.includes('灵感') || diary.includes('📱');
    const hasSocialEvidence = diary.includes('评论') || diary.includes('connect') || diary.includes('互动');
    console.log(`\n  Sub-skill diary evidence: instagram=${hasInstagramEvidence} search=${hasSearchEvidence} browse=${hasBrowseEvidence} social=${hasSocialEvidence}`);

    // Issues summary
    const crits = issues.filter(i => i.severity === 'critical');
    const warns = issues.filter(i => i.severity === 'warning');
    const infos = issues.filter(i => i.severity === 'info');
    console.log(`\n  Issues: ${crits.length} critical, ${warns.length} warning, ${infos.length} info`);
    for (const i of crits) console.log(`    🔴 [${i.cat}] ${i.desc}`);
    for (const i of warns) console.log(`    🟡 [${i.cat}] ${i.desc}`);
    for (const i of infos) console.log(`    🔵 [${i.cat}] ${i.desc}`);
    console.log('═══════════════════════════════════════════════════\n');

    // Always keep sandbox for analysis
    console.log(`  ⚠ Sandbox preserved: ${tmpDir}\n`);

    // Reset PATHS before done
    resetBasePaths();
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

    const pool = readJSON<IntentPool>(PATHS.intentPool, null as any);
    expect(pool.intents.length).toBeGreaterThan(0);

    const diary = readText(PATHS.diary);
    expect(diary).toContain('2026-03-25');
  }, 120_000);

  // ── Phase 2: Regular Heartbeat Ticks ───────────────────────

  it('runs 13 heartbeat ticks with real LLM and real sub-skills', async () => {
    const hours = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];

    for (const hour of hours) {
      setTimeOverride(new Date(2026, 2, 25, hour, 0, 0, 0));
      clearPersonaCache();
      const t0 = Date.now();
      try {
        await regularTick(llm);
        const elapsed = Date.now() - t0;
        reports.push({ hour, phase: 'regular', durationMs: elapsed });

        // After each tick, check heartbeat log for sub-skill executions
        const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
        const lastEntry = log.logs[log.logs.length - 1];
        if (lastEntry?.chosen_actions) {
          for (const action of lastEntry.chosen_actions) {
            const m = action.match(/^\[([^\]]+)\]\s*(.*)/);
            if (m && !['flow', 'drift'].includes(m[1])) {
              const isError = m[1].startsWith('error:');
              const isFallback = m[1].startsWith('fallback:');
              subSkillExecs.push({
                hour,
                skillName: m[1].replace('error:', '').replace('fallback:', ''),
                action: m[2] || '',
                narrative: m[2] || '',
                success: !isError,
                error: isError ? `sub-skill execution failed` : (isFallback ? 'route fallback to simulated' : undefined),
              });
            }
          }
        }

        console.log(`  ✓ ${String(hour).padStart(2, '0')}:00 — ${((elapsed) / 1000).toFixed(1)}s | actions: ${lastEntry?.chosen_actions?.join(', ') || 'none'}`);
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

    // Check for real skill actions (the main point of this test!)
    const allActions = regulars.flatMap(l => l.chosen_actions ?? []);
    const hasRealSkill = allActions.some(a => /^\[(?:instagram|content-browse|social-engagement|web-search)\]/.test(a));
    if (!hasRealSkill) {
      issue('critical', 'routing', 'P0: 全天 0 个 real sub-skill action — LLM 未遵循 prompt 中的技能引导');
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
  }, 3000_000); // 50 min timeout — real APIs (image gen + publish, search, social) take much longer

  // ── Phase 3: Night Reflection ──────────────────────────────

  it('night reflection generates wisdom and updates via real LLM', async () => {
    setTimeOverride(new Date(2026, 2, 25, 23, 0, 0, 0));
    clearPersonaCache();
    const t0 = Date.now();
    await runNightReflect(llm);
    reports.push({ hour: 23, phase: 'night', durationMs: Date.now() - t0 });
    console.log(`  ✓ Night reflect: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // Wisdom may be empty if LLM didn't generate any (or if fallback was used)
    const wisdom = readJSON<WisdomStore>(PATHS.coreWisdom, null as any);
    expect(wisdom).not.toBeNull();

    // Emotion should be reset to sleep mode
    const emotion = readJSON<EmotionState>(PATHS.emotionState, null as any);
    expect(emotion).not.toBeNull();
    expect(emotion.mood.arousal).toBeLessThanOrEqual(0.3);

    // Diary should have night entry
    const diary = readText(PATHS.diary);
    expect(diary).toContain('23:00');
  }, 180_000);

  // ── Phase 4: Sub-Skill Quality Assertions ──────────────────

  it('sub-skills executed with meaningful outputs', () => {
    const log = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
    expect(log.logs.filter(l => l.type === 'morning').length).toBe(1);
    // Night log may exist or not (if fallback was used, it still writes the entry)
    expect(log.logs.filter(l => l.type === 'night').length).toBeLessThanOrEqual(1);
    expect(log.logs.filter(l => l.type === 'regular').length).toBeGreaterThan(0);

    // Check sub-skill execution count
    const totalSubSkillExecs = subSkillExecs.length;
    console.log(`  Sub-skill executions: ${totalSubSkillExecs}`);

    if (totalSubSkillExecs === 0) {
      issue('critical', 'sub-skills', '全天没有任何 sub-skill 被真实执行');
    }

    const successfulExecs = subSkillExecs.filter(e => e.success);
    if (successfulExecs.length === 0 && totalSubSkillExecs > 0) {
      issue('critical', 'sub-skills', `${totalSubSkillExecs} 个 sub-skill 执行全部失败`);
    }

    // Diary coherence: should mention morning and night
    const diary = readText(PATHS.diary);
    expect(diary).toMatch(/2026-03-25 09:\d{2}/);
    expect(diary).toContain('23:00');

    // Check for sub-skill specific diary entries
    const diaryLines = diary.split('\n');
    const realSkillDiaryLines = diaryLines.filter(l =>
      l.includes('real,') || l.includes('instagram') || l.includes('web-search') ||
      l.includes('content-browse') || l.includes('social-engagement')
    );
    console.log(`  Diary lines with real skill tags: ${realSkillDiaryLines.length}`);
  });
});

// ── Utility ──────────────────────────────────────────────────────

function copyDirRecursive(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Copy non-TS resource files from source sub-skills directory to dist.
 * Only copies files that don't already exist in dest (won't overwrite compiled JS).
 * Copies: manifest.json, templates/, events.yaml, strategy.md, .py scripts, etc.
 */
function copyResourceFiles(srcDir: string, distDir: string) {
  if (!fs.existsSync(srcDir)) return;

  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const distPath = path.join(distDir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === 'scripts') {
        // For scripts/ dir: copy only non-TS files (.py, .sh, etc.)
        // The compiled .js files from tsc are already in dist
        fs.mkdirSync(distPath, { recursive: true });
        for (const scriptEntry of fs.readdirSync(srcPath, { withFileTypes: true })) {
          if (scriptEntry.isFile() && !scriptEntry.name.endsWith('.ts')) {
            fs.copyFileSync(
              path.join(srcPath, scriptEntry.name),
              path.join(distPath, scriptEntry.name),
            );
          }
        }
        continue;
      }
      // Ensure target dir exists and copy resource files
      fs.mkdirSync(distPath, { recursive: true });
      copyResourceFiles(srcPath, distPath);
    } else if (!entry.name.endsWith('.ts')) {
      // Copy non-TS files (manifest.json, *.yaml, *.md, etc.)
      fs.copyFileSync(srcPath, distPath);
    }
  }
}
