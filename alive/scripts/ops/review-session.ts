/**
 * review-session.ts
 * Lightweight persistence for the "active review item" — the queue item
 * the user is currently looking at / reviewing.
 *
 * Also tracks edit conversation history for the active item, enabling
 * multi-turn "operator says → AI rewrites → operator says again" workflows.
 *
 * Storage: {MEMORY_BASE}/review-session.json
 */

import { PATHS, readJSON, writeJSON } from '../utils/file-utils';
import * as path from 'path';

export interface EditTurn {
  role: 'operator' | 'ai';
  content: string;
  field?: string;
  timestamp: string;
}

interface ReviewSession {
  active_item_id: string | null;
  updated_at: string | null;
  /** Conversation-style edit history for the current active item */
  edit_conversation: EditTurn[];
}

const DEFAULT_SESSION: ReviewSession = { active_item_id: null, updated_at: null, edit_conversation: [] };

/** Max turns to keep in edit conversation (older turns are trimmed) */
const MAX_EDIT_TURNS = 20;

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
    // Reset conversation when switching items
    edit_conversation: [],
  };
  writeJSON(getSessionPath(), session);
}

/**
 * Get the edit conversation history for the current active item.
 */
export function getEditConversation(): EditTurn[] {
  const session = readJSON<ReviewSession>(getSessionPath(), DEFAULT_SESSION);
  return session.edit_conversation ?? [];
}

/**
 * Append a turn to the edit conversation for the current active item.
 */
export function appendEditTurn(turn: Omit<EditTurn, 'timestamp'>): void {
  const session = readJSON<ReviewSession>(getSessionPath(), DEFAULT_SESSION);
  const conversation = session.edit_conversation ?? [];

  conversation.push({ ...turn, timestamp: new Date().toISOString() });

  // Trim to max turns
  const trimmed = conversation.slice(-MAX_EDIT_TURNS);

  writeJSON(getSessionPath(), {
    ...session,
    edit_conversation: trimmed,
    updated_at: new Date().toISOString(),
  });
}

/**
 * Build a context string from edit conversation for LLM prompt injection.
 * Returns empty string if no conversation history.
 */
export function buildEditConversationContext(): string {
  const turns = getEditConversation();
  if (turns.length === 0) return '';

  const lines = ['【之前的修改对话】'];
  for (const turn of turns) {
    const prefix = turn.role === 'operator' ? '运营' : 'AI';
    const fieldHint = turn.field ? `[${turn.field}]` : '';
    lines.push(`${prefix}${fieldHint}：${turn.content}`);
  }
  return lines.join('\n');
}
