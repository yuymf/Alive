/**
 * generate-image/scripts/provider.ts
 * AI image generation via AIHubMix or fal.ai API.
 * Migrated from skill/scripts/generate-image.ts
 *
 * Changes from skill version:
 * - Import types from local prompt-builder.ts instead of skill/types.ts
 * - Import time utils from alive
 * - No PATHS dependency — outputDir and referenceImages passed as params
 * - ContentStyle, ShotDescription defined locally
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { now, getLocalDate, getLocalHour } from '../../../../scripts/utils/time-utils';
import {
  type ContentStyle,
  type ImageEntry,
  buildPromptForProvider,
  buildRealisticPromptForProvider,
  CAMERA_ANCHORS,
  NEGATIVE_CONSTRAINTS,
} from './prompt-builder';
import { isSelfieType, selectReferences } from './reference-selector';

// Re-export types for consumers
export type { ContentStyle, ImageEntry } from './prompt-builder';

export interface ShotDescription {
  description: string;
  angle: string;
  variation: string;
  style?: ContentStyle;
  outfit?: string;
  outfitChange?: boolean;
}

const MAX_REFERENCE_BYTES = 500_000;

const AIHUBMIX_BASE_URL = 'https://aihubmix.com/v1/chat/completions';
const AIHUBMIX_DEFAULT_MODEL = 'gemini-3.1-flash-image-preview';
const AIHUBMIX_QUALITY_MODEL = 'gemini-2.0-flash';

export function getAIHubMixModel(): string {
  return (process.env.AIHUBMIX_MODEL ?? '').trim() || AIHUBMIX_DEFAULT_MODEL;
}

const FAL_RUN_BASE_URL = 'https://fal.run';
const FAL_DEFAULT_MODEL = 'xai/grok-imagine-image/edit';

export function getFalModel(): string {
  const raw = (process.env.FAL_MODEL ?? '').trim();
  if (!raw) return FAL_DEFAULT_MODEL;
  return raw.replace(/^\/+/, '');
}

function getFalEndpointUrl(): string {
  return `${FAL_RUN_BASE_URL}/${getFalModel()}`;
}

export function getImageEntry(): ImageEntry {
  const raw = (process.env.IMAGE_ENTRY ?? '').trim().toUpperCase();
  if (raw === 'FAI' || raw === 'FAL') return 'FAI';
  return 'AIHUBMIX';
}

const DEFAULT_ASPECT_RATIO = '3:4';
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

export function sanitizeForImageGen(description: string): string {
  let result = description;
  result = result.replace(/紧身crop top/gi, '修身短上衣');
  result = result.replace(/crop top/gi, '修身短上衣');
  result = result.replace(/露出事业线/g, '展示穿搭');
  result = result.replace(/乳沟/g, '领口');
  result = result.replace(/低腰/g, '休闲腰线');
  result = result.replace(/髋骨/g, '腰部');
  result = result.replace(/身体微微前倾/g, '身体微微微微倾身');
  result = result.replace(/胸部轮廓/g, '上身线条');
  result = result.replace(/透明面料/g, '轻薄面料');
  result = result.replace(/透明[的]?衣服/g, '轻薄衣物');
  result = result.replace(/透视[装效果]?/g, '薄纱质感');
  result = result.replace(/半透明/g, '轻盈');
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
  result = result.replace(/暴露/g, '清凉');
  result = result.replace(/裸露/g, '露肤');
  result = result.replace(/性感/g, '时尚');
  result = result.replace(/诱惑/g, '魅力');
  result = result.replace(/挑逗/g, '俏皮');
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

export function buildImagePrompt(sceneDescription: string, style: ContentStyle): string {
  return buildPromptForProvider(sceneDescription, style, getImageEntry());
}

export function buildRealisticPrompt(sceneDescription: string, style: ContentStyle): string {
  return buildRealisticPromptForProvider(sceneDescription, style, getImageEntry());
}

// === API Calls ===

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
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } });
  });
  if (styleReferenceBase64) {
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${styleReferenceBase64}` } });
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
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`AIHubMix API returned ${res.status} (model=${model}): ${await res.text()}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const parts = (message?.multi_mod_content ?? message?.content) as Array<Record<string, unknown>> | undefined;

  let imageData: Buffer | null = null;
  let textResponse: string | undefined;

  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (typeof part.text === 'string') textResponse = part.text;
      const inlineData = part.inline_data as Record<string, unknown> | undefined;
      if (inlineData?.data) imageData = Buffer.from(inlineData.data as string, 'base64');
    }
  }

  if (!imageData) {
    const usage = data.usage as Record<string, number> | undefined;
    const choices2 = data.choices as Array<Record<string, unknown>> | undefined;
    const finishReason = choices2?.[0]?.finish_reason as string | undefined;
    const messageObj = choices2?.[0]?.message as Record<string, unknown> | undefined;
    const choiceImageToken = messageObj?.imagetoken;
    const topLevelImageToken = (data as { imagetoken?: unknown }).imagetoken;
    const hasEmptyImageToken = [choiceImageToken, topLevelImageToken].some(v => typeof v === 'string' && v.trim() === '');
    const isContentFiltered = (usage?.completion_tokens === 0) || finishReason === 'safety' || finishReason === 'content_filter' || hasEmptyImageToken;
    const errorMsg = isContentFiltered
      ? `Content filter triggered — prompt may be too suggestive (finish_reason: ${finishReason ?? 'unknown'}, completion_tokens: ${usage?.completion_tokens ?? 'unknown'}, imagetoken_empty: ${hasEmptyImageToken})`
      : `No image data in AIHubMix response: ${JSON.stringify(data).slice(0, 500)}`;
    throw new Error(errorMsg);
  }

  return { imageData, textResponse };
}

export async function callFalAi(
  prompt: string,
  referenceImagesBase64: string[],
  _aspectRatio: string,
  _styleReferenceBase64?: string,
): Promise<{ imageData: Buffer; textResponse?: string }> {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error('FAL_KEY not set');

  const imageUrls = referenceImagesBase64.slice(0, 3).map(b64 => `data:image/jpeg;base64,${b64}`);
  const model = getFalModel();
  const endpointUrl = getFalEndpointUrl();
  console.log(`[fal.ai] model=${model}, endpoint=${endpointUrl}, refs=${referenceImagesBase64.length}`);

  const body: Record<string, unknown> = { prompt, num_images: 1, output_format: 'png' };
  if (imageUrls.length > 0) body.image_urls = imageUrls;

  const res = await fetch(endpointUrl, {
    method: 'POST',
    headers: { 'Authorization': `Key ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`fal.ai API returned ${res.status} (model=${model}): ${await res.text()}`);

  const data = await res.json() as Record<string, unknown>;
  const images = data.images as Array<Record<string, unknown>> | undefined;
  const revisedPrompt = data.revised_prompt as string | undefined;

  if (!images || images.length === 0) throw new Error(`No images in fal.ai response: ${JSON.stringify(data).slice(0, 500)}`);

  const imageUrl = images[0].url as string;
  let imageData: Buffer;

  if (imageUrl.startsWith('data:')) {
    const base64Part = imageUrl.split(',')[1];
    if (!base64Part) throw new Error('Invalid data URI from fal.ai');
    imageData = Buffer.from(base64Part, 'base64');
  } else {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error(`Failed to download fal.ai image: ${imgRes.status}`);
    imageData = Buffer.from(await imgRes.arrayBuffer());
  }

  return { imageData, textResponse: revisedPrompt };
}

export async function callImageProvider(
  prompt: string,
  referenceImagesBase64: string[],
  aspectRatio: string,
  styleReferenceBase64?: string,
): Promise<{ imageData: Buffer; textResponse?: string }> {
  const entry = getImageEntry();
  if (entry === 'FAI') return callFalAi(prompt, referenceImagesBase64, aspectRatio, styleReferenceBase64);
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
  } catch {
    console.log(`[${providerLabel}] Grid composite fallback failed, trying single reference...`);
  }

  return await callImageProvider(prompt, [referenceImagesBase64[0]], aspectRatio, styleReferenceBase64);
}

async function compositeReferences(imagesBase64: string[]): Promise<string> {
  const { Jimp } = await import('jimp');
  const images = await Promise.all(imagesBase64.map(b64 => Jimp.read(Buffer.from(b64, 'base64'))));
  const targetHeight = 512;
  const resized = images.map(img => {
    const scale = targetHeight / img.height;
    return img.resize({ w: Math.round(img.width * scale), h: targetHeight });
  });
  const totalWidth = resized.reduce((sum, img) => sum + img.width, 0);
  const composite = new Jimp({ width: totalWidth, height: targetHeight, color: 0xffffffff });
  let x = 0;
  for (const img of resized) { composite.composite(img, x, 0); x += img.width; }
  const buffer = await composite.getBuffer('image/jpeg');
  return buffer.toString('base64');
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') return (part as { text: string }).text;
    return '';
  }).join('\n');
}

async function checkQuality(generatedImagePath: string, referenceImagePath: string): Promise<number> {
  const generatedBase64 = fs.readFileSync(generatedImagePath).toString('base64');
  const referenceBase64 = fs.readFileSync(referenceImagePath).toString('base64');
  const apiKey = process.env.AIHUBMIX_API_KEY;
  if (!apiKey) return QUALITY_THRESHOLD;

  const body = {
    model: AIHUBMIX_QUALITY_MODEL,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `对比这两张图（第一张=参考图，第二张=生成图）。按以下6个维度严格评估：\n1. 人脸相似度（权重最高）\n2. 姿态自然度\n3. 表情生动度\n4. 去AI感\n5. 服装面料质感\n6. 整体构图质量\n评分：8-10=专业摄影级，6-7=合格，4-5=勉强，1-3=不可用\n只返回一个1-10的综合评分数字。` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${referenceBase64}` } },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${generatedBase64}` } },
      ],
    }],
  };

  try {
    const res = await fetch(AIHUBMIX_BASE_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return QUALITY_THRESHOLD;
    const data = await res.json() as Record<string, unknown>;
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const content = extractMessageText(message?.content);
    const score = parseInt(content.match(/\d+/)?.[0] ?? '', 10);
    return isNaN(score) ? QUALITY_THRESHOLD : Math.min(10, Math.max(1, score));
  } catch {
    return QUALITY_THRESHOLD;
  }
}

export function loadReferenceBase64(imagePath: string): string {
  const raw = fs.readFileSync(imagePath);
  if (raw.length <= MAX_REFERENCE_BYTES) return raw.toString('base64');

  const cachedPath = imagePath.replace(/\.[^.]+$/, '.compressed.jpg');
  if (fs.existsSync(cachedPath) && fs.statSync(cachedPath).mtimeMs >= fs.statSync(imagePath).mtimeMs) {
    return fs.readFileSync(cachedPath).toString('base64');
  }

  try {
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '-Z', '1024', imagePath, '--out', cachedPath], { stdio: 'pipe' });
    console.log(`Reference image compressed: ${Math.round(raw.length / 1024)}KB → ${Math.round(fs.statSync(cachedPath).size / 1024)}KB`);
    return fs.readFileSync(cachedPath).toString('base64');
  } catch {
    return raw.toString('base64');
  }
}

export async function generateImage(options: GenerateImageOptions): Promise<GenerateImageResult> {
  const { prompt, referenceImages, styleReference, style = 'daily', aspectRatio = DEFAULT_ASPECT_RATIO } = options;
  const today = getLocalDate();
  const outputDir = options.outputDir ?? path.join('/tmp', 'alive-photo-roll', today);

  fs.mkdirSync(outputDir, { recursive: true });

  const refBase64List = referenceImages.filter(refPath => fs.existsSync(refPath)).map(refPath => loadReferenceBase64(refPath));
  if (refBase64List.length === 0) throw new Error(`No valid reference images found: ${referenceImages.join(', ')}`);

  const styleRefBase64 = styleReference && fs.existsSync(styleReference) ? loadReferenceBase64(styleReference) : undefined;
  const selfie = isSelfieType(style, prompt);
  const qualityThreshold = selfie ? 5 : QUALITY_THRESHOLD;

  let lastError: Error | null = null;
  let currentPrompt = prompt;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { imageData, textResponse } = await callWithFallback(currentPrompt, refBase64List, aspectRatio, styleRefBase64);
      const timestamp = now().getTime();
      const hour = getLocalHour();
      const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
      const existing = fs.existsSync(outputDir) ? fs.readdirSync(outputDir).length : 0;
      const filename = `${timeOfDay}_${style}_${existing + 1}.png`;
      const localPath = path.join(outputDir, filename);
      fs.writeFileSync(localPath, imageData);

      if (options.skipQualityCheck) return { localPath, textResponse, timestamp };

      const primaryRef = referenceImages.find(p => fs.existsSync(p)) ?? referenceImages[0];
      for (let qAttempt = 0; qAttempt < MAX_QUALITY_RETRIES; qAttempt++) {
        const score = await checkQuality(localPath, primaryRef);
        if (score >= qualityThreshold) return { localPath, textResponse, timestamp };
        console.log(`Quality score ${score} < ${qualityThreshold}, retrying (${qAttempt + 1}/${MAX_QUALITY_RETRIES})...`);
        const retry = await callWithFallback(`${prompt}\n\n[CRITICAL CORRECTIONS]`, refBase64List, aspectRatio, styleRefBase64);
        fs.writeFileSync(localPath, retry.imageData);
      }

      const finalScore = await checkQuality(localPath, primaryRef);
      if (finalScore >= qualityThreshold) return { localPath, textResponse, timestamp };
      console.warn(`Quality check low score ${finalScore} < ${qualityThreshold}, keeping image for fallback use`);
      return { localPath, textResponse, timestamp };
    } catch (err) {
      lastError = err as Error;
      if (attempt < MAX_RETRIES) {
        if (lastError.message.includes('Content filter triggered')) {
          console.error('Content filter triggered, sanitizing prompt for retry...');
          currentPrompt = sanitizeForImageGen(currentPrompt);
        } else {
          console.error(`Image generation failed, retrying: ${lastError.message}`);
        }
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  if (lastError) {
    const entry = getImageEntry();
    const host = entry === 'FAI' ? 'fal.ai' : 'aihubmix.com';
    const cause = lastError.cause as NodeJS.ErrnoException | undefined;
    const hint = cause?.code === 'ENOTFOUND' ? ` — 检查 DNS/网络是否可访问 ${host}` : '';
    throw new Error(`[${entry}] ${lastError.message}${hint}`, { cause: lastError });
  }
  throw new Error('Image generation failed');
}

// === Batch Generation ===

export interface GenerateSetOptions {
  shots: ShotDescription[];
  baseReferenceDir: string;
  styleReference?: string;
  style: ContentStyle;
  aspectRatio?: string;
  outputDir?: string;
  fallbackReferenceImage?: string;
}

export interface GenerateSetResult {
  images: GenerateImageResult[];
  failed: number;
}

const MIN_IMAGES: Record<ContentStyle, number> = {
  cos: 3, daily: 1, behind_scenes: 2, travel: 4, travel_portrait: 2, travel_food: 1, travel_street: 2,
};
const GENERATE_SET_CONCURRENCY = 2;

export async function generateImageSet(options: GenerateSetOptions): Promise<GenerateSetResult> {
  const { shots, style, baseReferenceDir, styleReference, aspectRatio, outputDir, fallbackReferenceImage } = options;
  const results: GenerateImageResult[] = [];
  let failed = 0;

  for (let i = 0; i < shots.length; i += GENERATE_SET_CONCURRENCY) {
    const batch = shots.slice(i, i + GENERATE_SET_CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (shot) => {
        const prompt = buildRealisticPrompt(shot.description, style);
        const refFileNames = selectReferences(style, shot.description);
        let referenceImages = refFileNames.map(f => path.join(baseReferenceDir, f)).filter(f => fs.existsSync(f));

        if (referenceImages.length === 0 && fallbackReferenceImage && fs.existsSync(fallbackReferenceImage)) {
          referenceImages = [fallbackReferenceImage];
        }
        if (referenceImages.length === 0) throw new Error(`No reference images found for shot: "${shot.description}"`);

        return await generateImage({ prompt, referenceImages, styleReference, style, aspectRatio, outputDir });
      })
    );

    for (const item of batchResults) {
      if (item.status === 'fulfilled') results.push(item.value);
      else { console.error(`Shot failed: ${(item.reason as Error).message}`); failed++; }
    }
  }

  const minRequired = MIN_IMAGES[style] ?? 1;
  if (results.length > 0 && results.length < minRequired) {
    console.log(`Only ${results.length}/${minRequired} images passed for ${style}, degrading to available set`);
  }

  return { images: results, failed };
}

export { generateReferences } from './generate-references';
