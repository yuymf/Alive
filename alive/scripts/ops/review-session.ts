/**
 * review-session.ts
 * Lightweight persistence for the "active review item" — the queue item
 * the user is currently looking at / reviewing.
 *
 * Storage: {MEMORY_BASE}/review-session.json
 */

import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import * as path from 'path';

interface ReviewSession {
  active_item_id: string | null;
  updated_at: string | null;
}

const DEFAULT_SESSION: ReviewSession = { active_item_id: null, updated_at: null };

function getSessionPath(): string {
  return path.join(path.dirname(PATHS.reviewQueue), 'review-session.json');
}

export function getActiveReviewItem(): string | null {
  const session = readJSON<ReviewSession>(getSessionPath(), DEFAULT_SESSION);
  return session.active_item_id;
}

export function setActiveReviewItem(itemId: string | null): void {
  const session: ReviewSession = {
    active_item_id: itemId,
    updated_at: new Date().toISOString(),
  };
  writeJSON(getSessionPath(), session);
}
