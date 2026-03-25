import { describe, it, expect, afterEach } from 'vitest';
import { PATHS, setBasePaths, resetBasePaths, readJSON, writeJSON, setPersonaName } from '../scripts/utils/file-utils';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('file-utils path override', () => {
  afterEach(() => resetBasePaths());

  it('PATHS uses default paths when no override set', () => {
    const home = process.env.HOME!;
    expect(PATHS.emotionState).toBe(path.join(home, '.openclaw', 'workspace', 'memory', 'default', 'emotion-state.json'));
  });

  it('PATHS uses overridden memory base after setBasePaths', () => {
    setBasePaths('/tmp/test-memory', '/tmp/test-skill');
    expect(PATHS.emotionState).toBe('/tmp/test-memory/emotion-state.json');
    expect(PATHS.diary).toBe('/tmp/test-memory/diary.md');
  });

  it('PATHS uses overridden skill base for shared skill paths', () => {
    setBasePaths('/tmp/test-memory', '/tmp/test-skill');
    // Shared skill paths should still point to skill base
    expect(PATHS.skillRegistry).toBe('/tmp/test-skill/skill-registry.json');
    expect(PATHS.subSkillsDir).toBe('/tmp/test-skill/sub-skills');
    expect(PATHS.assetsDir).toBe('/tmp/test-skill/assets');
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

describe('persona-sensitive paths should use memory base (not skill base)', () => {
  afterEach(() => resetBasePaths());

  it('PATHS.cronSchedule should point to memory directory, not skill directory', () => {
    setBasePaths('/tmp/test-memory', '/tmp/test-skill');
    expect(PATHS.cronSchedule).toBe('/tmp/test-memory/cron-schedule.json');
  });

  it('PATHS.personaConfig should point to memory directory, not skill directory', () => {
    setBasePaths('/tmp/test-memory', '/tmp/test-skill');
    expect(PATHS.personaConfig).toBe('/tmp/test-memory/persona.yaml');
  });

  it('PATHS.referencesDir should point to memory directory, not skill directory', () => {
    setBasePaths('/tmp/test-memory', '/tmp/test-skill');
    expect(PATHS.referencesDir).toBe('/tmp/test-memory/assets/references');
  });

  it('persona-sensitive paths include personaSlug in default (non-override) mode', () => {
    setPersonaName('minase');
    const home = process.env.HOME!;
    const memBase = path.join(home, '.openclaw', 'workspace', 'memory', 'minase');
    expect(PATHS.cronSchedule).toBe(path.join(memBase, 'cron-schedule.json'));
    expect(PATHS.personaConfig).toBe(path.join(memBase, 'persona.yaml'));
    expect(PATHS.referencesDir).toBe(path.join(memBase, 'assets', 'references'));
    // Reset persona name to avoid affecting other tests
    setPersonaName('default');
  });

  it('two different personas get isolated persona-sensitive paths', () => {
    const home = process.env.HOME!;

    setPersonaName('minase');
    const minaseCron = PATHS.cronSchedule;
    const minaseConfig = PATHS.personaConfig;
    const minaseRefs = PATHS.referencesDir;

    setPersonaName('kanna');
    const kannaCron = PATHS.cronSchedule;
    const kannaConfig = PATHS.personaConfig;
    const kannaRefs = PATHS.referencesDir;

    // Paths should differ between personas
    expect(minaseCron).not.toBe(kannaCron);
    expect(minaseConfig).not.toBe(kannaConfig);
    expect(minaseRefs).not.toBe(kannaRefs);

    // Each should contain the persona name
    expect(minaseCron).toContain('minase');
    expect(kannaCron).toContain('kanna');

    // Reset
    setPersonaName('default');
  });
});
