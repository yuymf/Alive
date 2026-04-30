/**
 * review-queue.ts
 * CRUD for the ops desk review queue.
 * Storage: {MEMORY_BASE}/review-queue.json
 * Cleanup: published/discarded/expired items older than 7 days are removed.
 * Expiry: pending items older than PENDING_EXPIRE_HOURS are auto-expired.
 */

import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import { now } from '../utils/time-utils';
import { extractTrendHookKeyword } from '../utils/text-utils';
import {
  QueueItem, QueueItemStatus, IdentityMode, QueueItemContent,
  ReviewQueue, QueueItemTemplateSpec, QueueItemCompetitorBenchmark,
  QueueItemReviewFeedback, RiskLevel,
} from '../utils/types';

export { ReviewQueue };

export const DEFAULT_REVIEW_QUEUE: ReviewQueue = { items: [], last_updated: '' };

const CLEANUP_STATUSES: QueueItemStatus[] = ['published', 'discarded', 'expired'];
const CLEANUP_AGE_DAYS = 7;

/**
 * How many hours a pending item stays "active" before being auto-expired.
 * After this threshold, the item is marked 'expired' and no longer shown
 * in daily briefs — the operator likely isn't interested.
 */
export const PENDING_EXPIRE_HOURS = 48;

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
  image_prompts?: string[];
  risk_level?: RiskLevel;
  risk_detail?: string;
}

