// alive/tests/dailyhot-provider.test.ts
// TDD Step 1: Write failing tests for DailyHotApi Provider

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('DailyHotApiProvider', () => {
  const MOCK_API_URL = 'https://dailyhot.example.com';

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DAILYHOT_API_URL;
  });

  // ── meta ──────────────────────────────────────────────────

  it('has correct meta information', async () => {
    const { DailyHotApiProvider } = await import('../scripts/adapters/providers/dailyhot-provider');
    const provider = new DailyHotApiProvider();
    expect(provider.meta.name).toBe('dailyhot');
    expect(provider.meta.displayName).toBe('DailyHot');
    expect(provider.meta.type).toBe('aggregator');
  });

  // ── isAvailable ──────────────────────────────────────────

  it('isAvailable returns true when API is reachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ code: 200 }),
    }));
    const { DailyHotApiProvider } = await import('../scripts/adapters/providers/dailyhot-provider');
    const provider = new DailyHotApiProvider();
    expect(await provider.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when API returns error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }));
    const { DailyHotApiProvider } = await import('../scripts/adapters/providers/dailyhot-provider');
    const provider = new DailyHotApiProvider();
    expect(await provider.isAvailable()).toBe(false);
  });

  it('isAvailable returns false on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const { DailyHotApiProvider } = await import('../scripts/adapters/providers/dailyhot-provider');
    const provider = new DailyHotApiProvider();
    expect(await provider.isAvailable()).toBe(false);
  });

  // ── getFeed ──────────────────────────────────────────────

  it('getFeed returns ContentItems mapped from DailyHotApi response', async () => {
    const mockData = {
      code: 200,
      data: [
        { id: 1, title: '知乎热榜第一', url: 'https://zhihu.com/q/1', hot: 5000000, mobileUrl: '' },
        { id: 2, title: '知乎热榜第二', url: 'https://zhihu.com/q/2', hot: 3000000, mobileUrl: '' },
      ],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockData),
    }));

    const { DailyHotApiProvider } = await import('../scripts/adapters/providers/dailyhot-provider');
    const provider = new DailyHotApiProvider({ platforms: ['zhihu'] });
    const items = await provider.getFeed();

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual(expect.objectContaining({
      id: expect.stringContaining('dailyhot:zhihu'),
      source: 'dailyhot:zhihu',
      title: '知乎热榜第一',
      url: 'https://zhihu.com/q/1',
      likes: 5000000,
    }));
  });

  it('getFeed fetches from multiple DailyHot platforms', async () => {
    const zhihuData = {
      code: 200,
      data: [
        { id: 1, title: 'Zhihu Hot', url: 'https://zhihu.com/1', hot: 1000, mobileUrl: '' },
      ],
    };
    const weiboData = {
      code: 200,
      data: [
        { id: 1, title: 'Weibo Hot', url: 'https://weibo.com/1', hot: 2000, mobileUrl: '' },
      ],
    };

    const mockFetch = vi.fn()
      .mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/zhihu')) {
          return { ok: true, json: () => Promise.resolve(zhihuData) };
        }
        if (typeof url === 'string' && url.includes('/weibo')) {
          return { ok: true, json: () => Promise.resolve(weiboData) };
        }
        return { ok: false };
      });
    vi.stubGlobal('fetch', mockFetch);

    const { DailyHotApiProvider } = await import('../scripts/adapters/providers/dailyhot-provider');
    const provider = new DailyHotApiProvider({ platforms: ['zhihu', 'weibo'] });
    const items = await provider.getFeed();

    expect(items).toHaveLength(2);
    expect(items.map(i => i.source)).toEqual(
      expect.arrayContaining(['dailyhot:zhihu', 'dailyhot:weibo'])
    );
  });

  it('getFeed respects limit option', async () => {
    const mockData = {
      code: 200,
      data: Array.from({ length: 20 }, (_, i) => ({
        id: i, title: `Item ${i}`, url: `https://x.com/${i}`, hot: 1000 - i, mobileUrl: '',
      })),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockData),
    }));

    const { DailyHotApiProvider } = await import('../scripts/adapters/providers/dailyhot-provider');
    const provider = new DailyHotApiProvider({ platforms: ['zhihu'] });
    const items = await provider.getFeed({ limit: 3 });

    expect(items).toHaveLength(3);
  });

  it('getFeed returns empty array on API error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }));

    const { DailyHotApiProvider } = await import('../scripts/adapters/providers/dailyhot-provider');
    const provider = new DailyHotApiProvider({ platforms: ['zhihu'] });
    const items = await provider.getFeed();

    expect(items).toEqual([]);
  });

  it('getFeed returns empty array on network timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('AbortError: timeout')));

    const { DailyHotApiProvider } = await import('../scripts/adapters/providers/dailyhot-provider');
    const provider = new DailyHotApiProvider({ platforms: ['zhihu'] });
    const items = await provider.getFeed();

    expect(items).toEqual([]);
  });

  // ── configurable API URL ─────────────────────────────────

  it('uses custom API URL from constructor options', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ code: 200, data: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { DailyHotApiProvider } = await import('../scripts/adapters/providers/dailyhot-provider');
    const provider = new DailyHotApiProvider({
      platforms: ['zhihu'],
      apiUrl: 'https://my-custom-api.com',
    });
    await provider.getFeed();

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://my-custom-api.com'),
      expect.any(Object),
    );
  });

  it('uses DAILYHOT_API_URL env var when set', async () => {
    process.env.DAILYHOT_API_URL = 'https://env-api.example.com';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ code: 200, data: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    // Need fresh import after env change
    vi.resetModules();
    const { DailyHotApiProvider } = await import('../scripts/adapters/providers/dailyhot-provider');
    const provider = new DailyHotApiProvider({ platforms: ['zhihu'] });
    await provider.getFeed();

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://env-api.example.com'),
      expect.any(Object),
    );
  });

  // ── search ───────────────────────────────────────────────

  it('search returns empty array (DailyHotApi does not support search)', async () => {
    const { DailyHotApiProvider } = await import('../scripts/adapters/providers/dailyhot-provider');
    const provider = new DailyHotApiProvider();
    const items = await provider.search('any keyword');
    expect(items).toEqual([]);
  });

  // ── default platforms ────────────────────────────────────

  it('uses default platforms when none specified', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ code: 200, data: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { DailyHotApiProvider } = await import('../scripts/adapters/providers/dailyhot-provider');
    const provider = new DailyHotApiProvider(); // no platforms
    await provider.getFeed();

    // Should fetch at least one default platform
    expect(mockFetch).toHaveBeenCalled();
  });
});
