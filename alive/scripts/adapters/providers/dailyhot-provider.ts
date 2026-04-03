// alive/scripts/adapters/providers/dailyhot-provider.ts
// DailyHotApi Provider — aggregates trending content from 60+ platforms via DailyHotApi

import type { ContentItem, ContentProvider, ContentProviderMeta } from '../content-provider';

const DEFAULT_API_URL = 'https://dailyhot-rho-nine.vercel.app';
const DEFAULT_PLATFORMS = ['zhihu', 'weibo', 'bilibili'];
const FETCH_TIMEOUT = 10_000;

interface DailyHotApiItem {
  id: number | string;
  title: string;
  url: string;
  hot: number;
  mobileUrl?: string;
}

interface DailyHotApiResponse {
  code: number;
  data: DailyHotApiItem[];
}

export interface DailyHotApiProviderOptions {
  platforms?: string[];
  apiUrl?: string;
}

export class DailyHotApiProvider implements ContentProvider {
  readonly meta: ContentProviderMeta = {
    name: 'dailyhot',
    displayName: 'DailyHot',
    type: 'aggregator',
  };

  private platforms: string[];
  private apiUrl: string;

  constructor(options?: DailyHotApiProviderOptions) {
    this.platforms = options?.platforms ?? DEFAULT_PLATFORMS;
    this.apiUrl = options?.apiUrl
      ?? process.env.DAILYHOT_API_URL
      ?? DEFAULT_API_URL;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiUrl}/`, {
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

    // Fetch from each configured DailyHot platform in parallel
    const results = await Promise.allSettled(
      this.platforms.map(platform => this.fetchPlatform(platform, limit))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allItems.push(...result.value);
      } else {
        console.warn(`[DailyHotApi] Failed to fetch platform: ${result.reason}`);
      }
    }

    return allItems;
  }

  async search(_keyword: string, _options?: { limit?: number }): Promise<ContentItem[]> {
    // DailyHotApi does not support search — it's a trending-only aggregator
    return [];
  }

  private async fetchPlatform(platform: string, limit?: number): Promise<ContentItem[]> {
    try {
      const res = await fetch(`${this.apiUrl}/${platform}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (!res.ok) return [];

      const json = await res.json() as DailyHotApiResponse;
      if (json.code !== 200 || !Array.isArray(json.data)) return [];

      let items = json.data;
      if (limit !== undefined) {
        items = items.slice(0, limit);
      }

      return items.map(item => ({
        id: `dailyhot:${platform}_${item.id}`,
        source: `dailyhot:${platform}`,
        title: item.title,
        url: item.url || undefined,
        likes: item.hot,
      }));
    } catch (err) {
      console.warn(`[DailyHotApi] Error fetching ${platform}: ${(err as Error).message}`);
      return [];
    }
  }
}
