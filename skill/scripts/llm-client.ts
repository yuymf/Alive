// skill/scripts/llm-client.ts
// LLM client with retry logic (Spec §13: retry once, then skip)
// Uses OpenAI-compatible API (works with aihubmix, openrouter, etc.)

import { now, wallNow } from './time-utils';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const LLM_LOG_PATH = path.join(
  process.env.HOME || '~',
  '.openclaw/workspace/memory/minase/llm-call-log.jsonl'
);
const LLM_LOG_MAX_BYTES = 500 * 1024; // 500 KB

function autoDetectCaller(): string {
  try {
    const argv1 = process.argv[1] || '';
    return path.basename(argv1, path.extname(argv1)) || 'unknown';
  } catch {
    return 'unknown';
  }
}

function appendLlmLog(entry: Record<string, unknown>): void {
  try {
    // Rotate if over size limit
    try {
      const stat = fs.statSync(LLM_LOG_PATH);
      if (stat.size > LLM_LOG_MAX_BYTES) {
        const backupPath = LLM_LOG_PATH.replace('.jsonl', '.1.jsonl');
        fs.renameSync(LLM_LOG_PATH, backupPath);
      }
    } catch {
      // File may not exist yet — that's fine
    }
    fs.appendFileSync(LLM_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Silently swallow — never disrupt heartbeat
  }
}

const DEFAULT_API_BASE = 'https://aihubmix.com/v1';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const MAX_RETRY_TOKENS = 16384;

const isDebug = () => process.env.LLM_DEBUG === '1' || process.env.LLM_DEBUG === 'true';

function debugLog(label: string, content: string): void {
  if (!isDebug()) return;
  const ts = now().toISOString();
  const separator = '─'.repeat(60);
  console.error(`\n${separator}`);
  console.error(`[LLM_DEBUG] ${ts} ${label}`);
  console.error(separator);
  console.error(content);
  console.error(separator);
}

interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface OpenAIChatResponse {
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model?: string;
}

export interface LLMResult {
  content: string;
  finishReason: string;
}

/**
 * Call LLM via OpenAI-compatible API with structured JSON output expected.
 * Retries once on failure (Spec §13).
 *
 * Returns { content, finishReason } so callers can detect truncation.
 *
 * Env:
 *   LLM_API_KEY   — required
 *   LLM_API_BASE  — default: https://aihubmix.com/v1
 *   LLM_MODEL     — default: claude-sonnet-4-20250514
 */
export async function callLLM(prompt: string, maxTokens = 1024, caller?: string): Promise<LLMResult> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error('LLM_API_KEY not set');

  const apiBase = (process.env.LLM_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
  const model = process.env.LLM_MODEL || DEFAULT_MODEL;

  debugLog('REQUEST', `model: ${model} | maxTokens: ${maxTokens}\n\n${prompt}`);

  const totalStart = wallNow().getTime();
  let startTime = totalStart;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      startTime = wallNow().getTime();
      const res = await fetch(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }] as LLMMessage[],
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        debugLog('ERROR', `HTTP ${res.status}: ${errText}`);
        throw new Error(`API returned ${res.status}: ${errText}`);
      }

      const data = await res.json() as OpenAIChatResponse;
      const content = data.choices?.[0]?.message?.content ?? '';
      const finishReason = data.choices?.[0]?.finish_reason ?? 'unknown';
      const elapsed = wallNow().getTime() - startTime;
      debugLog('RESPONSE', `elapsed: ${elapsed}ms | attempt: ${attempt + 1} | finish_reason: ${finishReason}\n\n${content}`);
      appendLlmLog({
        id: crypto.randomUUID(),
        timestamp: wallNow().toISOString(),
        caller: caller ?? autoDetectCaller(),
        prompt,
        response: stripThinkBlocks(content),
        elapsed_ms: elapsed,
        input_tokens: data.usage?.prompt_tokens ?? null,
        output_tokens: data.usage?.completion_tokens ?? null,
        finish_reason: finishReason,
        model: data.model ?? process.env.LLM_MODEL ?? model,
        error_message: null,
      });
      return { content, finishReason };
    } catch (err) {
      if (attempt === 0) {
        debugLog('RETRY', `attempt 1 failed: ${(err as Error).message}`);
        console.error(`LLM call failed, retrying in 10s: ${(err as Error).message}`);
        await new Promise(r => setTimeout(r, 10_000));
      } else {
        debugLog('FAIL', `attempt 2 failed: ${(err as Error).message}`);
        appendLlmLog({
          id: crypto.randomUUID(),
          timestamp: wallNow().toISOString(),
          caller: caller ?? autoDetectCaller(),
          prompt,
          response: null,
          elapsed_ms: wallNow().getTime() - totalStart,
          input_tokens: null,
          output_tokens: null,
          finish_reason: 'error',
          model: process.env.LLM_MODEL ?? model,
          error_message: (err as Error).message,
        });
        throw err;
      }
    }
  }

  throw new Error('LLM call failed after retry');
}

/**
 * Strip <think>...</think> blocks from LLM output.
 * Used both for JSON extraction and for logging clean responses.
 */
function stripThinkBlocks(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (text.startsWith('<think>')) {
    text = text.slice('<think>'.length);
  }
  return text;
}

/**
 * Extract JSON from LLM response text.
 * Strips <think> tags and searches for JSON in code blocks or raw text.
 */
function extractJSON<T>(raw: string): T {
  const text = stripThinkBlocks(raw);
  // Try to extract JSON from code block or raw text
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!jsonMatch) {
    debugLog('JSON_PARSE_FAIL', `raw response:\n${raw}`);
    throw new Error(`Could not parse JSON from LLM response: ${raw.slice(0, 200)}`);
  }
  debugLog('JSON_PARSED', jsonMatch[1]);
  return JSON.parse(jsonMatch[1]);
}

/**
 * Call LLM and parse response as JSON.
 * Extracts JSON from markdown code blocks if present.
 * Auto-retries with doubled maxTokens if response was truncated (finishReason === 'length').
 */
export async function callLLMJSON<T>(prompt: string, maxTokens = 1024, caller?: string): Promise<T> {
  const result = await callLLM(prompt, maxTokens, caller);

  // If truncated due to token limit, retry with doubled budget (capped at MAX_RETRY_TOKENS)
  if (result.finishReason === 'length' && maxTokens < MAX_RETRY_TOKENS) {
    const retryTokens = Math.min(maxTokens * 2, MAX_RETRY_TOKENS);
    console.warn(`[llm-client] Response truncated (finish_reason=length), retrying with maxTokens=${retryTokens}`);
    const retryResult = await callLLM(prompt, retryTokens, caller);

    if (retryResult.finishReason === 'length') {
      console.warn(`[llm-client] Retry still truncated (maxTokens=${retryTokens}), attempting parse anyway`);
    }

    return extractJSON<T>(retryResult.content);
  }

  return extractJSON<T>(result.content);
}
