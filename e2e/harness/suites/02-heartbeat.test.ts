// e2e/harness/suites/02-heartbeat.test.ts
// Suite 02: 心跳状态变化 — morning-plan + heartbeat-tick 执行后验证

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import { getConfig } from '../harness.config';
import {
  getContext,
  addSuiteResult,
  addInteraction,
  startTiming,
  endTiming,
  takeSnapshot,
} from '../harness-context';
import { runLifecycleScript, readMemoryFile } from '../openclaw-driver';
import { markLogPosition, readNewEntries, entriesToInteractions } from '../llm-log-reader';

describe('02-Heartbeat', () => {
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
    expect(
      fs.existsSync(config.skillDir),
      'Alive skill must be installed (run Suite 01 first)',
    ).toBe(true);
    startTiming('02-heartbeat');
  });

  afterAll(() => {
    const durationMs = endTiming('02-heartbeat');
    addSuiteResult({
      name: '02-Heartbeat',
      status: assertionsPassed === assertionsTotal ? 'pass' : 'fail',
      durationMs,
      assertionsPassed,
      assertionsTotal,
    });
  });

  it('runs morning-plan successfully', async () => {
    const beforeSnapshot = takeSnapshot();
    markLogPosition();

    const result = await runLifecycleScript('morning-plan');
    track('morning-plan exits successfully', () => {
      expect(result.success).toBe(true);
    });

    const newEntries = readNewEntries();
    const interactions = entriesToInteractions(newEntries, 'heartbeat');
    for (const interaction of interactions) {
      addInteraction(interaction);
    }

    track(`morning-plan triggered ${newEntries.length} LLM call(s)`, () => {
      expect(newEntries.length).toBeGreaterThan(0);
    });

    const schedule = readMemoryFile<{ schedule?: unknown[] }>('schedule-today.json', {});
    track('schedule-today.json has schedule items', () => {
      expect(schedule.schedule).toBeDefined();
      expect(Array.isArray(schedule.schedule)).toBe(true);
    });

    getContext().snapshots.postMorning = takeSnapshot();
  }, 180_000);

  it('runs heartbeat-tick(s) with state changes', async () => {
    const tickCount = config.tickCount;

    for (let tick = 1; tick <= tickCount; tick++) {
      console.log(`\n  🔄 Running tick ${tick}/${tickCount}...`);

      const beforeTick = takeSnapshot();
      markLogPosition();

      const result = await runLifecycleScript('heartbeat-tick');
      track(`tick ${tick}: heartbeat-tick exits successfully`, () => {
        expect(result.success).toBe(true);
      });

      const newEntries = readNewEntries();
      const interactions = entriesToInteractions(newEntries, 'heartbeat');
      for (const interaction of interactions) {
        addInteraction(interaction);
      }

      track(`tick ${tick}: triggered ${newEntries.length} LLM call(s)`, () => {
        expect(newEntries.length).toBeGreaterThan(0);
      });

      const afterTick = takeSnapshot();
      track(`tick ${tick}: emotion-state.json changed`, () => {
        const before = JSON.stringify(beforeTick.emotionState);
        const after = JSON.stringify(afterTick.emotionState);
        expect(after).not.toBe(before);
      });

      track(`tick ${tick}: diary.md has new content`, () => {
        expect(afterTick.diary.length).toBeGreaterThan(beforeTick.diary.length);
      });

      const hbLog = readMemoryFile<{ entries?: unknown[] }>('heartbeat-log.json', { entries: [] });
      track(`tick ${tick}: heartbeat-log.json has entries`, () => {
        expect((hbLog.entries ?? []).length).toBeGreaterThan(0);
      });

      getContext().snapshots.postTick.push(afterTick);
    }
  }, 360_000);
});
