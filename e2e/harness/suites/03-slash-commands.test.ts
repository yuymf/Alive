// e2e/harness/suites/03-slash-commands.test.ts
// Suite 03: 斜杠命令 — 验证 /alive 系列命令返回正确格式和数据

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import { getConfig } from '../harness.config';
import {
  addSuiteResult,
  startTiming,
  endTiming,
} from '../harness-context';
import { runSlashCommand } from '../openclaw-driver';

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

  beforeAll(() => {
    expect(fs.existsSync(config.skillDir), 'Alive skill must be installed').toBe(true);
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
    const result = await runSlashCommand('/alive status');
    track('/alive status: got response', () => {
      expect(result.response.length).toBeGreaterThan(0);
    });
    track('/alive status: contains persona or emotion info', () => {
      const lower = result.response.toLowerCase();
      const hasRelevantContent =
        lower.includes('persona') || lower.includes('emotion') ||
        lower.includes('vitality') || lower.includes('energy') ||
        lower.includes('status') || lower.includes(config.personaSlug);
      expect(hasRelevantContent).toBe(true);
    });
  }, 90_000);

  it('/alive emotion returns emotion data', async () => {
    const result = await runSlashCommand('/alive emotion');
    track('/alive emotion: got response', () => {
      expect(result.response.length).toBeGreaterThan(0);
    });
    track('/alive emotion: contains emotion dimensions', () => {
      const lower = result.response.toLowerCase();
      const emotionTerms = ['valence', 'arousal', 'energy', 'stress', 'creativity', 'sociability', '情绪', '心情'];
      const hasEmotionData = emotionTerms.some(term => lower.includes(term));
      expect(hasEmotionData).toBe(true);
    });
  }, 90_000);

  it('/alive schedule returns schedule data', async () => {
    const result = await runSlashCommand('/alive schedule');
    track('/alive schedule: got response', () => {
      expect(result.response.length).toBeGreaterThan(0);
    });
    track('/alive schedule: contains time-related content', () => {
      const lower = result.response.toLowerCase();
      const timeTerms = ['schedule', '日程', '计划', ':', 'am', 'pm', '时'];
      const hasTimeData = timeTerms.some(term => lower.includes(term));
      expect(hasTimeData).toBe(true);
    });
  }, 90_000);

  it('/alive memory returns memory data', async () => {
    const result = await runSlashCommand('/alive memory');
    track('/alive memory: got response', () => {
      expect(result.response.length).toBeGreaterThan(0);
    });
  }, 90_000);

  it('/alive skills returns sub-skill list', async () => {
    const result = await runSlashCommand('/alive skills');
    track('/alive skills: got response', () => {
      expect(result.response.length).toBeGreaterThan(0);
    });
    track('/alive skills: contains skill names', () => {
      const lower = result.response.toLowerCase();
      const skillTerms = ['instagram', 'voice', 'send-message', 'web-search', 'content', 'skill', '技能'];
      const hasSkillData = skillTerms.some(term => lower.includes(term));
      expect(hasSkillData).toBe(true);
    });
  }, 90_000);

  it('/alive help returns available commands', async () => {
    const result = await runSlashCommand('/alive help');
    track('/alive help: got response', () => {
      expect(result.response.length).toBeGreaterThan(0);
    });
    track('/alive help: lists known commands', () => {
      const lower = result.response.toLowerCase();
      const commands = ['status', 'emotion', 'schedule', 'help'];
      const foundCount = commands.filter(cmd => lower.includes(cmd)).length;
      expect(foundCount).toBeGreaterThanOrEqual(2);
    });
  }, 90_000);
});
