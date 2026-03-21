import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock file-utils to avoid filesystem access in unit tests
vi.mock('../skill/scripts/file-utils', () => ({
  PATHS: { travelState: '/fake/travel-state.json' },
  readJSON: vi.fn().mockReturnValue({
    current_city: '東京',
    country: '日本',
  }),
}));

import {
  buildGeminiPrompt,
  buildGrokPrompt,
  buildGeminiRealisticPrompt,
  buildGrokRealisticPrompt,
  buildPromptForProvider,
  buildRealisticPromptForProvider,
  CAMERA_ANCHORS,
  NEGATIVE_CONSTRAINTS,
  styleContext,
  type ImageEntry,
} from '../skill/scripts/prompt-builder';
import type { ContentStyle } from '../skill/scripts/types';

const ALL_STYLES: ContentStyle[] = [
  'cos', 'daily', 'behind_scenes', 'travel',
  'travel_portrait', 'travel_food', 'travel_street',
];

const SAMPLE_SCENE = '便利店门口，手持咖啡杯，回头看镜头';

// ─── Constants integrity ────────────────────────────────────────────────────

describe('shared constants', () => {
  it('CAMERA_ANCHORS covers all ContentStyle values', () => {
    for (const style of ALL_STYLES) {
      expect(CAMERA_ANCHORS[style]).toBeDefined();
      expect(typeof CAMERA_ANCHORS[style]).toBe('string');
      expect(CAMERA_ANCHORS[style].length).toBeGreaterThan(0);
    }
  });

  it('styleContext covers all ContentStyle values', () => {
    for (const style of ALL_STYLES) {
      expect(styleContext[style]).toBeDefined();
      expect(typeof styleContext[style]).toBe('string');
      expect(styleContext[style].length).toBeGreaterThan(0);
    }
  });

  it('NEGATIVE_CONSTRAINTS is a non-empty string', () => {
    expect(typeof NEGATIVE_CONSTRAINTS).toBe('string');
    expect(NEGATIVE_CONSTRAINTS.length).toBeGreaterThan(0);
  });
});

// ─── Gemini prompt strategy ─────────────────────────────────────────────────

describe('buildGeminiPrompt', () => {
  it('contains structured [Tag] sections', () => {
    const prompt = buildGeminiPrompt(SAMPLE_SCENE, 'cos');
    expect(prompt).toContain('[Scene]');
    expect(prompt).toContain('[Subject]');
    expect(prompt).toContain('[Expression]');
    expect(prompt).toContain('[Camera]');
    expect(prompt).toContain('[Atmosphere]');
    expect(prompt).toContain('[Negative]');
  });

  it('includes the scene description in [Scene]', () => {
    const prompt = buildGeminiPrompt(SAMPLE_SCENE, 'daily');
    const sceneSection = prompt.split('[Subject]')[0];
    expect(sceneSection).toContain(SAMPLE_SCENE);
  });

  it('includes camera anchor for the given style', () => {
    for (const style of ALL_STYLES) {
      const prompt = buildGeminiPrompt(SAMPLE_SCENE, style);
      const camera = CAMERA_ANCHORS[style];
      expect(prompt).toContain(camera);
    }
  });

  it('includes style context in [Scene]', () => {
    for (const style of ALL_STYLES) {
      const prompt = buildGeminiPrompt(SAMPLE_SCENE, style);
      expect(prompt).toContain(styleContext[style]);
    }
  });

  it('includes negative constraints in [Negative]', () => {
    const prompt = buildGeminiPrompt(SAMPLE_SCENE, 'cos');
    const negSection = prompt.split('[Negative]')[1];
    expect(negSection).toContain(NEGATIVE_CONSTRAINTS);
  });

  it.each(ALL_STYLES)('generates non-empty prompt for style "%s"', (style) => {
    const prompt = buildGeminiPrompt(SAMPLE_SCENE, style);
    expect(prompt.length).toBeGreaterThan(200);
  });
});

describe('buildGeminiRealisticPrompt', () => {
  it('appends [Realism] section to base Gemini prompt', () => {
    const prompt = buildGeminiRealisticPrompt(SAMPLE_SCENE, 'cos');
    expect(prompt).toContain('[Realism]');
    expect(prompt).toContain('[Scene]'); // base tags still present
  });

  it('includes travel city for travel styles', () => {
    const prompt = buildGeminiRealisticPrompt(SAMPLE_SCENE, 'travel');
    expect(prompt).toContain('東京');
    expect(prompt).toContain('日本');
  });
});

// ─── Grok prompt strategy ───────────────────────────────────────────────────

