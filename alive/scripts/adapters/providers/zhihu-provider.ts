// alive/scripts/adapters/providers/zhihu-provider.ts
// Zhihu Provider — fetches hot list with DailyHotApi fallback degradation

import type { ContentItem, ContentProvider, ContentProviderMeta } from '../content-provider';

const ZHIHU_HOT_URL = 'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total';
const DAILYHOT_DEFAULT_URL = 'https://dailyhot.hkg1.zeabur.app';
const FETCH_TIMEOUT = 10_000;

interface ZhihuHotItem {
  target: {
    id: number;
    title: string;
    url: string;
    excerpt?: string;
  };
  detail_text: string;
  children: unknown[];
}

interface DailyHotItem {
  id: number | string;
  title: string;
  url: string;
  hot: number;
  mobileUrl?: string;
}

export interface ZhihuProviderOptions {
  dailyhotApiUrl?: string;
}

export class ZhihuProvider implements ContentProvider {
  readonly meta: ContentProviderMeta = {
    name: 'zhihu',
    displayName: '知乎',
    type: 'trending',
  };

  private dailyhotApiUrl: string;

  constructor(options?: ZhihuProviderOptions) {
    this.dailyhotApiUrl = options?.dailyhotApiUrl
      ?? process.env.DAILYHOT_API_URL
      ?? DAILYHOT_DEFAULT_URL;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(ZHIHU_HOT_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getFeed(options?: { limit?: number; keywords?: string[] }): Promise<ContentItem[]> {
    const limit = options?.limit;

    // Try direct Zhihu API first
    try {
      const items = await this.fetchDirect(limit);
      if (items.length > 0) return items;
    } catch (err) {
      console.warn(`[ZhihuProvider] Direct API failed: ${(err as Error).message}, trying DailyHotApi fallback`);
    }

    // Fallback to DailyHotApi
    try {
      return await this.fetchViaDailyHot(limit);
    } catch (err) {
      console.warn(`[ZhihuProvider] DailyHotApi fallback also failed: ${(err as Error).message}`);
    }

    return [];
  }

  async search(_keyword: string, _options?: { limit?: number }): Promise<ContentItem[]> {
    // Zhihu search requires authentication, not supported in public API mode
    return [];
  }

  private async fetchDirect(limit?: number): Promise<ContentItem[]> {
    const res = await fetch(ZHIHU_HOT_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json() as { data: ZhihuHotItem[] };
    if (!Array.isArray(json.data)) throw new Error('Invalid response format');

    let items = json.data;
    if (limit !== undefined) {
      items = items.slice(0, limit);
    }

    return items.map(item => this.mapZhihuItem(item));
  }

  private async fetchViaDailyHot(limit?: number): Promise<ContentItem[]> {
    const res = await fetch(`${this.dailyhotApiUrl}/zhihu`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) throw new Error(`DailyHotApi HTTP ${res.status}`);

    const json = await res.json() as { code: number; data: DailyHotItem[] };
    if (json.code !== 200 || !Array.isArray(json.data)) throw new Error('Invalid DailyHotApi response');

    let items = json.data;
    if (limit !== undefined) {
      items = items.slice(0, limit);
    }

    return items.map(item => ({
      id: `zhihu_dh_${item.id}`,
      source: 'zhihu',
      title: item.title,
      url: item.url || undefined,
      likes: item.hot,
    }));
  }

  private mapZhihuItem(item: ZhihuHotItem): ContentItem {
    // Parse hot number from detail_text (e.g. "5000万热度")
    const hotMatch = item.detail_text?.match(/(\d+)/);
    const hot = hotMatch ? parseInt(hotMatch[1], 10) : undefined;

    return {
      id: `zhihu_${item.target.id}`,
      source: 'zhihu',
      title: item.target.title,
      url: item.target.url,
      likes: hot ?? 0,
      snippet: item.target.excerpt || undefined,
    };
  }
}
