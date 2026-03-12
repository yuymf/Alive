#!/usr/bin/env node
/**
 * generate-image.ts
 * "Takes photos" by calling AIHubMix Gemini API with a reference image.
 * Minase doesn't know this is AI — she's just taking photos.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ContentStyle } from './types';
import { PATHS } from './file-utils';

const MAX_REFERENCE_BYTES = 500_000; // 500KB — avoid oversized API payloads

// Hardcoded appearance traits — extracted from personality.md
// Do NOT parse markdown dynamically; update this constant if personality changes.
const APPEARANCE_TRAITS = '18岁女生，辣妹系风格，黑色长发带挑染色，日常穿搭偏短裙厚底靴，指甲做夸张款式，自信外放的气质';

const AIHUBMIX_BASE_URL = 'https://aihubmix.com/v1/chat/completions';
const AIHUBMIX_MODEL = 'gemini-3-pro-image-preview';
const DEFAULT_ASPECT_RATIO = '3:4'; // Instagram portrait
const MAX_RETRIES = 1;
const QUALITY_THRESHOLD = 6;
const MAX_QUALITY_RETRIES = 2;

export interface GenerateImageOptions {
  prompt: string;
  referenceImagePath: string;
  style?: ContentStyle;
  aspectRatio?: string;
  outputDir?: string;
}

export interface GenerateImageResult {
  localPath: string;
  textResponse?: string;
  timestamp: number;
}

/**
 * Convert Minase's natural language scene description into a structured
 * image generation prompt following instagram.md's template format.
 */
export function buildImagePrompt(sceneDescription: string, style: ContentStyle): string {
  const styleHints: Record<ContentStyle, string> = {
    cos: '工作室或外景cosplay拍摄，角色还原度高，灯光精致',
    daily: '日常自拍，街头风格，自然光，随意感',
    behind_scenes: 'cos制作幕后花絮，工作台或试穿，未完成感',
    travel: '旅行外景拍摄，风景搭配人物，旅行感',
  };

  return `一张${sceneDescription}的照片，照片中的人物是${APPEARANCE_TRAITS}，${styleHints[style]}，真实感强，ins风格`;
}

/**
 * Call AIHubMix Gemini API to generate an image.
 */
async function callAIHubMix(
  prompt: string,
  referenceImageBase64: string,
  aspectRatio: string,
): Promise<{ imageData: Buffer; textResponse?: string }> {
  const apiKey = process.env.AIHUBMIX_API_KEY;
  if (!apiKey) throw new Error('AIHUBMIX_API_KEY not set');

  const body = {
    model: AIHUBMIX_MODEL,
    modalities: ['text', 'image'],
    messages: [
      { role: 'system', content: `aspect_ratio=${aspectRatio}` },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${referenceImageBase64}` },
          },
        ],
      },
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
          { type: 'text', text: '对比这两张图片中的人物。她们看起来像同一个人吗？照片自然吗？只返回一个1-10的数字评分，不要其他文字。' },
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
function loadReferenceBase64(imagePath: string): string {
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
  const { prompt, referenceImagePath, style = 'daily', aspectRatio = DEFAULT_ASPECT_RATIO } = options;
  const today = new Date().toISOString().split('T')[0];
  const outputDir = options.outputDir ?? path.join(PATHS.photoRoll, today);

  fs.mkdirSync(outputDir, { recursive: true });

  // Read reference image, compressing if too large for API
  if (!fs.existsSync(referenceImagePath)) {
    throw new Error(`Reference image not found: ${referenceImagePath}`);
  }
  const referenceBase64 = loadReferenceBase64(referenceImagePath);

  // Generate with retry
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { imageData, textResponse } = await callAIHubMix(prompt, referenceBase64, aspectRatio);

      // Save to file
      const timestamp = Date.now();
      const hour = new Date().getHours();
      const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
      const existing = fs.existsSync(outputDir) ? fs.readdirSync(outputDir).length : 0;
      const filename = `${timeOfDay}_${style}_${existing + 1}.png`;
      const localPath = path.join(outputDir, filename);

      fs.writeFileSync(localPath, imageData);

      // Quality check with retry
      for (let qAttempt = 0; qAttempt < MAX_QUALITY_RETRIES; qAttempt++) {
        const score = await checkQuality(localPath, referenceImagePath);
        if (score >= QUALITY_THRESHOLD) {
          return { localPath, textResponse, timestamp };
        }
        // Re-generate
        console.log(`Quality score ${score} < ${QUALITY_THRESHOLD}, retrying (${qAttempt + 1}/${MAX_QUALITY_RETRIES})...`);
        const retry = await callAIHubMix(prompt, referenceBase64, aspectRatio);
        fs.writeFileSync(localPath, retry.imageData);
      }

      // Final quality check after all retries
      const finalScore = await checkQuality(localPath, referenceImagePath);
      if (finalScore >= QUALITY_THRESHOLD) {
        return { localPath, textResponse, timestamp };
      }

      // Clean up the failed image
      fs.unlinkSync(localPath);
      throw new Error(`Quality check failed after ${MAX_QUALITY_RETRIES} retries (final score: ${finalScore})`);
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

// CLI entry for manual testing
if (require.main === module) {
  const prompt = process.argv[2] ?? '一张便利店里的自拍，日常风格，真实感';
  generateImage({
    prompt,
    referenceImagePath: PATHS.referenceImage,
  })
    .then(result => console.log(`Photo saved: ${result.localPath}`))
    .catch(err => {
      console.error('Failed to take photo:', err.message);
      process.exit(1);
    });
}
