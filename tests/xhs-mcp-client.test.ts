import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('xhs-mcp-client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('isXhsMcpAvailable', () => {
    it('should return true when MCP server responds', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ jsonrpc: '2.0', result: {} }),
      }));
      const { isXhsMcpAvailable } = await import('../skill/scripts/xhs-mcp-client');
      const result = await isXhsMcpAvailable();
      expect(result).toBe(true);
    });

    it('should return false when MCP server is unreachable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
      const { isXhsMcpAvailable } = await import('../skill/scripts/xhs-mcp-client');
      const result = await isXhsMcpAvailable();
      expect(result).toBe(false);
    });
  });

  describe('listXhsFeed', () => {
    it('should parse MCP response into XhsNote array', async () => {
      const mcpResponse = {
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify([
              { id: 'note1', xsec_token: 'tok1', title: 'JK制服穿搭', description: '今日穿搭分享', likes: 2000, user: 'fashionista', tags: ['jk', '穿搭'] },
              { id: 'note2', xsec_token: 'tok2', title: 'Cos妆容教程', description: '简单日常妆', likes: 500, user: 'cosbeauty', tags: ['cos', '妆容'] },
            ]),
          }],
        },
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mcpResponse),
      }));
      const { listXhsFeed } = await import('../skill/scripts/xhs-mcp-client');
      const notes = await listXhsFeed();
      expect(notes).toHaveLength(2);
      expect(notes[0].title).toBe('JK制服穿搭');
      expect(notes[0].likes).toBe(2000);
    });

    it('should throw when MCP returns error', async () => {
      const mcpResponse = {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'Not logged in' },
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mcpResponse),
      }));
      const { listXhsFeed } = await import('../skill/scripts/xhs-mcp-client');
      await expect(listXhsFeed()).rejects.toThrow('Not logged in');
    });
  });

  describe('searchXhsNotes', () => {
    it('should pass keyword as argument to MCP search tool', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          jsonrpc: '2.0', id: 1,
          result: { content: [{ type: 'text', text: '[]' }] },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);
      const { searchXhsNotes } = await import('../skill/scripts/xhs-mcp-client');
      await searchXhsNotes('cosplay');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.params.name).toBe('search');
      expect(body.params.arguments.keyword).toBe('cosplay');
    });
  });

  describe('getXhsNoteDetail', () => {
    it('should pass note_id and xsec_token to MCP', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          jsonrpc: '2.0', id: 1,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                id: 'note1', xsec_token: 'tok1', title: 'Test', description: 'desc',
                likes: 100, user: 'u', tags: [], comments: [], images: [],
                collected_count: 10, share_count: 5,
              }),
            }],
          },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);
      const { getXhsNoteDetail } = await import('../skill/scripts/xhs-mcp-client');
      const detail = await getXhsNoteDetail('note1', 'tok1');
      expect(detail.id).toBe('note1');
      expect(detail.comments).toEqual([]);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.params.name).toBe('get_feed_detail');
      expect(body.params.arguments.note_id).toBe('note1');
    });
  });
});
