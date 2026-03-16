import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the MCP SDK before importing exa-client
const mockConnect = vi.fn();
const mockCallTool = vi.fn();
const mockClose = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    callTool: mockCallTool,
    close: mockClose,
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

import { exaWebSearch } from '../skill/scripts/exa-client';

describe('exaWebSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
  });

  it('should return parsed search results on success', async () => {
    mockCallTool.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: [
              { title: 'How to do cosplay makeup', url: 'https://example.com/1', snippet: 'Step by step guide...' },
              { title: 'Cosplay tips', url: 'https://example.com/2', snippet: 'Top tips for beginners...' },
            ],
          }),
        },
      ],
    });

    const results = await exaWebSearch('cosplay makeup tutorial');

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'web_search_exa',
      arguments: { query: 'cosplay makeup tutorial', numResults: 5, searchType: 'auto' },
    });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'How to do cosplay makeup',
      url: 'https://example.com/1',
      snippet: 'Step by step guide...',
    });
  });

  it('should call close even when callTool throws', async () => {
    mockCallTool.mockRejectedValue(new Error('MCP error'));

    await expect(exaWebSearch('test query')).rejects.toThrow('MCP error');
    expect(mockClose).toHaveBeenCalled();
  });

  it('should not throw when close fails', async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ results: [] }) }],
    });
    mockClose.mockRejectedValue(new Error('close failed'));

    const results = await exaWebSearch('test');
    expect(results).toEqual([]);
  });

  it('should throw on timeout', async () => {
    mockCallTool.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 15000)));

    await expect(exaWebSearch('slow query')).rejects.toThrow('Exa search timeout');
  }, 15000);

  it('should return empty array when response has no parseable results', async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'not valid json' }],
    });

    const results = await exaWebSearch('test');
    expect(results).toEqual([]);
  });

  it('should respect custom numResults and searchType', async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ results: [] }) }],
    });

    await exaWebSearch('query', 3, 'deep');

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'web_search_exa',
      arguments: { query: 'query', numResults: 3, searchType: 'deep' },
    });
  });
});
