/**
 * xhs-client.ts
 * Thin CLI client for xiaohongshu-skills Python scripts.
 * Migrated from skill/scripts/xhs-bridge-client.ts
 *
 * Changes from skill version:
 * - Renamed file from xhs-bridge-client.ts to xhs-client.ts
 * - No import path changes (self-contained module)
 *
 * Follows the same subprocess pattern as instagram-bridge —
 * spawns `uv run python cli.py <command>` and parses JSON from stdout.
 *
 * The CLI outputs camelCase JSON; this module normalises it to the
 * snake_case interfaces that inspiration-collector.ts expects.
 */

import * as path from 'path';
import { execFile } from 'child_process';

const XHS_CLI_TIMEOUT = 30_000;

export interface XhsNote {
  id: string;
  xsec_token: string;
  title: string;
  description: string;
  likes: number;
  user: string;
  tags: string[];
}

export interface XhsNoteDetail extends XhsNote {
  comments: Array<{ user: string; content: string; likes: number }>;
  images: string[];
  collected_count: number;
  share_count: number;
}

export interface XhsSearchOptions {
  sortBy?: string;
  noteType?: string;
  publishTime?: string;
  searchScope?: string;
  location?: string;
}

function resolveXhsDir(): string {
  const envDir = process.env.XHS_SKILLS_DIR;
  if (envDir) return envDir;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return path.join(home, '.openclaw', 'skills', 'xiaohongshu-skills');
}

function callXhsCli(command: string, args: string[] = []): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhsDir = resolveXhsDir();
    const cliPath = path.join(xhsDir, 'scripts', 'cli.py');
    // Use `uv run --directory <dir> python` so the .venv is auto-activated
    const uvArgs = ['run', '--directory', xhsDir, 'python', cliPath, command, ...args];

    execFile('uv', uvArgs, { timeout: XHS_CLI_TIMEOUT }, (error, stdout, stderr) => {
      if (stderr) console.error(`[xhs-bridge] ${stderr.trim()}`);
      if (error) {
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.error) return reject(new Error(parsed.error));
        } catch {
          if (stdout) console.error(`[xhs-bridge] Unparseable stdout: ${stdout.slice(0, 200)}`);
        }
        return reject(new Error(`xhs-bridge ${command} failed: ${error.message}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Failed to parse xhs-bridge output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

// ─── CLI → interface mapping ─────────────────────────────────

/**
 * Parse a Chinese-style count string like "3.4万" or "52" into a number.
 * Returns 0 for empty/unparseable strings.
 */
function parseCount(s: unknown): number {
  const str = String(s ?? '').trim();
  if (!str) return 0;
  const wanMatch = str.match(/^([\d.]+)\s*万$/);
  if (wanMatch) return Math.round(parseFloat(wanMatch[1]) * 10000);
  const num = parseInt(str, 10);
  return Number.isNaN(num) ? 0 : num;
}

/** Map a single CLI feed object to XhsNote. */
function mapFeedToNote(raw: Record<string, unknown>): XhsNote {
  const interact = (raw.interactInfo ?? {}) as Record<string, unknown>;
  const userObj = (raw.user ?? {}) as Record<string, unknown>;
  return {
    id: String(raw.id ?? ''),
    xsec_token: String(raw.xsecToken ?? ''),
    title: String(raw.displayTitle ?? ''),
    description: String(raw.displayTitle ?? ''),
    likes: parseCount(interact.likedCount),
    user: String(userObj.nickname ?? ''),
    tags: [],  // CLI feed does not include tags
  };
}

/** Map a CLI feed-detail response to XhsNoteDetail. */
function mapDetailToNoteDetail(raw: Record<string, unknown>): XhsNoteDetail {
  // get-feed-detail wraps the note inside { note: {...}, comments: [...] }
  const note = (raw.note ?? raw) as Record<string, unknown>;
  const rawComments = (raw.comments ?? []) as Array<Record<string, unknown>>;

  const interact = (note.interactInfo ?? {}) as Record<string, unknown>;
  const userObj = (note.user ?? {}) as Record<string, unknown>;
  const imageList = (note.imageList ?? []) as Array<Record<string, unknown>>;

  const comments = rawComments.map(c => {
    const cUser = (c.user ?? {}) as Record<string, unknown>;
    return {
      user: String(cUser.nickname ?? ''),
      content: String(c.content ?? ''),
      likes: parseCount(c.likeCount),
    };
  });

  return {
    id: String(note.noteId ?? ''),
    xsec_token: '',
    title: String(note.title ?? ''),
    description: String(note.desc ?? ''),
    likes: parseCount(interact.likedCount),
    user: String(userObj.nickname ?? ''),
    tags: [],
    comments,
    images: imageList.map(img => String(img.urlDefault ?? '')),
    collected_count: parseCount(interact.collectedCount),
    share_count: parseCount(interact.sharedCount),
  };
}

// ─── Public API ──────────────────────────────────────────────

/** Check if xiaohongshu-skills CLI is available and logged in. */
export async function isXhsAvailable(): Promise<boolean> {
  if (process.env.E2E_MOCK_XHS === '1') return false;
  try {
    await callXhsCli('check-login');
    return true;
  } catch {
    return false;
  }
}

/** Homepage recommendation feed — different content each call. */
export async function listXhsFeed(): Promise<XhsNote[]> {
  const result = await callXhsCli('list-feeds') as Record<string, unknown>;
  const feeds = (result.feeds ?? []) as Array<Record<string, unknown>>;
  return feeds.map(mapFeedToNote);
}

/** Keyword search. */
export async function searchXhsNotes(keyword: string, options: XhsSearchOptions = {}): Promise<XhsNote[]> {
  const args = ['--keyword', keyword];
  if (options.sortBy) args.push('--sort-by', options.sortBy);
  if (options.noteType) args.push('--note-type', options.noteType);
  if (options.publishTime) args.push('--publish-time', options.publishTime);
  if (options.searchScope) args.push('--search-scope', options.searchScope);
  if (options.location) args.push('--location', options.location);

  const result = await callXhsCli('search-feeds', args) as Record<string, unknown>;
  const feeds = (result.feeds ?? []) as Array<Record<string, unknown>>;
  return feeds.map(mapFeedToNote);
}

/** Full note detail with comments. */
export async function getXhsNoteDetail(noteId: string, xsecToken: string): Promise<XhsNoteDetail> {
  const result = await callXhsCli('get-feed-detail', ['--feed-id', noteId, '--xsec-token', xsecToken]);
  return mapDetailToNoteDetail(result as Record<string, unknown>);
}
