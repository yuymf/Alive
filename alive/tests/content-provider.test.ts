// alive/tests/content-provider.test.ts
// TDD Step 1: Write failing tests for ContentProvider + ContentProviderRegistry

import { describe, it, expect, vi } from 'vitest';
import type {
  ContentItem,
  ContentProvider,
  ContentProviderMeta,
} from '../scripts/adapters/content-provider';
import { ContentProviderRegistry } from '../scripts/adapters/content-provider';

// ── Mock Provider Factory ─────────────────────────────────────

function makeMeta(overrides: Partial<ContentProviderMeta> = {}): ContentProviderMeta {
  return {
    name: 'test',
    displayName: 'Test Provider',
    type: 'trending',
    ...overrides,
  };
}

function makeProvider(overrides: Partial<ContentProvider> & { meta?: Partial<ContentProviderMeta> } = {}): ContentProvider {
  const meta = makeMeta(overrides.meta);
  return {
    meta,
    isAvailable: overrides.isAvailable ?? vi.fn(async () => true),
    getFeed: overrides.getFeed ?? vi.fn(async () => []),
    search: overrides.search ?? vi.fn(async () => []),
  };
}

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: 'test_1',
    source: 'test',
    title: 'Test Item',
    ...overrides,
  };
}

// ── ContentProviderRegistry.register + getProviders ──────────

