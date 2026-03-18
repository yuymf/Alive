import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getComments, replyComment, postComment, getUserFeed, hashtagTop, hashtagRecent,
} from '../skill/scripts/instagram-bridge-client';

describe('instagram-bridge-client mock mode', () => {
  beforeEach(() => { process.env.E2E_MOCK_INSTAGRAM = '1'; });
  afterEach(() => { delete process.env.E2E_MOCK_INSTAGRAM; });

  it('getComments returns an array', async () => {
    const result = await getComments('12345');
    expect(Array.isArray(result)).toBe(true);
  });

  it('getUserFeed returns an array', async () => {
    const result = await getUserFeed('67890');
    expect(Array.isArray(result)).toBe(true);
  });

  it('replyComment returns success object', async () => {
    const result = await replyComment('12345', '99999', 'test reply');
    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('comment_pk');
  });

  it('postComment returns success object', async () => {
    const result = await postComment('12345', 'test comment');
    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('comment_pk');
  });

  it('hashtagTop returns object with posts array', async () => {
    const result = await hashtagTop('cosplay') as { posts: unknown[] };
    expect(Array.isArray(result.posts)).toBe(true);
    if (result.posts.length > 0) {
      const p = result.posts[0] as Record<string, unknown>;
      expect(p).toHaveProperty('pk');
      expect(p).toHaveProperty('like_count');
      expect(p).toHaveProperty('user_id');
      expect(p).toHaveProperty('username');
      expect(p).toHaveProperty('taken_at');
    }
  });

  it('hashtagRecent returns recent posts with taken_at', async () => {
    const result = await hashtagRecent('cosplay') as { posts: unknown[] };
    expect(Array.isArray(result.posts)).toBe(true);
    if (result.posts.length > 0) {
      const p = result.posts[0] as Record<string, unknown>;
      expect(p).toHaveProperty('pk');
      expect(p).toHaveProperty('taken_at');
    }
  });
});
