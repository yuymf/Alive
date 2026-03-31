// e2e/harness/llm-log-reader.ts
// 增量读取 llm-call-log.jsonl — 捕获 heartbeat 期间的引擎侧 LLM 调用

import * as fs from 'fs';
import * as path from 'path';
import type { Interaction, Phase } from './harness-context';

export interface LLMLogEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly caller: string;
  readonly prompt: string;
  readonly response: string | null;
  readonly elapsed_ms: number;
  readonly model: string;
  readonly error_message: string | null;
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly finish_reason?: string;
}

const LOG_PATH = path.join(
  process.env.HOME || '~',
  '.openclaw/workspace/memory/llm-call-log.jsonl',
);

let _lastLineCount = 0;

export function markLogPosition(): number {
  if (!fs.existsSync(LOG_PATH)) return 0;
  const content = fs.readFileSync(LOG_PATH, 'utf8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  _lastLineCount = lines.length;
  return _lastLineCount;
}

export function readNewEntries(): LLMLogEntry[] {
  if (!fs.existsSync(LOG_PATH)) return [];
  const content = fs.readFileSync(LOG_PATH, 'utf8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  const newLines = lines.slice(_lastLineCount);

  const entries: LLMLogEntry[] = [];
  for (const line of newLines) {
    try {
      entries.push(JSON.parse(line) as LLMLogEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

export function entriesToInteractions(entries: LLMLogEntry[], phase: Phase): Interaction[] {
  return entries.map(entry => ({
    timestamp: entry.timestamp,
    source: 'engine-llm' as const,
    phase,
    prompt: entry.prompt,
    response: entry.response ?? '[error: no response]',
    model: entry.model,
    elapsed_ms: entry.elapsed_ms,
    metadata: {
      caller: entry.caller,
      input_tokens: entry.input_tokens,
      output_tokens: entry.output_tokens,
      finish_reason: entry.finish_reason,
      error_message: entry.error_message,
    },
  }));
}
