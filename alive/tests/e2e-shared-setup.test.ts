import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadAliveEnv, readEnvFile } from '../scripts/utils/file-utils';

describe('ALIVE_HOME env loading', () => {
  const originalHome = process.env.ALIVE_HOME;
  const originalKey = process.env.LLM_API_KEY;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ALIVE_HOME;
    else process.env.ALIVE_HOME = originalHome;
    if (originalKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = originalKey;
  });

  it('reads key=value pairs from .env', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-env-'));
    fs.writeFileSync(path.join(tmp, '.env'), 'LLM_API_KEY=llm-key\nLLM_MODEL=test-model\n');
    const keys = readEnvFile(path.join(tmp, '.env'));
    expect(keys.LLM_API_KEY).toBe('llm-key');
    expect(keys.LLM_MODEL).toBe('test-model');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('loadAliveEnv does not override existing process.env', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-env-'));
    process.env.ALIVE_HOME = tmp;
    process.env.LLM_API_KEY = 'already-set';
    fs.writeFileSync(path.join(tmp, '.env'), 'LLM_API_KEY=from-file\n');
    loadAliveEnv();
    expect(process.env.LLM_API_KEY).toBe('already-set');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
