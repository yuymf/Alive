import { describe, it, expect, afterEach } from 'vitest';
import { PATHS, setBasePaths, resetBasePaths, readJSON, writeJSON } from '../skill/scripts/file-utils';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('file-utils path override', () => {
  afterEach(() => resetBasePaths());

  it('PATHS uses default paths when no override set', () => {
    const home = process.env.HOME!;
    expect(PATHS.emotionState).toBe(path.join(home, '.openclaw', 'workspace', 'memory', 'minase', 'emotion-state.json'));
  });

  it('PATHS uses overridden memory base after setBasePaths', () => {
    setBasePaths('/tmp/test-memory', '/tmp/test-skill');
    expect(PATHS.emotionState).toBe('/tmp/test-memory/emotion-state.json');
    expect(PATHS.diary).toBe('/tmp/test-memory/diary.md');
  });

  it('PATHS uses overridden skill base for skill paths', () => {
    setBasePaths('/tmp/test-memory', '/tmp/test-skill');
    expect(PATHS.references).toBe('/tmp/test-skill/assets/references');
    expect(PATHS.cronSchedule).toBe('/tmp/test-skill/cron-schedule.json');
  });

  it('resetBasePaths restores defaults', () => {
    setBasePaths('/tmp/test-memory', '/tmp/test-skill');
    resetBasePaths();
    expect(PATHS.emotionState).toContain('.openclaw');
  });

  it('readJSON and writeJSON work with overridden paths', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minase-test-'));
    setBasePaths(tmpDir, tmpDir);

    writeJSON(PATHS.emotionState, { test: true });
    const result = readJSON<{ test: boolean }>(PATHS.emotionState, { test: false });
    expect(result.test).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('PATHS.photoGallery points to photo-gallery.json', () => {
    setBasePaths('/tmp/test-memory', '/tmp/test-skill');
    expect(PATHS.photoGallery).toBe('/tmp/test-memory/photo-gallery.json');
    resetBasePaths();
  });

  it('PATHS.pendingEngagement returns path ending in pending-engagement.json', () => {
    setBasePaths('/tmp/test-memory', '/tmp/test-skill');
    expect(PATHS.pendingEngagement).toBe('/tmp/test-memory/pending-engagement.json');
    resetBasePaths();
  });

  it('PATHS.outboundHistory returns path ending in outbound-history.json', () => {
    setBasePaths('/tmp/test-memory', '/tmp/test-skill');
    expect(PATHS.outboundHistory).toBe('/tmp/test-memory/outbound-history.json');
    resetBasePaths();
  });
});
