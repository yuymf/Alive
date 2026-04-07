// alive/tests/admin-commands-setup.test.ts
// Tests for /alive setup subcommand

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { dispatch } from '../scripts/admin/command-handler';
import { setBasePaths, resetBasePaths } from '../scripts/utils/file-utils';
import { clearPersonaCache } from '../scripts/persona/persona-loader';

let tmpDir: string;
let memoryDir: string;
let skillDir: string;
let configFile: string;

const TEST_PERSONA_YAML = `
meta:
  name: "TestChar"
  name_reading: "testchar"
  id: "testchar"
  age: 20
  tagline: "Test character"
personality:
  mbti: "ENFP"
  core_traits: ["curious"]
voice:
  language: "zh-CN"
  style: "活泼"
  sample_lines: ["嗨！"]
schedule:
  wake_hour: 9
  sleep_hour: 1
  timezone: "Asia/Tokyo"
  active_peaks: [14, 21]
sub_skills: []
`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-setup-test-'));
  memoryDir = path.join(tmpDir, 'memory');
  skillDir = path.join(tmpDir, 'skill');
  configFile = path.join(tmpDir, 'openclaw.json');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'persona.yaml'), TEST_PERSONA_YAML);
  setBasePaths(memoryDir, skillDir);
});

afterEach(() => {
  resetBasePaths();
  clearPersonaCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.OPENCLAW_CONFIG_FILE;
});

describe('/alive setup', () => {
  it('returns env status table when no subarg given', async () => {
    fs.writeFileSync(configFile, JSON.stringify({
      skills: { entries: { alive: { env: { LLM_API_KEY: 'sk-test', INSTAGRAM_USERNAME: 'user1' } } } }
    }));
    process.env.OPENCLAW_CONFIG_FILE = configFile;

    const result = await dispatch('/alive setup');

    expect(result.error).toBeFalsy();
    // 'sk-test' is 7 chars (≤8) → maskKey returns '****' — proves the file was read and value masked
    expect(result.output).toMatch(/LLM_API_KEY.*\*\*\*\*/);
    // XHS_SKILLS_DIR is not in config → should show '—' (not set)
    expect(result.output).toMatch(/XHS_SKILLS_DIR.*—/);
  });

  it('returns setup instructions for /alive setup llm', async () => {
    const result = await dispatch('/alive setup llm');

    expect(result.error).toBeFalsy();
    expect(result.output).toContain('LLM_API_KEY');
    expect(result.output).toContain('openclaw env set');
  });

  it('returns setup instructions for /alive setup instagram', async () => {
    const result = await dispatch('/alive setup instagram');

    expect(result.error).toBeFalsy();
    expect(result.output).toContain('INSTAGRAM_USERNAME');
    expect(result.output).toContain('INSTAGRAM_PASSWORD');
    expect(result.output).toContain('openclaw env set');
  });

  it('returns error for unknown setup subarg', async () => {
    const result = await dispatch('/alive setup unknown-thing');

    expect(result.error).toBe(true);
    expect(result.output).toContain('unknown-thing');
  });
});
