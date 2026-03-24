// alive/tests/skill-adapter.test.ts
// TDD tests for skill-adapter module (Task 5.1)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setBasePaths, resetBasePaths, PATHS } from '../scripts/utils/file-utils';
import { generateAdaptedSkill } from '../scripts/hub/skill-adapter';

let sandbox: string;
let skillBase: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-skill-adapter-'));
  const memoryDir = path.join(sandbox, 'memory');
  skillBase = path.join(sandbox, 'skill');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(skillBase, { recursive: true });
  fs.mkdirSync(path.join(skillBase, 'sub-skills'), { recursive: true });
  setBasePaths(memoryDir, skillBase);
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function makeMockLlm(response: unknown) {
  return {
    callJSON: vi.fn().mockResolvedValue(response),
    call: vi.fn().mockResolvedValue(JSON.stringify(response)),
  };
}

const sampleSkillDoc = `# Music Generator Skill

This skill generates music tracks based on mood and genre preferences.

## Capabilities
- Generate background music
- Compose melodies
- Mix audio tracks

## Usage
Provide a mood (happy, sad, energetic) and genre (pop, jazz, classical).
`;

// ──── generateAdaptedSkill ────

describe('generateAdaptedSkill', () => {
  it('generates a complete sub-skill directory structure', async () => {
    const llm = makeMockLlm({
      intent_bindings: [
        { intent: '創作', action: 'generate-music', priority: 3 },
      ],
      description: 'AI-powered music generation',
    });

    const result = await generateAdaptedSkill(sampleSkillDoc, 'music-gen', llm);

    expect(result.success).toBe(true);
    const skillDir = path.join(skillBase, 'sub-skills', 'adapted-music-gen');
    expect(fs.existsSync(skillDir)).toBe(true);
  });

  it('generates manifest.json with correct intent_bindings from LLM', async () => {
    const llm = makeMockLlm({
      intent_bindings: [
        { intent: '創作', action: 'generate-music', priority: 3 },
        { intent: '表達', action: 'compose-melody', priority: 3 },
      ],
      description: 'Music generation skill',
    });

    await generateAdaptedSkill(sampleSkillDoc, 'music-gen', llm);

    const manifestPath = path.join(skillBase, 'sub-skills', 'adapted-music-gen', 'manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.intent_bindings).toHaveLength(2);
    expect(manifest.intent_bindings[0].priority).toBe(3);
    expect(manifest.name).toBe('adapted-music-gen');
  });

  it('generates scripts/index.js with adapter wrapper code', async () => {
    const llm = makeMockLlm({
      intent_bindings: [
        { intent: '創作', action: 'generate-music', priority: 3 },
      ],
      description: 'Music gen',
    });

    await generateAdaptedSkill(sampleSkillDoc, 'music-gen', llm);

    const indexPath = path.join(skillBase, 'sub-skills', 'adapted-music-gen', 'scripts', 'index.js');
    expect(fs.existsSync(indexPath)).toBe(true);
    const content = fs.readFileSync(indexPath, 'utf8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('creates .adapted marker file', async () => {
    const llm = makeMockLlm({
      intent_bindings: [
        { intent: '創作', action: 'generate-music', priority: 3 },
      ],
      description: 'Music gen',
    });

    await generateAdaptedSkill(sampleSkillDoc, 'music-gen', llm);

    const markerPath = path.join(skillBase, 'sub-skills', 'adapted-music-gen', '.adapted');
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it('copies SKILL.md into the adapted skill directory', async () => {
    const llm = makeMockLlm({
      intent_bindings: [
        { intent: '創作', action: 'generate-music', priority: 3 },
      ],
      description: 'Music gen',
    });

    await generateAdaptedSkill(sampleSkillDoc, 'music-gen', llm);

    const skillMdPath = path.join(skillBase, 'sub-skills', 'adapted-music-gen', 'SKILL.md');
    expect(fs.existsSync(skillMdPath)).toBe(true);
    const content = fs.readFileSync(skillMdPath, 'utf8');
    expect(content).toContain('Music Generator Skill');
  });

  it('sets adapted skill default priority to 3', async () => {
    const llm = makeMockLlm({
      intent_bindings: [
        { intent: '創作', action: 'generate-music', priority: 7 }, // LLM gives high priority
      ],
      description: 'Music gen',
    });

    await generateAdaptedSkill(sampleSkillDoc, 'music-gen', llm);

    const manifestPath = path.join(skillBase, 'sub-skills', 'adapted-music-gen', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    // All adapted skills should have priority capped at 3
    expect(manifest.intent_bindings[0].priority).toBe(3);
  });

  it('returns default manifest on LLM failure (graceful fallback)', async () => {
    const llm = {
      callJSON: vi.fn().mockRejectedValue(new Error('LLM timeout')),
      call: vi.fn().mockRejectedValue(new Error('LLM timeout')),
    };

    const result = await generateAdaptedSkill(sampleSkillDoc, 'fallback-skill', llm);

    expect(result.success).toBe(true);
    const manifestPath = path.join(skillBase, 'sub-skills', 'adapted-fallback-skill', 'manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    // Should have at least one default binding
    expect(manifest.intent_bindings.length).toBeGreaterThanOrEqual(1);
  });
});
