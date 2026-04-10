// alive/scripts/adapters/providers/douyin-provider.ts
// Douyin (抖音) Provider — wraps douyin-bridge CLI into ContentProvider interface

import type { ContentItem, ContentProvider, ContentProviderMeta } from '../content-provider';
import {
  checkDouyinLogin,
  searchDouyinVideos,
} from '../../../sub-skills/platform/douyin-bridge/scripts/douyin-client';

export class DouyinProvider implements ContentProvider {
  readonly meta: ContentProviderMeta = {
    name: 'douyin',
    displayName: '抖音',
    type: 'social',
  };

  async isAvailable(): Promise<boolean> {
    try {
      const result = checkDouyinLogin();
      return result.success && result.logged_in === true;
    } catch {
      return false;
    }
  }

  async getFeed(_options?: { limit?: number; keywords?: string[] }): Promise<ContentItem[]> {
    // 抖音没有通用推荐 feed API，返回空
    return [];
  }

  async search(keyword: string, options?: { limit?: number }): Promise<ContentItem[]> {
    try {
      const limit = options?.limit ?? 10;
      const result = searchDouyinVideos(keyword, limit);

      if (!result.success || !result.videos) return [];

      return result.videos.map(video => ({
        id: `douyin_${video.aweme_id}`,
        source: 'douyin',
        title: video.desc,
        url: `https://www.douyin.com/video/${video.aweme_id}`,
        likes: video.digg_count,
        user: video.author,
        timestamp: video.create_time
          ? new Date(video.create_time * 1000).toISOString()
          : undefined,
      }));
    } catch (err) {
      console.warn(`[DouyinProvider] search error: ${(err as Error).message}`);
      return [];
    }
  }
}
