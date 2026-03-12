/**
 * xhs-mcp-client.ts
 * Thin MCP JSON-RPC 2.0 client for xiaohongshu-mcp.
 * Follows the same organizational principle as instagram-bridge-client.ts —
 * a focused client module that other scripts import —
 * but uses HTTP JSON-RPC instead of subprocess execution.
 */

const XHS_MCP_URL = process.env.XHS_MCP_URL ?? 'http://localhost:18060/mcp';
const XHS_MCP_TIMEOUT = 30_000;

let requestId = 1;

export interface XhsNote {
  id: string;
  xsec_token: string;
  title: string;
  description: string;
  likes: number;
  user: string;
  tags: string[];
}

export interface XhsNoteDetail extends XhsNote {
  comments: Array<{ user: string; content: string; likes: number }>;
  images: string[];
  collected_count: number;
  share_count: number;
}

interface McpResponse {
  jsonrpc: string;
  id: number;
  result?: { content: Array<{ type: string; text: string }> };
  error?: { code: number; message: string };
}

async function callXhsMcp(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: toolName, arguments: args },
    id: requestId++,
  });

  const res = await fetch(XHS_MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(XHS_MCP_TIMEOUT),
  });

  const data = await res.json() as McpResponse;
  if (data.error) {
    throw new Error(data.error.message);
  }
  if (!data.result?.content?.[0]?.text) {
    throw new Error('Empty MCP response');
  }
  return JSON.parse(data.result.content[0].text);
}

/** Check if the xiaohongshu-mcp server is reachable. */
export async function isXhsMcpAvailable(): Promise<boolean> {
  try {
    await fetch(XHS_MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 0 }),
      signal: AbortSignal.timeout(5_000),
    });
    return true;
  } catch {
    return false;
  }
}

/** Homepage recommendation feed — different content each call (MCP tool: list_notes). */
export async function listXhsFeed(): Promise<XhsNote[]> {
  const result = await callXhsMcp('list_notes', {});
  return Array.isArray(result) ? result : [];
}

/** Keyword search (MCP tool: search). */
export async function searchXhsNotes(keyword: string): Promise<XhsNote[]> {
  const result = await callXhsMcp('search', { keyword });
  return Array.isArray(result) ? result : [];
}

/** Full note detail with comments (MCP tool: get_feed_detail). */
export async function getXhsNoteDetail(noteId: string, xsecToken: string): Promise<XhsNoteDetail> {
  const result = await callXhsMcp('get_feed_detail', { note_id: noteId, xsec_token: xsecToken });
  return result as XhsNoteDetail;
}
