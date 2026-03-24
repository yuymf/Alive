// alive/tests/weibo-provider.test.ts
// TDD Step 1: Write failing tests for Weibo Provider

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('WeiboProvider', () => {
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
    const { WeiboProvider } = await import('../scripts/adapters/providers/weibo-provider');
    const provider = new WeiboProvider();
    expect(provider.meta.name).toBe('weibo');
    expect(provider.meta.displayName).toBe('微博');
    expect(provider.meta.type).toBe('trending');
  });

  // ── isAvailable ──────────────────────────────────────────

  it('isAvailable returns true when Weibo API is reachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const { WeiboProvider } = await import('../scripts/adapters/providers/weibo-provider');
    const provider = new WeiboProvider();
    expect(await provider.isAvailable()).toBe(true);
  });

  it('isAvailable returns false on error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const { WeiboProvider } = await import('../scripts/adapters/providers/weibo-provider');
    const provider = new WeiboProvider();
    expect(await provider.isAvailable()).toBe(false);
  });

  // ── getFeed ──────────────────────────────────────────────

  it('getFeed returns ContentItems from Weibo hot search', async () => {
    const mockResponse = {
      data: {
        realtime: [
          {
            word: 'AI生图技术突破',
            num: 5000000,
            word_scheme: 'https://s.weibo.com/weibo?q=AI生图技术突破',
          },
          {
            word: 'cosplay大赛',
            num: 3000000,
            word_scheme: 'https://s.weibo.com/weibo?q=cosplay大赛',
          },
        ],
      },
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }));

    const { WeiboProvider } = await import('../scripts/adapters/providers/weibo-provider');
    const provider = new WeiboProvider();
    const items = await provider.getFeed();

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual(expect.objectContaining({
      id: expect.stringContaining('weibo_'),
      source: 'weibo',
      title: 'AI生图技术突破',
      likes: 5000000,
    }));
  });

  it('getFeed falls back to DailyHotApi when Weibo direct API fails', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      // Weibo direct API fails
      if (typeof url === 'string' && url.includes('weibo.com')) {
        throw new Error('Weibo API blocked');
      }
      // DailyHotApi succeeds
      return {
        ok: true,
        json: () => Promise.resolve({
          code: 200,
          data: [
            { id: 1, title: '微博热搜通过DailyHot获取', url: 'https://weibo.com/1', hot: 2000, mobileUrl: '' },
          ],
        }),
      };
    });
    vi.stubGlobal('fetch', mockFetch);

    const { WeiboProvider } = await import('../scripts/adapters/providers/weibo-provider');
    const provider = new WeiboProvider();
    const items = await provider.getFeed();

    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].title).toContain('微博热搜通过DailyHot获取');
  });

  it('getFeed respects limit option', async () => {
    const mockResponse = {
      data: {
        realtime: Array.from({ length: 20 }, (_, i) => ({
          word: `热搜 ${i}`,
          num: 1000000 - i * 10000,
          word_scheme: `https://s.weibo.com/weibo?q=热搜${i}`,
        })),
      },
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }));

    const { WeiboProvider } = await import('../scripts/adapters/providers/weibo-provider');
    const provider = new WeiboProvider();
    const items = await provider.getFeed({ limit: 5 });

    expect(items).toHaveLength(5);
  });

  it('getFeed returns empty array when all sources fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('all down')));

    const { WeiboProvider } = await import('../scripts/adapters/providers/weibo-provider');
    const provider = new WeiboProvider();
    const items = await provider.getFeed();

    expect(items).toEqual([]);
  });

  // ── search ───────────────────────────────────────────────

  it('search returns empty array (not supported)', async () => {
    const { WeiboProvider } = await import('../scripts/adapters/providers/weibo-provider');
    const provider = new WeiboProvider();
    const items = await provider.search('any keyword');
    expect(items).toEqual([]);
  });
});
