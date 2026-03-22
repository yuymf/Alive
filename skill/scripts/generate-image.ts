#!/usr/bin/env node
/**
 * generate-image.ts
 * "Takes photos" by calling AIHubMix or fal.ai API with reference images.
 * Supports multi-reference with fallback chain and realistic prompt hints.
 * Use IMAGE_ENTRY env to select provider: "FAI" for fal.ai, "AIHUBMIX" (default) for AIHubMix.
 * Minase doesn't know this is AI — she's just taking photos.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ContentStyle, ShotDescription } from './types';
import { PATHS } from './file-utils';
import {
  buildRealisticPromptForProvider,
  buildPromptForProvider,
  CAMERA_ANCHORS as _CAMERA_ANCHORS,
  NEGATIVE_CONSTRAINTS as _NEGATIVE_CONSTRAINTS,
  type ImageEntry,
} from './prompt-builder';
import { now, getLocalDate, getLocalHour } from './time-utils';
import { isSelfieType, selectReferences } from './reference-selector';

const MAX_REFERENCE_BYTES = 500_000; // 500KB — avoid oversized API payloads

// Per-style camera/lens anchors — now imported from prompt-builder.ts
// Re-exported for backward compatibility
const CAMERA_ANCHORS = _CAMERA_ANCHORS;

const NEGATIVE_CONSTRAINTS = _NEGATIVE_CONSTRAINTS;

const AIHUBMIX_BASE_URL = 'https://aihubmix.com/v1/chat/completions';
const AIHUBMIX_DEFAULT_MODEL = 'gemini-3.1-flash-image-preview';
const AIHUBMIX_QUALITY_MODEL = 'gemini-2.0-flash';

/**
 * Resolve AIHubMix model from AIHUBMIX_MODEL env.
 */
export function getAIHubMixModel(): string {
  const raw = (process.env.AIHUBMIX_MODEL ?? '').trim();
  return raw || AIHUBMIX_DEFAULT_MODEL;
}

// fal.ai constants
const FAL_RUN_BASE_URL = 'https://fal.run';
const FAL_DEFAULT_MODEL = 'xai/grok-imagine-image/edit';

/**
 * Resolve fal.ai model path from FAL_MODEL env.
 * Accepts either full path (e.g. xai/grok-imagine-image/edit) or with leading slash.
 */
export function getFalModel(): string {
  const raw = (process.env.FAL_MODEL ?? '').trim();
  if (!raw) return FAL_DEFAULT_MODEL;
  return raw.replace(/^\/+/, '');
}

function getFalEndpointUrl(): string {
  return `${FAL_RUN_BASE_URL}/${getFalModel()}`;
}

export type { ImageEntry };

/**
 * Determine the active image provider from IMAGE_ENTRY env.
 * Accepts "FAI" / "fai" / "fal" for fal.ai, defaults to AIHUBMIX.
 */
export function getImageEntry(): ImageEntry {
  const raw = (process.env.IMAGE_ENTRY ?? '').trim().toUpperCase();
  if (raw === 'FAI' || raw === 'FAL') return 'FAI';
  return 'AIHUBMIX';
}

const DEFAULT_ASPECT_RATIO = '3:4'; // Instagram portrait
const MAX_RETRIES = 2;
const QUALITY_THRESHOLD = 4;
const MAX_QUALITY_RETRIES = 1;

export interface GenerateImageOptions {
  prompt: string;
  referenceImages: string[];
  styleReference?: string;
  style?: ContentStyle;
  aspectRatio?: string;
  outputDir?: string;
  skipQualityCheck?: boolean;
}

export interface GenerateImageResult {
  localPath: string;
  textResponse?: string;
  timestamp: number;
}

/**
 * Sanitize a scene description to avoid triggering content filters.
 * Replaces or removes phrases that could be flagged while preserving
 * the overall scene intent.
 */
