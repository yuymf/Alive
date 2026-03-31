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
  ReviewQueue,
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

export async function cleanupOldItems(): Promise<void> {
  const queue = await loadQueue();
  const cutoff = new Date(now().getTime() - CLEANUP_AGE_DAYS * 24 * 60 * 60 * 1000);
  const filtered = queue.items.filter(item => {
    if (!CLEANUP_STATUSES.includes(item.status)) return true;
    return new Date(item.updated_at) > cutoff;
  });
  await saveQueue({ ...queue, items: filtered });
}
