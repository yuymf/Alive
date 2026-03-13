// skill/scripts/llm-client.ts
// LLM client with retry logic (Spec §13: retry once, then skip)
// Uses OpenAI-compatible API (works with aihubmix, openrouter, etc.)

const DEFAULT_API_BASE = 'https://aihubmix.com/v1';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

const isDebug = () => process.env.LLM_DEBUG === '1' || process.env.LLM_DEBUG === 'true';

function debugLog(label: string, content: string): void {
  if (!isDebug()) return;
  const ts = new Date().toISOString();
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
}

/**
 * Call LLM via OpenAI-compatible API with structured JSON output expected.
 * Retries once on failure (Spec §13).
 *
 * Env:
 *   LLM_API_KEY   — required
 *   LLM_API_BASE  — default: https://aihubmix.com/v1
 *   LLM_MODEL     — default: claude-sonnet-4-20250514
 */
export async function callLLM(prompt: string, maxTokens = 1024): Promise<string> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error('LLM_API_KEY not set');

  const apiBase = (process.env.LLM_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
  const model = process.env.LLM_MODEL || DEFAULT_MODEL;

  debugLog('REQUEST', `model: ${model} | maxTokens: ${maxTokens}\n\n${prompt}`);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const startTime = Date.now();
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
      const elapsed = Date.now() - startTime;
      debugLog('RESPONSE', `elapsed: ${elapsed}ms | attempt: ${attempt + 1}\n\n${content}`);
      return content;
    } catch (err) {
      if (attempt === 0) {
        debugLog('RETRY', `attempt 1 failed: ${(err as Error).message}`);
        console.error(`LLM call failed, retrying in 10s: ${(err as Error).message}`);
        await new Promise(r => setTimeout(r, 10_000));
      } else {
        debugLog('FAIL', `attempt 2 failed: ${(err as Error).message}`);
        throw err;
      }
    }
  }

  throw new Error('LLM call failed after retry');
}

/**
 * Call LLM and parse response as JSON.
 * Extracts JSON from markdown code blocks if present.
 */
export async function callLLMJSON<T>(prompt: string, maxTokens = 1024): Promise<T> {
  const text = await callLLM(prompt, maxTokens);
  // Try to extract JSON from code block or raw text
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!jsonMatch) {
    debugLog('JSON_PARSE_FAIL', `raw response:\n${text}`);
    throw new Error(`Could not parse JSON from LLM response: ${text.slice(0, 200)}`);
  }
  debugLog('JSON_PARSED', jsonMatch[1]);
  return JSON.parse(jsonMatch[1]);
}