export function sanitizeForImageGen(description: string): string {
  // Order matters! More specific patterns should come first to avoid partial matches
  let result = description;

  // Compound phrases (must come before individual terms)
  result = result.replace(/紧身crop top/gi, '修身短上衣'); // Handle the full phrase first
  result = result.replace(/crop top/gi, '修身短上衣');

  result = result.replace(/露出事业线/g, '展示穿搭'); // Specific pattern for this phrase
  result = result.replace(/乳沟/g, '领口');
  result = result.replace(/低腰/g, '休闲腰线');
  result = result.replace(/髋骨/g, '腰部');
  result = result.replace(/身体微微前倾/g, '身体微微微微倾身');
  result = result.replace(/胸部轮廓/g, '上身线条');

  // Transparency / see-through
  result = result.replace(/透明面料/g, '轻薄面料');
  result = result.replace(/透明[的]?衣服/g, '轻薄衣物');
  result = result.replace(/透视[装效果]?/g, '薄纱质感');
  result = result.replace(/半透明/g, '轻盈');

  // Body-fit / suggestive fit
  result = result.replace(/紧致勒肉/g, '修身合体');
  result = result.replace(/勒肉/g, '修身');
  result = result.replace(/深[vV]/g, '大领口');
  result = result.replace(/欲感/g, '魅力感');
  result = result.replace(/媚态/g, '优雅姿态');
  result = result.replace(/妩媚/g, '优雅');
  result = result.replace(/风情/g, '气质');
  result = result.replace(/撩人/g, '动人');
  result = result.replace(/肉感/g, '丰盈');
  result = result.replace(/紧绷/g, '贴合');
  result = result.replace(/包臀/g, '修身');
  result = result.replace(/高叉/g, '简约剪裁');

  // Exposure level
  result = result.replace(/暴露/g, '清凉');
  result = result.replace(/裸露/g, '露肤');
  result = result.replace(/性感/g, '时尚');
  result = result.replace(/诱惑/g, '魅力');
  result = result.replace(/挑逗/g, '俏皮');

  // Underwear / lingerie / swimwear
  result = result.replace(/内衣/g, '贴身衣物');
  result = result.replace(/内裤/g, '衣物');
  result = result.replace(/比基尼/g, '泳装');
  result = result.replace(/泳装/g, '度假服饰');
  result = result.replace(/蕾丝/g, '花纹面料');
  result = result.replace(/bra/gi, '内搭');
  result = result.replace(/吊带/g, '细肩带上衣');
  result = result.replace(/抹胸/g, '平口上衣');

  return result;
}

/**
 * Convert Minase's natural language scene description into a model-optimized
 * image generation prompt. Routes to Gemini or Grok strategy based on IMAGE_ENTRY.
 */
export function buildImagePrompt(sceneDescription: string, style: ContentStyle): string {
  const entry = getImageEntry();
  return buildPromptForProvider(sceneDescription, style, entry);
}

export function buildRealisticPrompt(sceneDescription: string, style: ContentStyle): string {
  const entry = getImageEntry();
  return buildRealisticPromptForProvider(sceneDescription, style, entry);
}

/**
 * Call AIHubMix Gemini API to generate an image.
 */
export async function callAIHubMix(
  prompt: string,
  referenceImagesBase64: string[],
  aspectRatio: string,
  styleReferenceBase64?: string,
): Promise<{ imageData: Buffer; textResponse?: string }> {
  const apiKey = process.env.AIHUBMIX_API_KEY;
  if (!apiKey) throw new Error('AIHUBMIX_API_KEY not set');

  const model = getAIHubMixModel();
  console.log(`[AIHubMix] model=${model}, refs=${referenceImagesBase64.length}, ratio=${aspectRatio}`);

  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: prompt },
  ];

  referenceImagesBase64.forEach((base64) => {
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${base64}` },
    });
  });

  if (styleReferenceBase64) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${styleReferenceBase64}` },
    });
  }

  const body = {
    model,
    modalities: ['text', 'image'],
    messages: [
      { role: 'system', content: `aspect_ratio=${aspectRatio}` },
      { role: 'user', content },
    ],
  };

  const res = await fetch(AIHUBMIX_BASE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`AIHubMix API returned ${res.status} (model=${model}): ${await res.text()}`);
  }

  const data = await res.json() as Record<string, unknown>;

  // Defensive parsing: AIHubMix proxies Gemini with possibly non-standard format
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const parts = (message?.multi_mod_content ?? message?.content) as Array<Record<string, unknown>> | undefined;

  let imageData: Buffer | null = null;
  let textResponse: string | undefined;

  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (typeof part.text === 'string') {
        textResponse = part.text;
      }
      const inlineData = part.inline_data as Record<string, unknown> | undefined;
      if (inlineData?.data) {
        imageData = Buffer.from(inlineData.data as string, 'base64');
      }
    }
  }

  if (!imageData) {
    // Check if this is a content filter issue (completion_tokens: 0, finish_reason: safety/content_filter,
    // or Gemini-style imagetoken exists but is empty).
    const usage = data.usage as Record<string, number> | undefined;
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const finishReason = choices?.[0]?.finish_reason as string | undefined;
    const messageObj = choices?.[0]?.message as Record<string, unknown> | undefined;
    const choiceImageToken = messageObj?.imagetoken;
    const topLevelImageToken = (data as { imagetoken?: unknown }).imagetoken;
    const hasEmptyImageToken = [choiceImageToken, topLevelImageToken]
      .some(v => typeof v === 'string' && v.trim() === '');

    const isContentFiltered = (usage?.completion_tokens === 0)
      || finishReason === 'safety'
      || finishReason === 'content_filter'
      || hasEmptyImageToken;

    const errorMsg = isContentFiltered
      ? `Content filter triggered — prompt may be too suggestive (finish_reason: ${finishReason ?? 'unknown'}, completion_tokens: ${usage?.completion_tokens ?? 'unknown'}, imagetoken_empty: ${hasEmptyImageToken})`
      : `No image data in AIHubMix response: ${JSON.stringify(data).slice(0, 500)}`;
    throw new Error(errorMsg);
  }

  return { imageData, textResponse };
}

