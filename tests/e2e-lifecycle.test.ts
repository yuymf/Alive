import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setTimeOverride, clearTimeOverride, now } from '../skill/scripts/time-utils';
import { setBasePaths, resetBasePaths, PATHS, readJSON, writeJSON } from '../skill/scripts/file-utils';
import { runMorningPlan } from '../skill/scripts/morning-plan';
import { regularTick } from '../skill/scripts/heartbeat-tick';
import { runNightReflect } from '../skill/scripts/night-reflect';
import {
  DEFAULT_MOMENTUM, DEFAULT_UNDERTONE,
  DEFAULT_FLOW_STATE, DEFAULT_CHAIN_STATE,
  DEFAULT_POST_IMPULSE,
} from '../skill/scripts/types';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SANDBOX_DIR = path.join(PROJECT_ROOT, 'tests', 'e2e-sandbox');
const SANDBOX_MEMORY = path.join(SANDBOX_DIR, 'memory', 'minase');
const SKILL_DIR = path.join(PROJECT_ROOT, 'skill');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'tests', 'e2e-output');

function initSandbox(): void {
  // Clean up any previous run
  if (fs.existsSync(SANDBOX_DIR)) fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
  if (fs.existsSync(OUTPUT_DIR)) fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });

  // Create directory structure
  for (const dir of [
    SANDBOX_MEMORY,
    path.join(SANDBOX_MEMORY, 'photo-roll'),
    path.join(SANDBOX_MEMORY, 'relations', 'social', 'instagram'),
    path.join(SANDBOX_MEMORY, 'inspiration-refs'),
    OUTPUT_DIR,
    path.join(OUTPUT_DIR, 'state-snapshots'),
    path.join(OUTPUT_DIR, 'images'),
    path.join(OUTPUT_DIR, 'final-state'),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write default state files (from spec Appendix A)
  const defaults: Record<string, unknown> = {
    'emotion-state.json': {
      mood: { valence: 0.3, arousal: 0.5, description: '刚醒来' },
      energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
      last_updated: null, recent_cause: '初始化',
      momentum: { ...DEFAULT_MOMENTUM },
      undertone: { ...DEFAULT_UNDERTONE },
      impulse_history: [],
      consecutive_high_stress: 0,
      threshold_break_cooldown: 0,
    },
    'intent-pool.json': { intents: [], last_updated: null },
    'schedule-today.json': { date: null, rigid: [], flexible: [], generated_by: null },
    'event-queue.json': { events: [], max_size: 50 },
    'heartbeat-log.json': { logs: [], retention_days: 7 },
    'core-wisdom.json': { version: 1, wisdom: [], total_importance_since_reflection: 0 },
    'preferences.json': { cos_characters: [], content_style: [], active_hours: [], social_platforms: [] },
    'aspirations.json': { aspirations: [] },
    'personality-drift.json': { base: 'ESTP', modifiers: [] },
    'post-history.json': { posts: [] },
    'vitality-state.json': { vitality: 80, consecutive_low_days: 0, last_updated: null, last_recovery_date: null },
    'confidence-state.json': { confidence: 1.0, last_updated: null, streak: 0 },
    'post-impulse.json': { ...DEFAULT_POST_IMPULSE, value: 75 },
    'inspiration.json': {
      instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: 0 },
      acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: 0 },
      visual_trends: { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: 0 },
      self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: 0 },
      xiaohongshu_trends: { feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [], saved_inspirations: [], updated_at: 0 },
    },
    'flow-state.json': { ...DEFAULT_FLOW_STATE },
    'pending-chains.json': { ...DEFAULT_CHAIN_STATE },
  };

  for (const [file, data] of Object.entries(defaults)) {
    fs.writeFileSync(path.join(SANDBOX_MEMORY, file), JSON.stringify(data, null, 2));
  }

  // Text files
  fs.writeFileSync(path.join(SANDBOX_MEMORY, 'diary.md'), '# 水瀬の日記\n');
  fs.writeFileSync(path.join(SANDBOX_MEMORY, 'world.md'), '# 世界観察\n\n_水瀬在浏览网络时学到的事情。_\n');

  // Social meta
  fs.writeFileSync(
    path.join(SANDBOX_MEMORY, 'relations', 'social', 'meta.json'),
    JSON.stringify({ instagram_following: [], xiaohongshu_following: [], stats: { core: 0, familiar: 0, cognitive: 0, dormant: 0 } }, null, 2),
  );
}

