// alive/scripts/persona/persona-loader.ts
// Loads persona.yaml and provides config access + template injection

import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import { PersonaConfig, EmotionDelta, DEFAULT_EMOTION_BASELINE, EmotionUndertone } from '../utils/types';
import { PATHS } from '../utils/file-utils';

// MBTI → Emotion Baseline mapping
const MBTI_BASELINES: Record<string, EmotionDelta> = {
  ESTP: { valence: 0.3, arousal: 0.5, energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5 },
  ENFP: { valence: 0.4, arousal: 0.6, energy: 0.5, stress: 0.2, creativity: 0.6, sociability: 0.7 },
  INTJ: { valence: 0.1, arousal: 0.3, energy: 0.5, stress: 0.3, creativity: 0.6, sociability: 0.2 },
  INFP: { valence: 0.2, arousal: 0.3, energy: 0.4, stress: 0.3, creativity: 0.7, sociability: 0.3 },
  ENTP: { valence: 0.3, arousal: 0.6, energy: 0.5, stress: 0.2, creativity: 0.7, sociability: 0.5 },
  ISFJ: { valence: 0.2, arousal: 0.3, energy: 0.5, stress: 0.2, creativity: 0.3, sociability: 0.4 },
  ENTJ: { valence: 0.2, arousal: 0.5, energy: 0.6, stress: 0.3, creativity: 0.5, sociability: 0.4 },
  INTP: { valence: 0.1, arousal: 0.3, energy: 0.4, stress: 0.3, creativity: 0.7, sociability: 0.2 },
  ESFP: { valence: 0.4, arousal: 0.6, energy: 0.6, stress: 0.1, creativity: 0.4, sociability: 0.7 },
  ISTJ: { valence: 0.1, arousal: 0.3, energy: 0.5, stress: 0.2, creativity: 0.3, sociability: 0.2 },
  ENFJ: { valence: 0.3, arousal: 0.5, energy: 0.5, stress: 0.2, creativity: 0.5, sociability: 0.7 },
  ISTP: { valence: 0.1, arousal: 0.3, energy: 0.5, stress: 0.2, creativity: 0.5, sociability: 0.2 },
  ESFJ: { valence: 0.3, arousal: 0.4, energy: 0.5, stress: 0.2, creativity: 0.3, sociability: 0.7 },
  INFJ: { valence: 0.2, arousal: 0.3, energy: 0.4, stress: 0.3, creativity: 0.6, sociability: 0.3 },
  ISFP: { valence: 0.2, arousal: 0.3, energy: 0.4, stress: 0.2, creativity: 0.6, sociability: 0.3 },
  ESTJ: { valence: 0.2, arousal: 0.5, energy: 0.6, stress: 0.2, creativity: 0.3, sociability: 0.4 },
};

let _cachedPersona: PersonaConfig | null = null;

/**
 * Load persona config from YAML file.
 * Uses the `yaml` package for native YAML parsing.
 */
export function loadPersona(customPath?: string): PersonaConfig {
  if (_cachedPersona) return _cachedPersona;

  const yamlPath = customPath ?? PATHS.personaConfig;
  if (!fs.existsSync(yamlPath)) {
    throw new Error(`Persona config not found: ${yamlPath}. Run "alive --persona <path>" to install.`);
  }

  const raw = fs.readFileSync(yamlPath, 'utf8');
  _cachedPersona = YAML.parse(raw) as PersonaConfig;

  return _cachedPersona!;
}

/** Clear cached persona (for testing). */
export function clearPersonaCache(): void {
  _cachedPersona = null;
}

/**
 * Get the emotion baseline for the persona's MBTI type.
 */
export function getEmotionBaseline(persona?: PersonaConfig): EmotionDelta {
  const p = persona ?? loadPersona();
  const mbti = p.personality.mbti.toUpperCase();
  return MBTI_BASELINES[mbti] ?? DEFAULT_EMOTION_BASELINE;
}

/**
 * Get the emotion undertone (daily base) from MBTI baseline.
 */
export function getDefaultUndertone(persona?: PersonaConfig): EmotionUndertone {
  const baseline = getEmotionBaseline(persona);
  return {
    valence: baseline.valence ?? 0.2,
    arousal: baseline.arousal ?? 0.4,
    energy: baseline.energy ?? 0.5,
    stress: baseline.stress ?? 0.2,
    creativity: baseline.creativity ?? 0.4,
    sociability: baseline.sociability ?? 0.4,
  };
}

