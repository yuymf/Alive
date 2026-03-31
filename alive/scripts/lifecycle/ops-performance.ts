#!/usr/bin/env node
/**
 * ops-performance.ts
 * Cron entry: every-4h post-publication metrics collection.
 * For each published item with URLs, fetches platform metrics and appends a snapshot.
 * Framework-generic: exits early if persona.ops.enabled is false/absent.
 * Registered as: alive:ops-performance → ops-performance.js
 */

import { loadPersona } from '../persona/persona-loader';
import { setTimezone, wallNow } from '../utils/time-utils';
import { getPublishedItemsWithUrls } from '../ops/review-queue';
import { appendSnapshot, fetchMetrics, cleanupOldEntries } from '../ops/performance-tracker';

async function main(): Promise<void> {
  const persona = await loadPersona();
  const ops = persona.ops;

  if (!ops?.enabled) {
    console.log(`[${wallNow().toISOString()}] ops-performance: ops.enabled is false for ${persona.meta.id}, skipping`);
    return;
  }

  setTimezone(persona.schedule?.timezone ?? null);

  console.log(`[${wallNow().toISOString()}] ops-performance: starting for ${persona.meta.id}`);

  const publishedItems = await getPublishedItemsWithUrls();
  let snapshotCount = 0;

  for (const item of publishedItems) {
    if (!item.published_urls) continue;

    const platforms: Array<{ platform: 'xhs' | 'douyin'; url: string }> = [];
    if (item.published_urls.xhs) platforms.push({ platform: 'xhs', url: item.published_urls.xhs });
    if (item.published_urls.douyin) platforms.push({ platform: 'douyin', url: item.published_urls.douyin });

    for (const { platform, url } of platforms) {
      const metrics = fetchMetrics(platform, url);
      if (metrics) {
        appendSnapshot(
          {
            item_id: item.id,
            identity_mode: item.identity_mode,
            template_type: item.template_spec?.content_type ?? 'unknown',
            topic: item.topic,
            platform,
            url,
            published_at: item.published_at ?? item.updated_at,
            tags_used: platform === 'xhs' ? (item.content.xhs?.tags ?? []) : [],
          },
          metrics,
        );
        snapshotCount++;
      }
    }
  }

  cleanupOldEntries();

  console.log(`[${wallNow().toISOString()}] ops-performance: ${publishedItems.length} items checked, ${snapshotCount} snapshots appended`);
}

main().catch(err => {
  console.error(`[${wallNow().toISOString()}] ops-performance ERROR:`, err);
  process.exit(1);
});
