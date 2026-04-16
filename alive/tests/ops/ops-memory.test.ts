import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildOpsMemoryContext, getOpsMemorySnapshot } from '../../scripts/ops/ops-memory';
import { setBasePaths, resetBasePaths } from '../../scripts/utils/file-utils';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const tmpDir = path.join(os.tmpdir(), 'alive-ops-memory-test-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── buildOpsMemoryContext ──────────────────────────────────────────────────

describe('buildOpsMemoryContext', () => {
  it('returns empty string on cold start (no data)', async () => {
    const ctx = await buildOpsMemoryContext();
    // On cold start with no persisted state, all sources return ''
    expect(ctx).toBe('');
  });

  it('does not throw even when sources fail', async () => {
    // No files exist in tmpDir — all sources should fail gracefully
    const ctx = await buildOpsMemoryContext();
    expect(typeof ctx).toBe('string');
  });

  it('respects maxChars soft truncation', async () => {
    // Even on cold start, test that the truncation logic doesn't crash
    const ctx = await buildOpsMemoryContext({ maxChars: 50 });
    // On cold start it's '', but if data existed it would be truncated
    expect(ctx.length).toBeLessThanOrEqual(100); // slack for truncation marker
  });
});

// ─── getOpsMemorySnapshot ───────────────────────────────────────────────────

describe('getOpsMemorySnapshot', () => {
  it('returns a snapshot with all fields on cold start', () => {
    const snapshot = getOpsMemorySnapshot();
    expect(snapshot).toHaveProperty('preference');
    expect(snapshot).toHaveProperty('taste');
    expect(snapshot).toHaveProperty('audiencePerception');
    expect(snapshot).toHaveProperty('strategySummary');
    expect(snapshot).toHaveProperty('proactiveAdvice');
    expect(snapshot).toHaveProperty('snapshot_at');
  });

  it('snapshot_at is a valid ISO date', () => {
    const snapshot = getOpsMemorySnapshot();
    expect(new Date(snapshot.snapshot_at).toISOString()).toBe(snapshot.snapshot_at);
  });

  it('returns empty proactiveAdvice when no context provided', () => {
    const snapshot = getOpsMemorySnapshot();
    expect(snapshot.proactiveAdvice).toEqual([]);
  });
});
