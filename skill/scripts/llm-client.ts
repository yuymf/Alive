// skill/scripts/llm-client.ts
// LLM client with retry logic (Spec §13: retry once, then skip)

interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface LLMResponse {
  content: Array<{ text: string }>;
}

/**
 * Call Anthropic API with structured JSON output expected.
 * Retries once on failure (Spec §13).
 */
export async function callLLM(prompt: string, maxTokens = 1024): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }] as LLMMessage[],
        }),
      });

      if (!res.ok) {
        throw new Error(`API returned ${res.status}: ${await res.text()}`);
      }

      const data = await res.json() as LLMResponse;
      return data.content[0]?.text ?? '';
    } catch (err) {
      if (attempt === 0) {
        console.error(`LLM call failed, retrying in 10s: ${(err as Error).message}`);
        await new Promise(r => setTimeout(r, 10_000));
      } else {
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
    throw new Error(`Could not parse JSON from LLM response: ${text.slice(0, 200)}`);
  }
  return JSON.parse(jsonMatch[1]);
}
