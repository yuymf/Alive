// alive/scripts/adapters/providers/bilibili-provider.ts
// Bilibili Provider — fetches trending videos and search results from B站

import type { ContentItem, ContentProvider, ContentProviderMeta } from '../content-provider';

const BILIBILI_TRENDING_URL = 'https://api.bilibili.com/x/web-interface/ranking/v2';
const BILIBILI_SEARCH_URL = 'https://api.bilibili.com/x/web-interface/search/type';
const FETCH_TIMEOUT = 10_000;

interface BilibiliTrendingItem {
  bvid: string;
  title: string;
  stat: { view: number; like: number };
  owner: { name: string };
  desc: string;
  pubdate: number;
}

interface BilibiliSearchItem {
  bvid: string;
  title: string;
  play: number;
  like: number;
  author: string;
  description: string;
  pubdate: number;
}

export class BilibiliProvider implements ContentProvider {
  readonly meta: ContentProviderMeta = {
    name: 'bilibili',
    displayName: 'Bilibili',
    type: 'social',
  };

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(BILIBILI_TRENDING_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getFeed(options?: { limit?: number; keywords?: string[] }): Promise<ContentItem[]> {
    try {
      const res = await fetch(BILIBILI_TRENDING_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (!res.ok) return [];

      const json = await res.json() as { code: number; data: { list: BilibiliTrendingItem[] } };
      if (json.code !== 0 || !json.data?.list) return [];

      let items = json.data.list;
      if (options?.limit !== undefined) {
        items = items.slice(0, options.limit);
      }

      return items.map(item => ({
        id: `bilibili_${item.bvid}`,
        source: 'bilibili',
        title: item.title,
        url: `https://www.bilibili.com/video/${item.bvid}`,
        likes: item.stat.like,
        user: item.owner.name,
        snippet: item.desc ? item.desc.slice(0, 200) : undefined,
        timestamp: item.pubdate
          ? new Date(item.pubdate * 1000).toISOString()
          : undefined,
      }));
    } catch (err) {
      console.warn(`[BilibiliProvider] getFeed error: ${(err as Error).message}`);
      return [];
    }
  }

  async search(keyword: string, options?: { limit?: number }): Promise<ContentItem[]> {
    try {
      const limit = options?.limit ?? 10;
      const url = `${BILIBILI_SEARCH_URL}?search_type=video&keyword=${encodeURIComponent(keyword)}&page_size=${limit}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (!res.ok) return [];

      const json = await res.json() as { code: number; data: { result: BilibiliSearchItem[] } };
      if (json.code !== 0 || !json.data?.result) return [];

      return json.data.result.map(item => ({
        id: `bilibili_${item.bvid}`,
        source: 'bilibili',
        title: item.title.replace(/<[^>]+>/g, ''), // Strip HTML tags from search results
        url: `https://www.bilibili.com/video/${item.bvid}`,
        likes: item.like,
        user: item.author,
        snippet: item.description ? item.description.slice(0, 200) : undefined,
        timestamp: item.pubdate
          ? new Date(item.pubdate * 1000).toISOString()
          : undefined,
      }));
    } catch (err) {
      console.warn(`[BilibiliProvider] search error: ${(err as Error).message}`);
      return [];
    }
  }
}
