// alive/scripts/adapters/providers/weibo-provider.ts
// Weibo Provider — fetches hot search with DailyHotApi fallback degradation

import type { ContentItem, ContentProvider, ContentProviderMeta } from '../content-provider';

const WEIBO_HOT_URL = 'https://weibo.com/ajax/side/hotSearch';
const DAILYHOT_DEFAULT_URL = 'https://dailyhot-rho-nine.vercel.app';
const FETCH_TIMEOUT = 10_000;

interface WeiboHotItem {
  word: string;
  num: number;
  word_scheme?: string;
}

interface DailyHotItem {
  id: number | string;
  title: string;
  url: string;
  hot: number;
  mobileUrl?: string;
}

export interface WeiboProviderOptions {
  dailyhotApiUrl?: string;
}

export class WeiboProvider implements ContentProvider {
  readonly meta: ContentProviderMeta = {
    name: 'weibo',
    displayName: '微博',
    type: 'trending',
  };

  private dailyhotApiUrl: string;

  constructor(options?: WeiboProviderOptions) {
    this.dailyhotApiUrl = options?.dailyhotApiUrl
      ?? process.env.DAILYHOT_API_URL
      ?? DAILYHOT_DEFAULT_URL;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(WEIBO_HOT_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getFeed(options?: { limit?: number; keywords?: string[] }): Promise<ContentItem[]> {
    const limit = options?.limit;

    // Try direct Weibo API first
    try {
      const items = await this.fetchDirect(limit);
      if (items.length > 0) return items;
    } catch (err) {
      console.warn(`[WeiboProvider] Direct API failed: ${(err as Error).message}, trying DailyHotApi fallback`);
    }

    // Fallback to DailyHotApi
    try {
      return await this.fetchViaDailyHot(limit);
    } catch (err) {
      console.warn(`[WeiboProvider] DailyHotApi fallback also failed: ${(err as Error).message}`);
    }

    return [];
  }

  async search(_keyword: string, _options?: { limit?: number }): Promise<ContentItem[]> {
    // Weibo search requires authentication, not supported in public API mode
    return [];
  }

  private async fetchDirect(limit?: number): Promise<ContentItem[]> {
    const res = await fetch(WEIBO_HOT_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json() as { data: { realtime: WeiboHotItem[] } };
    if (!json.data?.realtime || !Array.isArray(json.data.realtime)) {
      throw new Error('Invalid response format');
    }

    let items = json.data.realtime;
    if (limit !== undefined) {
      items = items.slice(0, limit);
    }

    return items.map((item) => ({
      id: `weibo_${item.word.replace(/\s+/g, '_').slice(0, 40)}`,
      source: 'weibo',
      title: item.word,
      url: item.word_scheme || `https://s.weibo.com/weibo?q=${encodeURIComponent(item.word)}`,
      likes: item.num,
    }));
  }

  private async fetchViaDailyHot(limit?: number): Promise<ContentItem[]> {
    const res = await fetch(`${this.dailyhotApiUrl}/weibo`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) throw new Error(`DailyHotApi HTTP ${res.status}`);

    const json = await res.json() as { code: number; data: DailyHotItem[] };
    if (json.code !== 200 || !Array.isArray(json.data)) {
      throw new Error('Invalid DailyHotApi response');
    }

    let items = json.data;
    if (limit !== undefined) {
      items = items.slice(0, limit);
    }

    return items.map(item => ({
      id: `weibo_dh_${item.id}`,
      source: 'weibo',
      title: item.title,
      url: item.url || undefined,
      likes: item.hot,
    }));
  }
}
