// alive/scripts/adapters/providers/xhs-provider.ts
// XHS (小红书) Provider — wraps xhs-bridge CLI into ContentProvider interface

import type { ContentItem, ContentProvider, ContentProviderMeta } from '../content-provider';
import {
  isXhsAvailable,
  listXhsFeed,
  searchXhsNotes,
} from '../../../sub-skills/platform/xhs-bridge/scripts/xhs-client';

export class XhsProvider implements ContentProvider {
  readonly meta: ContentProviderMeta = {
    name: 'xhs',
    displayName: '小红书',
    type: 'social',
  };

  async isAvailable(): Promise<boolean> {
    try {
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
      console.warn(`[XhsProvider] getFeed error: ${(err as Error).message}`);
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
      console.warn(`[XhsProvider] search error: ${(err as Error).message}`);
      return [];
    }
  }
}
