import { describe, it, expect } from 'vitest';
import {
  shouldConsiderPosting,
  normalizeBatchOutfits,
  filterAlreadyPostedPhotos,
  resolvePostSelection,
} from '../skill/scripts/content-planner';
import { PostHistory, PostRecord, ShotDescription } from '../skill/scripts/types';

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

  describe('normalizeBatchOutfits', () => {
    it('keeps one outfit across same batch when outfitChange is not marked', () => {
      const shots: ShotDescription[] = [
        { description: '主图', angle: '正面', variation: '主图', outfit: '黑色皮衣', outfitChange: false },
        { description: '侧面', angle: '侧面', variation: '侧脸特写', outfit: '白色衬衫', outfitChange: false },
        { description: '回眸', angle: '背面', variation: '回眸', outfit: '红色短裙', outfitChange: true },
        { description: '细节', angle: '近景', variation: '配饰', outfitChange: false },
      ];

      const normalized = normalizeBatchOutfits(shots);

      expect(normalized[0].outfit).toBe('黑色皮衣');
      expect(normalized[0].outfitChange).toBe(false);
      expect(normalized[1].outfit).toBe('黑色皮衣');
      expect(normalized[1].outfitChange).toBe(false);
      expect(normalized[2].outfit).toBe('红色短裙');
      expect(normalized[2].outfitChange).toBe(true);
      expect(normalized[3].outfit).toBe('黑色皮衣');
      expect(normalized[3].outfitChange).toBe(false);
    });
  });

  describe('filterAlreadyPostedPhotos', () => {
    it('filters out photos that already exist in post history', () => {
      const photoList = ['/tmp/a.png', '/tmp/b.png', '/tmp/c.png'];
      const history: PostHistory = {
        posts: [
          makePost({ image_local_paths: ['/tmp/../tmp/b.png'] }),
          makePost({ image_local_paths: ['/tmp/c.png'] }),
        ],
      };

      const filtered = filterAlreadyPostedPhotos(photoList, history);
      expect(filtered).toEqual(['/tmp/a.png']);
    });
  });

  describe('resolvePostSelection', () => {
    it('deduplicates selected photos and forces cover to first position', () => {
      const available = ['/tmp/1.png', '/tmp/2.png', '/tmp/3.png'];
      const resolved = resolvePostSelection(available, {
        selectedPhotos: ['2.png', '1.png', '2.png'],
        coverPhoto: '1.png',
      });

      expect(resolved.selectedPhotos).toEqual(['/tmp/1.png', '/tmp/2.png']);
      expect(resolved.coverPhoto).toBe('/tmp/1.png');
    });

    it('adds cover to selection when cover is valid but not in selectedPhotos', () => {
      const available = ['/tmp/1.png', '/tmp/2.png', '/tmp/3.png'];
      const resolved = resolvePostSelection(available, {
        selectedPhotos: ['2.png'],
        coverPhoto: '3.png',
      });

      expect(resolved.selectedPhotos).toEqual(['/tmp/3.png', '/tmp/2.png']);
      expect(resolved.coverPhoto).toBe('/tmp/3.png');
    });

    it('returns empty selection when all selected candidates are invalid', () => {
      const available = ['/tmp/1.png'];
      const resolved = resolvePostSelection(available, {
        selectedPhotos: ['missing.png'],
        coverPhoto: 'also-missing.png',
      });

      expect(resolved.selectedPhotos).toEqual([]);
      expect(resolved.coverPhoto).toBeUndefined();
    });
  });
});
