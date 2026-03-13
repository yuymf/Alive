#!/usr/bin/env node
/**
 * gallery-send.ts
 * Photo gallery search, send, and generate-and-send for chat sharing.
 * Called by the agent via Bash(node:*) during conversations.
 *
 * Actions:
 *   --action search  --query <text> [--limit N]
 *   --action send    --id <photoId> --channel <ch> --target <tgt> [--caption <text>]
 *   --action generate-and-send --prompt <text> --style <style> --channel <ch> --target <tgt> [--caption <text>]
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { GalleryPhoto, PhotoGallery, GallerySearchResult, GallerySendResult, ContentStyle } from './types';
import { DEFAULT_PHOTO_GALLERY } from './types';
import { PATHS, readJSON, writeJSON } from './file-utils';
import { now, getLocalDate, getLocalHour } from './time-utils';

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

// ── CLI actions ───────────────────────────────────────────────────

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

async function actionSearch(query: string, limit: number): Promise<void> {
  const result = searchGallery(query, limit);
  console.log(JSON.stringify(result, null, 2));
}

async function actionSend(id: string, channel: string, target: string, caption?: string): Promise<void> {
  const result = sendPhoto(id, channel, target, caption);
  console.log(JSON.stringify(result));
  if (!result.success) process.exit(1);
}

async function actionGenerateAndSend(
  prompt: string, style: ContentStyle, channel: string, target: string, caption?: string,
): Promise<void> {
  // Lazy imports to avoid pulling in heavy deps for search-only calls
  const { generateImage } = await import('./generate-image');
  const { selectReferences } = await import('./reference-selector');
  const { uploadToImgURL } = await import('./imgurl-upload');

  const refFileNames = selectReferences(style, prompt);
  const referenceImages = refFileNames
    .map(f => path.join(PATHS.references, f))
    .filter(f => fs.existsSync(f));

  if (referenceImages.length === 0) {
    const result: GallerySendResult = { success: false, photoId: '', error: 'No reference images found' };
    console.log(JSON.stringify(result));
    process.exit(1);
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
    const result: GallerySendResult = { success: true, photoId };
    console.log(JSON.stringify(result));
  } catch (err) {
    const result: GallerySendResult = { success: false, photoId, error: (err as Error).message };
    console.log(JSON.stringify(result));
    process.exit(1);
  }
}

// ── CLI entry ─────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  const action = args.action;

  if (!action) {
    console.error('Usage: node gallery-send.js --action <search|send|generate-and-send> [options]');
    process.exit(1);
  }

  const run = async () => {
    switch (action) {
      case 'search':
        await actionSearch(args.query ?? '', parseInt(args.limit ?? String(DEFAULT_LIMIT), 10));
        break;
      case 'send':
        await actionSend(args.id ?? '', args.channel ?? '', args.target ?? '', args.caption);
        break;
      case 'generate-and-send':
        await actionGenerateAndSend(
          args.prompt ?? '', (args.style ?? 'daily') as ContentStyle,
          args.channel ?? '', args.target ?? '', args.caption,
        );
        break;
      default:
        console.error(`Unknown action: ${action}`);
        process.exit(1);
    }
  };

  run().catch(err => {
    console.error(`gallery-send error: ${err.message}`);
    process.exit(1);
  });
}
