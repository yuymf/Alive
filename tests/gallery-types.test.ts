import { describe, it, expect } from 'vitest';
import { DEFAULT_PHOTO_GALLERY } from '../skill/scripts/types';
import type { GalleryPhoto, PhotoGallery, GallerySearchResult, GallerySendResult } from '../skill/scripts/types';

describe('gallery types', () => {
  it('DEFAULT_PHOTO_GALLERY has empty photos array', () => {
    expect(DEFAULT_PHOTO_GALLERY).toEqual({ photos: [] });
  });

  it('GalleryPhoto type accepts valid photo object', () => {
    const photo: GalleryPhoto = {
      id: '20260313_cos_afternoon_001',
      localPath: '/tmp/photo.png',
      publicUrl: 'https://example.com/photo.png',
      description: '在天台拍的初音cos',
      tags: ['cos', '初音'],
      style: 'cos',
      emotion: { valence: 0.7, energy: 0.6 },
      createdAt: '2026-03-13T15:30:00+08:00',
      sharedAt: null,
      shareCount: 0,
      postedToInstagram: false,
    };
    expect(photo.id).toBe('20260313_cos_afternoon_001');
    expect(photo.sharedAt).toBeNull();
  });
});