/**
 * Build the voice directive signature from persona config.
 * Replaces the hardcoded CHARACTER_VOICE_SIGNATURE.
 */
export function buildVoiceSignature(persona?: PersonaConfig): string {
  const p = persona ?? loadPersona();
  const parts: string[] = [];

  parts.push(`你是${p.meta.age ? p.meta.age + '岁的' : ''}${p.personality.mbti} ${p.meta.name}。`);
  parts.push(`性格: ${p.personality.core_traits.join('、')}。`);
  parts.push(`语言风格: ${p.voice.style}`);

  if (p.voice.mixed_languages) {
    for (const [lang, words] of Object.entries(p.voice.mixed_languages)) {
      parts.push(`口癖(${lang}): ${words.join('/')}`);
    }
  }

  if (p.voice.sample_lines.length > 0) {
    parts.push(`典型台词: 「${p.voice.sample_lines.slice(0, 3).join('」「')}」`);
  }

  parts.push('禁止：客服腔（"当然！""好的！"）、AI腔（"我理解您的..."）、过于正式的书面语。');

  return '\n' + parts.join('\n');
}

/**
 * Inject persona config into a template string.
 * Replaces {persona.xxx} placeholders.
 */
export function injectPersona(template: string, persona?: PersonaConfig): string {
  const p = persona ?? loadPersona();

  // Auto-generate behaviors_table from behaviors if not explicitly set
  const behaviorsTable = generateBehaviorsTable(p);
  // Auto-generate sample_lines_formatted
  const sampleLinesFormatted = p.voice.sample_lines.map(s => `- 「${s}」`).join('\n');

  return template
    // === meta ===
    .replace(/{persona\.meta\.name}/g, p.meta.name)
    .replace(/{persona\.meta\.name_reading}/g, p.meta.name_reading ?? p.meta.name)
    .replace(/{persona\.meta\.age}/g, String(p.meta.age ?? ''))
    .replace(/{persona\.meta\.id}/g, p.meta.id ?? (p.meta.name_reading ?? p.meta.name).toLowerCase().replace(/\s+/g, '-'))
    .replace(/{persona\.meta\.tagline}/g, p.meta.tagline)
    .replace(/{persona\.meta\.occupation_detail}/g, p.meta.occupation_detail ?? '')
    .replace(/{persona\.meta\.reference_image}/g, p.meta.reference_image ?? '')
    // Aliases
    .replace(/{persona\.name}/g, p.meta.name)
    .replace(/{persona\.name_reading}/g, p.meta.name_reading ?? p.meta.name)
    .replace(/{persona\.age}/g, String(p.meta.age ?? ''))
    .replace(/{persona\.tagline}/g, p.meta.tagline)
    // === personality ===
    .replace(/{persona\.personality\.mbti}/g, p.personality.mbti)
    .replace(/{persona\.personality\.core_traits\[0\]}/g, p.personality.core_traits[0] ?? '')
    .replace(/{persona\.personality\.core_traits}/g, p.personality.core_traits.join('、'))
    .replace(/{persona\.personality\.quirks}/g, (p.personality.quirks ?? []).join('、'))
    .replace(/{persona\.personality\.values}/g, (p.personality.values ?? []).join('、'))
    .replace(/{persona\.personality\.trait_descriptions}/g, (p.personality.trait_descriptions ?? '').trim())
    .replace(/{persona\.personality\.mbti_description}/g, (p.personality.mbti_description ?? '').trim())
    .replace(/{persona\.personality\.domain_knowledge}/g, (p.personality.domain_knowledge ?? '').trim())
    .replace(/{persona\.personality\.interests_description}/g, (p.personality.interests_description ?? '').trim())
    .replace(/{persona\.personality\.description}/g, (p.personality.description ?? '').trim())
    // Aliases
    .replace(/{persona\.mbti}/g, p.personality.mbti)
    .replace(/{persona\.core_traits}/g, p.personality.core_traits.join('、'))
    .replace(/{persona\.quirks}/g, (p.personality.quirks ?? []).join('、'))
    .replace(/{persona\.values}/g, (p.personality.values ?? []).join('、'))
    // === voice ===
    .replace(/{persona\.voice\.style}/g, p.voice.style)
    .replace(/{persona\.voice\.language_description}/g, p.voice.language_description ?? `${p.voice.language} 为主`)
    .replace(/{persona\.voice\.mixed_languages_table}/g, p.voice.mixed_languages_table ?? generateMixedLanguagesTable(p))
    .replace(/{persona\.voice\.expression_features}/g, (p.voice.expression_features ?? '').trim())
    .replace(/{persona\.voice\.style_description}/g, p.voice.style_description ?? p.voice.style)
    .replace(/{persona\.voice\.sample_lines_formatted}/g, sampleLinesFormatted)
    // Aliases
    .replace(/{persona\.voice_style}/g, p.voice.style)
    .replace(/{persona\.sample_lines}/g, p.voice.sample_lines.map(s => `「${s}」`).join(' '))
    .replace(/{persona\.voice_signature}/g, buildVoiceSignature(p))
    // === intimacy ===
    .replace(/{persona\.intimacy\.levels}/g, String(p.intimacy?.levels ?? 5))
    .replace(/{persona\.intimacy\.behaviors_table}/g, behaviorsTable)
    // === schedule ===
    .replace(/{persona\.schedule\.wake_hour}/g, String(p.schedule?.wake_hour ?? 8))
    .replace(/{persona\.schedule\.sleep_hour}/g, String(p.schedule?.sleep_hour ?? 23))
    .replace(/{persona\.schedule\.time_state_description}/g, (p.schedule?.time_state_description ?? '').trim())
    .replace(/{persona\.schedule\.time_descriptions}/g, (p.schedule?.time_descriptions ?? '').trim());
}

