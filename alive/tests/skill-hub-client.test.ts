// alive/tests/skill-hub-client.test.ts
// TDD tests for skill-hub-client module (Task 4.1)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process.execFile before importing the module
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return {
    ...actual,
    promisify: (fn: Function) => {
      // Return a wrapper that calls the mocked execFile and returns a promise
      return (...args: unknown[]) => {
        return new Promise((resolve, reject) => {
          (fn as Function)(...args, (err: Error | null, stdout: string, stderr: string) => {
            if (err) reject(err);
            else resolve({ stdout, stderr });
          });
        });
      };
    },
  };
});

import { execFile } from 'child_process';
import {
  searchClawHub,
  searchSkillsHub,
  installClawHubSkill,
  isCliAvailable,
  type SkillSearchResult,
} from '../scripts/hub/skill-hub-client';

const mockExecFile = vi.mocked(execFile);

function simulateExecFile(stdout: string, stderr = '') {
  mockExecFile.mockImplementation(
    ((_file: string, _args: readonly string[] | undefined, _opts: unknown, cb: Function) => {
      cb(null, stdout, stderr);
    }) as any,
  );
}

function simulateExecFileError(err: Error) {
  mockExecFile.mockImplementation(
    ((_file: string, _args: readonly string[] | undefined, _opts: unknown, cb: Function) => {
      cb(err, '', '');
    }) as any,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ──── searchClawHub ────

describe('searchClawHub', () => {
  it('parses CLI JSON output and maps to SkillSearchResult[]', () => {
    const cliOutput = JSON.stringify({
      results: [
        { name: 'music-gen', slug: 'music-gen', description: 'Generate music', author: 'test' },
        { name: 'video-edit', slug: 'video-edit', description: 'Edit videos', author: 'test2' },
      ],
    });
    simulateExecFile(cliOutput);

    return searchClawHub('music').then(results => {
      expect(results).toHaveLength(2);
      expect(results[0].name).toBe('music-gen');
      expect(results[0].slug).toBe('music-gen');
      expect(results[0].source).toBe('clawhub');
    });
  });

  it('returns empty array when CLI output is not valid JSON', () => {
    simulateExecFile('not json at all');

    return searchClawHub('music').then(results => {
      expect(results).toEqual([]);
    });
  });

  it('returns empty array on CLI error (graceful fallback)', () => {
    simulateExecFileError(new Error('command not found'));

    return searchClawHub('music').then(results => {
      expect(results).toEqual([]);
    });
  });

  it('returns empty array on timeout', () => {
    const timeoutErr = new Error('timeout') as NodeJS.ErrnoException;
    timeoutErr.code = 'ETIMEDOUT';
    simulateExecFileError(timeoutErr);

    return searchClawHub('music').then(results => {
      expect(results).toEqual([]);
    });
  });
});

// ──── searchSkillsHub ────

describe('searchSkillsHub', () => {
  it('parses CLI output and maps to SkillSearchResult[]', () => {
    const cliOutput = JSON.stringify({
      results: [
        { name: 'photo-filter', slug: 'photo-filter', description: 'Photo filters' },
      ],
    });
    simulateExecFile(cliOutput);

    return searchSkillsHub('photo').then(results => {
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('photo-filter');
      expect(results[0].source).toBe('skillshub');
    });
  });

  it('returns empty array on CLI error', () => {
    simulateExecFileError(new Error('CLI not available'));

    return searchSkillsHub('photo').then(results => {
      expect(results).toEqual([]);
    });
  });
});

// ──── installClawHubSkill ────

describe('installClawHubSkill', () => {
  it('calls correct CLI command and returns success', () => {
    simulateExecFile('Installed music-gen successfully');

    return installClawHubSkill('music-gen').then(result => {
      expect(result.success).toBe(true);
      expect(mockExecFile).toHaveBeenCalledWith(
        'npx',
        expect.arrayContaining(['clawhub', 'install', 'music-gen']),
        expect.any(Object),
        expect.any(Function),
      );
    });
  });

  it('returns failure result on CLI error', () => {
    simulateExecFileError(new Error('installation failed'));

    return installClawHubSkill('bad-skill').then(result => {
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});

// ──── isCliAvailable ────

describe('isCliAvailable', () => {
  it('returns true when CLI responds successfully', () => {
    simulateExecFile('clawhub v1.2.3');

    return isCliAvailable('clawhub').then(available => {
      expect(available).toBe(true);
    });
  });

  it('returns false when CLI is not found', () => {
    simulateExecFileError(new Error('command not found'));

    return isCliAvailable('clawhub').then(available => {
      expect(available).toBe(false);
    });
  });
});
