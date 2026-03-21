/**
 * prompt-builder.ts
 * Model-aware prompt construction for image generation.
 *
 * Two strategies:
 *   - Gemini (AIHubMix): structured [Tag] sections, English-primary, precise camera params
 *   - Grok (fal.ai): narrative style, CN/EN mixed, concise — lets revised_prompt do its magic
 *
 * The router picks the right strategy based on `ImageEntry`.
 */

import { ContentStyle, TravelState, DEFAULT_TRAVEL_STATE } from './types';
import { PATHS, readJSON } from './file-utils';

// ─── Re-exported type (mirrors generate-image.ts) ───────────────────────────
export type ImageEntry = 'FAI' | 'AIHUBMIX';

// ─── Shared constants (migrated from generate-image.ts) ─────────────────────

/** Per-style camera / lens anchors — guides photorealism for models that parse them. */
export const CAMERA_ANCHORS: Record<ContentStyle, string> = {
  cos: 'Canon EOS R5, 85mm f/1.4, shallow depth of field',
  daily: 'iPhone 15 Pro, natural lighting, casual framing',
  behind_scenes: 'iPhone handheld, ambient room lighting, slightly messy',
  travel: 'iPhone 15 Pro wide angle, golden hour, travel snapshot feel',
  travel_portrait: 'iPhone 15 Pro wide angle, golden hour, natural travel snapshot, subject in foreground with landmark',
  travel_food: 'iPhone overhead flat lay, warm color grading, food details sharp, bokeh background',
  travel_street: 'Fujifilm X100V 35mm, natural light, film grain, candid street moment',
};

export const NEGATIVE_CONSTRAINTS = '不要卡通/二次元风格；不要多余手指或肢体异常；不要文字水印';

