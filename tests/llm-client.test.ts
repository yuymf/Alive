import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  stripThinkBlocks,
  extractJSON,
  findBalancedJSON,
  callLLM,
  callLLMJSON,
} from '../skill/scripts/llm-client';

// ──────────────────────────────────────────────────
// Pure-function tests (no mocking needed)
// ──────────────────────────────────────────────────

describe('stripThinkBlocks', () => {
  it('removes a single closed think block', () => {
    expect(stripThinkBlocks('<think>reasoning</think>Hello')).toBe('Hello');
  });

  it('removes multiple closed think blocks', () => {
    const input = '<think>a</think>First<think>b</think>Second';
    expect(stripThinkBlocks(input)).toBe('FirstSecond');
  });

  it('removes multiline think block', () => {
    const input = '<think>\nline1\nline2\n</think>\n{"ok":true}';
    expect(stripThinkBlocks(input)).toBe('{"ok":true}');
  });

  it('handles unclosed think at the START of text', () => {
    expect(stripThinkBlocks('<think>partial reasoning that was cut off')).toBe('');
  });

  it('handles unclosed think in the MIDDLE of text (the fixed bug)', () => {
    const input = '<think>closed</think>{"a":1}<think>unclosed reasoning';
    expect(stripThinkBlocks(input)).toBe('{"a":1}');
  });

  it('handles closed block THEN unclosed block', () => {
    const input = '<think>ok</think>result text<think>truncated';
    expect(stripThinkBlocks(input)).toBe('result text');
  });

  it('returns original text when no think blocks', () => {
    expect(stripThinkBlocks('just plain text')).toBe('just plain text');
  });

  it('handles empty input', () => {
    expect(stripThinkBlocks('')).toBe('');
  });

  it('handles whitespace-only think block', () => {
    expect(stripThinkBlocks('<think>  \n  </think>data')).toBe('data');
  });
});

