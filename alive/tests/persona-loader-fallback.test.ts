import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import YAML from 'yaml';
import { setBasePaths, resetBasePaths, PATHS } from '../scripts/utils/file-utils';
import { loadPersona, clearPersonaCache } from '../scripts/persona/persona-loader';

const MINIMAL_PERSONA = {
  meta: { name: 'TestPersona', tagline: 'test' },
  personality: { mbti: 'INFP', core_traits: ['kind'] },
  voice: { language: 'ja', style: 'casual', sample_lines: ['hello'] },
};

describe('persona-loader fallback', () => {
  let tmpMemory: string;
  let tmpSkill: string;

  beforeEach(() => {
    clearPersonaCache();
    tmpMemory = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-mem-'));
    tmpSkill = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-skill-'));
    setBasePaths(tmpMemory, tmpSkill);
  });

  afterEach(() => {
    resetBasePaths();
    clearPersonaCache();
    fs.rmSync(tmpMemory, { recursive: true, force: true });
    fs.rmSync(tmpSkill, { recursive: true, force: true });
  });

  it('loads from memory directory when persona.yaml exists there', () => {
    // Write persona.yaml to memory dir
    fs.writeFileSync(
      path.join(tmpMemory, 'persona.yaml'),
      YAML.stringify({ ...MINIMAL_PERSONA, meta: { ...MINIMAL_PERSONA.meta, name: 'MemoryPersona' } })
    );

    const persona = loadPersona();
    expect(persona.meta.name).toBe('MemoryPersona');
  });

  it('falls back to skill directory when memory persona.yaml does not exist', () => {
    // Only write persona.yaml to skill dir (NOT memory dir)
    fs.writeFileSync(
      path.join(tmpSkill, 'persona.yaml'),
      YAML.stringify({ ...MINIMAL_PERSONA, meta: { ...MINIMAL_PERSONA.meta, name: 'SkillPersona' } })
    );

    // memory dir has NO persona.yaml — should fallback to skill dir
    const persona = loadPersona();
    expect(persona.meta.name).toBe('SkillPersona');
  });

  it('prefers memory directory over skill directory', () => {
    // Write to BOTH locations
    fs.writeFileSync(
      path.join(tmpMemory, 'persona.yaml'),
      YAML.stringify({ ...MINIMAL_PERSONA, meta: { ...MINIMAL_PERSONA.meta, name: 'MemoryPersona' } })
    );
    fs.writeFileSync(
      path.join(tmpSkill, 'persona.yaml'),
      YAML.stringify({ ...MINIMAL_PERSONA, meta: { ...MINIMAL_PERSONA.meta, name: 'SkillPersona' } })
    );

    const persona = loadPersona();
    // Should prefer memory over skill
    expect(persona.meta.name).toBe('MemoryPersona');
  });

  it('throws when persona.yaml exists in neither location', () => {
    // Neither memory nor skill dir has persona.yaml
    expect(() => loadPersona()).toThrow(/Persona config not found/);
  });
});
