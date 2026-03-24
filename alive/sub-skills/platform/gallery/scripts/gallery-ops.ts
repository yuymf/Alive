/**
 * gallery-ops.ts
 * Photo gallery search, send, and generate-and-send for chat sharing.
 * Migrated from skill/scripts/gallery-send.ts
 *
 * Changes from skill version:
 * - Import PATHS/readJSON/writeJSON from alive file-utils
 * - Import time-utils from alive utils
 * - GalleryPhoto/PhotoGallery/ContentStyle re-exported from alive/scripts/utils/types.ts (single source of truth)
 * - Removed CLI entry point (actions are exposed via index.ts)
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { PATHS, readJSON, writeJSON } from '../../../../scripts/utils/file-utils';
import { now, getLocalDate, getLocalHour } from '../../../../scripts/utils/time-utils';
// Re-export shared types from alive/scripts/utils/types.ts (single source of truth)
export type { GalleryPhoto, PhotoGallery, ContentStyle } from '../../../../scripts/utils/types';
import type { GalleryPhoto, PhotoGallery, ContentStyle } from '../../../../scripts/utils/types';

export interface GallerySearchResult {
  results: Pick<GalleryPhoto, 'id' | 'description' | 'tags' | 'style' | 'emotion' | 'createdAt' | 'publicUrl'>[];
  total: number;
}

export interface GallerySendResult {
  success: boolean;
  photoId: string;
  error?: string;
}

export const DEFAULT_PHOTO_GALLERY: PhotoGallery = { photos: [] };

const GALLERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RESHARE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 5;

// ── Gallery read/write helpers (pure, immutable) ──────────────────

function readGallery(): PhotoGallery {
  return readJSON<PhotoGallery>(PATHS.photoGallery, DEFAULT_PHOTO_GALLERY);
}

/**
 * Search gallery for photos matching query.
 * Filters: non-empty publicUrl, sharedAt > 24h ago or null.
 * Matches: tags (exact, case-insensitive), description (substring), style (exact).
 * Sorts: createdAt descending.
 */
export function searchGallery(query: string, limit: number = DEFAULT_LIMIT): GallerySearchResult {
  const gallery = readGallery();
  const currentMs = now().getTime();
  const queryLower = query.toLowerCase();

  const eligible = gallery.photos.filter(p => {
    if (!p.publicUrl) return false;
    if (p.sharedAt && (currentMs - new Date(p.sharedAt).getTime()) < RESHARE_COOLDOWN_MS) return false;
    return true;
  });

  const matched = eligible.filter(p => {
    if (p.tags.some(t => t.toLowerCase() === queryLower)) return true;
    if (p.description.toLowerCase().includes(queryLower)) return true;
    if (p.style.toLowerCase() === queryLower) return true;
    return false;
  });

  const sorted = [...matched].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const results = sorted.slice(0, limit).map(p => ({
    id: p.id,
    description: p.description,
    tags: p.tags,
    style: p.style,
    emotion: p.emotion,
    createdAt: p.createdAt,
    publicUrl: p.publicUrl,
  }));

  return { results, total: matched.length };
}

/**
 * Mark a photo as shared. Returns new PhotoGallery (immutable).
 * Writes updated gallery to disk.
 */
export function updateGalleryAfterShare(photoId: string): PhotoGallery {
  const gallery = readGallery();
  const idx = gallery.photos.findIndex(p => p.id === photoId);
  if (idx === -1) throw new Error(`Photo not found: ${photoId}`);

  const photo = gallery.photos[idx];
  const updatedPhoto: GalleryPhoto = {
    ...photo,
    sharedAt: now().toISOString(),
    shareCount: photo.shareCount + 1,
  };

  const updatedGallery: PhotoGallery = {
    photos: gallery.photos.map((p, i) => (i === idx ? updatedPhoto : p)),
  };

  writeJSON(PATHS.photoGallery, updatedGallery);
  return updatedGallery;
}

/**
 * Append a photo to the gallery. Returns new PhotoGallery (immutable).
 * Writes updated gallery to disk.
 */
