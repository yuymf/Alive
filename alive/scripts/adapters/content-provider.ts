// alive/scripts/adapters/content-provider.ts
// ContentProvider unified interface + ContentProviderRegistry aggregator

// ── Types ─────────────────────────────────────────────────────

export interface ContentItem {
  id: string;           // Global unique ID (format: <source>_<platform_id>)
  source: string;       // Source identifier (e.g. 'reddit', 'bilibili', 'dailyhot:zhihu')
  title: string;
  url?: string;
  likes?: number;       // Unified popularity metric
  user?: string;
  tags?: string[];
  snippet?: string;     // Content summary
  timestamp?: string;   // ISO 8601
}

export interface ContentProviderMeta {
  name: string;         // Registry key (e.g. 'reddit')
  displayName: string;  // Display name (e.g. 'Reddit')
  type: 'trending' | 'social' | 'search' | 'aggregator';
}

export interface ContentProvider {
  readonly meta: ContentProviderMeta;
  isAvailable(): Promise<boolean>;
  getFeed(options?: { limit?: number; keywords?: string[] }): Promise<ContentItem[]>;
  search(keyword: string, options?: { limit?: number }): Promise<ContentItem[]>;
}

// ── Registry ──────────────────────────────────────────────────

export class ContentProviderRegistry {
  private providers: Map<string, ContentProvider> = new Map();

  /**
   * Register a provider. If a provider with the same name exists, it will be overwritten.
   */
  register(provider: ContentProvider): void {
    this.providers.set(provider.meta.name, provider);
  }

  /**
   * Get registered providers, optionally filtered by name list.
   */
  getProviders(filter?: string[]): ContentProvider[] {
    const all = Array.from(this.providers.values());
    if (!filter || filter.length === 0) return all;
    return all.filter(p => filter.includes(p.meta.name));
  }

  /**
   * Aggregate feed from all registered (and available) providers.
   * Uses Promise.allSettled for graceful degradation.
   */
  async getAggregatedFeed(options?: {
    platforms?: string[];
    limit?: number;
    keywords?: string[];
  }): Promise<ContentItem[]> {
    const providers = this.getProviders(options?.platforms);
    if (providers.length === 0) return [];

    // Check availability in parallel
    const availabilityResults = await Promise.allSettled(
      providers.map(async p => {
        const available = await p.isAvailable();
        return { provider: p, available };
      })
    );

    const availableProviders = availabilityResults
      .filter((r): r is PromiseFulfilledResult<{ provider: ContentProvider; available: boolean }> =>
        r.status === 'fulfilled' && r.value.available
      )
      .map(r => r.value.provider);

    if (availableProviders.length === 0) return [];

    // Fetch feeds in parallel
    const feedOptions: { limit?: number; keywords?: string[] } = {};
    if (options?.limit !== undefined) feedOptions.limit = options.limit;
    if (options?.keywords !== undefined) feedOptions.keywords = options.keywords;

    const feedResults = await Promise.allSettled(
      availableProviders.map(p => p.getFeed(feedOptions))
    );

    // Flatten and deduplicate by id
    const seen = new Set<string>();
    const items: ContentItem[] = [];

    for (const result of feedResults) {
      if (result.status === 'fulfilled') {
        for (const item of result.value) {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            items.push(item);
          }
        }
      } else {
        console.warn('[ContentProviderRegistry] Provider feed failed:', result.reason);
      }
    }

    return items;
  }

  /**
   * Search across all registered (and available) providers.
   * Uses Promise.allSettled for graceful degradation.
   */
  async search(keyword: string, options?: {
    platforms?: string[];
    limit?: number;
  }): Promise<ContentItem[]> {
    const providers = this.getProviders(options?.platforms);
    if (providers.length === 0) return [];

    // Check availability in parallel
    const availabilityResults = await Promise.allSettled(
      providers.map(async p => {
        const available = await p.isAvailable();
        return { provider: p, available };
      })
    );

    const availableProviders = availabilityResults
      .filter((r): r is PromiseFulfilledResult<{ provider: ContentProvider; available: boolean }> =>
        r.status === 'fulfilled' && r.value.available
      )
      .map(r => r.value.provider);

    if (availableProviders.length === 0) return [];

    // Search in parallel
    const searchOptions: { limit?: number } = {};
    if (options?.limit !== undefined) searchOptions.limit = options.limit;

    const searchResults = await Promise.allSettled(
      availableProviders.map(p => p.search(keyword, searchOptions))
    );

    // Flatten and deduplicate by id
    const seen = new Set<string>();
    const items: ContentItem[] = [];

    for (const result of searchResults) {
      if (result.status === 'fulfilled') {
        for (const item of result.value) {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            items.push(item);
          }
        }
      } else {
        console.warn('[ContentProviderRegistry] Provider search failed:', result.reason);
      }
    }

    return items;
  }
}
