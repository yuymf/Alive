// alive/sub-skills/voice-tts/scripts/audio-store.ts
// Audio file management — save, retrieve, and auto-clean voice files.
//
// Storage layout:
//   ~/.openclaw/workspace/memory/{persona_id}/voice/
//   ├── 2026-03-24_143022.mp3
//   ├── 2026-03-24_180055.mp3
//   └── ...

import * as fs from 'fs';
import * as path from 'path';
import { PATHS } from '../../../scripts/utils/file-utils';
import { now, getLocalDate } from '../../../scripts/utils/time-utils';

// ── Configuration ────────────────────────────────────────────────

/** Auto-clean audio files older than this. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days

/** Maximum single audio file size (safety limit). */
const MAX_AUDIO_SIZE_BYTES = 5 * 1024 * 1024;  // 5 MB

/** Minimum audio file size (sanity check). */
const MIN_AUDIO_SIZE_BYTES = 100;

// ── Types ────────────────────────────────────────────────────────

export interface SavedAudio {
  filePath: string;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Get the voice directory for the current persona.
 * Creates it if it doesn't exist.
 */
export function getVoiceDir(): string {
  // PATHS use the memory base (e.g. ~/.openclaw/workspace/memory/{persona}/...)
  // We need the persona memory base and add /voice/ to it
  const memoryBase = path.dirname(PATHS.emotionState);
  const voiceDir = path.join(memoryBase, 'voice');

  if (!fs.existsSync(voiceDir)) {
    fs.mkdirSync(voiceDir, { recursive: true });
  }

  return voiceDir;
}

/**
 * Generate a unique filename based on current timestamp.
 */
function generateFileName(format: string): string {
  const d = now();
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const timestamp = [
    getLocalDate(d),
    '_',
    pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds()),
  ].join('');
  return `${timestamp}.${format}`;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Save audio data to the voice directory.
 * Returns the saved file info including the full path.
 */
export function saveAudio(audioBuffer: Buffer, format: string = 'mp3'): SavedAudio {
  if (audioBuffer.length < MIN_AUDIO_SIZE_BYTES) {
    throw new Error(`[audio-store] Audio too small (${audioBuffer.length} bytes) — likely corrupted`);
  }
  if (audioBuffer.length > MAX_AUDIO_SIZE_BYTES) {
    throw new Error(`[audio-store] Audio too large (${audioBuffer.length} bytes) — exceeds ${MAX_AUDIO_SIZE_BYTES} limit`);
  }

  const voiceDir = getVoiceDir();
  const fileName = generateFileName(format);
  const filePath = path.join(voiceDir, fileName);

  fs.writeFileSync(filePath, audioBuffer);

  return {
    filePath,
    fileName,
    sizeBytes: audioBuffer.length,
    createdAt: now().toISOString(),
  };
}

/**
 * List all audio files in the voice directory.
 * Returns sorted by creation time (newest first).
 */
export function listAudioFiles(): SavedAudio[] {
  const voiceDir = getVoiceDir();
  if (!fs.existsSync(voiceDir)) return [];

  const files = fs.readdirSync(voiceDir)
    .filter(f => f.endsWith('.mp3') || f.endsWith('.opus') || f.endsWith('.wav'))
    .sort()
    .reverse();

  return files.map(f => {
    const filePath = path.join(voiceDir, f);
    const stat = fs.statSync(filePath);
    return {
      filePath,
      fileName: f,
      sizeBytes: stat.size,
      createdAt: stat.mtime.toISOString(),
    };
  });
}

/**
 * Clean up audio files older than RETENTION_MS.
 * Returns the number of files deleted.
 */
export function pruneOldAudio(): number {
  const voiceDir = getVoiceDir();
  if (!fs.existsSync(voiceDir)) return 0;

  const cutoff = now().getTime() - RETENTION_MS;
  let deletedCount = 0;

  const files = fs.readdirSync(voiceDir)
    .filter(f => f.endsWith('.mp3') || f.endsWith('.opus') || f.endsWith('.wav'));

  for (const file of files) {
    const filePath = path.join(voiceDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtime.getTime() < cutoff) {
        fs.unlinkSync(filePath);
        deletedCount++;
      }
    } catch {
      // Ignore errors during cleanup
    }
  }

  if (deletedCount > 0) {
    console.log(`[audio-store] Pruned ${deletedCount} old audio file(s)`);
  }

  return deletedCount;
}

/**
 * Delete a specific audio file.
 * Returns true if deleted, false if not found.
 */
export function deleteAudio(filePath: string): boolean {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch {
    // Ignore
  }
  return false;
}
