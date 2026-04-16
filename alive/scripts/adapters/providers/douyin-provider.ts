// alive/scripts/adapters/providers/douyin-provider.ts
// Douyin (抖音) Provider — wraps douyin-bridge CLI into ContentProvider interface

import type { ContentItem, ContentProvider, ContentProviderMeta } from '../content-provider';
import {
  checkDouyinLogin,
  fetchDouyinFeed,
  searchDouyinVideos,
  getDouyinRateLimitStatus,
} from '../../../sub-skills/platform/douyin-bridge/scripts/douyin-client';

export class DouyinProvider implements ContentProvider {
  readonly meta: ContentProviderMeta = {
    name: 'douyin',
    displayName: '抖音',
    type: 'social',
  };

  async isAvailable(): Promise<boolean> {
    try {
      // 风控冷却期内直接视为不可用，避免无谓探测
      const rlStatus = getDouyinRateLimitStatus();
      if (rlStatus.in_cooldown) {
        console.warn(`[DouyinProvider] 风控冷却中 (剩余 ${rlStatus.cooldown_remaining_s}s)，暂不可用`);
        return false;
      }
      const result = checkDouyinLogin();
      return result.success && result.logged_in === true;
    } catch {
      return false;
    }
  }

  async getFeed(options?: { limit?: number; keywords?: string[] }): Promise<ContentItem[]> {
    try {
      const limit = options?.limit ?? 20;
      const result = fetchDouyinFeed(limit);

      if (!result.success || !result.videos) {
        if (result.rate_limited) {
          console.warn(`[DouyinProvider] getFeed 触发风控: ${result.reason ?? 'unknown'}`);
        }
        return [];
      }

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
      console.warn(`[DouyinProvider] getFeed error: ${(err as Error).message}`);
      return [];
    }
  }

  async search(keyword: string, options?: { limit?: number }): Promise<ContentItem[]> {
    try {
      const limit = options?.limit ?? 10;
      const result = searchDouyinVideos(keyword, limit);

      if (!result.success || !result.videos) {
        if (result.rate_limited) {
          console.warn(`[DouyinProvider] search 触发风控: ${result.reason ?? 'unknown'}，跳过关键词 "${keyword}"`);
        }
        return [];
      }

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