export function addPhotoToGallery(photo: GalleryPhoto): PhotoGallery {
  const gallery = readGallery();
  const updatedGallery: PhotoGallery = {
    photos: [...gallery.photos, photo],
  };
  writeJSON(PATHS.photoGallery, updatedGallery);
  return updatedGallery;
}

/**
 * Remove photos older than 30 days. Returns new PhotoGallery (immutable).
 * Writes updated gallery to disk.
 */
export function pruneGallery(): PhotoGallery {
  const gallery = readGallery();
  const cutoff = now().getTime() - GALLERY_RETENTION_MS;
  const updatedGallery: PhotoGallery = {
    photos: gallery.photos.filter(p => new Date(p.createdAt).getTime() > cutoff),
  };
  writeJSON(PATHS.photoGallery, updatedGallery);
  return updatedGallery;
}

// ── Send helpers ─────────────────────────────────────────────────

export function sendViaOpenClaw(mediaUrl: string, channel: string, target: string, caption?: string): void {
  const args = ['message', 'send', '--media', mediaUrl, '--channel', channel, '--target', target];
  if (caption) args.push('--message', caption);
  execFileSync('openclaw', args, { timeout: 30_000, encoding: 'utf8' });
}

/**
 * Look up a photo by id, send via OpenClaw, and update gallery.
 * Returns a GallerySendResult. Exported for testability.
 */
export function sendPhoto(id: string, channel: string, target: string, caption?: string): GallerySendResult {
  const gallery = readGallery();
  const photo = gallery.photos.find(p => p.id === id);
  if (!photo) {
    return { success: false, photoId: id, error: `Photo not found: ${id}` };
  }
  try {
    sendViaOpenClaw(photo.publicUrl, channel, target, caption);
    updateGalleryAfterShare(id);
    return { success: true, photoId: id };
  } catch (err) {
    return { success: false, photoId: id, error: (err as Error).message };
  }
}

/**
 * Generate an image, upload to ImgURL, add to gallery, and send.
 * Lazy-imports generate-image and imgurl-upload to avoid pulling heavy deps.
 */
export async function generateAndSend(
  prompt: string, style: ContentStyle, channel: string, target: string, caption?: string,
): Promise<GallerySendResult> {
  const { generateImage } = await import('../../generate-image/scripts/provider');
  const { selectReferences } = await import('../../generate-image/scripts/reference-selector');
  const { uploadToImgURL } = await import('./imgurl-upload');

  const refFileNames = selectReferences(style, prompt);
  const referenceImages = refFileNames
    .map(f => path.join(PATHS.referencesDir, f))
    .filter(f => fs.existsSync(f));

  if (referenceImages.length === 0) {
    return { success: false, photoId: '', error: 'No reference images found' };
  }

  const genResult = await generateImage({
    prompt,
    referenceImages,
    style,
    skipQualityCheck: true,
  });

  let publicUrl = '';
  try {
    const uploadResult = await uploadToImgURL(genResult.localPath);
    publicUrl = uploadResult.url;
  } catch (err) {
    console.error(`ImgURL upload failed: ${(err as Error).message}`);
    // Fall through with empty URL — still try to send via local path
  }

  const hour = getLocalHour();
  const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const seq = String(Date.now() % 1000).padStart(3, '0');
  const photoId = `${getLocalDate().replace(/-/g, '')}_${style}_${timeOfDay}_${seq}`;

  const newPhoto: GalleryPhoto = {
    id: photoId,
    localPath: genResult.localPath,
    publicUrl,
    description: prompt,
    tags: [],
    style,
    emotion: { valence: 0, energy: 0 },
    createdAt: now().toISOString(),
    sharedAt: now().toISOString(),
    shareCount: 1,
    postedToInstagram: false,
  };

  addPhotoToGallery(newPhoto);

  const mediaRef = publicUrl || genResult.localPath;
  try {
    sendViaOpenClaw(mediaRef, channel, target, caption);
    return { success: true, photoId };
  } catch (err) {
    return { success: false, photoId, error: (err as Error).message };
  }
}
