/**
 * instagram-bridge-client.ts
 * Thin client for calling the Python instagram-bridge.py script.
 * Extracted to avoid circular dependency between post-pipeline and inspiration-collector.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { now } from './time-utils';

function mockInstagramResponse(command: string): unknown {
  const ts = now().getTime();
  switch (command) {
    case 'upload_photo':
      return { media_pk: `mock_${ts}`, media_code: 'mock_code' };
    case 'upload_album':
      return { media_pk: `mock_album_${ts}`, media_code: 'mock_album_code' };
    case 'get_media_insights':
      return {
        likes: 15 + Math.floor(Math.random() * 30),
        comments: 2 + Math.floor(Math.random() * 5),
        reach: 200 + Math.floor(Math.random() * 300),
      };
    case 'hashtag_top':
      return {
        hashtag: 'mock_tag',
        posts: [
          { pk: 'mock_pk_1', code: 'mock_code_1', like_count: 500, comment_count: 10, caption_text: 'Amazing cosplay! #cosplay', thumbnail_url: null },
          { pk: 'mock_pk_2', code: 'mock_code_2', like_count: 300, comment_count: 5, caption_text: 'Daily OOTD #fashion', thumbnail_url: null },
        ],
      };
    case 'get_comments':
      return [];
    case 'get_user_feed':
      return [];
    case 'reply_comment':
      return { success: true, comment_pk: 'mock_reply_pk' };
    case 'post_comment':
      return { success: true, comment_pk: 'mock_comment_pk' };
    case 'get_user_info':
      return { follower_count: 150, following_count: 200, media_count: 10 };
    default:
      console.log(`[MOCK] Unhandled Instagram command: ${command}`);
      return {};
  }
}

/**
 * Call the Python instagram-bridge.py script with a subcommand and args.
 * Returns parsed JSON from stdout.
 */
export function callInstagramBridge(command: string, args: Record<string, string>): Promise<unknown> {
  if (process.env.E2E_MOCK_INSTAGRAM === '1') {
    return Promise.resolve(mockInstagramResponse(command));
  }
  return new Promise((resolve, reject) => {
    // Resolve bridge path: works both in installed context (__dirname = scripts/)
    // and development context (__dirname = dist/, bridge at skill/scripts/)
    let bridgePath = path.join(__dirname, 'instagram-bridge.py');
    if (!fs.existsSync(bridgePath)) {
      bridgePath = path.join(__dirname, '..', 'skill', 'scripts', 'instagram-bridge.py');
    }
    if (!fs.existsSync(bridgePath)) {
      return reject(new Error(`instagram-bridge.py not found (tried __dirname and skill/scripts/)`));
    }

    const cliArgs = [bridgePath, command];
    for (const [key, value] of Object.entries(args)) {
      cliArgs.push(`--${key}`, value);
    }

    execFile('python3', cliArgs, { timeout: 120_000 }, (error, stdout, stderr) => {
      if (stderr) console.error(`[ig-bridge] ${stderr.trim()}`);
      if (error) {
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.error) return reject(new Error(parsed.error));
        } catch {
          if (stdout) console.error(`[ig-bridge] Unparseable stdout: ${stdout.slice(0, 200)}`);
        }
        return reject(new Error(`instagram-bridge ${command} failed: ${error.message}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Failed to parse bridge output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

/**
 * Upload a carousel/album post to Instagram.
 * @param imagePaths Array of local image file paths
 * @param caption Post caption text
 * @returns media_pk of the created post
 */
export async function uploadAlbum(imagePaths: string[], caption: string): Promise<string> {
  const result = await callInstagramBridge('upload_album', {
    images: JSON.stringify(imagePaths),
    caption,
  });
  return (result as { media_pk: string }).media_pk;
}

// ── Types for new engagement commands ──────────────────────────────────────

export interface InstagramComment {
  comment_pk: string;
  user_id: string;
  username: string;
  text: string;
  created_at: string | null;
  like_count: number;
}

export interface InstagramMediaSummary {
  media_pk: string;
  caption: string;
  like_count: number;
  comment_count: number;
  taken_at: string | null;
}

export interface CommentResult {
  success: boolean;
  comment_pk: string;
}

// ── Wrapper functions ───────────────────────────────────────────────────────

export async function getComments(mediaPk: string, amount = 20): Promise<InstagramComment[]> {
  const result = await callInstagramBridge('get_comments', {
    'media-pk': mediaPk,
    amount: String(amount),
  });
  return result as InstagramComment[];
}

export async function replyComment(mediaPk: string, commentPk: string, text: string): Promise<CommentResult> {
  const result = await callInstagramBridge('reply_comment', {
    'media-pk': mediaPk,
    'comment-pk': commentPk,
    text,
  });
  return result as CommentResult;
}

export async function postComment(mediaPk: string, text: string): Promise<CommentResult> {
  const result = await callInstagramBridge('post_comment', {
    'media-pk': mediaPk,
    text,
  });
  return result as CommentResult;
}

export async function getUserFeed(userId: string, amount = 5): Promise<InstagramMediaSummary[]> {
  const result = await callInstagramBridge('get_user_feed', {
    'user-id': userId,
    amount: String(amount),
  });
  return result as InstagramMediaSummary[];
}

export async function hashtagTop(name: string, amount = 15): Promise<unknown> {
  return callInstagramBridge('hashtag_top', { name, amount: String(amount) });
}
