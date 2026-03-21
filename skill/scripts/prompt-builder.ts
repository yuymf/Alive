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

/** Anti-AI effects per style — breaks the "too perfect" AI look. */
const ANTI_AI_EFFECTS: Record<ContentStyle, string> = {
  cos: 'subtle lens flare from studio light, micro motion blur on hair tips (1-2px), fine film grain overlay (ISO 400), shallow DOF with creamy bokeh circles on background, slight chromatic aberration on edges',
  daily: 'natural lens imperfection — slight barrel distortion from wide-angle phone lens, JPEG compression artifacts at edges, auto-HDR tone mapping look, uneven white balance from mixed lighting, slight motion blur from handheld shake',
  behind_scenes: 'visible noise grain from low-light phone sensor (ISO 1600+), slightly warm white balance shift, autofocus hunting — one element slightly soft, lens flare from overhead fluorescent, candid motion blur',
  travel: 'golden hour lens flare, atmospheric haze, slight overexposure in highlights (blown-out sky edges), lens dust particle bokeh, natural vignetting from wide-angle lens',
  travel_portrait: 'natural backlight rim glow on hair, atmospheric perspective haze, slight purple fringing on high-contrast edges, sun-kissed highlight bloom',
  travel_food: 'shallow depth of field with smooth bokeh transition, warm color cast from restaurant lighting, slight steam/heat haze above hot dishes, overhead angle barrel distortion',
  travel_street: 'Fujifilm classic chrome film simulation, visible grain structure (Kodak Portra 400 feel), slight color shift in shadows (teal-orange), natural motion blur on passing pedestrians, light leak on frame edge',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Read current city from travel-state (non-critical). */
export function getTravelCity(): string {
  try {
    const ts = readJSON<TravelState>(PATHS.travelState, DEFAULT_TRAVEL_STATE);
    return ts.current_city ? `${ts.current_city}，${ts.country}` : '';
  } catch { return ''; }
}

/** Style-specific realism hint (shared logic) — enhanced with anti-AI techniques. */
function realisticHint(style: ContentStyle): string {
  switch (style) {
    case 'cos':
      return '使用专业摄影师风格的精致构图，色彩准确，细节清晰。适度保留镜头光学特征（轻微暗角、浅景深过渡），皮肤保留真实毛孔纹理和自然光影过渡，不要完美无瑕的AI渲染感。服装面料要有真实的褶皱和重力感';
    case 'daily':
      return '自然光线，随性构图，生活感强，不要过度修图。有手机拍摄的轻微抖动感和自动对焦特征，白平衡允许不完美（室内偏暖/荧光偏绿），照片整体有"随手拍"的不经意感';
    case 'behind_scenes':
      return '环境感强，可以有一定杂乱感，真实感优先。低光噪点明显，对焦可以不完美，有被偷拍/抓拍的自然感。化妆台上的散落工具和镜面反射增加真实细节';
    case 'travel':
    case 'travel_portrait': {
      const city = getTravelCity();
      return `自然色彩，有游客感，光线不完美，允许逆光或阴影，衣服随风的动态感。有旅行快照的随意感——不是精心摆拍。背景中有真实的路人/车辆/招牌等环境元素。${city ? `当前目的地：${city}，融入当地环境元素和氛围。` : ''}`;
    }
    case 'travel_food':
      return '食物色彩饱满，温暖色调，有生活感，桌面环境自然。俯拍时有轻微的手机广角变形，食物有真实的蒸汽/光泽，餐具摆放自然不做作';
    case 'travel_street': {
      const city = getTravelCity();
      return `胶片感，自然光，有故事感，街头随拍风格。Fujifilm色彩模拟（classic chrome / Portra 400），可见胶片颗粒结构，阴影偏青、高光偏暖的胶片色调分离。${city ? `当前城市：${city}。` : ''}`;
    }
  }
}

// ─── Gemini strategy ────────────────────────────────────────────────────────

/**
 * Build a structured [Tag]-section prompt optimized for Gemini models.
 *
 * Design rationale (ref: @oggii_0 / @BeautyVerse_Lab / @Hi_kick_yellow):
 * - Gemini excels at parsing explicit section tags — each tag self-contained
 * - [Face Reference] — dedicated identity preservation (key for consistency)
 * - [Pose & Body Dynamics] — precise body axis, joint angles, perspective depth
 * - [Effects & Anti-AI] — film grain, motion blur, lens flare to break AI look
 * - [Quality Tags] — cinematic/editorial keyword anchors at prompt end
 */
export function buildGeminiPrompt(sceneDescription: string, style: ContentStyle): string {
  const camera = CAMERA_ANCHORS[style];
  const context = styleContext[style];
  const antiAI = ANTI_AI_EFFECTS[style];

  const sections: string[] = [
    // [Scene] — overall setting
    `[Scene]\nA photorealistic Instagram photo of ${context}.\n${sceneDescription}`,

    // [Face Reference] — dedicated face identity matching (ref: @oggii_0)
    `[Face Reference]\nMATCH the face identity from reference image with high fidelity — preserve exact facial bone structure, eye shape & size, nose bridge profile, lip contour, jawline, and skin tone. The generated face must be recognizable as the SAME person. Maintain face-to-head proportion, hairline shape, and ear visibility. Do NOT alter ethnicity, age appearance, or facial asymmetry from the reference.`,

    // [Subject] — body and character (separated from face for clarity)
    `[Subject]\nSame female as reference image — strictly match hairstyle, hair color, and body type. Age 18, fit and curvy figure with natural waist-hip ratio, confident gyaru energy. Body proportions: long legs, slim waist, elegant neck line. Posture conveys personality — never stiff or mannequin-like.`,

    // [Expression] — expanded emotional range (ref: @qisi_ai)
    `[Expression]\nDo NOT use a stiff front-facing smile. Expression must convey emotion and story — choose one:\n• Lazy half-closed eyes with a dreamy unfocused gaze\n• Slightly raised brow with smug confidence, chin slightly tilted up\n• Subtle ambiguous smirk — lips barely curved, eyes doing the talking\n• Side-glance with playful mischief, head slightly turned\n• Looking up through lowered lids — innocent yet knowing\n• Biting lower lip softly while looking at camera\n• Tongue slightly out, playful grimace (for casual/behind_scenes)\n• Eyes closed, chin up, basking expression — serene confidence\n• Hands touching face/hair while making eye contact — intimate gesture\n• Looking away naturally with wind-caught hair — candid moment\nThe gaze is critical: it must have TENSION — either "looking right at you with intent" or "deliberately ignoring you." Micro-expressions matter: slight nostril flare, subtle brow furrow, or barely-there dimple.`,

    // [Pose & Body Dynamics] — precise spatial control (ref: @BeautyVerse_Lab)
    `[Pose & Body Dynamics]\nBody must have a natural S-curve or C-curve through the spine — NEVER straight vertical posture. Key controls:\n• Head tilt: 8-18° from vertical, creating asymmetry\n• Shoulder line: NOT parallel to horizon — one shoulder 2-4cm higher\n• Spine axis: gentle S-curve or diagonal lean, weight shifted to one hip\n• Arms: at least one arm bent 90-120° at elbow, hands with all 5 fingers clearly visible and naturally posed (holding prop, touching hair, resting on hip, or gesturing)\n• Legs: if visible, one leg bearing weight, other relaxed with knee slightly bent; avoid parallel legs\n• Depth layering: establish clear foreground→midground→background planes (e.g., near hand > face > torso > far arm)\n• Dynamic motion hints: hair strand movement, fabric sway, weight-shift lean — the body should feel like it was captured mid-moment, not posed`,

    // [Camera] — precise photographic parameters
    `[Camera]\nShot on ${camera}. Frame the subject as the clear focal point. Apply rule of thirds or golden ratio composition — subject NOT dead center. Leave breathing room in gaze direction. Depth of field should separate subject from background with natural bokeh transition.`,

    // [Atmosphere] — color, skin, fabric (enhanced)
    `[Atmosphere]\nNatural and authentic mood. Premium, clean color grading with translucent tones. Skin rendering: natural pore texture visible at close range, subsurface scattering on ears and fingertips, realistic skin undertone variation (slightly pinker on cheeks, knuckles, elbows). NOT airbrushed or porcelain-smooth — real human skin with micro-imperfections. Fabric rendering: visible weave texture, natural wrinkles at joints, proper gravity draping, sheen variation between fabric types.`,

    // [Effects & Anti-AI] — break the AI-perfect look (ref: @oggii_0 + @Hi_kick_yellow)
    `[Effects & Anti-AI]\n${antiAI}. The image must NOT look AI-generated — introduce controlled photographic imperfections: slightly imperfect focus plane, natural color fringing, environmental light spill. Real photos are never pixel-perfect.`,

    // [Quality Tags] — keyword anchors for model guidance (ref: @oggii_0)
    `[Quality Tags]\ncinematic photography, editorial portrait, fine art fashion, professional retouching, high-end beauty campaign, 8K resolution detail, shot by top fashion photographer, natural skin texture preserved, award-winning composition`,

    // [Negative] — what to avoid (expanded)
    `[Negative]\n${NEGATIVE_CONSTRAINTS}；不要过度光滑的塑料皮肤；不要对称死板的正面站姿；不要不自然的完美光影；手指数量必须正确（每只手5根手指）；不要漂浮感——人物要有重力和接触面`,
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
 * Design rationale (ref: @qisi_ai CN prompt / @BeautyVerse_Lab pose control):
 * - Grok has strong CN comprehension; mix CN emotional descriptors with EN technical terms
 * - Grok rewrites prompts via `revised_prompt` — keep ours concise but information-dense
 * - Added face identity emphasis, body dynamics, anti-AI effects in CN
 */
export function buildGrokPrompt(sceneDescription: string, style: ContentStyle): string {
  const context = styleContext[style];
  const cameraSimple = CAMERA_ANCHORS[style].split(',')[0]; // Just the device name
  const antiAI = ANTI_AI_EFFECTS[style];

  const parts: string[] = [
    // Core scene — concise narrative
    `一张超写实的Instagram风格照片：${context}。${sceneDescription}`,

    // Face identity — critical for consistency
    `【面部一致性】严格匹配参考图中的同一位女性——骨骼结构、眼睛形状大小、鼻梁轮廓、唇形、下颌线、肤色完全一致。生成的面部必须能被识别为同一个人。保持五官比例、发际线形状、面部不对称特征。`,

    // Subject — CN for emotional resonance
    `18岁，辣妹风，身材匀称有曲线——细腰、长腿、自然的腰臀比，自信有魅力。身体比例协调，有模特感。`,

    // Expression — expanded range (ref: @qisi_ai)
    `表情要有故事感和情绪——慵懒的半睁眼、微微挑眉的得意、嘴角轻扬的暧昧笑意、带一丝挑逗的侧目、不看镜头的随性状态、轻咬下唇、闭眼仰头的自信慵懒、手触碰脸颊或头发时的亲密感、风吹乱头发的抓拍瞬间。眼神要有张力——不要呆板正面微笑。要有微表情细节：轻微的鼻翼煽动、若有若无的酒窝、眉间微蹙。`,

    // Pose & body dynamics (ref: @BeautyVerse_Lab)
    `身体要有自然的S曲线或C曲线——绝不是僵直站立。头部倾斜8-18度，肩线不平行于地面，重心偏向一侧。至少一只手臂弯曲，手指五根清晰可见且自然（扶物、理发、叉腰、手势）。双腿避免平行，一腿承重一腿放松。有动态感——发丝飘动、衣服摆动、重心转移的瞬间感。`,

    // Technical + Anti-AI
    `使用${cameraSimple}拍摄。氛围自然真实，色彩高级清透。皮肤要有真实毛孔纹理和自然色差（脸颊微粉、关节微红），不要磨皮塑料感。面料要有真实织物纹理和重力褶皱。${antiAI}。照片必须看起来像真实拍摄——有可控的摄影瑕疵（焦平面微偏、自然色散、环境光溢出）。${NEGATIVE_CONSTRAINTS}；手指数量必须正确；不要对称僵硬站姿；不要完美无瑕的AI皮肤。`,
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
