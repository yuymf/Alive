import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setTimeOverride, clearTimeOverride } from '../skill/scripts/time-utils';
import { setBasePaths, resetBasePaths, PATHS, readJSON, writeJSON } from '../skill/scripts/file-utils';
import { runMorningPlan } from '../skill/scripts/morning-plan';
import { regularTick } from '../skill/scripts/heartbeat-tick';
import { runNightReflect } from '../skill/scripts/night-reflect';
import { runQualityJudge, writeQualitySummary } from './e2e-quality-judge';
import {
  initSandbox, loadApiKeys, applyApiKeys, setupMockEnv, captureConsole,
  SANDBOX_MEMORY, SKILL_DIR, OUTPUT_DIR,
} from './shared/setup';

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
  let restoreEnv: () => void;
  const tickLogs: TickLog[] = [];
  let pipelineRanAtLeastOnce = false;
  const today = '2026-06-15'; // Fixed simulated date (a Sunday for free schedule)

  beforeAll(() => {
    // Set mock environment (includes ImgURL mock)
    restoreEnv = setupMockEnv({
      instagram: true, xhs: true, cron: true,
      inlinePipeline: true, imgurl: true,
    });

    // Load and apply API keys
    const keys = loadApiKeys();
    applyApiKeys(keys, ['IMGURL_TOKEN']);

    // Init sandbox with high post impulse
    initSandbox({ overrides: {} });
    setBasePaths(SANDBOX_MEMORY, SKILL_DIR);
  });

  afterAll(() => {
    resetBasePaths();
    clearTimeOverride();
    restoreEnv();
  });

  it('morning plan (hour 7)', async () => {
    const simDate = new Date(`${today}T07:00:00`);
    setTimeOverride(simDate);

    const capture = captureConsole();
    const start = Date.now();
    let error: string | undefined;

    try {
      await runMorningPlan();
    } catch (err) {
      error = (err as Error).message;
    }
    capture.restore();

    const pipelineLogs = capture.logs.filter(l => l.includes('post-pipeline') || l.includes('REAL ACTION'));
    if (pipelineLogs.length > 0) pipelineRanAtLeastOnce = true;

    tickLogs.push({ hour: 7, module: 'morning-plan', logs: capture.logs, duration_ms: Date.now() - start, error });
    captureSnapshot(7);

    expect(error).toBeUndefined();
  }, 600_000);

  it('regular ticks (8-15)', async () => {
    for (const hour of [8, 9, 10, 11, 12, 13, 14, 15]) {
      const simDate = new Date(`${today}T${String(hour).padStart(2, '0')}:00:00`);
      setTimeOverride(simDate);

      const capture = captureConsole();
      const start = Date.now();
      let error: string | undefined;

      try {
        await regularTick();
      } catch (err) {
        error = (err as Error).message;
        console.error(`Tick hour ${hour} failed: ${error}`);
      }
      capture.restore();

      const pipelineLogs = capture.logs.filter(l => l.includes('post-pipeline') || l.includes('REAL ACTION'));
      if (pipelineLogs.length > 0) pipelineRanAtLeastOnce = true;

      tickLogs.push({ hour, module: 'regular-tick', logs: capture.logs, duration_ms: Date.now() - start, error });
      captureSnapshot(hour);

      console.log(`--- Hour ${hour} (regular-tick) completed in ${Date.now() - start}ms ${error ? `[ERROR: ${error}]` : ''}`);
    }
  }, 3600_000);

  it('regular ticks (16-22)', async () => {
    for (const hour of [16, 17, 18, 19, 20, 21, 22]) {
      const simDate = new Date(`${today}T${String(hour).padStart(2, '0')}:00:00`);
      setTimeOverride(simDate);

      const capture = captureConsole();
      const start = Date.now();
      let error: string | undefined;

      try {
        await regularTick();
      } catch (err) {
        error = (err as Error).message;
        console.error(`Tick hour ${hour} failed: ${error}`);
      }
      capture.restore();

      const pipelineLogs = capture.logs.filter(l => l.includes('post-pipeline') || l.includes('REAL ACTION'));
      if (pipelineLogs.length > 0) pipelineRanAtLeastOnce = true;

      tickLogs.push({ hour, module: 'regular-tick', logs: capture.logs, duration_ms: Date.now() - start, error });
      captureSnapshot(hour);

      console.log(`--- Hour ${hour} (regular-tick) completed in ${Date.now() - start}ms ${error ? `[ERROR: ${error}]` : ''}`);
    }
  }, 3600_000);

  it('night reflection (hour 23)', async () => {
    const simDate = new Date(`${today}T23:00:00`);
    setTimeOverride(simDate);

    const capture = captureConsole();
    const start = Date.now();
    let error: string | undefined;

    try {
      await runNightReflect();
    } catch (err) {
      error = (err as Error).message;
    }
    capture.restore();

    tickLogs.push({ hour: 23, module: 'night-reflect', logs: capture.logs, duration_ms: Date.now() - start, error });
    captureSnapshot(23);

    expect(error).toBeUndefined();
  }, 600_000);

  it('pipeline triggered (forced if needed)', async () => {
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

    // Collect output
    collectOutput();

    // Write lifecycle log
    const totalDuration = tickLogs.reduce((sum, t) => sum + t.duration_ms, 0);
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'lifecycle-log.json'),
      JSON.stringify({ tickLogs, totalDuration, pipelineRanAtLeastOnce }, null, 2),
    );

    // Basic assertions
    expect(tickLogs.length).toBeGreaterThanOrEqual(11); // at least morning + 8-15 + night
    expect(tickLogs.filter(t => !t.error).length).toBeGreaterThanOrEqual(10);

    // Check diary was written
    const diary = fs.readFileSync(path.join(OUTPUT_DIR, 'final-state', 'diary.md'), 'utf8');
    expect(diary.length).toBeGreaterThan(100);

    // Check wisdom was produced (by night reflect)
    const wisdom = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'final-state', 'core-wisdom.json'), 'utf8'));
    expect(wisdom.wisdom.length).toBeGreaterThan(0);

    const imageFiles = fs.readdirSync(path.join(OUTPUT_DIR, 'images'))
      .filter(f => f.endsWith('.png') || f.endsWith('.jpg'));

    console.log(`\n=== E2E Summary ===`);
    console.log(`Duration: ${totalDuration}ms`);
    console.log(`Ticks: ${tickLogs.length} (${tickLogs.filter(t => !t.error).length} successful)`);
    console.log(`Images: ${imageFiles.length}`);
    console.log(`Diary length: ${diary.length} chars`);
    console.log(`Wisdom entries: ${wisdom.wisdom.length}`);
    console.log(`Pipeline ran: ${pipelineRanAtLeastOnce}`);
  }, 600_000);

  it('quality judge', async () => {
    console.log('\n=== Running Quality Judge ===');
    const qualityReport = await runQualityJudge(OUTPUT_DIR);

    // Write reports
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'quality-report.json'),
      JSON.stringify(qualityReport, null, 2),
    );
    writeQualitySummary(qualityReport, OUTPUT_DIR);

    console.log(`Quality: ${qualityReport.overall_pass ? 'PASS' : 'FAIL'}`);
    console.log(`  Image: ${qualityReport.image_consistency.pass ? 'PASS' : 'FAIL'}`);
    console.log(`  Emotion: ${qualityReport.emotion_dynamics.pass ? 'PASS' : 'FAIL'}`);
    console.log(`  Memory: ${qualityReport.memory_quality.pass ? 'PASS' : 'FAIL'}`);
    if (qualityReport.diagnosis) console.log(`  Diagnosis: ${qualityReport.diagnosis}`);
  }, 1200_000);
});
