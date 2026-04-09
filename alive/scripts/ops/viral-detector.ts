/**
 * viral-detector.ts
 * Filters a list of trend/competitor items, returning those that are
 * viral candidates (likes > threshold, not already in KB or queue).
 *
 * Pure function: does not write to disk. Callers decide what to do with results.
 */

import { loadEntries, loadQueue, buildEntryId } from './viral-kb-store';
import { DissectQueueItem, ViralPlatform, ViralSourceType } from '../utils/types';
import { wallNow } from '../utils/time-utils';

// ─── Input type ───────────────────────────────────────────────────────────────

/** Minimal representation of a trend or competitor post item. */
export interface TrendLikeItem {
  /** Unique identifier on the source platform. */
  source_id: string;
  platform: ViralPlatform;
  title: string;
  description: string;
  likes: number;
  comments: number;
  shares: number;
  source_type: ViralSourceType;
  identity_mode?: string;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Filter items to viral candidates.
 *
 * An item is a candidate if:
 * 1. `likes > threshold`
 * 2. Its id is not already in the entries store (already dissected / being tracked)
 * 3. Its id is not already in the dissect queue (preventing duplicate queueing)
 *
 * Returns a ready-to-enqueue list of DissectQueueItem (does NOT write to disk).
 */
export function detectViral(
  items: TrendLikeItem[],
  basePath: string,
  threshold: number,
): DissectQueueItem[] {
  if (items.length === 0) return [];

  const existingIds = new Set(loadEntries(basePath).map(e => e.id));
  const queuedIds = new Set(loadQueue(basePath).map(q => q.id));

  const candidates: DissectQueueItem[] = [];
  const seenInBatch = new Set<string>();

  for (const item of items) {
    if (item.likes <= threshold) continue;

    const id = buildEntryId(item.platform, item.source_id);
    if (existingIds.has(id)) continue;
    if (queuedIds.has(id)) continue;
    if (seenInBatch.has(id)) continue;

    seenInBatch.add(id);

    const queueItem: DissectQueueItem = {
      id,
      platform: item.platform,
      source_id: item.source_id,
      source_type: item.source_type,
      title: item.title,
      description: item.description,
      likes: item.likes,
      comments: item.comments,
      shares: item.shares,
      queued_at: wallNow().toISOString(),
      ...(item.identity_mode ? { identity_mode: item.identity_mode } : {}),
    };

    candidates.push(queueItem);
  }

  return candidates;
}
