import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import { readJSON, writeJSON, appendText, readText } from '../skill/scripts/file-utils';

vi.mock('fs');

const mockedFs = vi.mocked(fs);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('file-utils', () => {
  describe('readJSON', () => {
    it('should return parsed JSON when primary file exists', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('{"key": "value"}');

      const result = readJSON('/some/file.json', {});
      expect(result).toEqual({ key: 'value' });
      expect(mockedFs.existsSync).toHaveBeenCalledWith('/some/file.json');
    });

    it('should fallback to .bak file when primary parse fails', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync
        .mockReturnValueOnce('corrupted{{{')       // primary fails
        .mockReturnValueOnce('{"backup": true}');   // .bak succeeds

      const result = readJSON('/some/file.json', {});
      expect(result).toEqual({ backup: true });
    });

    it('should return default when primary does not exist but .bak does', () => {
      mockedFs.existsSync
        .mockReturnValueOnce(false)   // primary missing
        .mockReturnValueOnce(true);   // .bak exists
      mockedFs.readFileSync.mockReturnValue('{"from_bak": true}');

      const result = readJSON('/some/file.json', { fallback: true });
      expect(result).toEqual({ from_bak: true });
    });

    it('should return default when both files are missing', () => {
      mockedFs.existsSync.mockReturnValue(false);

      const result = readJSON('/missing.json', { fallback: true });
      expect(result).toEqual({ fallback: true });
    });

    it('should return default when both files have corrupted JSON', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('not-json!!!');

      const result = readJSON('/bad.json', []);
      expect(result).toEqual([]);
    });
  });

  describe('writeJSON', () => {
    it('should create directory and write JSON', () => {
      mockedFs.existsSync.mockReturnValue(false);
      mockedFs.mkdirSync.mockReturnValue(undefined);
      mockedFs.writeFileSync.mockReturnValue(undefined);

      writeJSON('/new/path/file.json', { data: 1 });

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith('/new/path', { recursive: true });
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        '/new/path/file.json',
        JSON.stringify({ data: 1 }, null, 2)
      );
    });

    it('should backup existing file before overwrite', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.mkdirSync.mockReturnValue(undefined);
      mockedFs.copyFileSync.mockReturnValue(undefined);
      mockedFs.writeFileSync.mockReturnValue(undefined);

      writeJSON('/existing/file.json', { updated: true });

      expect(mockedFs.copyFileSync).toHaveBeenCalledWith(
        '/existing/file.json',
        '/existing/file.json.bak'
      );
      expect(mockedFs.writeFileSync).toHaveBeenCalled();
    });

    it('should not backup when file does not exist yet', () => {
      mockedFs.existsSync.mockReturnValue(false);
      mockedFs.mkdirSync.mockReturnValue(undefined);
      mockedFs.writeFileSync.mockReturnValue(undefined);

      writeJSON('/new/file.json', {});

      expect(mockedFs.copyFileSync).not.toHaveBeenCalled();
    });
  });

  describe('appendText', () => {
    it('should create directory and append text', () => {
      mockedFs.mkdirSync.mockReturnValue(undefined);
      mockedFs.appendFileSync.mockReturnValue(undefined);

      appendText('/log/diary.md', 'new entry\n');

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith('/log', { recursive: true });
      expect(mockedFs.appendFileSync).toHaveBeenCalledWith('/log/diary.md', 'new entry\n');
    });
  });

  describe('readText', () => {
    it('should return file content when file exists', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('hello world');

      expect(readText('/some/text.md')).toBe('hello world');
    });

    it('should return empty string when file does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);

      expect(readText('/missing.md')).toBe('');
    });

    it('should return custom fallback when file does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);

      expect(readText('/missing.md', 'default content')).toBe('default content');
    });
  });
});
