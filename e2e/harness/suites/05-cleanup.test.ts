// e2e/harness/suites/05-cleanup.test.ts
// Suite 05: 卸载清理 — 验证卸载并生成最终报告

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import { getConfig } from '../harness.config';
import {
  addSuiteResult,
  startTiming,
  endTiming,
} from '../harness-context';
import { uninstall, listCrons } from '../openclaw-driver';
import { writeReport } from '../reporter';

describe('05-Cleanup', () => {
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
    startTiming('05-cleanup');
  });

  afterAll(() => {
    const durationMs = endTiming('05-cleanup');
    addSuiteResult({
      name: '05-Cleanup',
      status: assertionsPassed === assertionsTotal ? 'pass' : 'fail',
      durationMs,
      assertionsPassed,
      assertionsTotal,
    });

    try {
      const reportPath = writeReport();
      console.log(`\n  📋 Final report: ${reportPath}`);
    } catch (err) {
      console.error(`  ⚠ Report generation failed: ${(err as Error).message}`);
    }
  });

  it('uninstalls alive skill', async () => {
    const result = await uninstall(config.persona);
    track('uninstall exits with code 0', () => {
      expect(result.exitCode).toBe(0);
    });
  }, 30_000);

  it('cron jobs are removed', () => {
    const cronOutput = listCrons();
    const slug = config.personaSlug;
    track('no alive cron jobs remain', () => {
      expect(cronOutput).not.toContain(`alive:${slug}:morning`);
      expect(cronOutput).not.toContain(`alive:${slug}:tick`);
      expect(cronOutput).not.toContain(`alive:${slug}:night`);
    });
  });

  it('skill directory is cleaned', () => {
    track('skill directory removed', () => {
      expect(fs.existsSync(config.skillDir)).toBe(false);
    });
  });

  it('memory directory is preserved', () => {
    track('memory directory still exists', () => {
      expect(fs.existsSync(config.memoryDir)).toBe(true);
    });
  });
});
