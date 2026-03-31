// e2e/harness/suites/02-heartbeat.test.ts
// Suite 02: 心跳状态变化 — morning-plan + heartbeat-tick 直接调用验证
// Uses in-process execution (like e2e-real-day.ts) instead of child processes

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
import { readMemoryFile } from '../openclaw-driver';
import { markLogPosition, readNewEntries, entriesToInteractions } from '../llm-log-reader';

// Direct imports from alive source (same pattern as e2e/e2e-real-day.ts)
import { setBasePaths, setPersonaName } from '../../../alive/scripts/utils/file-utils';
import { clearPersonaCache } from '../../../alive/scripts/persona/persona-loader';
import { createRealLLMClient } from '../../../alive/scripts/utils/llm-client';
import { setLlmLogPath } from '../../../alive/scripts/utils/llm-client';
import { runMorningPlan } from '../../../alive/scripts/lifecycle/morning-plan';
import { regularTick } from '../../../alive/scripts/lifecycle/heartbeat-tick';
import { loadAndApplyApiKeys } from '../../shared/setup';

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

    // Load API keys from openclaw.json into process.env
    const applied = loadAndApplyApiKeys('alive');
    console.log(`  🔑 Applied ${applied.length} env keys: ${applied.join(', ') || '(none from openclaw.json)'}`);

    // If no LLM_API_KEY from openclaw.json, check if already in env
    if (!process.env.LLM_API_KEY) {
      console.log('  ⚠ LLM_API_KEY not found — heartbeat LLM calls will fail');
    }

    // Set up file-utils to point at real memory/skill directories
    setBasePaths(config.memoryDir, config.skillDir);
    setPersonaName(config.personaSlug);
    clearPersonaCache();

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
    markLogPosition();

    let error: Error | null = null;
    try {
      const llm = createRealLLMClient('harness-morning');
      await runMorningPlan(llm);
    } catch (err) {
      error = err as Error;
      console.log(`  ⚠ morning-plan error: ${error.message}`);
    }

    track('morning-plan completes without fatal error', () => {
      expect(error).toBeNull();
    });

    // Capture LLM interactions from log
    const newEntries = readNewEntries();
    const interactions = entriesToInteractions(newEntries, 'heartbeat');
    for (const interaction of interactions) {
      addInteraction(interaction);
    }

    track(`morning-plan triggered ${newEntries.length} LLM call(s)`, () => {
      expect(newEntries.length).toBeGreaterThan(0);
    });

    // Verify schedule generated
    const schedule = readMemoryFile<{ schedule?: unknown[] }>('schedule-today.json', {});
    track('schedule-today.json has data', () => {
      expect(schedule).toBeDefined();
      expect(Object.keys(schedule).length).toBeGreaterThan(0);
    });

    getContext().snapshots.postMorning = takeSnapshot();
  }, 180_000);

  it('runs heartbeat-tick(s) with state changes', async () => {
    const tickCount = config.tickCount;

    for (let tick = 1; tick <= tickCount; tick++) {
      console.log(`\n  🔄 Running tick ${tick}/${tickCount}...`);

      const beforeTick = takeSnapshot();
      markLogPosition();

      let error: Error | null = null;
      try {
        const llm = createRealLLMClient(`harness-tick-${tick}`);
        await regularTick(llm);
      } catch (err) {
        error = err as Error;
        console.log(`  ⚠ tick ${tick} error: ${error.message}`);
      }

      track(`tick ${tick}: heartbeat-tick completes`, () => {
        expect(error).toBeNull();
      });

      // Capture LLM interactions
      const newEntries = readNewEntries();
      const interactions = entriesToInteractions(newEntries, 'heartbeat');
      for (const interaction of interactions) {
        addInteraction(interaction);
      }

      track(`tick ${tick}: triggered ${newEntries.length} LLM call(s)`, () => {
        // First tick must have LLM calls; subsequent ticks may skip (flow/drift/sleep gate)
        if (tick === 1) {
          expect(newEntries.length).toBeGreaterThan(0);
        } else {
          // Soft check — log but don't fail
          if (newEntries.length === 0) {
            console.log(`  ℹ tick ${tick}: no LLM calls (may have entered flow/drift/sleep)`);
          }
          expect(true).toBe(true);
        }
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

      const hbLog = readMemoryFile<{ logs?: unknown[]; entries?: unknown[] }>('heartbeat-log.json', { logs: [] });
      track(`tick ${tick}: heartbeat-log.json has entries`, () => {
        const logEntries = hbLog.logs ?? hbLog.entries ?? [];
        expect(logEntries.length).toBeGreaterThan(0);
      });

      getContext().snapshots.postTick.push(afterTick);
    }
  }, 360_000);
});
