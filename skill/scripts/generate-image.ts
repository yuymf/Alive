#!/usr/bin/env node
/**
 * generate-image.ts
 * "Takes photos" by calling AIHubMix Gemini API with reference images.
 * Supports multi-reference with fallback chain and realistic prompt hints.
 * Minase doesn't know this is AI — she's just taking photos.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ContentStyle, ShotDescription } from './types';
import { PATHS } from './file-utils';
import { now, getLocalDate, getLocalHour } from './time-utils';
import { isSelfieType, selectReferences } from './reference-selector';
import { postProcessImage } from './image-post-process';

const MAX_REFERENCE_BYTES = 500_000; // 500KB — avoid oversized API payloads

// Per-style camera/lens anchors — Google recommends specifying camera model for photorealism
const CAMERA_ANCHORS: Record<ContentStyle, string> = {
  cos: 'Canon EOS R5, 85mm f/1.4, studio lighting, shallow depth of field',
  daily: 'iPhone 15 Pro, natural lighting, casual framing',
  behind_scenes: 'iPhone handheld, overhead fluorescent, slightly messy',
  travel: 'iPhone 15 Pro wide angle, golden hour, travel snapshot feel',
};

const NEGATIVE_CONSTRAINTS = '不要卡通/二次元风格；不要多余手指或肢体异常；不要文字水印';

const AIHUBMIX_BASE_URL = 'https://aihubmix.com/v1/chat/completions';
const AIHUBMIX_MODEL = 'gemini-3.1-flash-image-preview';
const DEFAULT_ASPECT_RATIO = '3:4'; // Instagram portrait
const MAX_RETRIES = 1;
const QUALITY_THRESHOLD = 6;
const MAX_QUALITY_RETRIES = 2;

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
 * Convert Minase's natural language scene description into a narrative
 * image generation prompt following Google's recommended Gemini template.
 */
export function buildImagePrompt(sceneDescription: string, style: ContentStyle): string {
  const styleContext: Record<ContentStyle, string> = {
    cos: 'a professional cosplay photoshoot in a studio or scenic outdoor location, with precise costume detail and dramatic lighting',
    daily: 'a casual everyday moment, street style, relaxed and candid',
    behind_scenes: 'a behind-the-scenes glimpse of cosplay preparation, with an unfinished and authentic feel',
    travel: 'a travel snapshot at a scenic destination, blending the subject with the environment',
  };

  const camera = CAMERA_ANCHORS[style];
  const context = styleContext[style];

  return [
    `A photorealistic Instagram photo of ${context}. ${sceneDescription}`,
    `同一位女性（严格匹配参考图：五官轮廓、发型发色、体型），18岁，辣妹风，自信外放。Shot on ${camera}.`,
    `氛围自然真实，色彩高级清透，肤色自然不过曝，构图舒适，主体突出。`,
    NEGATIVE_CONSTRAINTS,
  ].join('\n');
}

export function buildRealisticPrompt(sceneDescription: string, style: ContentStyle): string {
  const realisticHints: Record<string, string> = {
    daily: '允许轻微过曝和手持微晃，非专业但舒服的构图，主体偶尔偏离中心',
    behind_scenes: '光线一般，有工作台杂物，未完成感，不是摆拍',
    travel: '自然色彩，有游客感，光线不完美，允许逆光或阴影',
  };

  const base = buildImagePrompt(sceneDescription, style);
  const hint = realisticHints[style];
  return hint ? `${base}\n真实感细节：${hint}。` : base;
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
    model: AIHUBMIX_MODEL,
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
    throw new Error(`AIHubMix API returned ${res.status}: ${await res.text()}`);
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
    throw new Error(`No image data in AIHubMix response: ${JSON.stringify(data).slice(0, 500)}`);
  }

  return { imageData, textResponse };
}

