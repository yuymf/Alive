import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Use a real temp directory for integration-style testing
// This avoids the vitest fs mocking issues with node:fs resolution
const TEST_DIR = path.join(os.tmpdir(), `file-utils-test-${process.pid}`);

beforeEach(() => {
  // Clean and recreate test directory
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

// Clean up after all tests
afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// Import after mock setup — use dynamic import to get around resolution
// We need to use the real module but test with real temp files
import { readJSON, writeJSON, appendText, readText, withFileLock } from '../scripts/utils/file-utils';

describe('file-utils', () => {
  describe('readJSON', () => {
    it('should return parsed JSON when primary file exists', () => {
      const filePath = path.join(TEST_DIR, 'test.json');
      fs.writeFileSync(filePath, '{"key": "value"}');

      const result = readJSON(filePath, {});
      expect(result).toEqual({ key: 'value' });
    });

    it('should fallback to .bak file when primary parse fails', () => {
      const filePath = path.join(TEST_DIR, 'test.json');
      fs.writeFileSync(filePath, 'corrupted{{{');
      fs.writeFileSync(filePath + '.bak', '{"backup": true}');

      const result = readJSON(filePath, {});
      expect(result).toEqual({ backup: true });
    });

    it('should return default when primary does not exist but .bak does', () => {
      const filePath = path.join(TEST_DIR, 'missing.json');
      fs.writeFileSync(filePath + '.bak', '{"from_bak": true}');

      const result = readJSON(filePath, { fallback: true });
      expect(result).toEqual({ from_bak: true });
    });

    it('should return default when both files are missing', () => {
      const filePath = path.join(TEST_DIR, 'totally-missing.json');

      const result = readJSON(filePath, { fallback: true });
      expect(result).toEqual({ fallback: true });
    });

    it('should return default when both files have corrupted JSON', () => {
      const filePath = path.join(TEST_DIR, 'bad.json');
      fs.writeFileSync(filePath, 'not-json!!!');
      fs.writeFileSync(filePath + '.bak', 'also-not-json!!!');

      const result = readJSON(filePath, []);
      expect(result).toEqual([]);
    });
  });

  describe('writeJSON', () => {
    it('should create directory and write JSON via atomic rename', () => {
      const filePath = path.join(TEST_DIR, 'sub', 'dir', 'file.json');

      writeJSON(filePath, { data: 1 });

      // File should exist with correct content
      expect(fs.existsSync(filePath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ data: 1 });
      // Temp file should NOT exist (was renamed)
      expect(fs.existsSync(`${filePath}.tmp.${process.pid}`)).toBe(false);
    });

    it('should backup existing file before overwrite', () => {
      const filePath = path.join(TEST_DIR, 'existing.json');
      fs.writeFileSync(filePath, '{"original": true}');

      writeJSON(filePath, { updated: true });

      // Updated content
      expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ updated: true });
      // Backup contains original content
      expect(JSON.parse(fs.readFileSync(filePath + '.bak', 'utf8'))).toEqual({ original: true });
    });

    it('should not create backup when file does not exist yet', () => {
      const filePath = path.join(TEST_DIR, 'new.json');

      writeJSON(filePath, { fresh: true });

      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.existsSync(filePath + '.bak')).toBe(false);
    });

    it('should write atomically — no corruption on valid data', () => {
      const filePath = path.join(TEST_DIR, 'atomic.json');

      // Write multiple times — each should be valid JSON
      for (let i = 0; i < 10; i++) {
        writeJSON(filePath, { iteration: i });
        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        expect(content).toEqual({ iteration: i });
      }
    });
  });

  describe('appendText', () => {
    it('should create directory and append text', () => {
      const filePath = path.join(TEST_DIR, 'logs', 'diary.md');

      appendText(filePath, 'entry 1\n');
      appendText(filePath, 'entry 2\n');

      expect(fs.readFileSync(filePath, 'utf8')).toBe('entry 1\nentry 2\n');
    });
  });

  describe('readText', () => {
    it('should return file content when file exists', () => {
      const filePath = path.join(TEST_DIR, 'text.md');
      fs.writeFileSync(filePath, 'hello world');

      expect(readText(filePath)).toBe('hello world');
    });

    it('should return empty string when file does not exist', () => {
      const filePath = path.join(TEST_DIR, 'missing.md');

      expect(readText(filePath)).toBe('');
    });

    it('should return custom fallback when file does not exist', () => {
      const filePath = path.join(TEST_DIR, 'missing2.md');

      expect(readText(filePath, 'default content')).toBe('default content');
    });
  });

  describe('withFileLock', () => {
    it('should acquire lock, run callback, and release lock', async () => {
      const filePath = path.join(TEST_DIR, 'lockable.json');
      fs.writeFileSync(filePath, '{}');

      const result = await withFileLock(filePath, () => 'done');

      expect(result).toBe('done');
      // Lock file should be cleaned up
      expect(fs.existsSync(filePath + '.lock')).toBe(false);
    });

    it('should release lock even if callback throws', async () => {
      const filePath = path.join(TEST_DIR, 'lockable2.json');
      fs.writeFileSync(filePath, '{}');

      await expect(
        withFileLock(filePath, () => { throw new Error('boom'); })
      ).rejects.toThrow('boom');

      // Lock should still be cleaned up
      expect(fs.existsSync(filePath + '.lock')).toBe(false);
    });

    it('should handle async callbacks', async () => {
      const filePath = path.join(TEST_DIR, 'lockable3.json');
      fs.writeFileSync(filePath, '{}');

      const result = await withFileLock(filePath, async () => {
        return 42;
      });

      expect(result).toBe(42);
      expect(fs.existsSync(filePath + '.lock')).toBe(false);
    });

    it('should remove stale locks and retry', async () => {
      const filePath = path.join(TEST_DIR, 'stale.json');
      fs.writeFileSync(filePath, '{}');

      // Create a stale lock (timestamp 60s ago)
      const staleTimestamp = Date.now() - 60_000;
      fs.writeFileSync(filePath + '.lock', `99999\n${staleTimestamp}`);

      const result = await withFileLock(filePath, () => 'recovered');

      expect(result).toBe('recovered');
      expect(fs.existsSync(filePath + '.lock')).toBe(false);
    });

    it('should protect against concurrent read-modify-write', async () => {
      const filePath = path.join(TEST_DIR, 'counter.json');
      writeJSON(filePath, { count: 0 });

      // Run 5 concurrent increments with lock protection
      const increments = Array.from({ length: 5 }, () =>
        withFileLock(filePath, () => {
          const data = readJSON<{ count: number }>(filePath, { count: 0 });
          writeJSON(filePath, { count: data.count + 1 });
        })
      );

      await Promise.all(increments);

      const final = readJSON<{ count: number }>(filePath, { count: 0 });
      expect(final.count).toBe(5);
    });
  });
});
