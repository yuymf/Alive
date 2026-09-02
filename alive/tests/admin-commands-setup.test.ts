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
let envFile: string;

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
  envFile = path.join(tmpDir, '.env');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'persona.yaml'), TEST_PERSONA_YAML);
  process.env.ALIVE_HOME = tmpDir;
  setBasePaths(memoryDir, skillDir);
});

afterEach(() => {
  resetBasePaths();
  clearPersonaCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ALIVE_HOME;
});

describe('/alive setup', () => {
  it('returns env status table when no subarg given', async () => {
    fs.writeFileSync(envFile, 'LLM_API_KEY=sk-test\nINSTAGRAM_USERNAME=user1\n');
    delete process.env.LLM_API_KEY;

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
    expect(result.output).toContain('ALIVE_HOME');
  });

  it('returns setup instructions for /alive setup voice', async () => {
    const result = await dispatch('/alive setup voice');

    expect(result.error).toBeFalsy();
    expect(result.output).toContain('TALK_TO_FENGGE_URL');
    expect(result.output).toContain('LIVEKIT');
    expect(result.output).toContain('VOXCPM');
    expect(result.output).toContain('USAGE.md');
    expect(result.output).toContain('麦克风');
  });

  it('returns setup instructions for /alive setup instagram', async () => {
    const result = await dispatch('/alive setup instagram');

    expect(result.error).toBeFalsy();
    expect(result.output).toContain('INSTAGRAM_USERNAME');
    expect(result.output).toContain('INSTAGRAM_PASSWORD');
    expect(result.output).toContain('ALIVE_HOME');
  });

  it('returns error for unknown setup subarg', async () => {
    const result = await dispatch('/alive setup unknown-thing');

    expect(result.error).toBe(true);
    expect(result.output).toContain('unknown-thing');
  });
});
