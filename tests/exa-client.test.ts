import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exaWebSearch, parseSearchResults, EXA_MCP_ENDPOINT } from '../skill/scripts/exa-client';

// ---------------------------------------------------------------------------
// Helpers — build realistic SSE response bodies
// ---------------------------------------------------------------------------

function makeSseBody(resultText: string): string {
  const envelope = {
    result: {
      content: [{ type: 'text', text: resultText }],
    },
    jsonrpc: '2.0',
    id: 1,
  };
  return `event: message\ndata: ${JSON.stringify(envelope)}\n\n`;
}

function makeErrorBody(message: string): string {
  const envelope = { error: { code: -32000, message }, jsonrpc: '2.0', id: 1 };
  return `event: message\ndata: ${JSON.stringify(envelope)}\n\n`;
}

const SAMPLE_TEXT = `Title: How to do cosplay makeup
Author: Jane Doe
Published Date: 2026-01-01T00:00:00.000Z
URL: https://example.com/cosplay-makeup
Text: Step by step guide to cosplay makeup. Start with a primer, then apply base.

Title: Cosplay tips for beginners
URL: https://example.com/tips
Text: Top tips for beginners entering the world of cosplay.`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('exaWebSearch', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to the correct endpoint with required headers', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(makeSseBody(SAMPLE_TEXT), { status: 200 }));

    await exaWebSearch('cosplay makeup tutorial');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(EXA_MCP_ENDPOINT);
    expect((init.headers as Record<string, string>)['Accept']).toContain('text/event-stream');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe('web_search_exa');
    expect(body.params.arguments.query).toBe('cosplay makeup tutorial');
    expect(body.params.arguments.numResults).toBe(5);
    expect(body.params.arguments.searchType).toBe('auto');
  });

  it('returns parsed results on success', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(makeSseBody(SAMPLE_TEXT), { status: 200 }));

    const results = await exaWebSearch('cosplay makeup tutorial');

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'How to do cosplay makeup',
      url: 'https://example.com/cosplay-makeup',
      snippet: expect.stringContaining('Step by step guide'),
    });
    expect(results[1].title).toBe('Cosplay tips for beginners');
  });

  it('respects custom numResults and searchType', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(makeSseBody(''), { status: 200 }));

    await exaWebSearch('query', 3, 'deep');

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.params.arguments.numResults).toBe(3);
    expect(body.params.arguments.searchType).toBe('deep');
  });

  it('throws on non-200 HTTP status', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 500 }));

    await expect(exaWebSearch('test')).rejects.toThrow('Exa MCP HTTP 500');
  });

  it('throws on Exa-level error in response envelope', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(makeErrorBody('rate limit exceeded'), { status: 200 }));

    await expect(exaWebSearch('test')).rejects.toThrow('Exa error: rate limit exceeded');
  });

  it('throws on timeout (AbortError)', async () => {
    vi.useFakeTimers();
    try {
      fetchSpy.mockImplementationOnce(
        (_url: unknown, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal as AbortSignal | undefined;
            if (signal) {
              signal.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted', 'AbortError'));
              });
            }
          }),
      );

      // Attach the rejects assertion BEFORE advancing timers so the rejection
      // is handled before Node.js considers it unhandled.
      const assertion = expect(exaWebSearch('slow query')).rejects.toMatchObject({ name: 'AbortError' });

      // Now advance past the 25s timeout to trigger AbortController.abort()
      await vi.runAllTimersAsync();

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns empty array when response has no data line', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('event: message\n\n', { status: 200 }));

    const results = await exaWebSearch('test');
    expect(results).toEqual([]);
  });

  it('returns empty array when text block is empty', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(makeSseBody(''), { status: 200 }));

    const results = await exaWebSearch('test');
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseSearchResults — unit tests for the SSE parser
// ---------------------------------------------------------------------------

describe('parseSearchResults', () => {
  it('parses a two-result response', () => {
    const results = parseSearchResults(makeSseBody(SAMPLE_TEXT));
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('How to do cosplay makeup');
    expect(results[0].url).toBe('https://example.com/cosplay-makeup');
    expect(results[0].snippet).toContain('Step by step guide');
    expect(results[1].title).toBe('Cosplay tips for beginners');
  });

  it('truncates snippet to 300 chars', () => {
    const longText = 'x'.repeat(500);
    const body = makeSseBody(`Title: Test\nURL: https://example.com\nText: ${longText}`);
    const results = parseSearchResults(body);
    expect(results[0].snippet.length).toBeLessThanOrEqual(300);
  });

  it('skips chunks without URL', () => {
    const body = makeSseBody('Title: No URL entry\nText: some text\n\nTitle: Has URL\nURL: https://x.com\nText: ok');
    const results = parseSearchResults(body);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Has URL');
  });

  it('handles optional Author and Published Date fields', () => {
    const text = `Title: With Meta\nAuthor: Alice\nPublished Date: 2026-03-01T00:00:00.000Z\nURL: https://example.com\nText: body`;
    const results = parseSearchResults(makeSseBody(text));
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('With Meta');
  });

  it('returns empty array for malformed JSON in data line', () => {
    const results = parseSearchResults('event: message\ndata: not-json\n\n');
    expect(results).toEqual([]);
  });

  it('returns empty array when no data: line present', () => {
    const results = parseSearchResults('event: message\n\n');
    expect(results).toEqual([]);
  });

  it('collapses whitespace in snippet', () => {
    const text = 'Title: T\nURL: https://x.com\nText: word1\n\n\n   word2\n\nword3';
    const results = parseSearchResults(makeSseBody(text));
    expect(results[0].snippet).toBe('word1 word2 word3');
  });
});
