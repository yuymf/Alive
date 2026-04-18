// alive/scripts/adapters/providers/xhs-provider.ts
// XHS (小红书) Provider — wraps xhs-bridge CLI into ContentProvider interface

import type { ContentItem, ContentProvider, ContentProviderMeta } from '../content-provider';
import {
  isXhsAvailable,
  listXhsFeed,
  searchXhsNotes,
  getXhsRateLimitStatus,
} from '../../../sub-skills/platform/xhs-bridge/scripts/xhs-client';

export class XhsProvider implements ContentProvider {
  readonly meta: ContentProviderMeta = {
    name: 'xhs',
    displayName: '小红书',
    type: 'social',
  };

  async isAvailable(): Promise<boolean> {
    try {
      // 风控冷却期内直接视为不可用，避免无谓探测
      const rlStatus = getXhsRateLimitStatus();
      if (rlStatus.in_cooldown) {
        console.warn(`[XhsProvider] 风控冷却中 (剩余 ${rlStatus.cooldown_remaining_s}s)，暂不可用`);
        return false;
      }
      return await isXhsAvailable();
    } catch {
      return false;
    }
  }

  async getFeed(options?: { limit?: number; keywords?: string[] }): Promise<ContentItem[]> {
    try {
      const notes = await listXhsFeed();
      const limited = options?.limit !== undefined ? notes.slice(0, options.limit) : notes;

      return limited.map(note => ({
        id: `xhs_${note.id}`,
        source: 'xhs',
        title: note.title,
        url: `https://www.xiaohongshu.com/explore/${note.id}`,
        likes: note.likes,
        user: note.user,
        tags: note.tags,
        snippet: note.description ? note.description.slice(0, 200) : undefined,
      }));
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('风控冷却中') || msg.includes('触发风控')) {
        console.warn(`[XhsProvider] getFeed 触发风控: ${msg}`);
      } else {
        console.warn(`[XhsProvider] getFeed error: ${msg}`);
      }
      return [];
    }
  }

  async search(keyword: string, options?: { limit?: number }): Promise<ContentItem[]> {
    try {
      const notes = await searchXhsNotes(keyword);
      const limited = options?.limit !== undefined ? notes.slice(0, options.limit) : notes;

      return limited.map(note => ({
        id: `xhs_${note.id}`,
        source: 'xhs',
        title: note.title,
        url: `https://www.xiaohongshu.com/explore/${note.id}`,
        likes: note.likes,
        user: note.user,
        tags: note.tags,
        snippet: note.description ? note.description.slice(0, 200) : undefined,
      }));
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('风控冷却中') || msg.includes('触发风控')) {
        console.warn(`[XhsProvider] search 触发风控: ${msg}，跳过关键词 "${keyword}"`);
      } else {
        console.warn(`[XhsProvider] search error: ${msg}`);
      }
      return [];
    }
  }
}
