import { describe, it, expect } from 'vitest';
import { DEFAULT_PHOTO_GALLERY } from '../sub-skills/platform/gallery/scripts/gallery-ops';
import type { GalleryPhoto, PhotoGallery, GallerySearchResult, GallerySendResult } from '../sub-skills/platform/gallery/scripts/gallery-ops';

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
      batchId: 'batch_001',
      shotIndex: 0,
      outfit: '黑色皮衣',
      outfitChange: false,
      sceneDescription: '天台夕阳',
    };
    expect(photo.id).toBe('20260313_cos_afternoon_001');
    expect(photo.sharedAt).toBeNull();
  });
});
