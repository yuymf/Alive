// e2e/harness/suites/03-slash-commands.test.ts
// Suite 03: 斜杠命令 — 直接调用 command-handler 验证 /alive 系列命令

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import { getConfig } from '../harness.config';
import {
  addSuiteResult,
  addInteraction,
  startTiming,
  endTiming,
} from '../harness-context';
import { setBasePaths, setPersonaName } from '../../../alive/scripts/utils/file-utils';
import { clearPersonaCache } from '../../../alive/scripts/persona/persona-loader';
import { dispatch } from '../../../alive/scripts/admin/command-handler';

describe('03-Slash Commands', () => {
  const config = getConfig();
  let assertionsPassed = 0;
  let assertionsTotal = 0;

  function track(name: string, fn: () => void): void {
    assertionsTotal++;
    try {
      fn();
      assertionsPassed++;
      console.log(`  ✅ ${name}`);
    } catch (err) {
      console.log(`  ❌ ${name}: ${(err as Error).message}`);
      throw err;
    }
  }

  async function runCommand(raw: string): Promise<string> {
    const result = await dispatch(raw);
    const response = result.output || result.message || JSON.stringify(result);

    addInteraction({
      timestamp: new Date().toISOString(),
      source: 'slash-command',
      phase: 'slash',
      prompt: raw,
      response,
    });

    return response;
  }

  beforeAll(() => {
    expect(fs.existsSync(config.skillDir), 'Alive skill must be installed').toBe(true);
    // Set up file-utils for command-handler to read memory files
    setBasePaths(config.memoryDir, config.skillDir);
    setPersonaName(config.personaSlug);
    clearPersonaCache();
    startTiming('03-slash');
  });

  afterAll(() => {
    const durationMs = endTiming('03-slash');
    addSuiteResult({
      name: '03-Slash Commands',
      status: assertionsPassed === assertionsTotal ? 'pass' : 'fail',
      durationMs,
      assertionsPassed,
      assertionsTotal,
    });
  });

  it('/alive status returns persona info', async () => {
    const response = await runCommand('status');
    track('/alive status: got response', () => {
      expect(response.length).toBeGreaterThan(0);
    });
    track('/alive status: contains relevant data', () => {
      const lower = response.toLowerCase();
      const hasRelevantContent =
        lower.includes('persona') || lower.includes('emotion') ||
        lower.includes('vitality') || lower.includes('energy') ||
        lower.includes('status') || lower.includes(config.personaSlug) ||
        lower.includes('水瀬') || lower.includes('minase');
      expect(hasRelevantContent).toBe(true);
    });
  }, 30_000);

  it('/alive emotion returns emotion data', async () => {
    const response = await runCommand('emotion');
    track('/alive emotion: got response', () => {
      expect(response.length).toBeGreaterThan(0);
    });
    track('/alive emotion: contains emotion dimensions', () => {
      const lower = response.toLowerCase();
      const emotionTerms = ['valence', 'arousal', 'energy', 'stress', 'creativity', 'sociability', '情绪', '心情', 'mood'];
      const hasEmotionData = emotionTerms.some(term => lower.includes(term));
      expect(hasEmotionData).toBe(true);
    });
  }, 30_000);

  it('/alive schedule returns schedule data', async () => {
    const response = await runCommand('schedule');
    track('/alive schedule: got response', () => {
      expect(response.length).toBeGreaterThan(0);
    });
  }, 30_000);

  it('/alive memory returns memory data', async () => {
    const response = await runCommand('memory');
    track('/alive memory: got response', () => {
      expect(response.length).toBeGreaterThan(0);
    });
  }, 30_000);

  it('/alive skills returns sub-skill list', async () => {
    const response = await runCommand('skills');
    track('/alive skills: got response', () => {
      expect(response.length).toBeGreaterThan(0);
    });
  }, 30_000);

  it('/alive help returns available commands', async () => {
    const response = await runCommand('help');
    track('/alive help: got response', () => {
      expect(response.length).toBeGreaterThan(0);
    });
    track('/alive help: lists known commands', () => {
      const lower = response.toLowerCase();
      const commands = ['status', 'emotion', 'schedule', 'help'];
      const foundCount = commands.filter(cmd => lower.includes(cmd)).length;
      expect(foundCount).toBeGreaterThanOrEqual(2);
    });
  }, 30_000);
});
