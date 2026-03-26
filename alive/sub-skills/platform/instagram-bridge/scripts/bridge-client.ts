/**
 * instagram-bridge/scripts/bridge-client.ts
 * Thin client for calling the Python instagram-bridge.py script.
 * Migrated from skill/scripts/instagram-bridge-client.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { now } from '../../../../scripts/utils/time-utils';

// === Mock responses for E2E testing ===

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
          {
            pk: 'mock_pk_1', code: 'mock_code_1',
            user_id: 'mock_user_1', username: 'mock_user_1_handle',
            like_count: 500, comment_count: 10,
            caption_text: 'Amazing cosplay! #cosplay',
            thumbnail_url: null,
            taken_at: new Date(ts - 2 * 60 * 60 * 1000).toISOString(),
          },
          {
            pk: 'mock_pk_2', code: 'mock_code_2',
            user_id: 'mock_user_2', username: 'mock_user_2_handle',
            like_count: 300, comment_count: 5,
            caption_text: 'Daily OOTD #fashion',
            thumbnail_url: null,
            taken_at: new Date(ts - 5 * 60 * 60 * 1000).toISOString(),
          },
        ],
      };
    case 'hashtag_recent':
      return {
        hashtag: 'mock_tag',
        posts: [
          {
            pk: 'recent_pk_1', code: 'recent_code_1',
            user_id: 'recent_user_1', username: 'recent_user_1_handle',
            like_count: 180, comment_count: 12,
            caption_text: 'Recent cosplay drop #cosplay',
            thumbnail_url: null,
            taken_at: new Date(ts - 30 * 60 * 1000).toISOString(),
          },
          {
            pk: 'recent_pk_2', code: 'recent_code_2',
            user_id: 'recent_user_2', username: 'recent_user_2_handle',
            like_count: 95, comment_count: 4,
            caption_text: 'Fresh mirror selfie #jfashion',
            thumbnail_url: null,
            taken_at: new Date(ts - 90 * 60 * 1000).toISOString(),
          },
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

// === Bridge call ===

/**
 * Call the Python instagram-bridge.py script with a subcommand and args.
 * Returns parsed JSON from stdout.
 */
export function callInstagramBridge(command: string, args: Record<string, string>): Promise<unknown> {
  if (process.env.E2E_MOCK_INSTAGRAM === '1') {
    return Promise.resolve(mockInstagramResponse(command));
  }
  return new Promise((resolve, reject) => {
    // Resolve python bridge relative to this file's directory
    let bridgePath = path.join(__dirname, 'instagram-bridge.py');
    if (!fs.existsSync(bridgePath)) {
      // Fallback: look in skill/ for backward compat during migration
      bridgePath = path.join(__dirname, '..', '..', '..', '..', '..', 'skill', 'scripts', 'instagram-bridge.py');
    }
    if (!fs.existsSync(bridgePath)) {
      return reject(new Error('instagram-bridge.py not found'));
    }

    const cliArgs = [bridgePath, command];
    for (const [key, value] of Object.entries(args)) {
      cliArgs.push(`--${key}`, value);
    }

    execFile('python3', cliArgs, { timeout: 120_000 }, (error, stdout, stderr) => {
      if (stderr) console.error(`[ig-bridge] ${stderr.trim()}`);

      let parsed: unknown = undefined;
      if (stdout) {
        try {
          parsed = JSON.parse(stdout);
        } catch {
          console.error(`[ig-bridge] Unparseable stdout: ${stdout.slice(0, 200)}`);
        }
      }

      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        return reject(new Error(`instagram-bridge ${command} failed: ${(parsed as { error: string }).error}`));
      }

      if (error) {
        return reject(new Error(`instagram-bridge ${command} failed: ${error.message}`));
      }

      if (parsed === undefined) {
        return reject(new Error(`Failed to parse bridge output: ${stdout.slice(0, 200)}`));
      }

      resolve(parsed);
    });
  });
}

// === Typed API Wrappers ===

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

export interface InstagramHashtagPost {
  pk: string;
  code: string;
  user_id: string;
  username: string;
  like_count: number;
  comment_count: number;
  caption_text: string;
  thumbnail_url?: string | null;
  taken_at: string | null;
}

export interface InstagramHashtagResult {
  hashtag: string;
  posts: InstagramHashtagPost[];
}

export interface CommentResult {
  success: boolean;
  comment_pk: string;
}

/**
 * Upload a single photo to Instagram.
 */
export async function uploadPhoto(imagePath: string, caption: string): Promise<string> {
  const result = await callInstagramBridge('upload_photo', {
    image: imagePath,
    caption,
  });
  return (result as { media_pk: string }).media_pk;
}

/**
 * Upload a carousel/album post to Instagram.
 * Automatically falls back to single photo upload when only 1 image is provided,
 * because configure_sidecar (album API) is unreliable for single-image posts
 * and can return 500 errors that corrupt the post on desktop.
 */
export async function uploadAlbum(imagePaths: string[], caption: string): Promise<string> {
  // Single image: use upload_photo instead of album (avoids configure_sidecar 500 errors)
  if (imagePaths.length === 1) {
    return uploadPhoto(imagePaths[0], caption);
  }

  const result = await callInstagramBridge('upload_album', {
    images: JSON.stringify(imagePaths),
    caption,
  });
  return (result as { media_pk: string }).media_pk;
}

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

export async function hashtagTop(name: string, amount = 15): Promise<InstagramHashtagResult> {
  return callInstagramBridge('hashtag_top', { name, amount: String(amount) }) as Promise<InstagramHashtagResult>;
}

export async function hashtagRecent(name: string, amount = 15): Promise<InstagramHashtagResult> {
  return callInstagramBridge('hashtag_recent', { name, amount: String(amount) }) as Promise<InstagramHashtagResult>;
}

export async function getMediaInsights(mediaPk: string): Promise<{ likes: number; comments: number; reach: number }> {
  const result = await callInstagramBridge('get_media_insights', {
    'media-pk': mediaPk,
  });
  const data = result as { likes?: number; comments?: number; reach?: number };
  return {
    likes: data.likes ?? 0,
    comments: data.comments ?? 0,
    reach: data.reach ?? 0,
  };
}

export async function getUserInfo(userId: string): Promise<{ follower_count: number; following_count: number; media_count: number }> {
  const result = await callInstagramBridge('get_user_info', {
    'user-id': userId,
  });
  return result as { follower_count: number; following_count: number; media_count: number };
}
