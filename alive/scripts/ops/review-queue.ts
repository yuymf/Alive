/**
 * review-queue.ts
 * CRUD for the ops desk review queue.
 * Storage: {MEMORY_BASE}/review-queue.json
 * Cleanup: published/discarded items older than 7 days are removed.
 */

import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now } from '../utils/time-utils';
import {
  QueueItem, QueueItemStatus, IdentityMode, QueueItemContent,
  ReviewQueue, QueueItemTemplateSpec, QueueItemCompetitorBenchmark,
} from '../utils/types';

export { ReviewQueue };

export const DEFAULT_REVIEW_QUEUE: ReviewQueue = { items: [], last_updated: '' };

const CLEANUP_STATUSES: QueueItemStatus[] = ['published', 'discarded'];
const CLEANUP_AGE_DAYS = 7;

function generateId(): string {
  return `q_${now().getTime()}_${Math.random().toString(36).slice(2, 7)}`;
}

export async function loadQueue(): Promise<ReviewQueue> {
  return readJSON<ReviewQueue>(PATHS.reviewQueue, DEFAULT_REVIEW_QUEUE);
}

export async function saveQueue(queue: ReviewQueue): Promise<void> {
  const updated: ReviewQueue = {
    ...queue,
    last_updated: now().toISOString(),
  };
  await writeJSON(PATHS.reviewQueue, updated);
}

export interface AddItemInput {
  topic: string;
  trend_hook: string;
  identity_mode: IdentityMode;
  content: QueueItemContent;
  template_spec?: QueueItemTemplateSpec;
  competitor_benchmarks?: QueueItemCompetitorBenchmark[];
}

export async function addItem(input: AddItemInput): Promise<QueueItem> {
  const queue = await loadQueue();
  const ts = now().toISOString();
  const item: QueueItem = {
    id: generateId(),
    status: 'pending',
    topic: input.topic,
    trend_hook: input.trend_hook,
    identity_mode: input.identity_mode,
    created_at: ts,
    updated_at: ts,
    content: input.content,
    edit_history: [],
    ...(input.template_spec ? { template_spec: input.template_spec } : {}),
    ...(input.competitor_benchmarks ? { competitor_benchmarks: input.competitor_benchmarks } : {}),
  };
  await saveQueue({ ...queue, items: [...queue.items, item] });
  return item;
}

export async function getItem(id: string): Promise<QueueItem | null> {
  const queue = await loadQueue();
  return queue.items.find(i => i.id === id) ?? null;
}

export async function updateItemStatus(
  id: string,
  status: QueueItemStatus,
): Promise<QueueItem | null> {
  const queue = await loadQueue();
  const idx = queue.items.findIndex(i => i.id === id);
  if (idx === -1) return null;
  const updated: QueueItem = {
    ...queue.items[idx],
    status,
    updated_at: now().toISOString(),
  };
  const newItems = [
    ...queue.items.slice(0, idx),
    updated,
    ...queue.items.slice(idx + 1),
  ];
  await saveQueue({ ...queue, items: newItems });
  return updated;
}

export async function updateItemContent(
  id: string,
  content: Partial<QueueItemContent>,
  editEntry: { instruction: string; field: string },
): Promise<QueueItem | null> {
  const queue = await loadQueue();
  const idx = queue.items.findIndex(i => i.id === id);
  if (idx === -1) return null;
  const existing = queue.items[idx];
  const ts = now().toISOString();
  const updated: QueueItem = {
    ...existing,
    content: { ...existing.content, ...content },
    updated_at: ts,
    edit_history: [
      ...existing.edit_history,
      { timestamp: ts, ...editEntry },
    ],
  };
  const newItems = [
    ...queue.items.slice(0, idx),
    updated,
    ...queue.items.slice(idx + 1),
  ];
  await saveQueue({ ...queue, items: newItems });
  return updated;
}

export async function getPendingItems(): Promise<QueueItem[]> {
  const queue = await loadQueue();
  return queue.items.filter(i => i.status === 'pending');
}

/**
 * Get all published items that have at least one URL.
 */
export async function getPublishedItemsWithUrls(): Promise<QueueItem[]> {
  const queue = await loadQueue();
  return queue.items.filter(item =>
    item.status === 'published' &&
    item.published_urls &&
    (item.published_urls.xhs || item.published_urls.douyin),
  );
}

export async function cleanupOldItems(): Promise<void> {
  const queue = await loadQueue();
  const cutoff = new Date(now().getTime() - CLEANUP_AGE_DAYS * 24 * 60 * 60 * 1000);
  const filtered = queue.items.filter(item => {
    if (!CLEANUP_STATUSES.includes(item.status)) return true;
    return new Date(item.updated_at) > cutoff;
  });
  await saveQueue({ ...queue, items: filtered });
}

// ─── Domain-level lifecycle APIs ─────────────────────────────────────────────
// These enforce valid state transitions and set the correct metadata fields.
// Callers should prefer these over the generic updateItemStatus().

/** Valid transitions: pending → approved, editing → approved */
export async function markApproved(id: string): Promise<QueueItem | null> {
  const item = await getItem(id);
  if (!item) return null;
  if (item.status !== 'pending' && item.status !== 'editing') return null;
  return updateItemStatus(id, 'approved');
}

/** Valid transitions: pending → discarded, approved → discarded, editing → discarded */
export async function markDiscarded(id: string): Promise<QueueItem | null> {
  const item = await getItem(id);
  if (!item) return null;
  if (item.status === 'published' || item.status === 'discarded') return null;
  return updateItemStatus(id, 'discarded');
}

export interface MarkPublishedInput {
  platform: 'xhs' | 'douyin';
  url: string;
  publishedAt?: string;
}

/**
 * Mark a queue item as published on a specific platform.
 * - Merges URLs per platform (calling twice with xhs then douyin is supported).
 * - Sets published_at on first publish.
 * - Sets performance_tracked = false so the performance cron picks it up.
 * Valid transitions: pending → published, approved → published (already published items can add more URLs).
 */
export async function markPublished(id: string, input: MarkPublishedInput): Promise<QueueItem | null> {
  const queue = await loadQueue();
  const idx = queue.items.findIndex(i => i.id === id);
  if (idx === -1) return null;

  const existing = queue.items[idx];
  if (existing.status === 'discarded') return null;

  const ts = now().toISOString();
  const existingUrls = existing.published_urls ?? {};
  const mergedUrls = { ...existingUrls, [input.platform]: input.url };

  const updated: QueueItem = {
    ...existing,
    status: 'published',
    published_urls: mergedUrls,
    published_at: existing.published_at ?? input.publishedAt ?? ts,
    performance_tracked: existing.performance_tracked ?? false,
    updated_at: ts,
  };

  const newItems = [
    ...queue.items.slice(0, idx),
    updated,
    ...queue.items.slice(idx + 1),
  ];
  await saveQueue({ ...queue, items: newItems });
  return updated;
}

/** Mark that performance tracking has started for this published item. */
export async function markPerformanceTracked(id: string): Promise<QueueItem | null> {
  const queue = await loadQueue();
  const idx = queue.items.findIndex(i => i.id === id);
  if (idx === -1) return null;

  const existing = queue.items[idx];
  if (existing.status !== 'published') return null;

  const updated: QueueItem = {
    ...existing,
    performance_tracked: true,
    updated_at: now().toISOString(),
  };

  const newItems = [
    ...queue.items.slice(0, idx),
    updated,
    ...queue.items.slice(idx + 1),
  ];
  await saveQueue({ ...queue, items: newItems });
  return updated;
}
