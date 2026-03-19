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
const MAX_RETRY_TOKENS = 32768;

const isDebug = () => process.env.LLM_DEBUG === '1' || process.env.LLM_DEBUG === 'true';

function isAbortError(err: unknown): boolean {
  return Boolean(err) && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

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
 * Options for callLLM.
 * responseFormat maps to the OpenAI `response_format` field.
 *   - { type: 'json_object' }  — forces the model to output valid JSON
 *   - { type: 'json_schema', json_schema: { name, schema } } — structured output with a JSON Schema
 *   - undefined / omitted      — free-form text (default)
 */
export interface CallLLMOptions {
  responseFormat?: ResponseFormat;
  signal?: AbortSignal;
}

export type ResponseFormat =
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name: string; strict?: boolean; schema: Record<string, unknown> } };

/**
 * Call LLM via OpenAI-compatible API.
 * Retries once on failure (Spec §13).
 *
 * Returns { content, finishReason } so callers can detect truncation.
 *
 * Env:
 *   LLM_API_KEY   — required
 *   LLM_API_BASE  — default: https://aihubmix.com/v1
 *   LLM_MODEL     — default: claude-sonnet-4-20250514
 */
export async function callLLM(prompt: string, maxTokens = 16384, caller?: string, options?: CallLLMOptions): Promise<LLMResult> {
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
          ...(options?.responseFormat ? { response_format: options.responseFormat } : {}),
        }),
        signal: options?.signal,
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
      if (options?.signal?.aborted || isAbortError(err)) {
        debugLog('ABORT', `request aborted: ${(err as Error).message}`);
        throw err;
      }

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
 * Handles closed blocks AND unclosed <think> tags anywhere in the text
 * (not just at the start — a previous closed block may precede an unclosed one).
 * Used both for JSON extraction and for logging clean responses.
 */
export function stripThinkBlocks(raw: string): string {
  // 1. Remove all closed <think>...</think> blocks
  let text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // 2. Handle any remaining unclosed <think> tag (anywhere in the text, not just at start).
  //    This happens when the model's reasoning is truncated mid-think.
  const unclosedIdx = text.indexOf('<think>');
  if (unclosedIdx !== -1) {
    // Everything from the unclosed <think> onward is reasoning garbage — drop it
    text = text.slice(0, unclosedIdx).trim();
  }
  return text;
}

/**
 * Repair common LLM JSON formatting issues while preserving semantics.
 * Only targets lightweight syntax issues (missing commas, trailing commas,
 * and raw control characters inside JSON strings).
 */
export function repairJSON(input: string): string {
  if (!input) return input;

  // Pass 1: escape raw control chars inside string literals
  const escapedControlChars: string[] = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escape) {
      escapedControlChars.push(ch);
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escapedControlChars.push(ch);
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      escapedControlChars.push(ch);
      continue;
    }

    if (inString && ch === '\n') {
      escapedControlChars.push('\\n');
      continue;
    }
    if (inString && ch === '\r') {
      escapedControlChars.push('\\r');
      continue;
    }
    if (inString && ch === '\t') {
      escapedControlChars.push('\\t');
      continue;
    }

    escapedControlChars.push(ch);
  }

  const escaped = escapedControlChars.join('');

  // Pass 2: remove trailing commas before } or ] (outside string literals)
  const noTrailingCommas: string[] = [];
  inString = false;
  escape = false;
  for (let i = 0; i < escaped.length; i++) {
    const ch = escaped[i];

    if (escape) {
      noTrailingCommas.push(ch);
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      noTrailingCommas.push(ch);
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      noTrailingCommas.push(ch);
      continue;
    }

    if (!inString && ch === ',') {
      let j = i + 1;
      while (j < escaped.length && /\s/.test(escaped[j])) j++;
      if (j < escaped.length && (escaped[j] === '}' || escaped[j] === ']')) {
        continue;
      }
    }

    noTrailingCommas.push(ch);
  }

  // Pass 3: add missing commas between adjacent values/properties split by newline
  // e.g. {"a": 1\n"b": 2} -> {"a": 1,\n"b": 2}
  return noTrailingCommas
    .join('')
    .replace(
      /("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|\}|\])(\s*\n\s*)(?=")/g,
      '$1,$2',
    );
}

function parseJSONWithRepair<T>(candidate: string): T {
  try {
    return JSON.parse(candidate) as T;
  } catch (parseErr) {
    const repaired = repairJSON(candidate);
    if (repaired === candidate) {
      throw parseErr;
    }

    debugLog('JSON_REPAIR_APPLIED', repaired);
    return JSON.parse(repaired) as T;
  }
}

/**
 * Extract JSON from LLM response text.
 * Strips <think> tags and searches for JSON in code blocks or raw text.
 */
export function extractJSON<T>(raw: string): T {
  const text = stripThinkBlocks(raw);

  // 1. Try code block first (non-greedy is safe here — code fences are unambiguous)
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    debugLog('JSON_PARSED', codeBlockMatch[1]);
    return parseJSONWithRepair<T>(codeBlockMatch[1]);
  }

  // 2. Find the first balanced { ... } or [ ... ] using bracket counting
  const jsonStr = findBalancedJSON(text);
  if (!jsonStr) {
    debugLog('JSON_PARSE_FAIL', `raw response:\n${raw}`);
    throw new Error(`Could not parse JSON from LLM response: ${raw.slice(0, 200)}`);
  }
  debugLog('JSON_PARSED', jsonStr);
  return parseJSONWithRepair<T>(jsonStr);
}

/**
 * Find the first balanced JSON object or array in text using bracket counting.
 * This correctly handles nested braces/brackets unlike regex approaches.
 */
export function findBalancedJSON(text: string): string | null {
  const startIdx = text.search(/[\[{]/);
  if (startIdx === -1) return null;

  const openChar = text[startIdx];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) depth++;
    if (ch === closeChar) depth--;
    if (depth === 0) {
      return text.slice(startIdx, i + 1);
    }
  }
  return null;  // unbalanced
}

/**
 * Call LLM and parse response as JSON.
 * Automatically sets response_format to json_object so the model is
 * constrained to return valid JSON (OpenAI-compatible API feature).
 * Still uses extractJSON as a safety net for models that ignore the format.
 * Auto-retries with doubled maxTokens if response was truncated (finishReason === 'length').
 */
export async function callLLMJSON<T>(prompt: string, maxTokens = 16384, caller?: string, options?: CallLLMOptions): Promise<T> {
  // Default to json_object unless caller explicitly provides a responseFormat
  const effectiveOptions: CallLLMOptions = {
    responseFormat: { type: 'json_object' },
    ...options,
  };
  const result = await callLLM(prompt, maxTokens, caller, effectiveOptions);

  // If truncated due to token limit, retry with doubled budget (capped at MAX_RETRY_TOKENS)
  if (result.finishReason === 'length' && maxTokens < MAX_RETRY_TOKENS) {
    const retryTokens = Math.min(maxTokens * 2, MAX_RETRY_TOKENS);
    console.warn(`[llm-client] Response truncated (finish_reason=length), retrying with maxTokens=${retryTokens}`);
    const retryResult = await callLLM(prompt, retryTokens, caller, effectiveOptions);

    if (retryResult.finishReason === 'length') {
      console.warn(`[llm-client] Retry still truncated (maxTokens=${retryTokens}), attempting parse anyway`);
    }

    return extractJSON<T>(retryResult.content);
  }

  return extractJSON<T>(result.content);
}