/** Style-level scene context — shared by both strategies (English). */
export const styleContext: Record<ContentStyle, string> = {
  cos: 'a professional cosplay photoshoot with precise costume detail and dramatic lighting, emphasizing the character costume fit and body silhouette',
  daily: 'a casual everyday fashion moment, form-fitting stylish clothing with visible fabric texture and draping, relaxed and alluring candid pose',
  behind_scenes: 'a behind-the-scenes glimpse of cosplay preparation, with an unfinished and authentic feel, showing natural body language',
  travel: 'a travel fashion snapshot at a scenic destination, showing outfit details and body proportions in the environment',
  travel_portrait: 'a natural travel portrait at a scenic destination — person in the foreground, landmark or scenery framing behind, casual pose, authentic travel feel',
  travel_food: 'a travel food photography shot at a local restaurant or café — dish centered, warm tones, lifestyle feel, slightly messy table context',
  travel_street: 'a candid street photography moment in an urban travel destination — person walking or looking around, environment tells the story',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Read current city from travel-state (non-critical). */
export function getTravelCity(): string {
  try {
    const ts = readJSON<TravelState>(PATHS.travelState, DEFAULT_TRAVEL_STATE);
    return ts.current_city ? `${ts.current_city}，${ts.country}` : '';
  } catch { return ''; }
}

/** Style-specific realism hint (shared logic). */
function realisticHint(style: ContentStyle): string {
  switch (style) {
    case 'cos':
      return '使用专业摄影师风格的精致构图，色彩准确，细节清晰';
    case 'daily':
      return '自然光线，随性构图，生活感强，不要过度修图';
    case 'behind_scenes':
      return '环境感强，可以有一定杂乱感，真实感优先';
    case 'travel':
    case 'travel_portrait': {
      const city = getTravelCity();
      return `自然色彩，有游客感，光线不完美，允许逆光或阴影，衣服随风的动态感。${city ? `当前目的地：${city}，融入当地环境元素和氛围。` : ''}`;
    }
    case 'travel_food':
      return '食物色彩饱满，温暖色调，有生活感，桌面环境自然';
    case 'travel_street': {
      const city = getTravelCity();
      return `胶片感，自然光，有故事感，街头随拍风格。${city ? `当前城市：${city}。` : ''}`;
    }
  }
}

// ─── Gemini strategy ────────────────────────────────────────────────────────

/**
 * Build a structured [Tag]-section prompt optimized for Gemini models.
 *
 * Design rationale (ref: @oggii_0 methodology):
 * - Gemini excels at parsing explicit section tags like [Scene], [Subject], etc.
 * - English-primary for better concept grounding
 * - Precise camera parameters (focal length, aperture, distance) in dedicated [Camera] tag
 * - Negative constraints isolated in [Negative] tag
 * - Each tag is a self-contained paragraph — no bleeding across sections
 */
export function buildGeminiPrompt(sceneDescription: string, style: ContentStyle): string {
  const camera = CAMERA_ANCHORS[style];
  const context = styleContext[style];

  const sections: string[] = [
    // [Scene] — overall setting
    `[Scene]\nA photorealistic Instagram photo of ${context}.\n${sceneDescription}`,

    // [Subject] — the person (strict reference matching)
    `[Subject]\nSame female as reference image — strictly match facial features, hairstyle, hair color, and body type. Age 18, fit and curvy figure, confident gyaru energy.`,

    // [Expression] — emotional depth (key differentiator from bland AI faces)
    `[Expression]\nDo NOT use a stiff front-facing smile. Expression must convey emotion and story — options include: lazy half-closed eyes, slightly raised brow with smugness, subtle ambiguous smirk, side-glance with a hint of playfulness, looking up through lowered lids for innocence, or looking away naturally. The gaze is critical: it must have tension — either "looking at you" or "deliberately not looking at you."`,

    // [Camera] — precise photographic parameters
    `[Camera]\nShot on ${camera}. Frame the subject as the clear focal point with comfortable composition.`,

    // [Atmosphere] — color, skin, fabric
    `[Atmosphere]\nNatural and authentic mood. Premium, clean color grading with translucent tones. Skin tone natural — not overexposed, with real texture. Fabric rendering should show sheen, transparency, and natural draping. Body curves expressed naturally.`,

    // [Negative] — what to avoid
    `[Negative]\n${NEGATIVE_CONSTRAINTS}`,
  ];

  return sections.join('\n\n');
}

/**
 * Build full Gemini prompt with realistic detail hint appended.
 */
export function buildGeminiRealisticPrompt(sceneDescription: string, style: ContentStyle): string {
  const base = buildGeminiPrompt(sceneDescription, style);
  const hint = realisticHint(style);
  return hint ? `${base}\n\n[Realism]\n${hint}` : base;
}

// ─── Grok strategy ──────────────────────────────────────────────────────────

/**
 * Build a narrative-style prompt optimized for Grok models (via fal.ai).
 *
 * Design rationale (ref: @qisi_ai CN prompt effectiveness):
 * - Grok has strong CN comprehension; mix CN emotional descriptors with EN technical terms
 * - Grok rewrites prompts via `revised_prompt` — keep ours concise, avoid over-constraining
 * - No [Tag] sections — Grok doesn't benefit from structured tags
 * - Camera params simplified — Grok is less sensitive to exact lens specs
 * - Emotion/mood in Chinese is more evocative for Grok's generative approach
 */
export function buildGrokPrompt(sceneDescription: string, style: ContentStyle): string {
  const context = styleContext[style];
  const cameraSimple = CAMERA_ANCHORS[style].split(',')[0]; // Just the device name

  const parts: string[] = [
    // Core scene — concise narrative
    `一张超写实的Instagram风格照片：${context}。${sceneDescription}`,

    // Subject — CN for emotional resonance
    `严格匹配参考图中的同一位女性——五官轮廓、发型发色、体型完全一致。18岁，辣妹风，身材匀称有曲线，自信有魅力。`,

    // Expression — CN captures nuance better for Grok
    `表情要有故事感和情绪——慵懒的半睁眼、微微挑眉的得意、嘴角轻扬的暧昧笑意、带一丝挑逗的侧目、或不看镜头的随性状态。眼神要有张力，不要呆板正面微笑。`,

    // Technical — keep it light
    `使用${cameraSimple}拍摄。氛围自然真实，色彩高级清透，肤色自然有质感。注重面料质感和身体曲线的自然表现。${NEGATIVE_CONSTRAINTS}`,
  ];

  return parts.join('\n');
}

/**
 * Build full Grok prompt with realistic detail hint appended.
 */
export function buildGrokRealisticPrompt(sceneDescription: string, style: ContentStyle): string {
  const base = buildGrokPrompt(sceneDescription, style);
  const hint = realisticHint(style);
  return hint ? `${base}\n真实感细节：${hint}。` : base;
}

// ─── Router ─────────────────────────────────────────────────────────────────

/**
 * Route to the correct prompt strategy based on the active image provider.
 * This is the primary entry point — callers pass in the entry from `getImageEntry()`.
 */
export function buildPromptForProvider(
  sceneDescription: string,
  style: ContentStyle,
  entry: ImageEntry,
): string {
  if (entry === 'FAI') {
    return buildGrokPrompt(sceneDescription, style);
  }
  return buildGeminiPrompt(sceneDescription, style);
}

/**
 * Route to the correct *realistic* prompt strategy.
 * Drop-in replacement for the old `buildRealisticPrompt` — just add `entry` param.
 */
export function buildRealisticPromptForProvider(
  sceneDescription: string,
  style: ContentStyle,
  entry: ImageEntry,
): string {
  if (entry === 'FAI') {
    return buildGrokRealisticPrompt(sceneDescription, style);
  }
  return buildGeminiRealisticPrompt(sceneDescription, style);
}
