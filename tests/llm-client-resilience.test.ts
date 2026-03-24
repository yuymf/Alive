import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { callLLM, callLLMJSON } from '../skill/scripts/llm-client';

function makeOkResponse(content: string, finishReason: string = 'stop'): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    model: 'test-model',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('llm-client resilience', () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.LLM_API_KEY;

  beforeEach(() => {
    process.env.LLM_API_KEY = 'test-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.LLM_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it('repairs malformed JSON (trailing comma + missing comma) before parsing', async () => {
    const malformed = `\n\`\`\`json\n{\n  "wantToPost": true,\n  "selectedPhotos": ["a.jpg",],\n  "caption": "hello"\n  "hashtags": ["tag1"],\n  "reason": "ok"\n}\n\`\`\``;
    globalThis.fetch = vi.fn().mockResolvedValue(makeOkResponse(malformed));

    const result = await callLLMJSON<{ caption: string; selectedPhotos: string[] }>('prompt');
    expect(result.caption).toBe('hello');
    expect(result.selectedPhotos).toEqual(['a.jpg']);
  });

  it('retries once with correction prompt when first response has no JSON', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(makeOkResponse('<think>先分析一下用户需求...</think>'))
      .mockResolvedValueOnce(makeOkResponse('{"wantToPost":true,"selectedPhotos":["a.jpg"],"caption":"ok","hashtags":["tag"],"reason":"ok"}'));

    const result = await callLLMJSON<{ caption: string }>('prompt');
    expect(result.caption).toBe('ok');
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('passes response_format=json_object when explicitly requested in callLLM', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse('{"ok":true}'));
    globalThis.fetch = fetchMock;

    await callLLM('prompt', 2048, 'unit-test', { type: 'json_object' });

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? '{}'));
    expect(payload.response_format).toEqual({ type: 'json_object' });
  });

  it('passes response_format=json_schema when explicitly requested in callLLM', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse('{"ok":true}'));
    globalThis.fetch = fetchMock;

    await callLLM('prompt', 2048, 'unit-test', {
      type: 'json_schema',
      json_schema: {
        name: 'post_intent',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            caption: { type: 'string' },
          },
          required: ['caption'],
        },
      },
    });

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? '{}'));
    expect(payload.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'post_intent',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            caption: { type: 'string' },
          },
          required: ['caption'],
        },
      },
    });
  });

  it('callLLMJSON sends json_object response_format by default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeOkResponse('{"caption":"ok"}'));
    globalThis.fetch = fetchMock;

    const result = await callLLMJSON<{ caption: string }>('prompt');
    expect(result.caption).toBe('ok');

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? '{}'));
    expect(payload.response_format).toEqual({ type: 'json_object' });
  });
});
