/**
 * generate-image/scripts/post-process.ts
 * 对 AI 生成图片进行后处理，模拟手机/相机拍摄质感。
 * Migrated from skill/scripts/image-post-process.ts — no file I/O deps.
 */

import * as path from 'path';
import type { ContentStyle } from './prompt-builder';

export interface ProcessingParams {
  skip: boolean;
  noisePercent: number;
  blurRadius: number;
  contrastDelta: number;
  saturationDelta: number;
  colorTempShift: number;
  vignetteStrength: number;
}

interface StylePreset {
  noisePercent: number;
  blurRadius: number;
  contrastDelta: number;
  saturationDelta: number;
  colorTempShift: number;
  vignetteStrength: number;
}

const STYLE_PRESETS: Record<string, StylePreset> = {
  cos: { noisePercent: 0.3, blurRadius: 0, contrastDelta: 0.02, saturationDelta: 0, colorTempShift: 2, vignetteStrength: 0.05 },
  daily: { noisePercent: 1.5, blurRadius: 0.5, contrastDelta: -0.05, saturationDelta: -0.05, colorTempShift: 5, vignetteStrength: 0 },
  behind_scenes: { noisePercent: 1.0, blurRadius: 0.3, contrastDelta: -0.1, saturationDelta: -0.03, colorTempShift: 8, vignetteStrength: 0 },
  travel: { noisePercent: 0.5, blurRadius: 0, contrastDelta: 0.05, saturationDelta: 0.1, colorTempShift: 3, vignetteStrength: 0.15 },
  travel_portrait: { noisePercent: 0.4, blurRadius: 0, contrastDelta: 0.03, saturationDelta: 0.08, colorTempShift: 4, vignetteStrength: 0.10 },
  travel_food: { noisePercent: 0.3, blurRadius: 0, contrastDelta: 0.05, saturationDelta: 0.15, colorTempShift: 6, vignetteStrength: 0.08 },
  travel_street: { noisePercent: 2.0, blurRadius: 0, contrastDelta: -0.08, saturationDelta: -0.10, colorTempShift: -3, vignetteStrength: 0.20 },
};

export function mulberry32(seed: number): () => number {
  let t = seed | 0;
  return () => {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function getProcessingParams(style: ContentStyle, groupSeed?: number): ProcessingParams {
  const preset = STYLE_PRESETS[style] ?? STYLE_PRESETS.daily;
  const variationRange = groupSeed !== undefined ? 0.03 : 0.10;
  const rng = groupSeed !== undefined ? mulberry32(groupSeed) : () => Math.random();

  function vary(base: number): number {
    const offset = (rng() * 2 - 1) * variationRange;
    return base * (1 + offset);
  }

  return {
    skip: false,
    noisePercent: vary(preset.noisePercent),
    blurRadius: vary(preset.blurRadius),
    contrastDelta: vary(preset.contrastDelta),
    saturationDelta: vary(preset.saturationDelta),
    colorTempShift: vary(preset.colorTempShift),
    vignetteStrength: vary(preset.vignetteStrength),
  };
}

export async function postProcessImage(
  imagePath: string,
  style: ContentStyle,
  groupSeed?: number,
): Promise<string> {
  const params = getProcessingParams(style, groupSeed);
  if (params.skip) return imagePath;

  const { Jimp } = await import('jimp');
  const image = await Jimp.read(imagePath);

  if (params.blurRadius > 0) {
    image.blur(Math.max(1, Math.round(params.blurRadius)));
  }

  if (params.contrastDelta !== 0) {
    image.contrast(params.contrastDelta);
  }

  if (params.colorTempShift !== 0) {
    image.color([
      { apply: 'red', params: [Math.round(params.colorTempShift)] },
      { apply: 'blue', params: [Math.round(-params.colorTempShift * 0.5)] },
    ]);
  }

  if (params.saturationDelta !== 0) {
    const absSat = Math.round(Math.abs(params.saturationDelta) * 100);
    if (absSat > 0) {
      image.color([
        { apply: params.saturationDelta > 0 ? 'saturate' : 'desaturate', params: [absSat] },
      ]);
    }
  }

  if (params.noisePercent > 0) {
    const { width, height } = image;
    const pixelCount = Math.round(width * height * params.noisePercent / 100);
    for (let i = 0; i < pixelCount; i++) {
      const x = Math.floor(Math.random() * width);
      const y = Math.floor(Math.random() * height);
      const pixel = image.getPixelColor(x, y);
      const offset = Math.floor(Math.random() * 40) - 20;
      const r = Math.min(255, Math.max(0, ((pixel >> 24) & 0xff) + offset));
      const g = Math.min(255, Math.max(0, ((pixel >> 16) & 0xff) + offset));
      const b = Math.min(255, Math.max(0, ((pixel >> 8) & 0xff) + offset));
      const a = pixel & 0xff;
      image.setPixelColor(((r << 24) | (g << 16) | (b << 8) | a) >>> 0, x, y);
    }
  }

  if (params.vignetteStrength > 0) {
    const { width, height } = image;
    const cx = width / 2;
    const cy = height / 2;
    const maxDist = Math.sqrt(cx * cx + cy * cy);
    image.scan(0, 0, width, height, (x: number, y: number, idx: number) => {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy) / maxDist;
      const factor = 1 - params.vignetteStrength * dist * dist;
      const data = image.bitmap.data;
      data[idx] = Math.round(data[idx] * factor);
      data[idx + 1] = Math.round(data[idx + 1] * factor);
      data[idx + 2] = Math.round(data[idx + 2] * factor);
    });
  }

  const ext = path.extname(imagePath);
  const base = imagePath.slice(0, -ext.length);
  const outputPath = `${base}_processed${ext}`;
  await image.write(outputPath as `${string}.${string}`);

  return outputPath;
}
