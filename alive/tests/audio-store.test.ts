// alive/tests/audio-store.test.ts
// Tests for the audio file storage module

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setBasePaths, resetBasePaths } from '../scripts/utils/file-utils';
import { setTimeOverride, createLocalDate, clearTimeOverride } from '../scripts/utils/time-utils';
import { saveAudio, listAudioFiles, pruneOldAudio, deleteAudio, getVoiceDir } from '../sub-skills/voice-tts/scripts/audio-store';

const TEST_DIR = path.join(__dirname, '__audio-store-test__');
const TEST_MEMORY = path.join(TEST_DIR, 'memory');
const TEST_SKILL = path.join(TEST_DIR, 'skill');

beforeEach(() => {
  fs.mkdirSync(TEST_MEMORY, { recursive: true });
  fs.mkdirSync(TEST_SKILL, { recursive: true });
  // Create emotion-state.json so PATHS.emotionState resolves correctly
  fs.writeFileSync(path.join(TEST_MEMORY, 'emotion-state.json'), '{}');
  setBasePaths(TEST_MEMORY, TEST_SKILL);
  setTimeOverride(createLocalDate(2026, 3, 24, 14, 30));
});

afterEach(() => {
  resetBasePaths();
  clearTimeOverride();
  // Clean up test directory
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ── saveAudio ────────────────────────────────────────────────────

describe('audio-store/saveAudio', () => {
  it('saves audio buffer to voice directory', () => {
    const buffer = Buffer.alloc(1024, 'A');  // 1KB dummy audio
    const result = saveAudio(buffer, 'mp3');

    expect(result.filePath).toContain('voice');
    expect(result.filePath).toContain('.mp3');
    expect(result.sizeBytes).toBe(1024);
    expect(result.createdAt).toBeTruthy();
    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  it('creates voice directory if not exists', () => {
    const voiceDir = getVoiceDir();
    expect(fs.existsSync(voiceDir)).toBe(true);
  });

  it('rejects audio that is too small', () => {
    const buffer = Buffer.alloc(10);
    expect(() => saveAudio(buffer, 'mp3')).toThrow('too small');
  });

  it('rejects audio that is too large', () => {
    const buffer = Buffer.alloc(6 * 1024 * 1024);  // 6MB > 5MB limit
    expect(() => saveAudio(buffer, 'mp3')).toThrow('too large');
  });
});

// ── listAudioFiles ───────────────────────────────────────────────

describe('audio-store/listAudioFiles', () => {
  it('returns empty array when no files', () => {
    const files = listAudioFiles();
    expect(files).toEqual([]);
  });

  it('lists saved audio files', () => {
    const buffer = Buffer.alloc(500);
    saveAudio(buffer, 'mp3');
    saveAudio(buffer, 'mp3');

    const files = listAudioFiles();
    // May be 1 if both save in same second (same filename)
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0].fileName).toContain('.mp3');
  });
});

// ── deleteAudio ──────────────────────────────────────────────────

describe('audio-store/deleteAudio', () => {
  it('deletes an existing file', () => {
    const buffer = Buffer.alloc(500);
    const saved = saveAudio(buffer, 'mp3');
    expect(fs.existsSync(saved.filePath)).toBe(true);

    const result = deleteAudio(saved.filePath);
    expect(result).toBe(true);
    expect(fs.existsSync(saved.filePath)).toBe(false);
  });

  it('returns false for non-existent file', () => {
    const result = deleteAudio('/nonexistent/file.mp3');
    expect(result).toBe(false);
  });
});

// ── pruneOldAudio ────────────────────────────────────────────────

describe('audio-store/pruneOldAudio', () => {
  it('does not prune recent files', () => {
    const buffer = Buffer.alloc(500);
    saveAudio(buffer, 'mp3');

    const pruned = pruneOldAudio();
    expect(pruned).toBe(0);
  });

  it('prunes files older than 7 days', () => {
    const voiceDir = getVoiceDir();
    const oldFile = path.join(voiceDir, 'old-file.mp3');
    fs.writeFileSync(oldFile, Buffer.alloc(500));

    // Set file mtime to 8 days before the time override (2026-03-24)
    const eightDaysAgo = new Date(2026, 2, 24 - 8, 14, 30);
    fs.utimesSync(oldFile, eightDaysAgo, eightDaysAgo);

    const pruned = pruneOldAudio();
    expect(pruned).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
  });
});
