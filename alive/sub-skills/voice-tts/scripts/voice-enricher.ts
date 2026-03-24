// alive/sub-skills/voice-tts/scripts/voice-enricher.ts
// Characteristic Voice enrichment — makes text sound more natural for speech.
//
// Borrows concepts from NoizAI/skills characteristic-voice:
// - Filler words (填充词) insertion at natural pauses
// - Emotion → TTS emotion parameter mapping
// - Scene preset detection
//
// Phase 1: rule-based enrichment (no LLM call needed).
// Phase 2: LLM-assisted enrichment for more nuanced results.

import type { EmotionState, PersonaConfig } from '../../../scripts/utils/types';

// ── Types ────────────────────────────────────────────────────────

export interface EnrichmentContext {
  emotion: EmotionState;
  persona: PersonaConfig;
  tone: string;           // e.g. "温柔", "开心", "感慨"
}

export interface EnrichedVoice {
  text: string;                          // Enriched text with fillers
  emotionParams: Record<string, number>; // TTS emotion weights (e.g. { Joy: 0.6 })
  detectedScene: string | null;          // Scene preset name if detected
}

// ── Filler Palette (中文版) ──────────────────────────────────────

const FILLER_PALETTE: Record<string, string[]> = {
  thinking:    ['嗯...', '唔...', '让我想想...'],
  surprise:    ['诶？', '哦！', '啊！'],
  playful:     ['嘿嘿', '哈哈', '嘻嘻'],
  comfort:     ['嗯~', '啊~', '唔嗯...'],
  hesitation:  ['那个...', '就是...', '怎么说呢...'],
  relief:      ['呼~', '哈~', '终于~'],
  greeting:    ['嗨~', '哎~', '诶嘿~'],
  excitement:  ['哇！', '天啊！', '不会吧！'],
};

// ── Scene Presets ────────────────────────────────────────────────

interface ScenePreset {
  emotion: Record<string, number>;
  speed: number;
  fillerStyle: keyof typeof FILLER_PALETTE;
}

const SCENE_PRESETS: Record<string, ScenePreset> = {
  goodnight:   { emotion: { Tenderness: 0.9 }, speed: 0.85, fillerStyle: 'comfort' },
  goodmorning: { emotion: { Joy: 0.6, Tenderness: 0.4 }, speed: 0.95, fillerStyle: 'greeting' },
  comfort:     { emotion: { Tenderness: 0.8, Sadness: 0.2 }, speed: 0.8, fillerStyle: 'comfort' },
  celebrate:   { emotion: { Joy: 0.9 }, speed: 1.1, fillerStyle: 'excitement' },
  casual:      { emotion: { Joy: 0.3 }, speed: 1.0, fillerStyle: 'thinking' },
  sharing:     { emotion: { Joy: 0.5, Excitement: 0.3 }, speed: 1.0, fillerStyle: 'excitement' },
  hesitant:    { emotion: { Sadness: 0.3, Tenderness: 0.3 }, speed: 0.9, fillerStyle: 'hesitation' },
};

// ── Scene Detection ──────────────────────────────────────────────

const SCENE_KEYWORDS: Record<string, string[]> = {
  goodnight:   ['晚安', '睡了', '困了', '做个好梦', '明天见'],
  goodmorning: ['早上好', '早安', '起床了', '早啊', '新的一天'],
  comfort:     ['别难过', '没关系', '抱抱', '辛苦了', '加油'],
  celebrate:   ['太好了', '成功了', '恭喜', '耶', '做到了', '终于'],
  sharing:     ['你看', '告诉你', '分享', '发现了', '好好玩', '安利'],
  hesitant:    ['其实', '不知道', '也许', '可能', '犹豫', '纠结'],
};

function detectScene(text: string, tone: string): string | null {
  // Check tone-based detection first
  const toneLower = tone.toLowerCase();
  if (toneLower.includes('晚安') || toneLower.includes('温馨')) return 'goodnight';
  if (toneLower.includes('早安') || toneLower.includes('活力')) return 'goodmorning';
  if (toneLower.includes('安慰') || toneLower.includes('关心')) return 'comfort';
  if (toneLower.includes('兴奋') || toneLower.includes('庆祝')) return 'celebrate';

  // Keyword-based detection from text
  const textLower = text.toLowerCase();
  for (const [scene, keywords] of Object.entries(SCENE_KEYWORDS)) {
    if (keywords.some(kw => textLower.includes(kw))) return scene;
  }

  return null;
}

// ── Emotion → TTS Mapping ────────────────────────────────────────

