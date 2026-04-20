import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildRunId,
  loadLeaderboard,
  recordRunToLeaderboard,
  saveLeaderboard,
  scoreToSummary,
  snapshotTunablePrompts,
  updateLeaderboard,
  writeRunArtifacts,
  type RunMeta,
  type RunScore,
} from '../../e2e/harness/runs-store';

const tmpDirs: string[] = [];

function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-runs-store-'));
  tmpDirs.push(d);
  return d;
}

function makeScore(fixtureName: string, seed: number, opsScore: number): RunScore {
  return {
    runId: buildRunId(fixtureName, seed),
    fixtureName,
    seed,
    opsScore,
    judges: [
      { judge: 'generation_completed', score: 100, weight: 0.15 },
      { judge: 'judge_composite', score: 80, weight: 0.25 },
    ],
    breakdown: { generationCompleted: 1, judgeComposite: 0.8 },
  };
}

function makeMeta(fixtureName: string, seed: number): RunMeta {
  return {
    runId: buildRunId(fixtureName, seed),
    timestamp: new Date().toISOString(),
    fixtureName,
    seed,
  };
}

describe('runs-store', () => {
  afterEach(() => {
    while (tmpDirs.length > 0) {
      const d = tmpDirs.pop();
      if (d) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('buildRunId encodes fixture + seed + timestamp', () => {
    const id = buildRunId('default-fixture', 3, new Date('2026-03-18T10:20:30Z'));
    expect(id).toContain('default-fixture');
    expect(id).toContain('seed3');
    expect(id.startsWith('2026-03-18T10-20-30')).toBe(true);
  });

  it('writeRunArtifacts creates 6 expected files under runs/<id>/', () => {
    const harness = mkTmp();
    const meta = makeMeta('fx', 0);
    const score = makeScore('fx', 0, 88.5);
    const out = writeRunArtifacts({
      harnessDir: harness,
      meta,
      score,
      diagnostics: '# diag',
      transcript: [{ step: 1, kind: 'operator', content: 'hi' }],
      tunableSnapshot: [{ relativePath: 'ops/x.md', sha256: 'abc', sizeBytes: 3 }],
      llmUsage: { calls: 4, successfulCalls: 4, failedCalls: 0, promptChars: 100, responseChars: 50, elapsedMs: 1000 },
    });
    expect(out.runDir).toContain('runs');
    expect(fs.existsSync(path.join(out.runDir, 'meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(out.runDir, 'score.json'))).toBe(true);
    expect(fs.existsSync(path.join(out.runDir, 'diagnostics.md'))).toBe(true);
    expect(fs.existsSync(path.join(out.runDir, 'transcript.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(out.runDir, 'tunable.snapshot.json'))).toBe(true);
    expect(fs.existsSync(path.join(out.runDir, 'llm-usage.json'))).toBe(true);
    // transcript.jsonl is newline-delimited JSON
    const tContent = fs.readFileSync(path.join(out.runDir, 'transcript.jsonl'), 'utf8');
    expect(JSON.parse(tContent.trim()).step).toBe(1);
  });

  it('snapshotTunablePrompts hashes every file under tunable/prompts/', () => {
    const harness = mkTmp();
    const promptsDir = path.join(harness, 'tunable', 'prompts', 'ops');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'a.md'), 'hello');
    fs.writeFileSync(path.join(promptsDir, 'b.json'), '{}');
    const snap = snapshotTunablePrompts(harness);
    expect(snap.length).toBe(2);
    const paths = snap.map(s => s.relativePath).sort();
    expect(paths).toEqual([path.join('ops', 'a.md'), path.join('ops', 'b.json')].sort());
    expect(snap[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('snapshotTunablePrompts returns [] when directory absent', () => {
    const harness = mkTmp();
    expect(snapshotTunablePrompts(harness)).toEqual([]);
  });

  it('updateLeaderboard sets baseline on first run and tracks best/bestPerFixture', () => {
    const r1 = scoreToSummary(makeMeta('A', 0), makeScore('A', 0, 70));
    const r2 = scoreToSummary(makeMeta('A', 1), makeScore('A', 1, 85));
    const r3 = scoreToSummary(makeMeta('B', 0), makeScore('B', 0, 80));

    let lb = updateLeaderboard({
      version: 1,
      bestPerFixture: {},
      recentRuns: [],
      totalRuns: 0,
      updatedAt: new Date().toISOString(),
    }, r1);
    expect(lb.baselineRun?.runId).toBe(r1.runId);
    expect(lb.bestRun?.runId).toBe(r1.runId);
    expect(lb.bestPerFixture['A'].runId).toBe(r1.runId);

    lb = updateLeaderboard(lb, r2);
    expect(lb.baselineRun?.runId).toBe(r1.runId); // baseline locked
    expect(lb.bestRun?.runId).toBe(r2.runId);
    expect(lb.bestPerFixture['A'].runId).toBe(r2.runId);

    lb = updateLeaderboard(lb, r3);
    expect(lb.bestRun?.runId).toBe(r2.runId); // r2 still best overall
    expect(lb.bestPerFixture['B'].runId).toBe(r3.runId);
    expect(lb.totalRuns).toBe(3);
    expect(lb.recentRuns[0].runId).toBe(r3.runId); // newest first
  });

  it('recordRunToLeaderboard persists JSON and can be reloaded', () => {
    const harness = mkTmp();
    const meta = makeMeta('fx', 0);
    const score = makeScore('fx', 0, 77);
    const lb1 = recordRunToLeaderboard(harness, meta, score);
    expect(lb1.totalRuns).toBe(1);
    expect(fs.existsSync(path.join(harness, 'leaderboard.json'))).toBe(true);

    const reloaded = loadLeaderboard(harness);
    expect(reloaded.totalRuns).toBe(1);
    expect(reloaded.bestRun?.opsScore).toBe(77);
  });

  it('loadLeaderboard returns empty on malformed JSON', () => {
    const harness = mkTmp();
    fs.writeFileSync(path.join(harness, 'leaderboard.json'), 'not-json{{{');
    const lb = loadLeaderboard(harness);
    expect(lb.totalRuns).toBe(0);
    expect(lb.recentRuns).toEqual([]);
  });

  it('saveLeaderboard creates harness dir if missing', () => {
    const harness = path.join(mkTmp(), 'nested', 'deep');
    saveLeaderboard({
      version: 1,
      bestPerFixture: {},
      recentRuns: [],
      totalRuns: 0,
      updatedAt: '2026-01-01T00:00:00Z',
    }, harness);
    expect(fs.existsSync(path.join(harness, 'leaderboard.json'))).toBe(true);
  });
});
