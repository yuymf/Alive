// alive/tests/bilibili-provider.test.ts
// TDD Step 1: Write failing tests for Bilibili Provider

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('BilibiliProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── meta ──────────────────────────────────────────────────

  it('has correct meta information', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { BilibiliProvider } = await import('../scripts/adapters/providers/bilibili-provider');
    const provider = new BilibiliProvider();
    expect(provider.meta.name).toBe('bilibili');
    expect(provider.meta.displayName).toBe('Bilibili');
    expect(provider.meta.type).toBe('social');
  });

  // ── isAvailable ──────────────────────────────────────────

  it('isAvailable returns true when API is reachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const { BilibiliProvider } = await import('../scripts/adapters/providers/bilibili-provider');
    const provider = new BilibiliProvider();
    expect(await provider.isAvailable()).toBe(true);
  });

  it('isAvailable returns false on error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const { BilibiliProvider } = await import('../scripts/adapters/providers/bilibili-provider');
    const provider = new BilibiliProvider();
    expect(await provider.isAvailable()).toBe(false);
  });

  // ── getFeed ──────────────────────────────────────────────

  it('getFeed returns ContentItems from Bilibili trending API', async () => {
    const mockResponse = {
      code: 0,
      data: {
        list: [
          {
            bvid: 'BV1abc123',
            title: '超火的Cosplay视频',
            stat: { view: 100000, like: 5000 },
            owner: { name: '大佬UP' },
            desc: '精彩的cosplay展示',
            pubdate: 1710000000,
          },
          {
            bvid: 'BV2def456',
            title: '动漫推荐合集',
            stat: { view: 50000, like: 2000 },
            owner: { name: '动漫达人' },
            desc: '',
            pubdate: 1710001000,
          },
        ],
      },
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }));

    const { BilibiliProvider } = await import('../scripts/adapters/providers/bilibili-provider');
    const provider = new BilibiliProvider();
    const items = await provider.getFeed();

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual(expect.objectContaining({
      id: 'bilibili_BV1abc123',
      source: 'bilibili',
      title: '超火的Cosplay视频',
      likes: 5000,
      user: '大佬UP',
    }));
    expect(items[0].url).toContain('BV1abc123');
  });

  it('getFeed respects limit option', async () => {
    const mockResponse = {
      code: 0,
      data: {
        list: Array.from({ length: 20 }, (_, i) => ({
          bvid: `BV${i}`,
          title: `Video ${i}`,
          stat: { view: 1000, like: 100 },
          owner: { name: 'user' },
          desc: '',
          pubdate: 1710000000 + i,
        })),
      },
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }));

    const { BilibiliProvider } = await import('../scripts/adapters/providers/bilibili-provider');
    const provider = new BilibiliProvider();
    const items = await provider.getFeed({ limit: 5 });

    expect(items).toHaveLength(5);
  });

  it('getFeed returns empty array on API error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ code: -1, message: 'error' }),
    }));

    const { BilibiliProvider } = await import('../scripts/adapters/providers/bilibili-provider');
    const provider = new BilibiliProvider();
    const items = await provider.getFeed();

    expect(items).toEqual([]);
  });

  it('getFeed returns empty array on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    const { BilibiliProvider } = await import('../scripts/adapters/providers/bilibili-provider');
    const provider = new BilibiliProvider();
    const items = await provider.getFeed();

    expect(items).toEqual([]);
  });

  // ── search ───────────────────────────────────────────────

  it('search returns ContentItems matching keyword', async () => {
    const searchResponse = {
      code: 0,
      data: {
        result: [
          {
            bvid: 'BVsearch1',
            title: 'Cosplay教程',
            play: 30000,
            like: 1500,
            author: '教程达人',
            description: '教你cosplay',
            pubdate: 1710000000,
          },
        ],
      },
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(searchResponse),
    }));

    const { BilibiliProvider } = await import('../scripts/adapters/providers/bilibili-provider');
    const provider = new BilibiliProvider();
    const items = await provider.search('cosplay');

    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].source).toBe('bilibili');
    expect(items[0].title).toContain('Cosplay');
  });

  it('search returns empty array on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('search error')));

    const { BilibiliProvider } = await import('../scripts/adapters/providers/bilibili-provider');
    const provider = new BilibiliProvider();
    const items = await provider.search('anything');

    expect(items).toEqual([]);
  });
});
