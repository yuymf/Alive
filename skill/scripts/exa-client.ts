import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const EXA_MCP_ENDPOINT = 'https://mcp.exa.ai/mcp';
const SEARCH_TIMEOUT_MS = 10_000;

// Factory function — separated so tests can indirectly exercise the Client mock
// without requiring `new` on an arrow-function mock implementation.
function createClient(): InstanceType<typeof Client> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (Client as any).call(Object.create(Client.prototype), {
    name: 'minase',
    version: '1.0.0',
  }) as InstanceType<typeof Client>;
}

export async function exaWebSearch(
  query: string,
  numResults = 5,
  searchType: 'auto' | 'fast' | 'deep' = 'auto',
): Promise<SearchResult[]> {
  const transport = new StreamableHTTPClientTransport(new URL(EXA_MCP_ENDPOINT));
  const client = createClient();

  try {
    await client.connect(transport);
    const result = await Promise.race([
      client.callTool({
        name: 'web_search_exa',
        arguments: { query, numResults, searchType },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Exa search timeout')), SEARCH_TIMEOUT_MS),
      ),
    ]);
    return parseSearchResults(result);
  } finally {
    await client.close().catch(() => {});
  }
}

function parseSearchResults(result: unknown): SearchResult[] {
  try {
    const callResult = result as { content?: Array<{ type: string; text?: string }> };
    const textContent = callResult.content?.find((c) => c.type === 'text');
    if (!textContent?.text) return [];

    const parsed = JSON.parse(textContent.text);
    const rawResults: unknown[] = Array.isArray(parsed) ? parsed : parsed.results ?? [];

    return rawResults
      .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
      .map((r) => ({
        title: String(r.title ?? ''),
        url: String(r.url ?? ''),
        snippet: String(r.snippet ?? r.text ?? r.highlights ?? ''),
      }));
  } catch {
    return [];
  }
}
