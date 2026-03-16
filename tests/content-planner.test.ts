import { describe, it, expect } from 'vitest';
import { shouldConsiderPosting } from '../skill/scripts/content-planner';
import { PostHistory, PostRecord } from '../skill/scripts/types';

/** Returns a timestamp for today at the given hour (local time). Avoids midnight-boundary flakiness. */
function todayAt(hour: number): number {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

function makePost(overrides?: Partial<PostRecord>): PostRecord {
  return {
    media_id: '123',
    timestamp: todayAt(12),
    style: 'cos',
    caption: 'test caption',
    hashtags: ['cosplay'],
    image_local_paths: ['/tmp/test.png'],
    ...overrides,
  };
}

describe('content-planner', () => {
  describe('shouldConsiderPosting', () => {
    it('should allow posting when there are no previous posts', () => {
      const result = shouldConsiderPosting({ posts: [] });
      expect(result.allowed).toBe(true);
    });
    it('should allow posting when last post was 2 hours ago (no 16h limit)', () => {
      const result = shouldConsiderPosting({
        posts: [makePost({ timestamp: todayAt(10) })],
      });
      expect(result.allowed).toBe(true);
    });
    it('should block posting when 3 posts already today', () => {
      const result = shouldConsiderPosting({
        posts: [
          makePost({ timestamp: todayAt(9) }),
          makePost({ timestamp: todayAt(11) }),
          makePost({ timestamp: todayAt(13) }),
        ],
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('3');
    });
    it('should allow posting when 2 posts today', () => {
      const result = shouldConsiderPosting({
        posts: [
          makePost({ timestamp: todayAt(9) }),
          makePost({ timestamp: todayAt(11) }),
        ],
      });
      expect(result.allowed).toBe(true);
    });
    it('should not count posts from previous days', () => {
      const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
      const result = shouldConsiderPosting({
        posts: [
          makePost({ timestamp: twoDaysAgo }),
          makePost({ timestamp: twoDaysAgo + 1000 }),
          makePost({ timestamp: twoDaysAgo + 2000 }),
        ],
      });
      expect(result.allowed).toBe(true);
    });
    it('should return a reason string regardless of allowed status', () => {
      const allowed = shouldConsiderPosting({ posts: [] });
      expect(allowed.reason).toBeTruthy();
      const blocked = shouldConsiderPosting({
        posts: [
          makePost({ timestamp: todayAt(9) }),
          makePost({ timestamp: todayAt(11) }),
          makePost({ timestamp: todayAt(13) }),
        ],
      });
      expect(blocked.reason).toBeTruthy();
    });
  });
});