async function callAIHubMixWithFallback(
  prompt: string,
  referenceImagesBase64: string[],
  aspectRatio: string,
  styleReferenceBase64?: string,
): Promise<{ imageData: Buffer; textResponse?: string }> {
  try {
    return await callAIHubMix(prompt, referenceImagesBase64, aspectRatio, styleReferenceBase64);
  } catch (err) {
    if (referenceImagesBase64.length <= 1) throw err;
    console.log('Multi-image reference failed, trying grid composite fallback...');
  }

  try {
    const compositeBase64 = await compositeReferences(referenceImagesBase64);
    return await callAIHubMix(prompt, [compositeBase64], aspectRatio, styleReferenceBase64);
  } catch (err) {
    console.log('Grid composite fallback failed, trying single reference...');
  }

  return await callAIHubMix(prompt, [referenceImagesBase64[0]], aspectRatio, styleReferenceBase64);
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
async function checkQuality(generatedImagePath: string, referenceImagePath: string): Promise<number> {
  const generatedBase64 = fs.readFileSync(generatedImagePath).toString('base64');
  const referenceBase64 = fs.readFileSync(referenceImagePath).toString('base64');

  // Note: llm-client.ts only supports text prompts (Anthropic text API).
  // For image-based quality check, we'd need multimodal support.
  // Fallback: use AIHubMix Gemini for quality check too.
  const apiKey = process.env.AIHUBMIX_API_KEY;
  if (!apiKey) return QUALITY_THRESHOLD; // Skip check if no key

  const body = {
    model: AIHUBMIX_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '对比这两张图。评估：1. 人脸相似度（五官、轮廓是否像同一人）2. 照片自然度（是否像真实照片而非AI生成）3. 整体质量（清晰度、构图、光线）。只返回一个1-10的综合评分数字，不要其他文字。7分以上=可用。' },
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
    const content = message?.content as string | undefined;
    const score = parseInt(content?.match(/\d+/)?.[0] ?? '', 10);
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
  const qualityThreshold = selfie ? 7 : QUALITY_THRESHOLD;
  const maxQualityRetries = selfie ? 2 : MAX_QUALITY_RETRIES;

  // Generate with retry
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { imageData, textResponse } = await callAIHubMixWithFallback(
        prompt, refBase64List, aspectRatio, styleRefBase64
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

        const correctionPrompt = `${prompt}\n请特别注意让人物面部特征与参考图完全一致，这是最重要的要求。五官轮廓、发型发色、体型比例必须匹配参考图。`;

        // Re-generate
        console.log(`Quality score ${score} < ${qualityThreshold}, retrying (${qAttempt + 1}/${maxQualityRetries})...`);
        const retry = await callAIHubMixWithFallback(
          correctionPrompt, refBase64List, aspectRatio, styleRefBase64
        );
        fs.writeFileSync(localPath, retry.imageData);
      }

      // Final quality check after all retries
      const finalScore = await checkQuality(localPath, primaryRef);
      if (finalScore >= qualityThreshold) {
        return { localPath, textResponse, timestamp };
      }

      // Clean up the failed image
      fs.unlinkSync(localPath);
      throw new Error(`Quality check failed after ${maxQualityRetries} retries (final score: ${finalScore})`);
    } catch (err) {
      lastError = err as Error;
      if (attempt < MAX_RETRIES) {
        console.error(`Image generation failed, retrying: ${lastError.message}`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  throw lastError ?? new Error('Image generation failed');
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
};

export async function generateImageSet(options: GenerateSetOptions): Promise<GenerateSetResult> {
  const { shots, style, baseReferenceDir, styleReference, aspectRatio, outputDir } = options;
  const results: GenerateImageResult[] = [];
  let failed = 0;
  const groupSeed = Math.random() * 2 ** 32 | 0;

  for (const shot of shots) {
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
      console.error(`No reference images found for shot: "${shot.description}"`);
      failed++;
      continue;
    }

    try {
      const result = await generateImage({
        prompt,
        referenceImages,
        styleReference,
        style,
        aspectRatio,
        outputDir,
      });

      const processedPath = await postProcessImage(result.localPath, style, groupSeed);
      results.push({ ...result, localPath: processedPath });
    } catch (err) {
      console.error(`Shot failed: "${shot.description}" — ${(err as Error).message}`);
      failed++;
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
