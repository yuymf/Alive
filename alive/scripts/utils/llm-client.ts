// alive/scripts/utils/llm-client.ts
// LLM client interface + real implementation + test doubles.
// Provides both the injectable interface pattern (for engines/sub-skills)
// and a concrete OpenAI-compatible implementation (for host bootstrapping).

import { now, wallNow } from './time-utils';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// === Core Interface ===

/**
 * LLM client interface used by all alive engines and sub-skills.
 *
 * Design decision: The host application (e.g. OpenClaw) injects an LLM client
 * instance at startup. Alive never imports a concrete LLM SDK — this keeps the
 * framework model-agnostic and testable.
 */
export interface LLMClient {
  /**
   * Send a prompt and get a plain-text completion.
   * @param prompt  Full prompt string (system + user merged or separated by host)
   * @param maxTokens  Max tokens for the response (host decides default)
   */
  call(prompt: string, maxTokens?: number): Promise<string>;

  /**
   * Send a prompt and parse the response as JSON of type T.
   * The implementation should handle markdown fences, trailing commas, etc.
   * Throws if the response cannot be parsed.
   */
  callJSON<T>(prompt: string, maxTokens?: number): Promise<T>;
}

// === Options ===

export interface LLMCallOptions {
  /** Override model for this call (e.g. "gpt-4o", "claude-3-opus") */
  model?: string;
  /** Temperature override (0.0 – 2.0) */
  temperature?: number;
  /** System message override */
  system?: string;
  /** Max tokens for the response */
  maxTokens?: number;
  /** OpenAI response_format */
  responseFormat?: ResponseFormat;
  /** Abort signal */
  signal?: AbortSignal;
}

export type ResponseFormat =
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name: string; strict?: boolean; schema: Record<string, unknown> } };

/**
 * Extended LLM client with per-call options.
 * Hosts may implement this for advanced use; engines only depend on LLMClient.
 */
export interface LLMClientExtended extends LLMClient {
  callWithOptions(prompt: string, options: LLMCallOptions): Promise<string>;
  callJSONWithOptions<T>(prompt: string, options: LLMCallOptions): Promise<T>;
}

/** Result from a raw LLM call (includes finish_reason for truncation detection). */
export interface LLMResult {
  content: string;
  finishReason: string;
}

// === Real LLM Implementation (OpenAI-compatible API) ===

import { LLM_CONFIG } from '../config';

const DEFAULT_API_BASE = LLM_CONFIG.DEFAULT_API_BASE;
const DEFAULT_MODEL = LLM_CONFIG.DEFAULT_MODEL;
const MAX_RETRY_TOKENS = LLM_CONFIG.MAX_RETRY_TOKENS;

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

let _llmLogPath: string | null = null;
const LLM_LOG_MAX_BYTES = LLM_CONFIG.LLM_LOG_MAX_BYTES;

function getLlmLogPath(): string {
  if (!_llmLogPath) {
    _llmLogPath = path.join(
      process.env.HOME || '~',
      '.openclaw/workspace/memory/llm-call-log.jsonl'
    );
  }
  return _llmLogPath;
}

/** Override log path for testing. */
export function setLlmLogPath(p: string | null): void {
  _llmLogPath = p;
}

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
    const logPath = getLlmLogPath();
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > LLM_LOG_MAX_BYTES) {
        const backupPath = logPath.replace('.jsonl', '.1.jsonl');
        fs.renameSync(logPath, backupPath);
      }
    } catch {
      // File may not exist yet
    }
    const dir = path.dirname(logPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Silently swallow — never disrupt heartbeat
  }
}

/**
 * Call LLM via OpenAI-compatible API.
 * Retries once on failure.
 *
 * Env:
 *   LLM_API_KEY   — required
 *   LLM_API_BASE  — default: https://aihubmix.com/v1
 *   LLM_MODEL     — default: minimax-m2.5
 */