function mapEmotionToTTSParams(emotion: EmotionState, scene: string | null): Record<string, number> {
  // If scene detected, use its preset
  if (scene && SCENE_PRESETS[scene]) {
    return { ...SCENE_PRESETS[scene].emotion };
  }

  // Otherwise, derive from emotion state
  const params: Record<string, number> = {};
  const { valence, arousal } = emotion.mood;

  if (valence > 0.3 && arousal > 0.4) {
    params.Joy = Math.min(1.0, valence * 0.8 + arousal * 0.2);
  }
  if (valence > 0.2 && arousal < 0.4) {
    params.Tenderness = Math.min(1.0, valence * 0.6 + (1 - arousal) * 0.3);
  }
  if (valence < -0.2) {
    params.Sadness = Math.min(1.0, Math.abs(valence) * 0.7);
  }
  if (emotion.stress > 0.5) {
    params.Anxiety = Math.min(1.0, emotion.stress * 0.6);
  }
  if (arousal > 0.6 && valence > 0) {
    params.Excitement = Math.min(1.0, arousal * 0.5);
  }

  // Ensure at least one emotion param
  if (Object.keys(params).length === 0) {
    params.Joy = 0.3;  // Neutral-positive fallback
  }

  return params;
}

// ── Filler Insertion ─────────────────────────────────────────────

function selectFillerStyle(emotion: EmotionState, scene: string | null): keyof typeof FILLER_PALETTE {
  if (scene && SCENE_PRESETS[scene]) {
    return SCENE_PRESETS[scene].fillerStyle;
  }

  const { valence, arousal } = emotion.mood;

  if (valence > 0.4 && arousal > 0.5) return 'excitement';
  if (valence > 0.3 && arousal < 0.4) return 'comfort';
  if (valence < -0.1) return 'hesitation';
  if (emotion.sociability > 0.6) return 'playful';
  if (emotion.creativity > 0.5) return 'thinking';

  return 'thinking';  // default
}

/**
 * Insert 2-3 filler words at natural pause points in the text.
 * Natural pauses: sentence starts, after commas, between sentences.
 */
function insertFillers(text: string, style: keyof typeof FILLER_PALETTE, rng = Math.random): string {
  const fillers = FILLER_PALETTE[style] ?? FILLER_PALETTE.thinking;
  const targetCount = 2 + Math.floor(rng() * 2);  // 2-3 fillers

  // Split text into segments at natural pause points
  // (Chinese: 。！？；, or newlines; also English punctuation)
  const segments = text.split(/(?<=[。！？；\n])\s*/);

  if (segments.length <= 1) {
    // Short text: prepend a filler
    const filler = fillers[Math.floor(rng() * fillers.length)];
    return `${filler}${text}`;
  }

  // Insert fillers at random positions between segments
  let insertCount = 0;
  const result: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    // Maybe prepend a filler before this segment (not the first one)
    if (i > 0 && insertCount < targetCount && rng() < 0.6) {
      const filler = fillers[Math.floor(rng() * fillers.length)];
      result.push(filler);
      insertCount++;
    }
    result.push(segments[i]);
  }

  // If we didn't insert enough, prepend one
  if (insertCount === 0) {
    const filler = fillers[Math.floor(rng() * fillers.length)];
    result.unshift(filler);
  }

  return result.join('');
}

// ── Tail Softening ───────────────────────────────────────────────

/**
 * Add warmth to sentence endings for gentle tones.
 * e.g. "好的" → "好的~", "晚安" → "晚安~"
 */
function softenTail(text: string, emotion: EmotionState): string {
  const { valence } = emotion.mood;
  // Only soften for positive/warm moods
  if (valence < 0.2) return text;

  // Add ~ to the last character if it's a friendly ending
  const warmEndings = ['呀', '呢', '吧', '哦', '啦', '啊', '嘛', '呗'];
  const lastChar = text.trim().slice(-1);

  if (warmEndings.includes(lastChar) && !text.endsWith('~')) {
    return text.trimEnd() + '~';
  }

  return text;
}

// ── Main Enrichment Function ─────────────────────────────────────

/**
 * Enrich plain text for voice synthesis.
 * Adds filler words, maps emotions, detects scene presets.
 *
 * @param text - The raw text to speak
 * @param context - Emotion state, persona, and tone
 * @param rng - Random number generator (injectable for testing)
 * @returns Enriched text + TTS emotion parameters
 */
export function enrichForVoice(
  text: string,
  context: EnrichmentContext,
  rng = Math.random,
): EnrichedVoice {
  const { emotion, tone } = context;

  // 1. Detect scene from text content and tone
  const detectedScene = detectScene(text, tone);

  // 2. Map emotion state to TTS parameters
  const emotionParams = mapEmotionToTTSParams(emotion, detectedScene);

  // 3. Select filler style based on emotion/scene
  const fillerStyle = selectFillerStyle(emotion, detectedScene);

  // 4. Insert natural filler words
  let enrichedText = insertFillers(text, fillerStyle, rng);

  // 5. Soften tail for warm tones
  enrichedText = softenTail(enrichedText, emotion);

  return {
    text: enrichedText,
    emotionParams,
    detectedScene,
  };
}

// ── Exports for testing ──────────────────────────────────────────

export { detectScene, mapEmotionToTTSParams, insertFillers, softenTail, selectFillerStyle };
export { FILLER_PALETTE, SCENE_PRESETS, SCENE_KEYWORDS };
