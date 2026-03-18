/**
 * exa-client.ts
 *
 * Calls the Exa MCP endpoint directly via fetch (no MCP SDK handshake).
 *
 * Why direct fetch instead of MCP SDK Client:
 * - The SDK performs three HTTP round-trips (initialize → initialized → tools/call)
 *   before the actual search, adding ~1.5s latency per call.
 * - mcp.exa.ai is stateless (no mcp-session-id required), so we can POST
 *   tools/call directly without the protocol handshake.
 * - The server returns SSE (text/event-stream) for every response, even
 *   non-streaming ones — we parse the first `data:` line.
 *
 * Response format from Exa:
 *   Content is a single text block where each result looks like:
 *     Title: <title>
 *     URL: <url>
 *     Text: <body text>
 *   Results are separated by the next "Title:" occurrence.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const EXA_MCP_ENDPOINT = 'https://mcp.exa.ai/mcp';

/** Timeout covering full round-trip: connect + server search (~10–12s from Asia) */
const SEARCH_TIMEOUT_MS = 25_000;

export async function exaWebSearch(
  query: string,
  numResults = 5,
  searchType: 'auto' | 'fast' | 'deep' = 'auto',
): Promise<SearchResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(EXA_MCP_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'web_search_exa',
          arguments: { query, numResults, searchType },
        },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Exa MCP HTTP ${response.status}${errBody ? ': ' + errBody.slice(0, 200) : ''}`);
  }

  const body = await response.text();
  return parseSearchResults(body);
}

/**
 * Parse the SSE response body from Exa MCP.
 *
 * The body looks like:
 *   event: message
 *   data: {"result":{"content":[{"type":"text","text":"Title: ...\nURL: ...\nText: ..."}]},...}
 *
 * Each result entry in the text block starts with "Title:" and contains URL and Text fields.
 * Results are separated by the next "Title:" occurrence.
 */
export function parseSearchResults(body: string): SearchResult[] {
  try {
    // Extract the JSON payload from the first `data:` line in the SSE stream
    const dataLine = body.split('\n').find(l => l.startsWith('data:'));
    if (!dataLine) return [];

    const envelope = JSON.parse(dataLine.slice('data:'.length).trim()) as {
      result?: { content?: Array<{ type: string; text?: string }> };
      error?: { message: string };
    };

    if (envelope.error) {
      throw new Error(`Exa error: ${envelope.error.message}`);
    }

    const textBlock = envelope.result?.content?.find(c => c.type === 'text')?.text ?? '';
    if (!textBlock) return [];

    return extractResultsFromText(textBlock);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Exa error:')) throw err;
    // JSON parse or structure errors should be visible, not silently swallowed
    throw new Error(`Exa response parse failed: ${(err as Error).message}`);
  }
}

/**
 * Extract individual results from Exa's plain-text multi-result block.
 *
 * Format per result:
 *   Title: <title>\n
 *   [Author: <author>\n]
 *   [Published Date: <date>\n]
 *   URL: <url>\n
 *   Text: <body>\n
 *
 * We split on "Title:" boundaries and extract Title, URL, and a snippet
 * from Text (first 300 chars to keep diary entries readable).
 */
function extractResultsFromText(text: string): SearchResult[] {
  // Split into per-result chunks using "Title:" as a boundary
  const chunks = text.split(/(?=Title: )/);
  const results: SearchResult[] = [];

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;

    const titleMatch = chunk.match(/^Title:\s*(.+)/m);
    const urlMatch = chunk.match(/^URL:\s*(https?:\/\/\S+)/m);
    const textMatch = chunk.match(/^Text:\s*([\s\S]+)/m);

    if (!titleMatch || !urlMatch) continue;

    const rawSnippet = textMatch ? textMatch[1].trim() : '';
    // Take first 300 chars of body text; strip excess whitespace
    const snippet = rawSnippet.replace(/\s+/g, ' ').slice(0, 300).trim();

    results.push({
      title: titleMatch[1].trim(),
      url: urlMatch[1].trim(),
      snippet,
    });
  }

  return results;
}