/**
 * Auto-generate a Markdown behaviors table from intimacy.behaviors.
 */
function generateBehaviorsTable(p: PersonaConfig): string {
  const behaviors = p.intimacy?.behaviors;
  if (!behaviors || Object.keys(behaviors).length === 0) return '';

  const rows = Object.entries(behaviors)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([level, desc]) => `| ${level} | ${desc} |`);

  return `| 等级 | 行为变化 |\n|------|---------|\n${rows.join('\n')}`;
}

/**
 * Auto-generate a Markdown table from mixed_languages config.
 */
function generateMixedLanguagesTable(p: PersonaConfig): string {
  if (!p.voice.mixed_languages) return '';

  const rows: string[] = [];
  for (const [_lang, words] of Object.entries(p.voice.mixed_languages)) {
    for (const word of words) {
      rows.push(`| ${word} | 常用 |`);
    }
  }
  if (rows.length === 0) return '';
  return `| 词 | 使用场景 |\n|-----|---------|\n${rows.join('\n')}`;
}

/**
 * Get schedule config with defaults.
 */
export function getScheduleConfig(persona?: PersonaConfig): Required<NonNullable<PersonaConfig['schedule']>> {
  const p = persona ?? loadPersona();
  return {
    wake_hour: p.schedule?.wake_hour ?? 8,
    sleep_hour: p.schedule?.sleep_hour ?? 23,
    timezone: p.schedule?.timezone ?? 'system',
    active_peaks: p.schedule?.active_peaks ?? [14, 21],
    time_state_description: p.schedule?.time_state_description ?? '',
    time_descriptions: p.schedule?.time_descriptions ?? '',
  };
}

// === Reference Image Helpers ===

const REFERENCE_FILES = ['front.png', 'half-body.png', 'full-body.png', 'left-profile.png'];

/**
 * Check if reference images exist in the references directory.
 * Returns true if at least one reference image file exists.
 */
export function hasReferenceImages(): boolean {
  const refDir = PATHS.referencesDir;
  if (!fs.existsSync(refDir)) return false;
  return REFERENCE_FILES.some(f => fs.existsSync(path.join(refDir, f)));
}

/**
 * Get the count of existing reference images.
 */
export function getReferenceImageCount(): { existing: number; total: number; missing: string[] } {
  const refDir = PATHS.referencesDir;
  const missing: string[] = [];
  let existing = 0;
  for (const f of REFERENCE_FILES) {
    if (fs.existsSync(path.join(refDir, f))) {
      existing++;
    } else {
      missing.push(f);
    }
  }
  return { existing, total: REFERENCE_FILES.length, missing };
}

/**
 * Resolve the reference_image path from persona config.
 * If relative, resolves against the persona YAML file directory.
 */
export function resolveReferenceImagePath(persona: PersonaConfig, personaYamlDir: string): string | null {
  const refImage = persona.meta?.reference_image;
  if (!refImage) return null;
  if (path.isAbsolute(refImage)) return refImage;
  return path.resolve(personaYamlDir, refImage);
}