interface CapturedLogs {
  logs: string[];
  restore: () => void;
}

function captureConsole(): CapturedLogs {
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(`[LOG] ${args.map(String).join(' ')}`);
    origLog(...args);
  };
  console.error = (...args: unknown[]) => {
    logs.push(`[ERR] ${args.map(String).join(' ')}`);
    origErr(...args);
  };
  return { logs, restore: () => { console.log = origLog; console.error = origErr; } };
}

function captureSnapshot(hour: number): void {
  const snapshot: Record<string, unknown> = {};
  const jsonFiles = fs.readdirSync(SANDBOX_MEMORY).filter(f => f.endsWith('.json'));
  for (const file of jsonFiles) {
    try {
      snapshot[file] = JSON.parse(fs.readFileSync(path.join(SANDBOX_MEMORY, file), 'utf8'));
    } catch { /* skip corrupt */ }
  }
  // Also capture diary
  const diaryPath = path.join(SANDBOX_MEMORY, 'diary.md');
  if (fs.existsSync(diaryPath)) {
    snapshot['diary.md'] = fs.readFileSync(diaryPath, 'utf8');
  }
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'state-snapshots', `hour-${String(hour).padStart(2, '0')}.json`),
    JSON.stringify(snapshot, null, 2),
  );
}

interface TickLog {
  hour: number;
  module: string;
  logs: string[];
  duration_ms: number;
  error?: string;
}

async function runSimulation(): Promise<{ tickLogs: TickLog[]; pipelineRanAtLeastOnce: boolean }> {
  const tickLogs: TickLog[] = [];
  let pipelineRanAtLeastOnce = false;
  const today = '2026-06-15'; // Fixed simulated date (a Sunday for free schedule)
  const hours = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];

  for (const hour of hours) {
    const simDate = new Date(`${today}T${String(hour).padStart(2, '0')}:00:00`);
    setTimeOverride(simDate);

    const capture = captureConsole();
    const start = Date.now();
    let module = '';
    let error: string | undefined;

    try {
      if (hour === 7) {
        module = 'morning-plan';
        await runMorningPlan();
      } else if (hour === 23) {
        module = 'night-reflect';
        await runNightReflect();
      } else {
        module = 'regular-tick';
        await regularTick();
      }
    } catch (err) {
      error = (err as Error).message;
      console.error(`Tick hour ${hour} failed: ${error}`);
    }

    capture.restore();
    const duration = Date.now() - start;

    // Check if pipeline ran
    const pipelineLogs = capture.logs.filter(l => l.includes('post-pipeline') || l.includes('REAL ACTION'));
    if (pipelineLogs.length > 0) pipelineRanAtLeastOnce = true;

    tickLogs.push({ hour, module, logs: capture.logs, duration_ms: duration, error });
    captureSnapshot(hour);

    console.log(`--- Hour ${hour} (${module}) completed in ${duration}ms ${error ? `[ERROR: ${error}]` : ''}`);
  }

  // Forced pipeline trigger at end if none ran
  if (!pipelineRanAtLeastOnce) {
    console.log('--- FORCED PIPELINE TRIGGER (no pipeline ran during simulation)');
    setTimeOverride(new Date(`${today}T14:30:00`));
    const capture = captureConsole();
    const start = Date.now();
    try {
      const { runPipeline } = await import('../skill/scripts/post-pipeline');
      await runPipeline();
      pipelineRanAtLeastOnce = true;
    } catch (err) {
      console.error(`Forced pipeline failed: ${(err as Error).message}`);
    }
    capture.restore();
    tickLogs.push({ hour: 14.5, module: 'forced-pipeline', logs: capture.logs, duration_ms: Date.now() - start });
  }

  return { tickLogs, pipelineRanAtLeastOnce };
}