describe('ContentProviderRegistry', () => {
  describe('register / getProviders', () => {
    it('registers a provider and retrieves it', () => {
      const registry = new ContentProviderRegistry();
      const provider = makeProvider({ meta: { name: 'reddit' } });

      registry.register(provider);

      const providers = registry.getProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0].meta.name).toBe('reddit');
    });

    it('registers multiple providers', () => {
      const registry = new ContentProviderRegistry();
      registry.register(makeProvider({ meta: { name: 'reddit' } }));
      registry.register(makeProvider({ meta: { name: 'bilibili' } }));
      registry.register(makeProvider({ meta: { name: 'dailyhot' } }));

      expect(registry.getProviders()).toHaveLength(3);
    });

    it('overwrites provider with same name', () => {
      const registry = new ContentProviderRegistry();
      const old = makeProvider({ meta: { name: 'reddit', displayName: 'Old' } });
      const newer = makeProvider({ meta: { name: 'reddit', displayName: 'New' } });

      registry.register(old);
      registry.register(newer);

      const providers = registry.getProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0].meta.displayName).toBe('New');
    });

    it('filters providers by name list', () => {
      const registry = new ContentProviderRegistry();
      registry.register(makeProvider({ meta: { name: 'reddit' } }));
      registry.register(makeProvider({ meta: { name: 'bilibili' } }));
      registry.register(makeProvider({ meta: { name: 'dailyhot' } }));

      const filtered = registry.getProviders(['reddit', 'dailyhot']);
      expect(filtered).toHaveLength(2);
      expect(filtered.map(p => p.meta.name)).toEqual(
        expect.arrayContaining(['reddit', 'dailyhot'])
      );
    });

    it('returns empty array when filter matches nothing', () => {
      const registry = new ContentProviderRegistry();
      registry.register(makeProvider({ meta: { name: 'reddit' } }));

      const filtered = registry.getProviders(['nonexistent']);
      expect(filtered).toHaveLength(0);
    });
  });

  // ── getAggregatedFeed ────────────────────────────────────────

  describe('getAggregatedFeed', () => {
    it('aggregates feed from all available providers', async () => {
      const registry = new ContentProviderRegistry();
      registry.register(makeProvider({
        meta: { name: 'reddit' },
        getFeed: vi.fn(async () => [
          makeItem({ id: 'reddit_1', source: 'reddit', title: 'Reddit Post' }),
        ]),
      }));
      registry.register(makeProvider({
        meta: { name: 'bilibili' },
        getFeed: vi.fn(async () => [
          makeItem({ id: 'bili_1', source: 'bilibili', title: 'Bilibili Video' }),
        ]),
      }));

      const items = await registry.getAggregatedFeed();
      expect(items).toHaveLength(2);
      expect(items.map(i => i.source)).toEqual(
        expect.arrayContaining(['reddit', 'bilibili'])
      );
    });

    it('skips unavailable providers', async () => {
      const registry = new ContentProviderRegistry();
      registry.register(makeProvider({
        meta: { name: 'reddit' },
        isAvailable: vi.fn(async () => true),
        getFeed: vi.fn(async () => [
          makeItem({ id: 'reddit_1', source: 'reddit' }),
        ]),
      }));
      registry.register(makeProvider({
        meta: { name: 'bilibili' },
        isAvailable: vi.fn(async () => false),
        getFeed: vi.fn(async () => [
          makeItem({ id: 'bili_1', source: 'bilibili' }),
        ]),
      }));

      const items = await registry.getAggregatedFeed();
      expect(items).toHaveLength(1);
      expect(items[0].source).toBe('reddit');
    });

    it('skips providers that throw in isAvailable', async () => {
      const registry = new ContentProviderRegistry();
      registry.register(makeProvider({
        meta: { name: 'reddit' },
        isAvailable: vi.fn(async () => { throw new Error('connection refused'); }),
        getFeed: vi.fn(async () => [makeItem({ id: 'reddit_1', source: 'reddit' })]),
      }));
      registry.register(makeProvider({
        meta: { name: 'bilibili' },
        getFeed: vi.fn(async () => [makeItem({ id: 'bili_1', source: 'bilibili' })]),
      }));

      const items = await registry.getAggregatedFeed();
      expect(items).toHaveLength(1);
      expect(items[0].source).toBe('bilibili');
    });

    it('skips providers that throw in getFeed', async () => {
      const registry = new ContentProviderRegistry();
      registry.register(makeProvider({
        meta: { name: 'reddit' },
        getFeed: vi.fn(async () => { throw new Error('API error'); }),
      }));
      registry.register(makeProvider({
        meta: { name: 'bilibili' },
        getFeed: vi.fn(async () => [makeItem({ id: 'bili_1', source: 'bilibili' })]),
      }));

      const items = await registry.getAggregatedFeed();
      expect(items).toHaveLength(1);
      expect(items[0].source).toBe('bilibili');
    });

    it('deduplicates items by id', async () => {
      const registry = new ContentProviderRegistry();
      registry.register(makeProvider({
        meta: { name: 'provider_a' },
        getFeed: vi.fn(async () => [
          makeItem({ id: 'shared_1', source: 'a', title: 'First copy' }),
          makeItem({ id: 'unique_a', source: 'a', title: 'Unique A' }),
        ]),
      }));
      registry.register(makeProvider({
        meta: { name: 'provider_b' },
        getFeed: vi.fn(async () => [
          makeItem({ id: 'shared_1', source: 'b', title: 'Second copy' }),
          makeItem({ id: 'unique_b', source: 'b', title: 'Unique B' }),
        ]),
      }));

      const items = await registry.getAggregatedFeed();
      expect(items).toHaveLength(3); // shared_1 (first seen wins) + unique_a + unique_b
      const ids = items.map(i => i.id);
      expect(ids).toContain('shared_1');
      expect(ids).toContain('unique_a');
      expect(ids).toContain('unique_b');
      // First-seen wins for duplicate
      const shared = items.find(i => i.id === 'shared_1');
      expect(shared!.source).toBe('a');
    });

    it('filters by platforms option', async () => {
      const registry = new ContentProviderRegistry();
      registry.register(makeProvider({
        meta: { name: 'reddit' },
        getFeed: vi.fn(async () => [makeItem({ id: 'r1', source: 'reddit' })]),
      }));
      registry.register(makeProvider({
        meta: { name: 'bilibili' },
        getFeed: vi.fn(async () => [makeItem({ id: 'b1', source: 'bilibili' })]),
      }));
      registry.register(makeProvider({
        meta: { name: 'dailyhot' },
        getFeed: vi.fn(async () => [makeItem({ id: 'd1', source: 'dailyhot' })]),
      }));

      const items = await registry.getAggregatedFeed({ platforms: ['reddit', 'dailyhot'] });
      expect(items).toHaveLength(2);
      expect(items.map(i => i.source)).toEqual(
        expect.arrayContaining(['reddit', 'dailyhot'])
      );
    });

    it('passes limit option to providers', async () => {
      const getFeed = vi.fn(async () => [makeItem({ id: 'r1', source: 'reddit' })]);
      const registry = new ContentProviderRegistry();
      registry.register(makeProvider({
        meta: { name: 'reddit' },
        getFeed,
      }));

      await registry.getAggregatedFeed({ limit: 5 });
      expect(getFeed).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
    });

    it('passes keywords option to providers', async () => {
      const getFeed = vi.fn(async () => []);
      const registry = new ContentProviderRegistry();
      registry.register(makeProvider({
        meta: { name: 'reddit' },
        getFeed,
      }));

      await registry.getAggregatedFeed({ keywords: ['cosplay', 'anime'] });
      expect(getFeed).toHaveBeenCalledWith(
        expect.objectContaining({ keywords: ['cosplay', 'anime'] })
      );
    });

    it('returns empty array when no providers registered', async () => {
      const registry = new ContentProviderRegistry();
      const items = await registry.getAggregatedFeed();
      expect(items).toEqual([]);
    });

    it('returns empty array when all providers are unavailable', async () => {
      const registry = new ContentProviderRegistry();
      registry.register(makeProvider({
        meta: { name: 'reddit' },
        isAvailable: vi.fn(async () => false),
      }));

      const items = await registry.getAggregatedFeed();
      expect(items).toEqual([]);
    });
  });

  // ── search ───────────────────────────────────────────────────

  describe('search', () => {
    it('searches across all available providers', async () => {
      const registry = new ContentProviderRegistry();
      registry.register(makeProvider({
        meta: { name: 'reddit' },
        search: vi.fn(async () => [
          makeItem({ id: 'r1', source: 'reddit', title: 'Reddit result' }),
        ]),
      }));
      registry.register(makeProvider({
        meta: { name: 'bilibili' },
        search: vi.fn(async () => [
          makeItem({ id: 'b1', source: 'bilibili', title: 'Bilibili result' }),
        ]),
      }));

      const items = await registry.search('cosplay');
      expect(items).toHaveLength(2);
    });

    it('passes keyword and options to providers', async () => {
      const searchFn = vi.fn(async () => []);
      const registry = new ContentProviderRegistry();
      registry.register(makeProvider({
        meta: { name: 'reddit' },
        search: searchFn,
      }));

      await registry.search('cosplay', { limit: 10 });
      expect(searchFn).toHaveBeenCalledWith('cosplay', { limit: 10 });
    });

    it('skips unavailable providers in search', async () => {
      const registry = new ContentProviderRegistry();
      registry.register(makeProvider({
        meta: { name: 'reddit' },
        isAvailable: vi.fn(async () => false),
        search: vi.fn(async () => [makeItem({ id: 'r1', source: 'reddit' })]),
      }));
      registry.register(makeProvider({
        meta: { name: 'bilibili' },
        search: vi.fn(async () => [makeItem({ id: 'b1', source: 'bilibili' })]),
      }));

      const items = await registry.search('test');
      expect(items).toHaveLength(1);
      expect(items[0].source).toBe('bilibili');
    });

    it('deduplicates search results by id', async () => {
      const registry = new ContentProviderRegistry();
      registry.register(makeProvider({
        meta: { name: 'provider_a' },
        search: vi.fn(async () => [
          makeItem({ id: 'shared_1', source: 'a' }),
        ]),
      }));
      registry.register(makeProvider({
        meta: { name: 'provider_b' },
        search: vi.fn(async () => [
          makeItem({ id: 'shared_1', source: 'b' }),
          makeItem({ id: 'unique_b', source: 'b' }),
        ]),
      }));

      const items = await registry.search('test');
      expect(items).toHaveLength(2);
    });

    it('filters search by platforms option', async () => {
      const registry = new ContentProviderRegistry();
      registry.register(makeProvider({
        meta: { name: 'reddit' },
        search: vi.fn(async () => [makeItem({ id: 'r1', source: 'reddit' })]),
      }));
      registry.register(makeProvider({
        meta: { name: 'bilibili' },
        search: vi.fn(async () => [makeItem({ id: 'b1', source: 'bilibili' })]),
      }));

      const items = await registry.search('cosplay', { platforms: ['bilibili'] });
      expect(items).toHaveLength(1);
      expect(items[0].source).toBe('bilibili');
    });

    it('skips providers that throw in search', async () => {
      const registry = new ContentProviderRegistry();
      registry.register(makeProvider({
        meta: { name: 'reddit' },
        search: vi.fn(async () => { throw new Error('search error'); }),
      }));
      registry.register(makeProvider({
        meta: { name: 'bilibili' },
        search: vi.fn(async () => [makeItem({ id: 'b1', source: 'bilibili' })]),
      }));

      const items = await registry.search('test');
      expect(items).toHaveLength(1);
      expect(items[0].source).toBe('bilibili');
    });

    it('returns empty array when no providers registered', async () => {
      const registry = new ContentProviderRegistry();
      const items = await registry.search('anything');
      expect(items).toEqual([]);
    });
  });
});
