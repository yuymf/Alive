import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setBasePaths, resetBasePaths, PATHS, writeJSON, readJSON } from '../scripts/utils/file-utils';
import type { PhotoGallery, GalleryPhoto } from '../scripts/utils/types';
import { DEFAULT_PHOTO_GALLERY } from '../scripts/utils/types';
import { writePhotosToGallery, markPhotosAsPosted } from '../sub-skills/instagram/scripts/post-pipeline';

describe('post-pipeline gallery integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minase-pipeline-'));
    setBasePaths(tmpDir, tmpDir);
    writeJSON(PATHS.photoGallery, DEFAULT_PHOTO_GALLERY);
  });

  afterEach(() => {
    resetBasePaths();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes gallery entries for generated images', () => {
    // writePhotosToGallery needs emotion-state.json to exist
    writeJSON(path.join(tmpDir, 'emotion-state.json'), {
      mood: { valence: 0.3, arousal: 0.5, description: '普通' },
      energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
      last_updated: null, recent_cause: '',
      momentum: { direction: 0, magnitude: 0, duration_ticks: 0, base_decay_rate: 0.05 },
      undertone: { baseline_valence: 0.3, baseline_arousal: 0.5, baseline_energy: 0.6, set_at: '' },
      impulse_history: [],
      consecutive_high_stress: 0,
      threshold_break_cooldown: 0,
    });

    const images = [
      { localPath: '/tmp/photo1.png', textResponse: undefined, timestamp: Date.now() },
      { localPath: '/tmp/photo2.png', textResponse: undefined, timestamp: Date.now() },
    ];
    const uploadResults = [
      { url: 'https://example.com/1.png' },
      { url: '' }, // failed upload
    ];

    writePhotosToGallery(images, uploadResults, 'cos', '初音cos户外拍摄', ['cos', '初音', '户外']);

    const gallery = readJSON<PhotoGallery>(PATHS.photoGallery, DEFAULT_PHOTO_GALLERY);
    expect(gallery.photos.length).toBe(2);
    expect(gallery.photos[0].publicUrl).toBe('https://example.com/1.png');
    expect(gallery.photos[0].style).toBe('cos');
    expect(gallery.photos[0].tags).toEqual(['cos', '初音', '户外']);
    expect(gallery.photos[1].publicUrl).toBe('');
  });

  it('persists batch and outfit metadata into gallery entries', () => {
    writeJSON(path.join(tmpDir, 'emotion-state.json'), {
      mood: { valence: 0.3, arousal: 0.5, description: '普通' },
      energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
      last_updated: null, recent_cause: '',
      momentum: { direction: 0, magnitude: 0, duration_ticks: 0, base_decay_rate: 0.05 },
      undertone: { baseline_valence: 0.3, baseline_arousal: 0.5, baseline_energy: 0.6, set_at: '' },
      impulse_history: [],
      consecutive_high_stress: 0,
      threshold_break_cooldown: 0,
    });

    const images = [{ localPath: '/tmp/photo_meta.png', textResponse: undefined, timestamp: Date.now() }];
    const uploadResults = [{ url: 'https://example.com/meta.png' }];

    writePhotosToGallery(images, uploadResults, 'cos', '同一场景测试', ['cos'], {
      batchId: 'batch_001',
      sceneDescription: '同一场景测试',
      shots: [{ description: '主图', angle: '正面', variation: '主图', outfit: '黑色皮衣', outfitChange: false }],
    });

    const gallery = readJSON<PhotoGallery>(PATHS.photoGallery, DEFAULT_PHOTO_GALLERY);
    expect(gallery.photos[0].batchId).toBe('batch_001');
    expect(gallery.photos[0].sceneDescription).toBe('同一场景测试');
    expect(gallery.photos[0].outfit).toBe('黑色皮衣');
    expect(gallery.photos[0].outfitChange).toBe(false);
    expect(gallery.photos[0].shotIndex).toBe(0);
  });

  it('marks photos as posted to Instagram', () => {
    const photo: GalleryPhoto = {
      id: 'test_001',
      localPath: '/tmp/photo.png',
      publicUrl: 'https://example.com/photo.png',
      description: 'test',
      tags: ['test'],
      style: 'cos',
      emotion: { valence: 0, energy: 0 },
      createdAt: new Date().toISOString(),
      sharedAt: null,
      shareCount: 0,
      postedToInstagram: false,
    };
    writeJSON(PATHS.photoGallery, { photos: [photo] });

    markPhotosAsPosted(['/tmp/photo.png']);

    const gallery = readJSON<PhotoGallery>(PATHS.photoGallery, DEFAULT_PHOTO_GALLERY);
    expect(gallery.photos[0].postedToInstagram).toBe(true);
  });
});