function collectOutput(): void {
  // Copy images from sandbox photo-roll to output
  const photoRoll = path.join(SANDBOX_MEMORY, 'photo-roll');
  if (fs.existsSync(photoRoll)) {
    const dateDirs = fs.readdirSync(photoRoll);
    for (const dateDir of dateDirs) {
      const dirPath = path.join(photoRoll, dateDir);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      for (const file of fs.readdirSync(dirPath)) {
        if (file.endsWith('.png') || file.endsWith('.jpg')) {
          fs.copyFileSync(
            path.join(dirPath, file),
            path.join(OUTPUT_DIR, 'images', file),
          );
        }
      }
    }
  }

  // Copy final state
  const finalDir = path.join(OUTPUT_DIR, 'final-state');
  for (const file of fs.readdirSync(SANDBOX_MEMORY)) {
    const src = path.join(SANDBOX_MEMORY, file);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(finalDir, file));
    }
  }
}

describe('E2E Lifecycle', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeAll(() => {
    // Save and set env vars
    savedEnv = {
      E2E_MOCK_INSTAGRAM: process.env.E2E_MOCK_INSTAGRAM,
      E2E_MOCK_XHS: process.env.E2E_MOCK_XHS,
      E2E_MOCK_CRON: process.env.E2E_MOCK_CRON,
      E2E_INLINE_PIPELINE: process.env.E2E_INLINE_PIPELINE,
    };
    process.env.E2E_MOCK_INSTAGRAM = '1';
    process.env.E2E_MOCK_XHS = '1';
    process.env.E2E_MOCK_CRON = '1';
    process.env.E2E_INLINE_PIPELINE = '1';

    // Load API keys from openclaw config
    try {
      const configPath = path.join(process.env.HOME!, '.openclaw', 'openclaw.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const minaseEnv = config?.skills?.entries?.minase?.env ?? {};
      if (minaseEnv.LLM_API_KEY) process.env.LLM_API_KEY = minaseEnv.LLM_API_KEY;
      if (minaseEnv.LLM_API_BASE) process.env.LLM_API_BASE = minaseEnv.LLM_API_BASE;
      if (minaseEnv.LLM_MODEL) process.env.LLM_MODEL = minaseEnv.LLM_MODEL;
      if (minaseEnv.AIHUBMIX_API_KEY) process.env.AIHUBMIX_API_KEY = minaseEnv.AIHUBMIX_API_KEY;
    } catch {
      console.error('Warning: Could not load openclaw config for API keys');
    }

    initSandbox();
    setBasePaths(SANDBOX_MEMORY, SKILL_DIR);
  });

  afterAll(() => {
    resetBasePaths();
    clearTimeOverride();
    // Restore env
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('runs a full 24-hour lifecycle simulation', async () => {
    const startTime = Date.now();
    const { tickLogs, pipelineRanAtLeastOnce } = await runSimulation();
    const totalDuration = Date.now() - startTime;

    // Collect output
    collectOutput();

    // Write lifecycle log
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'lifecycle-log.json'),
      JSON.stringify({ tickLogs, totalDuration, pipelineRanAtLeastOnce }, null, 2),
    );

    // Count generated images
    const imageFiles = fs.readdirSync(path.join(OUTPUT_DIR, 'images'))
      .filter(f => f.endsWith('.png') || f.endsWith('.jpg'));

    // Basic assertions
    expect(tickLogs.length).toBeGreaterThanOrEqual(17); // 17 hours
    expect(tickLogs.filter(t => !t.error).length).toBeGreaterThanOrEqual(15); // at least 15 succeed

    // Check diary was written
    const diary = fs.readFileSync(path.join(OUTPUT_DIR, 'final-state', 'diary.md'), 'utf8');
    expect(diary.length).toBeGreaterThan(100);

    // Check wisdom was produced (by night reflect)
    const wisdom = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'final-state', 'core-wisdom.json'), 'utf8'));
    expect(wisdom.wisdom.length).toBeGreaterThan(0);

    console.log(`\n=== E2E Summary ===`);
    console.log(`Duration: ${totalDuration}ms`);
    console.log(`Ticks: ${tickLogs.length} (${tickLogs.filter(t => !t.error).length} successful)`);
    console.log(`Images: ${imageFiles.length}`);
    console.log(`Diary length: ${diary.length} chars`);
    console.log(`Wisdom entries: ${wisdom.wisdom.length}`);
    console.log(`Pipeline ran: ${pipelineRanAtLeastOnce}`);
  }, 600_000); // 10 minute timeout
});
