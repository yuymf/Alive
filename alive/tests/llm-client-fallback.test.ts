import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Dynamic import so the mock is in place first
let callLLM: typeof import('../scripts/utils/llm-client').callLLM;
let callLLMJSON: typeof import('../scripts/utils/llm-client').callLLMJSON;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  delete process.env.LLM_API_KEY;
  delete process.env.OPENCLAW_GATEWAY_URL;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.OPENCLAW_AGENT;
  delete process.env.ALIVE_PERSONA;
  ({ callLLM, callLLMJSON } = await import('../scripts/utils/llm-client'));
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LLM_API_KEY;
  delete process.env.OPENCLAW_GATEWAY_URL;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.OPENCLAW_AGENT;
  delete process.env.ALIVE_PERSONA;
});

describe('llm-client openclaw gateway fallback', () => {
  it('calls Gateway HTTP API when LLM_API_KEY is absent', async () => {
    delete process.env.LLM_API_KEY;

    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'chatcmpl_test',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello from gateway' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const result = await callLLM('say hello', 'test');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('127.0.0.1:18789/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('openclaw/main');
    expect(result.content).toBe('hello from gateway');
    expect(result.finishReason).toBe('stop');
  });

  it('routes to correct agent based on ALIVE_PERSONA', async () => {
    delete process.env.LLM_API_KEY;
    process.env.ALIVE_PERSONA = 'miss-v';

    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'chatcmpl_test',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: '嗨' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await callLLM('say hello', 'test');

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.model).toBe('openclaw/miss-v');
  });

  it('maps "default" persona to "main" agent', async () => {
    delete process.env.LLM_API_KEY;
    process.env.ALIVE_PERSONA = 'default';

    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'chatcmpl_test',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await callLLM('say hello', 'test');

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.model).toBe('openclaw/main');
  });

  it('OPENCLAW_AGENT takes priority over ALIVE_PERSONA', async () => {
    delete process.env.LLM_API_KEY;
    process.env.OPENCLAW_AGENT = 'miss-v';
    process.env.ALIVE_PERSONA = 'main';

    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'chatcmpl_test',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    await callLLM('say hello', 'test');

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.model).toBe('openclaw/miss-v');
  });

  it('callLLMJSON fallback parses JSON from gateway response', async () => {
    delete process.env.LLM_API_KEY;

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'chatcmpl_test',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: '```json\n{"action":"rest"}\n```' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const result = await callLLMJSON<{ action: string }>('decide', 'test');
    expect(result.action).toBe('rest');
  });

  it('retries once on gateway failure', async () => {
    delete process.env.LLM_API_KEY;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(global, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any; });

    const mockFetch = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          id: 'chatcmpl_test',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );

    const result = await callLLM('say hello', 'test');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('recovered');
  });

  it('still uses direct API path when LLM_API_KEY is set', async () => {
    process.env.LLM_API_KEY = 'test-key';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(global, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any; });
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));

    await expect(callLLM('say hello', 'test')).rejects.toThrow();
    // Should call external API, not gateway
    const [url] = mockFetch.mock.calls[0] as [string, unknown];
    expect(url).not.toContain('127.0.0.1:18789');
  });
});
