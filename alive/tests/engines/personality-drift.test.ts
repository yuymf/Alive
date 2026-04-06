/**
 * personality-drift.test.ts
 * Tests for the P4-2 personality drift detection engine.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { setBasePaths, resetBasePaths, PATHS, writeJSON, readJSON } from '../../scripts/utils/file-utils';
import { clearPersonaCache } from '../../scripts/persona/persona-loader';
import YAML from 'yaml';
import {
  loadPersonalityDrift,
  savePersonalityDrift,
  decayModifiers,
  capModifiers,
  computeDriftScore,
  detectDrift,
  generateDriftWarning,
  runDriftAnalysis,
  buildDriftContext,
  buildDriftBriefSection,
} from '../../scripts/engines/personality-drift';
import type { PersonalityDrift, PersonalityModifier, PersonaConfig } from '../../scripts/utils/types';

const TEST_DIR = path.join(__dirname, '__personality_drift_test_sandbox__');

function cleanSandbox() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
  setBasePaths(TEST_DIR, path.join(TEST_DIR, '_skills'));
}

function writePersona(overrides: Partial<PersonaConfig> = {}) {
  const persona: any = {
    name: 'test-persona',
    personality: {
      mbti: 'ENFP',
      core_traits: ['creative', 'curious', 'empathetic'],
      tone: 'casual',
    },
    content_sources: {
      platforms: ['reddit'],
      keywords: [],
      dailyhot_platforms: [],
      reddit_subreddits: [],
    },
    ...overrides,
  };
  fs.writeFileSync(PATHS.personaConfig, YAML.stringify(persona));
  clearPersonaCache();
}

function makeModifier(overrides: Partial<PersonalityModifier> = {}): PersonalityModifier {
  return {
    trait: 'extraversion',
    strength: 0.5,
    origin: 'night-reflect 2026-04-01',
    effect: '变得更加外向',
    ...overrides,
  };
}

beforeEach(() => {
  cleanSandbox();
  clearPersonaCache();
});

afterEach(() => {
  resetBasePaths();
  clearPersonaCache();
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe('loadPersonalityDrift / savePersonalityDrift', () => {
  it('returns default drift when no file exists', () => {
    writePersona();
    const drift = loadPersonalityDrift();
    expect(drift.base).toBe('ENFP');
    expect(drift.modifiers).toEqual([]);
  });

  it('loads and saves drift correctly', () => {
    writePersona();
    const drift: PersonalityDrift = {
      base: 'ENFP',
      modifiers: [makeModifier()],
    };
    savePersonalityDrift(drift);
    const loaded = loadPersonalityDrift();
    expect(loaded.modifiers).toHaveLength(1);
    expect(loaded.modifiers[0].trait).toBe('extraversion');
  });
});

describe('decayModifiers', () => {
  it('decays old modifiers based on half-life', () => {
    // Create a modifier from 14 days ago (2 half-lives → strength should be ~0.25)
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const mods = [makeModifier({ strength: 1.0, origin: `night-reflect ${twoWeeksAgo}` })];
    const [surviving, removed] = decayModifiers(mods);
    expect(surviving).toHaveLength(1);
    // After 2 half-lives, strength should be ~0.25
    expect(surviving[0].strength).toBeGreaterThan(0.1);
    expect(surviving[0].strength).toBeLessThan(0.4);
    expect(removed).toBe(0);
  });

  it('removes modifiers below MIN_STRENGTH', () => {
    // Very old modifier: 100 days ago → should decay to near-zero
    const longAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const mods = [makeModifier({ strength: 0.5, origin: `night-reflect ${longAgo}` })];
    const [surviving, removed] = decayModifiers(mods);
    expect(surviving).toHaveLength(0);
    expect(removed).toBe(1);
  });

  it('does not decay modifiers without date in origin', () => {
    const mods = [makeModifier({ strength: 0.8, origin: 'manual-override' })];
    const [surviving, removed] = decayModifiers(mods);
    expect(surviving).toHaveLength(1);
    expect(surviving[0].strength).toBe(0.8); // unchanged
    expect(removed).toBe(0);
  });

  it('handles empty modifiers array', () => {
    const [surviving, removed] = decayModifiers([]);
    expect(surviving).toEqual([]);
    expect(removed).toBe(0);
  });
});

describe('capModifiers', () => {
  it('does not cap when under limit', () => {
    const mods = Array.from({ length: 5 }, (_, i) =>
      makeModifier({ trait: `trait-${i}`, strength: 0.5 + i * 0.1 }),
    );
    const [capped, removed] = capModifiers(mods);
    expect(capped).toHaveLength(5);
    expect(removed).toBe(0);
  });

  it('caps to MAX_MODIFIERS (10) keeping highest strength', () => {
    const mods = Array.from({ length: 15 }, (_, i) =>
      makeModifier({ trait: `trait-${i}`, strength: 0.1 * (i + 1) }),
    );
    const [capped, removed] = capModifiers(mods);
    expect(capped).toHaveLength(10);
    expect(removed).toBe(5);
    // Highest strength should be kept
    expect(capped[0].strength).toBe(1.5); // trait-14
  });
});

describe('computeDriftScore', () => {
  it('returns 0 for empty modifiers', () => {
    expect(computeDriftScore([])).toBe(0);
  });

  it('computes based on sum of absolute strengths', () => {
    const mods = [
      makeModifier({ strength: 2.0 }),
      makeModifier({ strength: -1.5 }),
    ];
    const score = computeDriftScore(mods);
    expect(score).toBe(3.5); // |2.0| + |-1.5| = 3.5
  });

  it('caps at 10', () => {
    const mods = Array.from({ length: 20 }, () => makeModifier({ strength: 1.0 }));
    const score = computeDriftScore(mods);
    expect(score).toBe(10);
  });
});

describe('detectDrift', () => {
  it('detects no drift when no modifiers exist', () => {
    writePersona();
    const analysis = detectDrift();
    expect(analysis.score).toBe(0);
    expect(analysis.direction).toBe('none');
    expect(analysis.drifting_traits).toHaveLength(0);
    expect(analysis.warning).toBeNull();
  });

  it('detects trait-level drift from modifiers', () => {
    writePersona();
    savePersonalityDrift({
      base: 'ENFP',
      modifiers: [
        makeModifier({ trait: 'introversion', strength: 2.0, effect: '更内敛' }),
        makeModifier({ trait: 'introversion', strength: 1.5, effect: '社交减少' }),
        makeModifier({ trait: 'creativity', strength: 0.3, effect: '微创意提升' }),
      ],
    });
    const analysis = detectDrift();
    expect(analysis.drifting_traits.length).toBeGreaterThanOrEqual(1);
    expect(analysis.drifting_traits[0].trait).toBe('introversion');
    expect(analysis.drifting_traits[0].deviation).toBe(3.5);
  });

  it('generates warning when score exceeds threshold', () => {
    writePersona();
    savePersonalityDrift({
      base: 'ENFP',
      modifiers: Array.from({ length: 8 }, (_, i) =>
        makeModifier({ trait: 'aggression', strength: 1.0, effect: `攻击性增强${i}` }),
      ),
    });
    const analysis = detectDrift();
    expect(analysis.score).toBeGreaterThanOrEqual(6);
    expect(analysis.warning).toBeTruthy();
    expect(analysis.warning).toContain('人设漂移预警');
  });
});

describe('generateDriftWarning', () => {
  it('generates warning with trait details', () => {
    writePersona();
    const persona: any = {
      personality: {
        mbti: 'ENFP',
        core_traits: ['creative', 'curious'],
      },
    };
    const traits = [
      { trait: 'aggression', deviation: 7.5, evidence: '攻击性表达增加；语气变得强硬' },
    ];
    const warning = generateDriftWarning(persona as PersonaConfig, 7.5, traits);
    expect(warning).toContain('⚠️ 人设漂移预警');
    expect(warning).toContain('7.5');
    expect(warning).toContain('ENFP');
    expect(warning).toContain('aggression');
  });

  it('gives strong suggestion for score >= 8', () => {
    const persona: any = {
      personality: {
        mbti: 'ENFP',
        core_traits: ['creative'],
      },
    };
    const warning = generateDriftWarning(persona as PersonaConfig, 8.5, []);
    expect(warning).toContain('需要立即校正');
  });
});

describe('runDriftAnalysis', () => {
  it('runs full pipeline: decay + cap + detect', () => {
    writePersona();
    const today = new Date().toISOString().split('T')[0];
    savePersonalityDrift({
      base: 'ENFP',
      modifiers: [
        makeModifier({ trait: 'curiosity', strength: 0.8, origin: `night-reflect ${today}` }),
      ],
    });
    const report = runDriftAnalysis();
    expect(report.analysis).toBeDefined();
    expect(report.analysis.score).toBeGreaterThanOrEqual(0);
    expect(report.modifiers_after.length).toBeGreaterThanOrEqual(0);
    expect(typeof report.decayed_count).toBe('number');
    expect(typeof report.capped_count).toBe('number');
  });

  it('decays and removes old modifiers during analysis', () => {
    writePersona();
    const longAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    savePersonalityDrift({
      base: 'ENFP',
      modifiers: [
        makeModifier({ strength: 0.3, origin: `night-reflect ${longAgo}` }),
      ],
    });
    const report = runDriftAnalysis();
    expect(report.decayed_count).toBe(1); // Should be decayed away
    expect(report.modifiers_after).toHaveLength(0);
    // Verify the drift file was updated
    const saved = readJSON<PersonalityDrift>(PATHS.personalityDrift, { base: '', modifiers: [] });
    expect(saved.modifiers).toHaveLength(0);
  });
});

describe('buildDriftContext', () => {
  it('returns stable message when no modifiers', () => {
    writePersona();
    const ctx = buildDriftContext();
    expect(ctx).toContain('ENFP基底');
    expect(ctx).toContain('稳定');
  });

  it('includes modifier effects and score', () => {
    writePersona();
    savePersonalityDrift({
      base: 'ENFP',
      modifiers: [
        makeModifier({ strength: 1.5, effect: '更加内敛和沉思' }),
      ],
    });
    const ctx = buildDriftContext();
    expect(ctx).toContain('ENFP基底');
    expect(ctx).toContain('更加内敛和沉思');
    expect(ctx).toContain('偏移');
  });
});

describe('buildDriftBriefSection', () => {
  it('returns empty string when no warning needed', () => {
    writePersona();
    const section = buildDriftBriefSection();
    expect(section).toBe('');
  });

  it('returns warning section when drift is high', () => {
    writePersona();
    savePersonalityDrift({
      base: 'ENFP',
      modifiers: Array.from({ length: 8 }, (_, i) =>
        makeModifier({ trait: 'aggression', strength: 1.0, effect: `攻击性${i}` }),
      ),
    });
    const section = buildDriftBriefSection();
    expect(section).toContain('人设漂移预警');
  });
});
