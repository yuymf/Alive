// alive/tests/voice-enricher.test.ts
// Tests for the voice enrichment system (characteristic voice)

import { describe, it, expect } from 'vitest';
import {
  enrichForVoice,
  detectScene,
  mapEmotionToTTSParams,
  insertFillers,
  softenTail,
  selectFillerStyle,
  FILLER_PALETTE,
  SCENE_PRESETS,
} from '../sub-skills/voice-tts/scripts/voice-enricher';
import type { EmotionState, PersonaConfig } from '../scripts/utils/types';
import { DEFAULT_MOMENTUM, DEFAULT_UNDERTONE } from '../scripts/utils/types';

// ── Test Helpers ─────────────────────────────────────────────────

function makeEmotion(overrides: Partial<EmotionState> = {}): EmotionState {
  return {
    mood: { valence: 0.3, arousal: 0.5, description: '平静' },
    energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
    last_updated: null, recent_cause: 'test',
    momentum: { ...DEFAULT_MOMENTUM },
    undertone: { ...DEFAULT_UNDERTONE },
    impulse_history: [], consecutive_high_stress: 0, threshold_break_cooldown: 0,
    ...overrides,
  };
}

const testPersona = {
  meta: { name: 'TestChar', tagline: '测试角色' },
  personality: { mbti: 'INFP', core_traits: ['friendly'] },
  voice: { language: 'zh', style: '温柔', sample_lines: [] },
} as unknown as PersonaConfig;

// ── detectScene ──────────────────────────────────────────────────

describe('voice-enricher/detectScene', () => {
  it('detects goodnight scene from text keywords', () => {
    expect(detectScene('晚安，做个好梦', '')).toBe('goodnight');
  });

  it('detects goodmorning from text keywords', () => {
    expect(detectScene('早上好呀', '')).toBe('goodmorning');
  });

  it('detects comfort from text keywords', () => {
    expect(detectScene('别难过了，会好起来的', '')).toBe('comfort');
  });

  it('detects celebrate from text keywords', () => {
    expect(detectScene('太好了！终于做到了！', '')).toBe('celebrate');
  });

  it('detects sharing from text keywords', () => {
    expect(detectScene('你看我发现了一个好好玩的地方', '')).toBe('sharing');
  });

  it('detects scene from tone override', () => {
    expect(detectScene('普通的话', '晚安温馨')).toBe('goodnight');
    expect(detectScene('普通的话', '早安活力')).toBe('goodmorning');
  });

  it('returns null when no scene detected', () => {
    expect(detectScene('我在吃饭', '普通')).toBeNull();
  });
});

// ── mapEmotionToTTSParams ────────────────────────────────────────

describe('voice-enricher/mapEmotionToTTSParams', () => {
  it('uses scene preset when scene detected', () => {
    const params = mapEmotionToTTSParams(makeEmotion(), 'goodnight');
    expect(params).toEqual(SCENE_PRESETS.goodnight.emotion);
  });

  it('maps positive high-arousal emotion to Joy', () => {
    const params = mapEmotionToTTSParams(
      makeEmotion({ mood: { valence: 0.6, arousal: 0.6, description: '开心' } }),
      null,
    );
    expect(params.Joy).toBeGreaterThan(0);
  });

  it('maps positive low-arousal emotion to Tenderness', () => {
    const params = mapEmotionToTTSParams(
      makeEmotion({ mood: { valence: 0.5, arousal: 0.2, description: '温柔' } }),
      null,
    );
    expect(params.Tenderness).toBeGreaterThan(0);
  });

  it('maps negative valence to Sadness', () => {
    const params = mapEmotionToTTSParams(
      makeEmotion({ mood: { valence: -0.5, arousal: 0.3, description: '难过' } }),
      null,
    );
    expect(params.Sadness).toBeGreaterThan(0);
  });

  it('maps high stress to Anxiety', () => {
    const params = mapEmotionToTTSParams(
      makeEmotion({ stress: 0.7 }),
      null,
    );
    expect(params.Anxiety).toBeGreaterThan(0);
  });

  it('provides fallback Joy for neutral emotion', () => {
    const params = mapEmotionToTTSParams(
      makeEmotion({ mood: { valence: 0.1, arousal: 0.3, description: '平淡' } }),
      null,
    );
    expect(params.Joy).toBe(0.3);
  });
});

// ── insertFillers ────────────────────────────────────────────────