export async function callLLM(
  prompt: string,
  maxTokens = LLM_CONFIG.DEFAULT_MAX_TOKENS,
  caller?: string,
  options?: LLMCallOptions,
): Promise<LLMResult> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error('LLM_API_KEY not set');

  const apiBase = (process.env.LLM_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
  const model = options?.model || process.env.LLM_MODEL || DEFAULT_MODEL;

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
          messages: [{ role: 'user', content: prompt }],
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
      const cleanContent = stripThinkBlocks(content);
      appendLlmLog({
        id: crypto.randomUUID(),
        timestamp: wallNow().toISOString(),
        caller: caller ?? autoDetectCaller(),
        prompt,
        response: cleanContent,
        elapsed_ms: elapsed,
        input_tokens: data.usage?.prompt_tokens ?? null,
        output_tokens: data.usage?.completion_tokens ?? null,
        finish_reason: finishReason,
        model: data.model ?? model,
        error_message: null,
      });
      return { content: cleanContent, finishReason };
    } catch (err) {
      if (options?.signal?.aborted || isAbortError(err)) {
        debugLog('ABORT', `request aborted: ${(err as Error).message}`);
        throw err;
      }

      if (attempt === 0) {
        debugLog('RETRY', `attempt 1 failed: ${(err as Error).message}`);
        console.error(`LLM call failed, retrying in 10s: ${(err as Error).message}`);
        await new Promise(r => setTimeout(r, LLM_CONFIG.RETRY_DELAY_MS));
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
 * Call LLM and parse response as JSON.
 * Sets response_format to json_object, with auto-retry on truncation.
 */
export async function callLLMJSON<T>(
  prompt: string,
  maxTokens = LLM_CONFIG.DEFAULT_MAX_TOKENS,
  caller?: string,
  options?: LLMCallOptions,
): Promise<T> {
  const effectiveOptions: LLMCallOptions = {
    responseFormat: { type: 'json_object' },
    ...options,
  };
  const result = await callLLM(prompt, maxTokens, caller, effectiveOptions);

  // If truncated, retry with doubled budget (capped)
  if (result.finishReason === 'length' && maxTokens < MAX_RETRY_TOKENS) {
    const retryTokens = Math.min(maxTokens * 2, MAX_RETRY_TOKENS);
    console.warn(`[llm-client] Response truncated, retrying with maxTokens=${retryTokens}`);
    const retryResult = await callLLM(prompt, retryTokens, caller, effectiveOptions);
    if (retryResult.finishReason === 'length') {
      console.warn(`[llm-client] Retry still truncated, attempting parse anyway`);
    }
    return extractJSON<T>(retryResult.content);
  }

  return extractJSON<T>(result.content);
}

// === Factory: Real LLM Client ===

/**
 * Create a real LLM client backed by the OpenAI-compatible API.
 * Use for production; inject into sub-skills via ctx.llm.
 */
export function createRealLLMClient(caller?: string): LLMClient {
  return {
    async call(prompt: string, maxTokens?: number): Promise<string> {
      const result = await callLLM(prompt, maxTokens, caller);
      return result.content;
    },
    async callJSON<T>(prompt: string, maxTokens?: number): Promise<T> {
      return callLLMJSON<T>(prompt, maxTokens, caller);
    },
  };
}

// === Factory for Test Doubles ===

/**
 * Create a mock LLM client that returns canned responses.
 * Useful for unit testing engines and sub-skills without hitting a real API.
 *
 * @example
 * ```ts
 * const llm = createMockLLMClient({
 *   'morning plan': '{"schedule": []}',
 *   default: '{"action": "rest"}',
 * });
 * ```
 */
export function createMockLLMClient(
  responses: Record<string, string> & { default?: string },
): LLMClient {
  function findResponse(prompt: string): string {
    for (const [keyword, response] of Object.entries(responses)) {
      if (keyword === 'default') continue;
      if (prompt.toLowerCase().includes(keyword.toLowerCase())) {
        return response;
      }
    }
    return responses.default ?? '{}';
  }

  return {
    async call(prompt: string): Promise<string> {
      return findResponse(prompt);
    },
    async callJSON<T>(prompt: string): Promise<T> {
      const raw = findResponse(prompt);
      return JSON.parse(raw) as T;
    },
  };
}

// === Text Processing Helpers ===

/**
 * Strip <think>...</think> blocks from LLM output.
 * Handles both closed blocks and unclosed trailing <think> tags.
 */
export function stripThinkBlocks(raw: string): string {
  // 1. Remove all closed <think>...</think> blocks
  let text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // 2. Handle any remaining unclosed <think> tag
  const unclosedIdx = text.indexOf('<think>');
  if (unclosedIdx !== -1) {
    text = text.slice(0, unclosedIdx).trim();
  }
  return text;
}

/**
 * Repair common LLM JSON formatting issues while preserving semantics.
 * Handles: raw control chars in strings, trailing commas, missing commas.
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

    if (inString && ch === '\n') { escapedControlChars.push('\\n'); continue; }
    if (inString && ch === '\r') { escapedControlChars.push('\\r'); continue; }
    if (inString && ch === '\t') { escapedControlChars.push('\\t'); continue; }

    escapedControlChars.push(ch);
  }

  const escaped = escapedControlChars.join('');

  // Pass 2: remove trailing commas before } or ]
  const noTrailingCommas: string[] = [];
  inString = false;
  escape = false;
  for (let i = 0; i < escaped.length; i++) {
    const ch = escaped[i];

    if (escape) { noTrailingCommas.push(ch); escape = false; continue; }
    if (ch === '\\' && inString) { noTrailingCommas.push(ch); escape = true; continue; }
    if (ch === '"') { inString = !inString; noTrailingCommas.push(ch); continue; }

    if (!inString && ch === ',') {
      let j = i + 1;
      while (j < escaped.length && /\s/.test(escaped[j])) j++;
      if (j < escaped.length && (escaped[j] === '}' || escaped[j] === ']')) {
        continue;
      }
    }

    noTrailingCommas.push(ch);
  }

  // Pass 3: add missing commas between adjacent values
  return noTrailingCommas
    .join('')
    .replace(
      /("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|\}|\])(\s*\n\s*)(?=")/g,
      '$1,$2',
    );
}

/**
 * Find the first balanced JSON object or array in text using bracket counting.
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

// === JSON Extraction Helper ===

/**
 * Extract and parse JSON from an LLM response that may contain markdown fences,
 * think blocks, preamble text, or trailing prose.
 *
 * Tries in order:
 * 1. Strip <think> blocks
 * 2. ```json ... ``` fenced block
 * 3. First balanced { ... } or [ ... ] span (bracket counting, not regex)
 * 4. Full string as-is
 */
export function extractJSON<T>(raw: string): T {
  const text = stripThinkBlocks(raw);

  // Try fenced JSON block
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    debugLog('JSON_PARSED', codeBlockMatch[1]);
    return parseJSONWithRepair<T>(codeBlockMatch[1]);
  }

  // Find balanced JSON object/array
  const jsonStr = findBalancedJSON(text);
  if (!jsonStr) {
    debugLog('JSON_PARSE_FAIL', `raw response:\n${raw}`);
    throw new Error(`Could not parse JSON from LLM response: ${raw.slice(0, 200)}`);
  }
  debugLog('JSON_PARSED', jsonStr);
  return parseJSONWithRepair<T>(jsonStr);
}

/**
 * Wrap a basic LLMClient.call into a callJSON that uses extractJSON.
 * Useful when the host only provides a plain `call` method.
 */
export function wrapWithJSONSupport(client: Pick<LLMClient, 'call'>): LLMClient {
  return {
    call: client.call.bind(client),
    async callJSON<T>(prompt: string, maxTokens?: number): Promise<T> {
      const raw = await client.call(prompt, maxTokens);
      return extractJSON<T>(raw);
    },
  };
}
