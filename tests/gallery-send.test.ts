import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as child_process from 'child_process';
import { setBasePaths, resetBasePaths, PATHS, writeJSON, readJSON } from '../skill/scripts/file-utils';
import type { PhotoGallery, GalleryPhoto } from '../skill/scripts/types';
import { DEFAULT_PHOTO_GALLERY } from '../skill/scripts/types';
import { searchGallery, updateGalleryAfterShare, addPhotoToGallery, pruneGallery, sendPhoto } from '../skill/scripts/gallery-send';

vi.mock('child_process');
const mockedCp = vi.mocked(child_process);

function makePhoto(overrides: Partial<GalleryPhoto> = {}): GalleryPhoto {
  return {
    id: '20260313_cos_afternoon_001',
    localPath: '/tmp/photo.png',
    publicUrl: 'https://example.com/photo.png',
    description: '在天台拍的初音cos，夕阳逆光',
    tags: ['cos', '初音', '户外', '夕阳'],
    style: 'cos',
    emotion: { valence: 0.7, energy: 0.6 },
    createdAt: '2026-03-13T15:30:00+08:00',
    sharedAt: null,
    shareCount: 0,
    postedToInstagram: false,
    ...overrides,
  };
}

describe('gallery-send', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minase-gallery-'));
    setBasePaths(tmpDir, tmpDir);
  });

  afterEach(() => {
    resetBasePaths();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('searchGallery', () => {
    it('returns empty results for empty gallery', () => {
      writeJSON(PATHS.photoGallery, DEFAULT_PHOTO_GALLERY);
      const result = searchGallery('cos');
      expect(result.results).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('matches by tag (case-insensitive)', () => {
      const gallery: PhotoGallery = { photos: [makePhoto()] };
      writeJSON(PATHS.photoGallery, gallery);
      const result = searchGallery('COS');
      expect(result.total).toBe(1);
      expect(result.results[0].id).toBe('20260313_cos_afternoon_001');
    });

    it('matches by description substring', () => {
      const gallery: PhotoGallery = { photos: [makePhoto()] };
      writeJSON(PATHS.photoGallery, gallery);
      const result = searchGallery('初音');
      expect(result.total).toBe(1);
    });

    it('matches by style', () => {
      const gallery: PhotoGallery = { photos: [makePhoto()] };
      writeJSON(PATHS.photoGallery, gallery);
      const result = searchGallery('cos');
      expect(result.total).toBe(1);
    });

    it('excludes photos with empty publicUrl', () => {
      const gallery: PhotoGallery = { photos: [makePhoto({ publicUrl: '' })] };
      writeJSON(PATHS.photoGallery, gallery);
      const result = searchGallery('cos');
      expect(result.total).toBe(0);
    });

    it('excludes photos shared within 24 hours', () => {
      const recentShare = new Date().toISOString();
      const gallery: PhotoGallery = { photos: [makePhoto({ sharedAt: recentShare })] };
      writeJSON(PATHS.photoGallery, gallery);
      const result = searchGallery('cos');
      expect(result.total).toBe(0);
    });

    it('includes photos shared more than 24 hours ago', () => {
      const oldShare = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const gallery: PhotoGallery = { photos: [makePhoto({ sharedAt: oldShare })] };
      writeJSON(PATHS.photoGallery, gallery);
      const result = searchGallery('cos');
      expect(result.total).toBe(1);
    });

    it('sorts by recency (newest first)', () => {
      const gallery: PhotoGallery = {
        photos: [
          makePhoto({ id: 'old', createdAt: '2026-03-12T10:00:00+08:00' }),
          makePhoto({ id: 'new', createdAt: '2026-03-13T10:00:00+08:00' }),
        ],
      };
      writeJSON(PATHS.photoGallery, gallery);
      const result = searchGallery('cos');
      expect(result.results[0].id).toBe('new');
    });

    it('respects limit parameter', () => {
      const photos = Array.from({ length: 10 }, (_, i) =>
        makePhoto({ id: `photo_${i}`, createdAt: `2026-03-${String(i + 1).padStart(2, '0')}T10:00:00+08:00` })
      );
      writeJSON(PATHS.photoGallery, { photos });
      const result = searchGallery('cos', 3);
      expect(result.results.length).toBe(3);
      expect(result.total).toBe(10);
    });

    it('search result excludes internal fields', () => {
      const gallery: PhotoGallery = { photos: [makePhoto()] };
      writeJSON(PATHS.photoGallery, gallery);
      const result = searchGallery('cos');
      const item = result.results[0] as Record<string, unknown>;
      expect(item).not.toHaveProperty('localPath');
      expect(item).not.toHaveProperty('sharedAt');
      expect(item).not.toHaveProperty('shareCount');
      expect(item).not.toHaveProperty('postedToInstagram');
    });
  });

  describe('updateGalleryAfterShare', () => {
    it('sets sharedAt and increments shareCount immutably', () => {
      const original: PhotoGallery = { photos: [makePhoto()] };
      writeJSON(PATHS.photoGallery, original);

      const updated = updateGalleryAfterShare('20260313_cos_afternoon_001');
      expect(updated.photos[0].sharedAt).not.toBeNull();
      expect(updated.photos[0].shareCount).toBe(1);

      // Verify written to disk
      const onDisk = readJSON<PhotoGallery>(PATHS.photoGallery, DEFAULT_PHOTO_GALLERY);
      expect(onDisk.photos[0].shareCount).toBe(1);

      // Original object not mutated
      expect(original.photos[0].shareCount).toBe(0);
    });

    it('throws if photo id not found', () => {
      writeJSON(PATHS.photoGallery, DEFAULT_PHOTO_GALLERY);
      expect(() => updateGalleryAfterShare('nonexistent')).toThrow('not found');
    });
  });

  describe('addPhotoToGallery', () => {
    it('appends a new photo immutably', () => {
      writeJSON(PATHS.photoGallery, DEFAULT_PHOTO_GALLERY);
      const photo = makePhoto();
      const updated = addPhotoToGallery(photo);
      expect(updated.photos.length).toBe(1);
      expect(updated.photos[0].id).toBe('20260313_cos_afternoon_001');
    });
  });

  describe('pruneGallery', () => {
    it('removes photos older than 30 days', () => {
      const old = makePhoto({
        id: 'old',
        createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const recent = makePhoto({ id: 'recent' });
      writeJSON(PATHS.photoGallery, { photos: [old, recent] });

      const pruned = pruneGallery();
      expect(pruned.photos.length).toBe(1);
      expect(pruned.photos[0].id).toBe('recent');
    });
  });

  describe('sendPhoto', () => {
    it('calls openclaw message send --media and updates gallery', () => {
      const gallery: PhotoGallery = { photos: [makePhoto()] };
      writeJSON(PATHS.photoGallery, gallery);

      mockedCp.execFileSync.mockReturnValue('');

      const result = sendPhoto('20260313_cos_afternoon_001', 'telegram', '@user123', '看！');

      expect(result.success).toBe(true);
      expect(mockedCp.execFileSync).toHaveBeenCalledWith(
        'openclaw',
        ['message', 'send', '--media', 'https://example.com/photo.png', '--channel', 'telegram', '--target', '@user123', '--message', '看！'],
        expect.objectContaining({ timeout: 30_000 }),
      );

      // Verify gallery was updated
      const updated = readJSON<PhotoGallery>(PATHS.photoGallery, DEFAULT_PHOTO_GALLERY);
      expect(updated.photos[0].sharedAt).not.toBeNull();
      expect(updated.photos[0].shareCount).toBe(1);
    });

    it('returns error when photo not found', () => {
      writeJSON(PATHS.photoGallery, DEFAULT_PHOTO_GALLERY);
      const result = sendPhoto('nonexistent', 'telegram', '@user123');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('returns error when openclaw send fails', () => {
      const gallery: PhotoGallery = { photos: [makePhoto()] };
      writeJSON(PATHS.photoGallery, gallery);

      mockedCp.execFileSync.mockImplementation(() => {
        throw new Error('Connection refused');
      });

      const result = sendPhoto('20260313_cos_afternoon_001', 'telegram', '@user123');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection refused');
    });
  });
});
