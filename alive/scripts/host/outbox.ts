// Writes proactive messages for the host Code Agent to deliver.
// Skills cannot assume a chat bus; the agent reads outbox on conversation start.

import * as fs from 'fs';
import * as path from 'path';
import { PATHS } from '../utils/file-utils';

export interface OutboxItem {
  id: string;
  created_at: string;
  kind: 'text' | 'media';
  text?: string;
  mediaPath?: string;
}

function outboxDir(): string {
  return PATHS.outboxDir;
}

export function deliverText(text: string): boolean {
  return writeItem({ kind: 'text', text });
}

export function deliverMedia(mediaPath: string, text?: string): boolean {
  return writeItem({ kind: 'media', mediaPath, text });
}

export function listOutbox(): OutboxItem[] {
  const dir = outboxDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as OutboxItem;
      } catch {
        return null;
      }
    })
    .filter((item): item is OutboxItem => item !== null);
}

/** Return pending items and delete the files so the host delivers them once. */
export function consumeOutbox(): OutboxItem[] {
  const dir = outboxDir();
  if (!fs.existsSync(dir)) return [];
  const items = listOutbox();
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    fs.unlinkSync(path.join(dir, name));
  }
  return items;
}

function writeItem(partial: Omit<OutboxItem, 'id' | 'created_at'>): boolean {
  try {
    const dir = outboxDir();
    fs.mkdirSync(dir, { recursive: true });
    const created_at = new Date().toISOString();
    const id = created_at.replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 8);
    const item: OutboxItem = { id, created_at, ...partial };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(item, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`[outbox] write failed: ${(err as Error).message}`);
    return false;
  }
}