describe('buildGrokPrompt', () => {
  it('does NOT contain [Tag] sections', () => {
    const prompt = buildGrokPrompt(SAMPLE_SCENE, 'cos');
    expect(prompt).not.toContain('[Scene]');
    expect(prompt).not.toContain('[Subject]');
    expect(prompt).not.toContain('[Camera]');
    expect(prompt).not.toContain('[Negative]');
    expect(prompt).not.toContain('[Atmosphere]');
  });

  it('includes the scene description', () => {
    const prompt = buildGrokPrompt(SAMPLE_SCENE, 'daily');
    expect(prompt).toContain(SAMPLE_SCENE);
  });

  it('uses Chinese emotional descriptors', () => {
    const prompt = buildGrokPrompt(SAMPLE_SCENE, 'cos');
    expect(prompt).toContain('故事感');
    expect(prompt).toContain('情绪');
    expect(prompt).toContain('辣妹风');
  });

  it('includes simplified camera info (device name only)', () => {
    const prompt = buildGrokPrompt(SAMPLE_SCENE, 'cos');
    // Grok gets just "Canon EOS R5" without the lens details
    expect(prompt).toContain('Canon EOS R5');
    // Should NOT include the full lens spec
    expect(prompt).not.toContain('85mm f/1.4, shallow depth of field');
  });

  it('includes negative constraints inline (not in a tag)', () => {
    const prompt = buildGrokPrompt(SAMPLE_SCENE, 'cos');
    expect(prompt).toContain(NEGATIVE_CONSTRAINTS);
  });

  it.each(ALL_STYLES)('generates non-empty prompt for style "%s"', (style) => {
    const prompt = buildGrokPrompt(SAMPLE_SCENE, style);
    expect(prompt.length).toBeGreaterThan(100);
  });
});

describe('buildGrokRealisticPrompt', () => {
  it('appends 真实感细节 to base Grok prompt', () => {
    const prompt = buildGrokRealisticPrompt(SAMPLE_SCENE, 'cos');
    expect(prompt).toContain('真实感细节');
  });

  it('does NOT contain [Tag] sections', () => {
    const prompt = buildGrokRealisticPrompt(SAMPLE_SCENE, 'cos');
    expect(prompt).not.toContain('[Realism]');
    expect(prompt).not.toContain('[Scene]');
  });

  it('includes travel city for travel styles', () => {
    const prompt = buildGrokRealisticPrompt(SAMPLE_SCENE, 'travel_street');
    expect(prompt).toContain('東京');
  });
});

// ─── Router ─────────────────────────────────────────────────────────────────

describe('buildPromptForProvider', () => {
  it('routes to Gemini prompt for AIHUBMIX', () => {
    const prompt = buildPromptForProvider(SAMPLE_SCENE, 'cos', 'AIHUBMIX');
    expect(prompt).toContain('[Scene]'); // Gemini signature
    expect(prompt).toContain('[Camera]');
  });

  it('routes to Grok prompt for FAI', () => {
    const prompt = buildPromptForProvider(SAMPLE_SCENE, 'cos', 'FAI');
    expect(prompt).not.toContain('[Scene]'); // No Gemini tags
    expect(prompt).toContain('Instagram风格');
  });

  it.each(ALL_STYLES)('AIHUBMIX x %s — produces structured prompt', (style) => {
    const prompt = buildPromptForProvider(SAMPLE_SCENE, style, 'AIHUBMIX');
    expect(prompt).toContain('[Scene]');
    expect(prompt).toContain('[Negative]');
  });

  it.each(ALL_STYLES)('FAI x %s — produces narrative prompt', (style) => {
    const prompt = buildPromptForProvider(SAMPLE_SCENE, style, 'FAI');
    expect(prompt).not.toContain('[Scene]');
    expect(prompt).toContain(NEGATIVE_CONSTRAINTS);
  });
});

describe('buildRealisticPromptForProvider', () => {
  it('AIHUBMIX includes [Realism] tag', () => {
    const prompt = buildRealisticPromptForProvider(SAMPLE_SCENE, 'cos', 'AIHUBMIX');
    expect(prompt).toContain('[Realism]');
  });

  it('FAI includes 真实感细节 without [Realism] tag', () => {
    const prompt = buildRealisticPromptForProvider(SAMPLE_SCENE, 'cos', 'FAI');
    expect(prompt).toContain('真实感细节');
    expect(prompt).not.toContain('[Realism]');
  });

  it.each(ALL_STYLES)('AIHUBMIX x %s — has realism section', (style) => {
    const prompt = buildRealisticPromptForProvider(SAMPLE_SCENE, style, 'AIHUBMIX');
    expect(prompt).toContain('[Realism]');
    expect(prompt).toContain('[Scene]');
  });

  it.each(ALL_STYLES)('FAI x %s — has 真实感细节', (style) => {
    const prompt = buildRealisticPromptForProvider(SAMPLE_SCENE, style, 'FAI');
    expect(prompt).toContain('真实感细节');
    expect(prompt).not.toContain('[Scene]');
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles empty scene description gracefully', () => {
    const gemini = buildGeminiPrompt('', 'cos');
    const grok = buildGrokPrompt('', 'cos');
    expect(gemini.length).toBeGreaterThan(100);
    expect(grok.length).toBeGreaterThan(100);
  });

  it('Gemini and Grok produce different prompts for same input', () => {
    const gemini = buildPromptForProvider(SAMPLE_SCENE, 'cos', 'AIHUBMIX');
    const grok = buildPromptForProvider(SAMPLE_SCENE, 'cos', 'FAI');
    expect(gemini).not.toBe(grok);
    // Structural difference: Gemini has [Scene], Grok doesn't
    expect(gemini).toContain('[Scene]');
    expect(grok).not.toContain('[Scene]');
  });

  it('Gemini prompt is longer than Grok prompt (more structured)', () => {
    const gemini = buildGeminiPrompt(SAMPLE_SCENE, 'cos');
    const grok = buildGrokPrompt(SAMPLE_SCENE, 'cos');
    // Gemini's structured format is more verbose
    expect(gemini.length).toBeGreaterThan(grok.length);
  });
});
