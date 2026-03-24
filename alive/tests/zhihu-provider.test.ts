// alive/tests/zhihu-provider.test.ts
// TDD Step 1: Write failing tests for Zhihu Provider

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('ZhihuProvider', () => {
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
    const { ZhihuProvider } = await import('../scripts/adapters/providers/zhihu-provider');
    const provider = new ZhihuProvider();
    expect(provider.meta.name).toBe('zhihu');
    expect(provider.meta.displayName).toBe('知乎');
    expect(provider.meta.type).toBe('trending');
  });

  // ── isAvailable ──────────────────────────────────────────

  it('isAvailable returns true when Zhihu API is reachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const { ZhihuProvider } = await import('../scripts/adapters/providers/zhihu-provider');
    const provider = new ZhihuProvider();
    expect(await provider.isAvailable()).toBe(true);
  });

  it('isAvailable returns false on error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const { ZhihuProvider } = await import('../scripts/adapters/providers/zhihu-provider');
    const provider = new ZhihuProvider();
    expect(await provider.isAvailable()).toBe(false);
  });

  // ── getFeed (direct API) ─────────────────────────────────

  it('getFeed returns ContentItems from Zhihu hot list', async () => {
    const mockResponse = {
      data: [
        {
          target: {
            id: 12345,
            title: '如何看待最近的AI发展？',
            url: 'https://www.zhihu.com/question/12345',
            excerpt: '最近AI发展很快...',
          },
          detail_text: '5000万热度',
          children: [{ thumbnail: '' }],
        },
        {
          target: {
            id: 67890,
            title: '有哪些令人惊艳的cosplay？',
            url: 'https://www.zhihu.com/question/67890',
            excerpt: '看到很多精彩的...',
          },
          detail_text: '3000万热度',
          children: [],
        },
      ],
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }));

    const { ZhihuProvider } = await import('../scripts/adapters/providers/zhihu-provider');
    const provider = new ZhihuProvider();
    const items = await provider.getFeed();

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual(expect.objectContaining({
      id: expect.stringContaining('zhihu_'),
      source: 'zhihu',
      title: '如何看待最近的AI发展？',
    }));
  });

  it('getFeed falls back to DailyHotApi when Zhihu direct API fails', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      // Zhihu direct API fails
      if (typeof url === 'string' && url.includes('zhihu.com')) {
        throw new Error('Zhihu API blocked');
      }
      // DailyHotApi succeeds
      return {
        ok: true,
        json: () => Promise.resolve({
          code: 200,
          data: [
            { id: 1, title: '知乎热榜通过DailyHot获取', url: 'https://zhihu.com/q/1', hot: 1000, mobileUrl: '' },
          ],
        }),
      };
    });
    vi.stubGlobal('fetch', mockFetch);

    const { ZhihuProvider } = await import('../scripts/adapters/providers/zhihu-provider');
    const provider = new ZhihuProvider();
    const items = await provider.getFeed();

    expect(items.length).toBeGreaterThanOrEqual(1);
    // Fallback items should be marked with dailyhot source or zhihu source
    expect(items[0].title).toContain('知乎热榜通过DailyHot获取');
  });

  it('getFeed respects limit option', async () => {
    const mockResponse = {
      data: Array.from({ length: 20 }, (_, i) => ({
        target: {
          id: i,
          title: `Question ${i}`,
          url: `https://zhihu.com/q/${i}`,
          excerpt: '',
        },
        detail_text: `${1000 - i}万热度`,
        children: [],
      })),
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }));

    const { ZhihuProvider } = await import('../scripts/adapters/providers/zhihu-provider');
    const provider = new ZhihuProvider();
    const items = await provider.getFeed({ limit: 5 });

    expect(items).toHaveLength(5);
  });

  it('getFeed returns empty array when all sources fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('all down')));

    const { ZhihuProvider } = await import('../scripts/adapters/providers/zhihu-provider');
    const provider = new ZhihuProvider();
    const items = await provider.getFeed();

    expect(items).toEqual([]);
  });

  // ── search ───────────────────────────────────────────────

  it('search returns empty array (not supported)', async () => {
    const { ZhihuProvider } = await import('../scripts/adapters/providers/zhihu-provider');
    const provider = new ZhihuProvider();
    const items = await provider.search('any keyword');
    expect(items).toEqual([]);
  });
});
