// e2e/harness/harness-context.ts
// 共享上下文 — 收集交互记录、状态快照、阶段计时

import * as fs from 'fs';
import { getConfig, type HarnessConfig } from './harness.config';

// === Types ===

export type InteractionSource = 'engine-llm' | 'session-stdout' | 'slash-command' | 'chat';
export type Phase = 'install' | 'heartbeat' | 'slash' | 'chat' | 'cleanup';

export interface Interaction {
  readonly timestamp: string;
  readonly source: InteractionSource;
  readonly phase: Phase;
  readonly prompt?: string;
  readonly response: string;
  readonly model?: string;
  readonly elapsed_ms?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface StateSnapshot {
  readonly timestamp: string;
  readonly emotionState: unknown;
  readonly intentPool: unknown;
  readonly diary: string;
  readonly scheduleToday: unknown;
  readonly heartbeatLog: unknown;
  readonly coreWisdom: unknown;
}

export interface SuiteResult {
  readonly name: string;
  readonly status: 'pass' | 'fail' | 'review' | 'skip';
  readonly durationMs: number;
  readonly assertionsPassed: number;
  readonly assertionsTotal: number;
  readonly error?: string;
}

export interface TimingEntry {
  readonly start: number;
  readonly end: number;
}

export interface HarnessContext {
  readonly config: HarnessConfig;
  readonly interactions: Interaction[];
  readonly suiteResults: SuiteResult[];
  readonly snapshots: {
    preInstall: StateSnapshot | null;
    postInstall: StateSnapshot | null;
    postMorning: StateSnapshot | null;
    postTick: StateSnapshot[];
  };
  readonly timings: Record<string, TimingEntry>;
}

// === Singleton ===

let _ctx: HarnessContext | null = null;

export function getContext(): HarnessContext {
  if (!_ctx) {
    _ctx = {
      config: getConfig(),
      interactions: [],
      suiteResults: [],
      snapshots: {
        preInstall: null,
        postInstall: null,
        postMorning: null,
        postTick: [],
      },
      timings: {},
    };
  }
  return _ctx;
}

export function resetContext(): void {
  _ctx = null;
}

// === Helpers ===

export function addInteraction(interaction: Interaction): void {
  getContext().interactions.push(interaction);
}

export function addSuiteResult(result: SuiteResult): void {
  getContext().suiteResults.push(result);
}

export function startTiming(label: string): void {
  const ctx = getContext();
  (ctx.timings as Record<string, TimingEntry>)[label] = {
    start: Date.now(),
    end: 0,
  };
}

export function endTiming(label: string): number {
  const ctx = getContext();
  const entry = ctx.timings[label];
  if (!entry) return 0;
  const end = Date.now();
  (ctx.timings as Record<string, TimingEntry>)[label] = {
    ...entry,
    end,
  };
  return end - entry.start;
}

export function takeSnapshot(): StateSnapshot {
  const { memoryDir } = getContext().config;
  const readSafe = (file: string, fallback: unknown = null) => {
    const p = `${memoryDir}/${file}`;
    if (!fs.existsSync(p)) return fallback;
    try {
      const raw = fs.readFileSync(p, 'utf8');
      return file.endsWith('.json') ? JSON.parse(raw) : raw;
    } catch {
      return fallback;
    }
  };

  return {
    timestamp: new Date().toISOString(),
    emotionState: readSafe('emotion-state.json', {}),
    intentPool: readSafe('intent-pool.json', { intents: [] }),
    diary: readSafe('diary.md', '') as string,
    scheduleToday: readSafe('schedule-today.json', {}),
    heartbeatLog: readSafe('heartbeat-log.json', { entries: [] }),
    coreWisdom: readSafe('core-wisdom.json', []),
  };
}