export async function addItem(input: AddItemInput): Promise<QueueItem> {
  // TODO: Wrap in withFileLock(PATHS.reviewQueue, ...) to prevent concurrent write races
  const queue = await loadQueue();

  // Dedup: check if same keyword + identity_mode already pending
  const inputKeyword = extractTrendHookKeyword(input.trend_hook);
  const existingItem = queue.items.find(
    i => i.status === 'pending'
      && extractTrendHookKeyword(i.trend_hook) === inputKeyword
      && i.identity_mode === input.identity_mode,
  );
  if (existingItem) {
    console.log(`[review-queue] Dedup: skipping duplicate keyword "${inputKeyword}" (existing id: ${existingItem.id})`);
    return existingItem;
  }

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
    ...(input.image_prompts?.length ? { image_prompts: input.image_prompts } : {}),
    ...(input.risk_level ? { risk_level: input.risk_level } : {}),
    ...(input.risk_detail ? { risk_detail: input.risk_detail } : {}),
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
  // TODO: Wrap in withFileLock(PATHS.reviewQueue, ...) to prevent concurrent write races
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
  // TODO: Wrap in withFileLock(PATHS.reviewQueue, ...) to prevent concurrent write races
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

// ─── Pending expiry ──────────────────────────────────────────────────────────

/**
 * Calculate hours since an item was created.
 */
export function hoursSinceCreated(item: QueueItem): number {
  return (now().getTime() - new Date(item.created_at).getTime()) / (1000 * 60 * 60);
}

/**
 * Cleanup old items AND auto-expire stale pending items in a single pass.
 *
 * 1. Pending items older than PENDING_EXPIRE_HOURS → marked 'expired'
 * 2. Published/discarded/expired items older than CLEANUP_AGE_DAYS → removed
 *
 * This is called at the start of every brief cycle, so all downstream
 * consumers (brief, health-check) see an up-to-date queue.
 */
export async function cleanupOldItems(): Promise<void> {
  // TODO: Wrap in withFileLock(PATHS.reviewQueue, ...) to prevent concurrent write races
  const queue = await loadQueue();
  const cutoff = new Date(now().getTime() - CLEANUP_AGE_DAYS * 24 * 60 * 60 * 1000);
  const ts = now().toISOString();
  let expiredCount = 0;

  // Step 1: auto-expire stale pending items
  const withExpired = queue.items.map(item => {
    if (item.status !== 'pending') return item;
    if (hoursSinceCreated(item) >= PENDING_EXPIRE_HOURS) {
      expiredCount++;
      return { ...item, status: 'expired' as QueueItemStatus, updated_at: ts };
    }
    return item;
  });

  // Step 2: remove old published/discarded/expired items
  const filtered = withExpired.filter(item => {
    if (!CLEANUP_STATUSES.includes(item.status)) return true;
    return new Date(item.updated_at) > cutoff;
  });

  await saveQueue({ ...queue, items: filtered });

  if (expiredCount > 0) {
    console.log(`[review-queue] Auto-expired ${expiredCount} stale pending item(s) (>${PENDING_EXPIRE_HOURS}h)`);
  }
}

/**
 * Auto-expire pending items that have been sitting for longer than
 * PENDING_EXPIRE_HOURS. Returns the number of items expired.
 *
 * Standalone version — prefer cleanupOldItems() which does both
 * expiry and cleanup in one pass.
 */
export async function expireStalePendingItems(): Promise<number> {
  // TODO: Wrap in withFileLock(PATHS.reviewQueue, ...) to prevent concurrent write races
  const queue = await loadQueue();
  let expiredCount = 0;
  const ts = now().toISOString();
  const updatedItems = queue.items.map(item => {
    if (item.status !== 'pending') return item;
    if (hoursSinceCreated(item) >= PENDING_EXPIRE_HOURS) {
      expiredCount++;
      return { ...item, status: 'expired' as QueueItemStatus, updated_at: ts };
    }
    return item;
  });
  if (expiredCount > 0) {
    await saveQueue({ ...queue, items: updatedItems });
    console.log(`[review-queue] Auto-expired ${expiredCount} stale pending item(s) (>${PENDING_EXPIRE_HOURS}h)`);
  }
  return expiredCount;
}

/**
 * Get only "active" pending items — those still within the expiry window.
 * Use this for brief display instead of getPendingItems() to avoid
 * nagging the operator with stale topics.
 */
export async function getActivePendingItems(): Promise<QueueItem[]> {
  const queue = await loadQueue();
  return queue.items.filter(i =>
    i.status === 'pending' && hoursSinceCreated(i) < PENDING_EXPIRE_HOURS,
  );
}

// ─── Domain-level lifecycle APIs ─────────────────────────────────────────────
// These enforce valid state transitions and set the correct metadata fields.
// Callers should prefer these over the generic updateItemStatus().

/** Valid transitions: pending → approved, editing → approved, expired → approved (revive) */
export async function markApproved(id: string): Promise<QueueItem | null> {
  const item = await getItem(id);
  if (!item) return null;
  if (item.status !== 'pending' && item.status !== 'editing' && item.status !== 'expired') return null;
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
  // TODO: Wrap in withFileLock(PATHS.reviewQueue, ...) to prevent concurrent write races
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
  // TODO: Wrap in withFileLock(PATHS.reviewQueue, ...) to prevent concurrent write races
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

// ─── Structured Review Feedback ──────────────────────────────────────────────

export type { QueueItemReviewFeedback };

/**
 * Append a structured review feedback entry to a queue item.
 * Also updates `latest_review_summary` for quick display.
 * Can be called alongside or after markApproved / markDiscarded.
 */
export async function addReviewFeedback(
  id: string,
  feedback: Omit<QueueItemReviewFeedback, 'created_at'> & { created_at?: string },
): Promise<QueueItem | null> {
  // TODO: Wrap in withFileLock(PATHS.reviewQueue, ...) to prevent concurrent write races
  const queue = await loadQueue();
  const idx = queue.items.findIndex(i => i.id === id);
  if (idx === -1) return null;

  const existing = queue.items[idx];
  const ts = now().toISOString();
  const entry: QueueItemReviewFeedback = {
    ...feedback,
    created_at: feedback.created_at ?? ts,
  };

  const existingFeedback = existing.review_feedback ?? [];

  const updated: QueueItem = {
    ...existing,
    review_feedback: [...existingFeedback, entry],
    latest_review_summary: entry.reason_summary,
    updated_at: ts,
  };

  const newItems = [
    ...queue.items.slice(0, idx),
    updated,
    ...queue.items.slice(idx + 1),
  ];
  await saveQueue({ ...queue, items: newItems });

  // Update operator preference profile (fire-and-forget, non-blocking)
  try {
    const { updatePreferenceFromFeedback } = await import('./operator-preference');
    updatePreferenceFromFeedback(updated, entry);
  } catch {
    // operator-preference module not available, skip
  }

  return updated;
}

/**
 * Get aggregated review feedback for recent queue items.
 * Useful for brief-generator and strategy-engine context injection.
 */
export async function getRecentReviewLearning(maxItems = 10): Promise<{
  approveReasons: string[];
  discardReasons: string[];
  commonDeviationTags: string[];
  commonRiskTags: string[];
  improvementDirections: string[];
}> {
  const queue = await loadQueue();

  const recentItems = queue.items
    .filter(i => i.review_feedback && i.review_feedback.length > 0)
    .slice(-maxItems);

  // Build tag frequency maps using reduce (immutable accumulation)
  const approveReasons: string[] = [];
  const discardReasons: string[] = [];
  const deviationTagCounts: Record<string, number> = {};
  const riskTagCounts: Record<string, number> = {};
  const directions = new Set<string>();

  for (const item of recentItems) {
    for (const fb of item.review_feedback!) {
      if (fb.decision === 'approved' && fb.reason_summary) {
        approveReasons.push(fb.reason_summary);
      }
      if (fb.decision === 'discarded' && fb.reason_summary) {
        discardReasons.push(fb.reason_summary);
      }
      for (const tag of fb.persona_deviation_tags ?? []) {
        deviationTagCounts[tag] = (deviationTagCounts[tag] ?? 0) + 1;
      }
      for (const tag of fb.risk_tags ?? []) {
        riskTagCounts[tag] = (riskTagCounts[tag] ?? 0) + 1;
      }
      for (const dir of fb.improvement_directions ?? []) {
        directions.add(dir);
      }
    }
  }

  const sortedTags = (counts: Record<string, number>) =>
    Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k]) => k);

  return {
    approveReasons: approveReasons.slice(-5),
    discardReasons: discardReasons.slice(-5),
    commonDeviationTags: sortedTags(deviationTagCounts).slice(0, 10),
    commonRiskTags: sortedTags(riskTagCounts).slice(0, 10),
    improvementDirections: [...directions].slice(0, 10),
  };
}