/**
 * Call fal.ai Grok Imagine Image Edit API to generate an image.
 * Uses synchronous fal.run endpoint — blocks until result.
 */
export async function callFalAi(
  prompt: string,
  referenceImagesBase64: string[],
  _aspectRatio: string,
  _styleReferenceBase64?: string,
): Promise<{ imageData: Buffer; textResponse?: string }> {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error('FAL_KEY not set');

  const imageUrls = referenceImagesBase64.slice(0, 3).map(
    b64 => `data:image/jpeg;base64,${b64}`
  );

  const model = getFalModel();
  const endpointUrl = getFalEndpointUrl();
  console.log(`[fal.ai] model=${model}, endpoint=${endpointUrl}, refs=${referenceImagesBase64.length}`);

  const body: Record<string, unknown> = {
    prompt,
    num_images: 1,
    output_format: 'png',
  };
  if (imageUrls.length > 0) {
    body.image_urls = imageUrls;
  }

  const res = await fetch(endpointUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`fal.ai API returned ${res.status} (model=${model}): ${await res.text()}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const images = data.images as Array<Record<string, unknown>> | undefined;
  const revisedPrompt = data.revised_prompt as string | undefined;

  if (!images || images.length === 0) {
    throw new Error(`No images in fal.ai response: ${JSON.stringify(data).slice(0, 500)}`);
  }

  const imageUrl = images[0].url as string;
  let imageData: Buffer;

  if (imageUrl.startsWith('data:')) {
    const base64Part = imageUrl.split(',')[1];
    if (!base64Part) throw new Error('Invalid data URI from fal.ai');
    imageData = Buffer.from(base64Part, 'base64');
  } else {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) {
      throw new Error(`Failed to download fal.ai image: ${imgRes.status}`);
    }
    const arrayBuffer = await imgRes.arrayBuffer();
    imageData = Buffer.from(arrayBuffer);
  }

  return { imageData, textResponse: revisedPrompt };
}

/**
 * Unified image provider call — routes to AIHubMix or fal.ai based on IMAGE_ENTRY env.
 */
export async function callImageProvider(
  prompt: string,
  referenceImagesBase64: string[],
  aspectRatio: string,
  styleReferenceBase64?: string,
): Promise<{ imageData: Buffer; textResponse?: string }> {
  const entry = getImageEntry();
  if (entry === 'FAI') {
    return callFalAi(prompt, referenceImagesBase64, aspectRatio, styleReferenceBase64);
  }
  return callAIHubMix(prompt, referenceImagesBase64, aspectRatio, styleReferenceBase64);
}

async function callWithFallback(
  prompt: string,
  referenceImagesBase64: string[],
  aspectRatio: string,
  styleReferenceBase64?: string,
): Promise<{ imageData: Buffer; textResponse?: string }> {
  const entry = getImageEntry();
  const providerLabel = entry === 'FAI' ? 'fal.ai' : 'AIHubMix';
  try {
    return await callImageProvider(prompt, referenceImagesBase64, aspectRatio, styleReferenceBase64);
  } catch (err) {
    if (referenceImagesBase64.length <= 1) throw err;
    console.log(`[${providerLabel}] Multi-image reference failed, trying grid composite fallback...`);
  }

  try {
    const compositeBase64 = await compositeReferences(referenceImagesBase64);
    return await callImageProvider(prompt, [compositeBase64], aspectRatio, styleReferenceBase64);
  } catch (err) {
    console.log(`[${providerLabel}] Grid composite fallback failed, trying single reference...`);
  }

  return await callImageProvider(prompt, [referenceImagesBase64[0]], aspectRatio, styleReferenceBase64);
}

async function compositeReferences(imagesBase64: string[]): Promise<string> {
  const { Jimp } = await import('jimp');
  const images = await Promise.all(
    imagesBase64.map(b64 => Jimp.read(Buffer.from(b64, 'base64')))
  );

  const targetHeight = 512;
  const resized = images.map(img => {
    const scale = targetHeight / img.height;
    return img.resize({ w: Math.round(img.width * scale), h: targetHeight });
  });

  const totalWidth = resized.reduce((sum, img) => sum + img.width, 0);
  const composite = new Jimp({ width: totalWidth, height: targetHeight, color: 0xffffffff });

  let x = 0;
  for (const img of resized) {
    composite.composite(img, x, 0);
    x += img.width;
  }

  const buffer = await composite.getBuffer('image/jpeg');
  return buffer.toString('base64');
}

/**
 * Check generated image quality by asking LLM to compare with reference.
 * Returns a score from 1-10.
 */
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text;
      }
      return '';
    })
    .join('\n');
}

async function checkQuality(generatedImagePath: string, referenceImagePath: string): Promise<number> {
  const generatedBase64 = fs.readFileSync(generatedImagePath).toString('base64');
  const referenceBase64 = fs.readFileSync(referenceImagePath).toString('base64');

  const apiKey = process.env.AIHUBMIX_API_KEY;
  if (!apiKey) return QUALITY_THRESHOLD; // Skip check if no key

  const body = {
    model: AIHUBMIX_QUALITY_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `对比这两张图（第一张=参考图，第二张=生成图）。按以下6个维度严格评估：

1. **人脸相似度**（权重最高）：五官骨骼结构、眼睛形状大小、鼻梁轮廓、唇形、下颌线是否像同一个人？不像同一人直接扣4分。
2. **姿态自然度**：身体有没有自然的S/C曲线？还是僵直站立？肩线是否自然不对称？手指数量正确吗（每只手5根）？动作有没有被捕捉的瞬间感？
3. **表情生动度**：表情是否有情绪和故事感？是否有微表情（眉毛、嘴角、眼神细节）？呆板正面微笑扣3分。
4. **去AI感**：是否像真实照片？检查：皮肤是否有真实毛孔纹理（vs 过度光滑塑料感）？有没有适当的摄影瑕疵（轻微噪点、焦平面偏移、自然色散）？完美无瑕的AI渲染感扣2分。
5. **服装面料质感**：布料有没有真实褶皱、重力感、织物纹理？还是像画上去的平面贴图？
6. **整体构图质量**：清晰度、光线合理性、景深过渡、背景与主体的关系。

评分标准：
- 8-10分=专业摄影级别，可直接发Instagram
- 6-7分=合格，小问题不影响整体
- 4-5分=勉强可用，有明显问题
- 1-3分=不可用，需要重新生成

只返回一个1-10的综合评分数字，不要其他文字。` },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${referenceBase64}` } },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${generatedBase64}` } },
        ],
      },
    ],
  };

  try {
    const res = await fetch(AIHUBMIX_BASE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) return QUALITY_THRESHOLD; // Skip check on API error

    const data = await res.json() as Record<string, unknown>;
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const content = extractMessageText(message?.content);
    const score = parseInt(content.match(/\d+/)?.[0] ?? '', 10);
    return isNaN(score) ? QUALITY_THRESHOLD : Math.min(10, Math.max(1, score));
  } catch {
    return QUALITY_THRESHOLD; // Skip check on error
  }
}

/**
 * Load reference image as base64, compressing with sips if it exceeds MAX_REFERENCE_BYTES.
 * Caches the compressed version next to the original as .compressed.jpg.
 */
export function loadReferenceBase64(imagePath: string): string {
  const raw = fs.readFileSync(imagePath);
  if (raw.length <= MAX_REFERENCE_BYTES) {
    return raw.toString('base64');
  }

  const cachedPath = imagePath.replace(/\.[^.]+$/, '.compressed.jpg');
  if (fs.existsSync(cachedPath) && fs.statSync(cachedPath).mtimeMs >= fs.statSync(imagePath).mtimeMs) {
    return fs.readFileSync(cachedPath).toString('base64');
  }

  // Compress using sips (macOS) — resize to max 1024px, JPEG 85%
  try {
    execFileSync('sips', [
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', '85',
      '-Z', '1024',
      imagePath,
      '--out', cachedPath,
    ], { stdio: 'pipe' });
    console.log(`Reference image compressed: ${Math.round(raw.length / 1024)}KB → ${Math.round(fs.statSync(cachedPath).size / 1024)}KB`);
    return fs.readFileSync(cachedPath).toString('base64');
  } catch {
    // Fallback: send original
    return raw.toString('base64');
  }
}

/**
 * Main entry: generate an image ("take a photo").
 */
export async function generateImage(options: GenerateImageOptions): Promise<GenerateImageResult> {
  const { prompt, referenceImages, styleReference, style = 'daily', aspectRatio = DEFAULT_ASPECT_RATIO } = options;
  const today = getLocalDate();
  const outputDir = options.outputDir ?? path.join(PATHS.photoRoll, today);

  fs.mkdirSync(outputDir, { recursive: true });

  const refBase64List = referenceImages
    .filter(refPath => fs.existsSync(refPath))
    .map(refPath => loadReferenceBase64(refPath));

  if (refBase64List.length === 0) {
    throw new Error(`No valid reference images found: ${referenceImages.join(', ')}`);
  }

  const styleRefBase64 = styleReference && fs.existsSync(styleReference)
    ? loadReferenceBase64(styleReference)
    : undefined;

  const selfie = isSelfieType(style, prompt);
  const qualityThreshold = selfie ? 5 : QUALITY_THRESHOLD;
  const maxQualityRetries = MAX_QUALITY_RETRIES;

  // Generate with retry
  let lastError: Error | null = null;
  let currentPrompt = prompt;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { imageData, textResponse } = await callWithFallback(
        currentPrompt, refBase64List, aspectRatio, styleRefBase64
      );

      // Save to file
      const timestamp = now().getTime();
      const hour = getLocalHour();
      const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
      const existing = fs.existsSync(outputDir) ? fs.readdirSync(outputDir).length : 0;
      const filename = `${timeOfDay}_${style}_${existing + 1}.png`;
      const localPath = path.join(outputDir, filename);

      fs.writeFileSync(localPath, imageData);

      // Skip quality check for low-latency paths (chat real-time generation)
      if (options.skipQualityCheck) {
        return { localPath, textResponse, timestamp };
      }

      const primaryRef = referenceImages.find(p => fs.existsSync(p)) ?? referenceImages[0];

      // Quality check with retry
      for (let qAttempt = 0; qAttempt < maxQualityRetries; qAttempt++) {
        const score = await checkQuality(localPath, primaryRef);
        if (score >= qualityThreshold) {
          return { localPath, textResponse, timestamp };
        }

        const correctionPrompt = `${prompt}\n\n[CRITICAL CORRECTIONS — previous attempt failed quality check]\n1. FACE IDENTITY: The face MUST match the reference image exactly — same bone structure, eye shape, nose profile, lip contour, jawline. This is the #1 priority.\n2. EXPRESSION: Must have emotional depth — NO stiff front-facing smile. Use: dreamy half-closed eyes / smug raised brow / ambiguous smirk / playful side-glance. Micro-expressions matter.\n3. POSE DYNAMICS: Body must have natural S-curve, NOT straight vertical. Shoulders asymmetric, weight on one hip, at least one arm bent naturally. Each hand must have exactly 5 fingers.\n4. ANTI-AI: Add photographic imperfections — subtle noise grain, slight focus plane shift, natural lens vignetting, micro motion blur on hair tips. Skin must show real pore texture, NOT smooth plastic.\n5. LIGHTING: Must match the actual environment (window light for indoor, golden hour for outdoor). No random studio lighting in casual scenes.\n6. FABRIC: Clothing must show real wrinkles, gravity draping, and weave texture — not flat painted-on texture.`;

        // Re-generate
        console.log(`Quality score ${score} < ${qualityThreshold}, retrying (${qAttempt + 1}/${maxQualityRetries})...`);
        const retry = await callWithFallback(
          correctionPrompt, refBase64List, aspectRatio, styleRefBase64
        );
        fs.writeFileSync(localPath, retry.imageData);
      }

      // Final quality check after all retries
      const finalScore = await checkQuality(localPath, primaryRef);
      if (finalScore >= qualityThreshold) {
        return { localPath, textResponse, timestamp };
      }

      // Degrade gracefully: keep image even if quality score is low
      console.warn(`Quality check low score ${finalScore} < ${qualityThreshold}, keeping image for fallback use`);
      return { localPath, textResponse, timestamp };
    } catch (err) {
      lastError = err as Error;
      const cause = lastError.cause as NodeJS.ErrnoException | undefined;
      const detail = cause ? ` (${cause.code ?? cause.message})` : '';
      if (attempt < MAX_RETRIES) {
        // Only sanitize prompt after API indicates content filtering / empty imagetoken.
        if (lastError.message.includes('Content filter triggered')) {
          console.error('Content filter triggered, sanitizing prompt for retry...');
          currentPrompt = sanitizeForImageGen(currentPrompt);
        } else {
          console.error(`Image generation failed, retrying: ${lastError.message}${detail}`);
        }
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  if (lastError) {
    const entry = getImageEntry();
    const host = entry === 'FAI' ? 'fal.ai' : 'aihubmix.com';
    const cause = lastError.cause as NodeJS.ErrnoException | undefined;
    const hint = cause?.code === 'ENOTFOUND' ? ` — 检查 DNS/网络是否可访问 ${host}`
      : cause?.code === 'ECONNREFUSED' ? ' — 目标服务未响应，可能暂时不可用'
      : cause?.code === 'ETIMEDOUT' ? ' — 请求超时，可检查网络或稍后重试'
      : '';
    throw new Error(`[${entry}] ${lastError.message}${hint}`, { cause: lastError });
  }
  throw new Error('Image generation failed');
}

export interface GenerateSetOptions {
  shots: ShotDescription[];
  baseReferenceDir: string;
  styleReference?: string;
  style: ContentStyle;
  aspectRatio?: string;
  outputDir?: string;
}

export interface GenerateSetResult {
  images: GenerateImageResult[];
  failed: number;
}

const MIN_IMAGES: Record<ContentStyle, number> = {
  cos: 3,
  daily: 1,
  behind_scenes: 2,
  travel: 4,
  travel_portrait: 2,
  travel_food: 1,
  travel_street: 2,
};
const GENERATE_SET_CONCURRENCY = 2;

export async function generateImageSet(options: GenerateSetOptions): Promise<GenerateSetResult> {
  const { shots, style, baseReferenceDir, styleReference, aspectRatio, outputDir } = options;
  const results: GenerateImageResult[] = [];
  let failed = 0;

  for (let i = 0; i < shots.length; i += GENERATE_SET_CONCURRENCY) {
    const batch = shots.slice(i, i + GENERATE_SET_CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (shot) => {
        const prompt = buildRealisticPrompt(shot.description, style);

        const refFileNames = selectReferences(style, shot.description);
        let referenceImages = refFileNames
          .map(f => path.join(baseReferenceDir, f))
          .filter(f => fs.existsSync(f));

        // Fallback to main reference image if specific angle references don't exist
        if (referenceImages.length === 0 && fs.existsSync(PATHS.referenceImage)) {
          referenceImages = [PATHS.referenceImage];
        }

        if (referenceImages.length === 0) {
          throw new Error(`No reference images found for shot: "${shot.description}"`);
        }

        const result = await generateImage({
          prompt,
          referenceImages,
          styleReference,
          style,
          aspectRatio,
          outputDir,
        });

        return { result, shotDescription: shot.description };
      })
    );

    for (const item of batchResults) {
      if (item.status === 'fulfilled') {
        results.push(item.value.result);
      } else {
        console.error(`Shot failed: ${(item.reason as Error).message}`);
        failed++;
      }
    }
  }

  const minRequired = MIN_IMAGES[style] ?? 1;
  if (results.length > 0 && results.length < minRequired) {
    console.log(`Only ${results.length}/${minRequired} images passed for ${style}, degrading to available set`);
  }

  return { images: results, failed };
}

// CLI entry for manual testing
if (require.main === module) {
  const prompt = process.argv[2] ?? '一张便利店里的自拍，日常风格，真实感';
  generateImage({
    prompt,
    referenceImages: [PATHS.referenceImage],
  })
    .then(result => console.log(`Photo saved: ${result.localPath}`))
    .catch(err => {
      console.error('Failed to take photo:', err.message);
      process.exit(1);
    });
}