describe('findBalancedJSON', () => {
  it('finds a simple object', () => {
    expect(findBalancedJSON('{"a":1}')).toBe('{"a":1}');
  });

  it('finds a simple array', () => {
    expect(findBalancedJSON('[1,2,3]')).toBe('[1,2,3]');
  });

  it('finds nested objects', () => {
    const json = '{"a":{"b":{"c":1}}}';
    expect(findBalancedJSON(json)).toBe(json);
  });

  it('finds JSON preceded by text', () => {
    expect(findBalancedJSON('Here is the result: {"ok":true}')).toBe('{"ok":true}');
  });

  it('stops at the first balanced close (ignores trailing text)', () => {
    const input = '{"a":1} and then {"b":2}';
    expect(findBalancedJSON(input)).toBe('{"a":1}');
  });

  it('handles strings with braces inside', () => {
    const json = '{"msg":"hello {world}"}';
    expect(findBalancedJSON(json)).toBe(json);
  });

  it('handles escaped quotes in strings', () => {
    const json = '{"msg":"say \\"hi\\""}';
    expect(findBalancedJSON(json)).toBe(json);
  });

  it('handles escaped backslash before quote', () => {
    // The string value is: path\\  (ending with a backslash)
    // In JSON: "path\\\\"  — but we need the raw text representation
    const json = '{"path":"C:\\\\dir"}';
    expect(findBalancedJSON(json)).toBe(json);
  });

  it('returns null for no JSON', () => {
    expect(findBalancedJSON('no json here')).toBeNull();
  });

  it('returns null for unbalanced braces', () => {
    expect(findBalancedJSON('{"a":1')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(findBalancedJSON('')).toBeNull();
  });

  it('handles array of objects', () => {
    const json = '[{"a":1},{"b":2}]';
    expect(findBalancedJSON(json)).toBe(json);
  });

  it('handles deeply nested mixed brackets', () => {
    const json = '{"arr":[1,{"inner":[2,3]},4]}';
    expect(findBalancedJSON(json)).toBe(json);
  });
});

describe('extractJSON', () => {
  it('extracts JSON from code block', () => {
    const raw = '```json\n{"a":1}\n```';
    expect(extractJSON(raw)).toEqual({ a: 1 });
  });

  it('extracts JSON from code block without json tag', () => {
    const raw = '```\n{"a":1}\n```';
    expect(extractJSON(raw)).toEqual({ a: 1 });
  });

  it('extracts raw JSON object', () => {
    expect(extractJSON('{"a":1}')).toEqual({ a: 1 });
  });

  it('extracts raw JSON array', () => {
    expect(extractJSON('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('extracts JSON preceded by prose', () => {
    const raw = 'Here is my answer:\n{"wantToPost": true, "caption": "hello"}';
    expect(extractJSON(raw)).toEqual({ wantToPost: true, caption: 'hello' });
  });

  it('extracts JSON followed by prose', () => {
    const raw = '{"result": "ok"}\n\nHope this helps!';
    expect(extractJSON(raw)).toEqual({ result: 'ok' });
  });

  it('extracts JSON with think block before it', () => {
    const raw = '<think>let me think</think>\n{"a":1}';
    expect(extractJSON(raw)).toEqual({ a: 1 });
  });

  it('extracts nested JSON correctly (the fixed greedy-regex bug)', () => {
    const raw = '{"outer":{"inner":1}} some extra text with {braces}';
    const result = extractJSON(raw);
    expect(result).toEqual({ outer: { inner: 1 } });
  });

  it('extracts JSON from code block even with think block', () => {
    const raw = '<think>reasoning</think>\n```json\n{"data": [1, 2]}\n```\nDone!';
    expect(extractJSON(raw)).toEqual({ data: [1, 2] });
  });

  it('throws on no JSON', () => {
    expect(() => extractJSON('no json here at all')).toThrow('Could not parse JSON');
  });

  it('throws on invalid JSON', () => {
    expect(() => extractJSON('{invalid json}')).toThrow();
  });

  it('repairs missing comma between properties', () => {
    const raw = '{"wantToShoot": true\n"sceneDescription": "窗边光线很好"}';
    expect(extractJSON(raw)).toEqual({ wantToShoot: true, sceneDescription: '窗边光线很好' });
  });

  it('repairs trailing commas and raw control chars inside string', () => {
    const raw = '{"reason":"line1\nline2\tOK", "shots": [1,2,],}';
    expect(extractJSON(raw)).toEqual({ reason: 'line1\nline2\tOK', shots: [1, 2] });
  });

  it('handles unclosed think then JSON', () => {
    // A closed think block, then JSON, then an unclosed think block
    const raw = '<think>ok</think>{"data":true}<think>oops truncated';
    expect(extractJSON(raw)).toEqual({ data: true });
  });
});

// ──────────────────────────────────────────────────
// Network-level tests (mocking fetch)
// ──────────────────────────────────────────────────

describe('callLLM', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.LLM_API_KEY = 'test-key';
    process.env.LLM_API_BASE = 'https://test.example.com/v1';
    process.env.LLM_MODEL = 'test-model';
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_API_BASE;
    delete process.env.LLM_MODEL;
  });

  function mockFetchOk(content: string, finishReason = 'stop') {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: 'test-model',
      }),
    });
  }

  it('sends request without response_format by default', async () => {
    mockFetchOk('hello');
    await callLLM('test prompt');

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('response_format');
    expect(body.model).toBe('test-model');
    expect(body.messages[0].content).toBe('test prompt');
  });

  it('sends response_format when options.responseFormat is set', async () => {
    mockFetchOk('{"a":1}');
    await callLLM('test', 4096, 'test-caller', {
      responseFormat: { type: 'json_object' },
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('sends json_schema response_format', async () => {
    mockFetchOk('{"name":"test"}');
    const schema = {
      type: 'json_schema' as const,
      json_schema: {
        name: 'test_schema',
        strict: true,
        schema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
    };

    await callLLM('test', 4096, 'test-caller', { responseFormat: schema });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.response_format).toEqual(schema);
    expect(body.response_format.json_schema.name).toBe('test_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
  });

  it('returns content and finishReason', async () => {
    mockFetchOk('result text', 'stop');
    const result = await callLLM('prompt');
    expect(result.content).toBe('result text');
    expect(result.finishReason).toBe('stop');
  });

  it('throws if LLM_API_KEY is not set', async () => {
    delete process.env.LLM_API_KEY;
    await expect(callLLM('test')).rejects.toThrow('LLM_API_KEY not set');
  });

  it('retries once on failure then throws', async () => {
    vi.useFakeTimers();

    fetchSpy
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('still failing'));

    // Capture the promise and attach a catch handler immediately to prevent
    // "unhandled rejection" warnings while fake timers advance
    let caughtError: Error | undefined;
    const promise = callLLM('test').catch((e: Error) => { caughtError = e; });

    // Advance past the 10s retry delay so the promise resolves
    await vi.advanceTimersByTimeAsync(11_000);
    await promise;

    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toBe('still failing');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('does not retry when aborted by signal', async () => {
    const controller = new AbortController();
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchSpy.mockRejectedValueOnce(abortError);

    await expect(callLLM('test', 16384, 'test-caller', { signal: controller.signal })).rejects.toThrow('aborted');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('callLLMJSON', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.LLM_API_KEY = 'test-key';
    process.env.LLM_API_BASE = 'https://test.example.com/v1';
    process.env.LLM_MODEL = 'test-model';
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_API_BASE;
    delete process.env.LLM_MODEL;
  });

  function mockFetchOk(content: string, finishReason = 'stop') {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: 'test-model',
      }),
    });
  }

  it('automatically sends response_format: json_object', async () => {
    mockFetchOk('{"wantToPost":true}');
    await callLLMJSON('test prompt');

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('allows overriding response_format via options', async () => {
    const customSchema = {
      type: 'json_schema' as const,
      json_schema: {
        name: 'post_intent',
        schema: { type: 'object', properties: { wantToPost: { type: 'boolean' } } },
      },
    };
    mockFetchOk('{"wantToPost":false}');
    await callLLMJSON('test', 4096, 'caller', { responseFormat: customSchema });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.response_format).toEqual(customSchema);
  });

  it('parses JSON from response', async () => {
    mockFetchOk('{"count":42,"items":["a","b"]}');
    const result = await callLLMJSON<{ count: number; items: string[] }>('test');
    expect(result).toEqual({ count: 42, items: ['a', 'b'] });
  });

  it('repairs malformed JSON in response before parsing', async () => {
    mockFetchOk('{"wantToShoot": true\n"sceneDescription": "窗边自然光"}');
    const result = await callLLMJSON<{ wantToShoot: boolean; sceneDescription: string }>('test');
    expect(result).toEqual({ wantToShoot: true, sceneDescription: '窗边自然光' });
  });

  it('parses JSON from code block in response', async () => {
    mockFetchOk('Here is the result:\n```json\n{"ok":true}\n```');
    const result = await callLLMJSON<{ ok: boolean }>('test');
    expect(result).toEqual({ ok: true });
  });

  it('strips think blocks before parsing', async () => {
    mockFetchOk('<think>let me think about this</think>\n{"result":"done"}');
    const result = await callLLMJSON<{ result: string }>('test');
    expect(result).toEqual({ result: 'done' });
  });

  it('retries with doubled maxTokens on truncation', async () => {
    // First call: truncated
    mockFetchOk('{"incomplete":', 'length');
    // Second call: complete
    mockFetchOk('{"complete":true}', 'stop');

    const result = await callLLMJSON<{ complete: boolean }>('test', 8192);
    expect(result).toEqual({ complete: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Verify second call has doubled maxTokens
    const body1 = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const body2 = JSON.parse(fetchSpy.mock.calls[1][1].body);
    expect(body1.max_tokens).toBe(8192);
    expect(body2.max_tokens).toBe(16384);

    // Both calls should have response_format
    expect(body1.response_format).toEqual({ type: 'json_object' });
    expect(body2.response_format).toEqual({ type: 'json_object' });
  });

  it('does not retry truncation when already at MAX_RETRY_TOKENS', async () => {
    mockFetchOk('{"data":true}', 'length');
    const result = await callLLMJSON<{ data: boolean }>('test', 32768);
    expect(result).toEqual({ data: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // No retry
  });

  it('throws on unparseable response', async () => {
    mockFetchOk('This is not JSON at all, no braces anywhere');
    await expect(callLLMJSON('test')).rejects.toThrow('Could not parse JSON');
  });
});
