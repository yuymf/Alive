// alive/tests/reddit-provider.test.ts
// TDD Step 1: Write failing tests for Reddit Provider

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('RedditProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── meta ──────────────────────────────────────────────────

  it('has correct meta information', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: [] }) }));
    const { RedditProvider } = await import('../scripts/adapters/providers/reddit-provider');
    const provider = new RedditProvider();
    expect(provider.meta.name).toBe('reddit');
    expect(provider.meta.displayName).toBe('Reddit');
    expect(provider.meta.type).toBe('social');
  });

  // ── isAvailable ──────────────────────────────────────────

  it('isAvailable returns true when Arctic Shift is reachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const { RedditProvider } = await import('../scripts/adapters/providers/reddit-provider');
    const provider = new RedditProvider();
    expect(await provider.isAvailable()).toBe(true);
  });

  it('isAvailable returns false on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const { RedditProvider } = await import('../scripts/adapters/providers/reddit-provider');
    const provider = new RedditProvider();
    expect(await provider.isAvailable()).toBe(false);
  });

  // ── getFeed (Arctic Shift) ───────────────────────────────

  it('getFeed returns ContentItems from Arctic Shift API', async () => {
    const mockPosts = {
      data: [
        {
          id: 'abc123',
          title: 'Amazing cosplay',
          score: 1500,
          selftext: 'First cosplay attempt!',
          subreddit: 'cosplay',
          permalink: '/r/cosplay/comments/abc123/amazing_cosplay/',
          num_comments: 10,
          name: 't3_abc123',
          created_utc: 1710000000,
        },
        {
          id: 'def456',
          title: 'Anime convention highlights',
          score: 800,
          selftext: '',
          subreddit: 'cosplay',
          permalink: '/r/cosplay/comments/def456/anime_convention/',
          num_comments: 5,
          name: 't3_def456',
          created_utc: 1710001000,
        },
      ],
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockPosts),
    }));

    const { RedditProvider } = await import('../scripts/adapters/providers/reddit-provider');
    const provider = new RedditProvider({ subreddits: ['cosplay'] });
    const items = await provider.getFeed();

    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]).toEqual(expect.objectContaining({
      id: expect.stringContaining('reddit_'),
      source: 'reddit',
      title: expect.any(String),
      likes: expect.any(Number),
    }));
  });

  it('getFeed falls back to Reddit public JSON when Arctic Shift fails', async () => {
    const redditResponse = {
      data: {
        children: [
          {
            data: {
              id: 'xyz789',
              title: 'Fallback post',
              score: 500,
              selftext: 'Some content',
              permalink: '/r/cosplay/comments/xyz789/fallback/',
              num_comments: 3,
              subreddit: 'cosplay',
              url: 'https://reddit.com/r/cosplay/xyz789',
            },
          },
        ],
      },
    };

    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      // Arctic Shift calls fail
      if (typeof url === 'string' && url.includes('arctic-shift')) {
        throw new Error('Arctic Shift down');
      }
      // Reddit fallback succeeds
      return {
        ok: true,
        json: () => Promise.resolve(redditResponse),
      };
    }));

    const { RedditProvider } = await import('../scripts/adapters/providers/reddit-provider');
    const provider = new RedditProvider({ subreddits: ['cosplay'] });
    const items = await provider.getFeed();

    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].source).toBe('reddit');
  });

  it('getFeed uses configured subreddits', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { RedditProvider } = await import('../scripts/adapters/providers/reddit-provider');
    const provider = new RedditProvider({ subreddits: ['cosplay', 'anime'] });
    await provider.getFeed();

    // Should fetch from both subreddits
    const urls = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(urls.some((u: string) => u.includes('cosplay'))).toBe(true);
    expect(urls.some((u: string) => u.includes('anime'))).toBe(true);
  });

  it('getFeed respects limit option', async () => {
    const mockPosts = {
      data: Array.from({ length: 20 }, (_, i) => ({
        id: `post${i}`,
        title: `Post ${i}`,
        score: 1000 - i * 10,
        selftext: '',
        subreddit: 'cosplay',
        permalink: `/r/cosplay/comments/post${i}/`,
        num_comments: 0,
        name: `t3_post${i}`,
        created_utc: 1710000000 + i,
      })),
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockPosts),
    }));

    const { RedditProvider } = await import('../scripts/adapters/providers/reddit-provider');
    const provider = new RedditProvider({ subreddits: ['cosplay'] });
    const items = await provider.getFeed({ limit: 3 });

    expect(items).toHaveLength(3);
  });

  it('getFeed returns empty array when all sources fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('all down')));

    const { RedditProvider } = await import('../scripts/adapters/providers/reddit-provider');
    const provider = new RedditProvider({ subreddits: ['cosplay'] });
    const items = await provider.getFeed();

    expect(items).toEqual([]);
  });

  // ── search ───────────────────────────────────────────────

  it('search returns ContentItems matching keyword', async () => {
    const searchResults = {
      data: [
        {
          id: 's1',
          title: 'Cosplay makeup tutorial',
          score: 200,
          selftext: 'How to do anime makeup',
          subreddit: 'cosplay',
          permalink: '/r/cosplay/comments/s1/',
          num_comments: 5,
          name: 't3_s1',
          created_utc: 1710000000,
        },
      ],
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(searchResults),
    }));

    const { RedditProvider } = await import('../scripts/adapters/providers/reddit-provider');
    const provider = new RedditProvider({ subreddits: ['cosplay'] });
    const items = await provider.search('cosplay makeup');

    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].source).toBe('reddit');
    expect(items[0].title).toContain('Cosplay');
  });

  it('search returns empty array on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('search failed')));

    const { RedditProvider } = await import('../scripts/adapters/providers/reddit-provider');
    const provider = new RedditProvider();
    const items = await provider.search('anything');

    expect(items).toEqual([]);
  });

  // ── default subreddits ───────────────────────────────────

  it('uses default subreddits when none specified', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { RedditProvider } = await import('../scripts/adapters/providers/reddit-provider');
    const provider = new RedditProvider(); // no subreddits
    await provider.getFeed();

    expect(mockFetch).toHaveBeenCalled();
  });
});
