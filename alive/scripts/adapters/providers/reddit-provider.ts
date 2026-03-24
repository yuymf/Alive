// alive/scripts/adapters/providers/reddit-provider.ts
// Reddit Provider — fetches trending posts via Arctic Shift API with Reddit JSON fallback

import type { ContentItem, ContentProvider, ContentProviderMeta } from '../content-provider';

const ARCTIC_SHIFT_BASE = 'https://arctic-shift.photon-reddit.com/api';
const USER_AGENT = 'alive-content-bridge/0.1';
const FETCH_TIMEOUT = 10_000;
const DEFAULT_SUBREDDITS = ['popular'];

interface ArcticShiftPost {
  id: string;
  title: string;
  score: number;
  selftext: string;
  subreddit: string;
  permalink: string;
  num_comments: number;
  name: string;
  created_utc: number;
}

interface RedditJsonPost {
  data: {
    id: string;
    title: string;
    score: number;
    selftext: string;
    permalink: string;
    num_comments: number;
    subreddit: string;
    url: string;
  };
}

export interface RedditProviderOptions {
  subreddits?: string[];
}

export class RedditProvider implements ContentProvider {
  readonly meta: ContentProviderMeta = {
    name: 'reddit',
    displayName: 'Reddit',
    type: 'social',
  };

  private subreddits: string[];

  constructor(options?: RedditProviderOptions) {
    this.subreddits = options?.subreddits ?? DEFAULT_SUBREDDITS;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${ARCTIC_SHIFT_BASE}/posts/search?limit=1`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getFeed(options?: { limit?: number; keywords?: string[] }): Promise<ContentItem[]> {
    const limit = options?.limit;
    const allItems: ContentItem[] = [];

    // Fetch from each subreddit in parallel
    const results = await Promise.allSettled(
      this.subreddits.map(sub => this.fetchSubreddit(sub, limit))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allItems.push(...result.value);
      } else {
        console.warn(`[RedditProvider] Failed to fetch subreddit: ${result.reason}`);
      }
    }

    // Apply global limit after combining all subreddits
    if (limit !== undefined && allItems.length > limit) {
      return allItems.slice(0, limit);
    }

    return allItems;
  }

  async search(keyword: string, options?: { limit?: number }): Promise<ContentItem[]> {
    try {
      const limit = options?.limit ?? 10;
      const url = `${ARCTIC_SHIFT_BASE}/posts/search?q=${encodeURIComponent(keyword)}&limit=${limit}&sort=desc&sort_type=score`;
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (!res.ok) return [];

      const json = await res.json() as { data: ArcticShiftPost[] | null };
      if (!json.data) return [];

      return json.data.map(post => this.mapArcticShiftPost(post));
    } catch (err) {
      console.warn(`[RedditProvider] Search failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Fetch posts from a subreddit. Tries Arctic Shift first, falls back to Reddit public JSON.
   */
  private async fetchSubreddit(subreddit: string, limit?: number): Promise<ContentItem[]> {
    // Try Arctic Shift first
    try {
      return await this.fetchArcticShift(subreddit, limit);
    } catch (err) {
      console.warn(`[RedditProvider] Arctic Shift failed for r/${subreddit}: ${(err as Error).message}, trying Reddit fallback`);
    }

    // Fallback to Reddit public JSON
    try {
      return await this.fetchRedditJson(subreddit, limit);
    } catch (err) {
      console.warn(`[RedditProvider] Reddit fallback also failed for r/${subreddit}: ${(err as Error).message}`);
    }

    return [];
  }

  private async fetchArcticShift(subreddit: string, limit?: number): Promise<ContentItem[]> {
    const fetchLimit = limit ?? 10;
    const url = `${ARCTIC_SHIFT_BASE}/posts/search?subreddit=${subreddit}&after=7d&limit=25`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json() as { data: ArcticShiftPost[] | null };
    if (!json.data || json.data.length === 0) return [];

    const topPosts = [...json.data]
      .sort((a, b) => b.score - a.score)
      .slice(0, fetchLimit);

    return topPosts.map(post => this.mapArcticShiftPost(post));
  }

  private async fetchRedditJson(subreddit: string, limit?: number): Promise<ContentItem[]> {
    const fetchLimit = limit ?? 5;
    const url = `https://www.reddit.com/r/${subreddit}/top.json?t=week&limit=${fetchLimit}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json() as { data: { children: RedditJsonPost[] } };
    if (!json.data?.children) return [];

    return json.data.children.map(post => this.mapRedditJsonPost(post));
  }

  private mapArcticShiftPost(post: ArcticShiftPost): ContentItem {
    return {
      id: `reddit_${post.id}`,
      source: 'reddit',
      title: post.title,
      url: `https://reddit.com${post.permalink}`,
      likes: post.score,
      snippet: post.selftext ? post.selftext.slice(0, 200) : undefined,
      timestamp: post.created_utc
        ? new Date(post.created_utc * 1000).toISOString()
        : undefined,
    };
  }

  private mapRedditJsonPost(post: RedditJsonPost): ContentItem {
    return {
      id: `reddit_${post.data.id}`,
      source: 'reddit',
      title: post.data.title,
      url: `https://reddit.com${post.data.permalink}`,
      likes: post.data.score,
      snippet: post.data.selftext ? post.data.selftext.slice(0, 200) : undefined,
    };
  }
}
