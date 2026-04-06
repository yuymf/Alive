import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setBasePaths, resetBasePaths, PATHS, readJSON } from '../../scripts/utils/file-utils';
import { dispatch, assertDispatchSucceeded } from '../../dashboard/test-runner';

let sandboxDir = '';

beforeEach(() => {
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-test-runner-'));
  setBasePaths(sandboxDir, path.join(sandboxDir, '_skills'));
});

afterEach(() => {
  resetBasePaths();
  if (sandboxDir && fs.existsSync(sandboxDir)) {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  }
});

describe('dashboard test-runner', () => {
  it('reset-state writes pending-chains with pending[] field', async () => {
    await dispatch('reset-state');

    const chainState = readJSON<{
      pending?: unknown[];
      chains?: unknown[];
      cooldowns?: Record<string, string>;
    }>(PATHS.pendingChains, {});

    expect(Array.isArray(chainState.pending)).toBe(true);
    expect(chainState.pending).toHaveLength(0);
    expect(chainState.cooldowns).toEqual({});
    expect(chainState).not.toHaveProperty('chains');
  });

  it('assertDispatchSucceeded throws when dispatch result contains error', async () => {
    const result = await dispatch('unknown-command-for-test');
    expect(() => assertDispatchSucceeded(result)).toThrow(/Unknown command/i);
  });
});