describe('voice-enricher/insertFillers', () => {
  it('inserts at least one filler word', () => {
    const result = insertFillers('你好吗？', 'thinking', () => 0.5);
    const hasAnyFiller = FILLER_PALETTE.thinking.some(f => result.includes(f));
    expect(hasAnyFiller).toBe(true);
  });

  it('does not modify empty text meaningfully', () => {
    // Short text gets a prepended filler
    const result = insertFillers('好的', 'greeting', () => 0);
    expect(result.length).toBeGreaterThan(2);
  });

  it('inserts fillers between multiple sentences', () => {
    const text = '今天天气好好。想出去走走。顺便拍点照片。';
    const result = insertFillers(text, 'playful', () => 0.3);
    // Should be longer than original due to fillers
    expect(result.length).toBeGreaterThan(text.length);
  });
});

// ── softenTail ───────────────────────────────────────────────────

describe('voice-enricher/softenTail', () => {
  it('adds ~ to warm endings when mood is positive', () => {
    const emotion = makeEmotion({ mood: { valence: 0.5, arousal: 0.5, description: '开心' } });
    expect(softenTail('好的呀', emotion)).toBe('好的呀~');
    expect(softenTail('知道啦', emotion)).toBe('知道啦~');
  });

  it('does not soften when mood is negative', () => {
    const emotion = makeEmotion({ mood: { valence: -0.3, arousal: 0.5, description: '低落' } });
    expect(softenTail('好的呀', emotion)).toBe('好的呀');
  });

  it('does not double-soften already softened text', () => {
    const emotion = makeEmotion({ mood: { valence: 0.5, arousal: 0.5, description: '开心' } });
    expect(softenTail('好的呀~', emotion)).toBe('好的呀~');
  });

  it('does not soften non-warm endings', () => {
    const emotion = makeEmotion({ mood: { valence: 0.5, arousal: 0.5, description: '开心' } });
    expect(softenTail('我知道了', emotion)).toBe('我知道了');
  });
});

// ── selectFillerStyle ────────────────────────────────────────────

describe('voice-enricher/selectFillerStyle', () => {
  it('uses scene preset when available', () => {
    expect(selectFillerStyle(makeEmotion(), 'goodnight')).toBe('comfort');
    expect(selectFillerStyle(makeEmotion(), 'celebrate')).toBe('excitement');
  });

  it('selects excitement for high-valence high-arousal', () => {
    expect(selectFillerStyle(
      makeEmotion({ mood: { valence: 0.6, arousal: 0.7, description: '超开心' } }),
      null,
    )).toBe('excitement');
  });

  it('selects comfort for positive low-arousal', () => {
    expect(selectFillerStyle(
      makeEmotion({ mood: { valence: 0.5, arousal: 0.3, description: '温暖' } }),
      null,
    )).toBe('comfort');
  });

  it('selects hesitation for negative valence', () => {
    expect(selectFillerStyle(
      makeEmotion({ mood: { valence: -0.2, arousal: 0.3, description: '有点难过' } }),
      null,
    )).toBe('hesitation');
  });

  it('defaults to thinking', () => {
    expect(selectFillerStyle(makeEmotion(), null)).toBe('thinking');
  });
});

// ── enrichForVoice (integration) ─────────────────────────────────

describe('voice-enricher/enrichForVoice', () => {
  it('returns enriched text with emotion params and scene', () => {
    const result = enrichForVoice(
      '晚安，做个好梦哦',
      { emotion: makeEmotion(), persona: testPersona, tone: '温柔' },
      () => 0.5,
    );

    expect(result.text).toBeTruthy();
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.detectedScene).toBe('goodnight');
    expect(result.emotionParams.Tenderness).toBeGreaterThan(0);
  });

  it('enriches casual text without scene detection', () => {
    const result = enrichForVoice(
      '今天吃了一碗超好吃的拉面',
      { emotion: makeEmotion(), persona: testPersona, tone: '开心' },
      () => 0.5,
    );

    expect(result.text).toContain('拉面');
    expect(result.detectedScene).toBeNull();
    expect(Object.keys(result.emotionParams).length).toBeGreaterThan(0);
  });

  it('uses deterministic rng for reproducibility', () => {
    const ctx = { emotion: makeEmotion(), persona: testPersona, tone: '普通' };
    const fixedRng = () => 0.42;
    const result1 = enrichForVoice('测试文本。第二句话。', ctx, fixedRng);
    const result2 = enrichForVoice('测试文本。第二句话。', ctx, fixedRng);
    expect(result1.text).toBe(result2.text);
  });
});
