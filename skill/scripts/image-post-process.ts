#!/usr/bin/env node
/**
 * image-post-process.ts
 * 对 AI 生成图片进行后处理，模拟手机/相机拍摄质感。
 * 按内容风格应用不同滤镜组合（噪点、模糊、色温、晕影）。
 * 所有风格都会应用处理——cos 使用极轻参数保留质感，travel_street 用强胶片感。
 */

import * as path from 'path';
import { ContentStyle } from './types';

export interface ProcessingParams {
  skip: boolean;
  noisePercent: number;
  blurRadius: number;
  contrastDelta: number;
  saturationDelta: number;
  colorTempShift: number;
  vignetteStrength: number;
}

const EMPTY_PARAMS: ProcessingParams = {
  skip: true,
  noisePercent: 0,
  blurRadius: 0,
  contrastDelta: 0,
  saturationDelta: 0,
  colorTempShift: 0,
  vignetteStrength: 0,
};

interface StylePreset {
  noisePercent: number;
  blurRadius: number;
  contrastDelta: number;
  saturationDelta: number;
  colorTempShift: number;
  vignetteStrength: number;
}

// 各风格的基础滤镜参数
const STYLE_PRESETS: Record<string, StylePreset> = {
  cos: {
    // Previously skipped — now apply very subtle realism (studio photo still has minor imperfections)
    noisePercent: 0.3,        // Very light grain — studio cameras still have some noise
    blurRadius: 0,            // No blur — studio shots are sharp
    contrastDelta: 0.02,      // Tiny contrast boost — studio lighting is controlled
    saturationDelta: 0,
    colorTempShift: 2,        // Barely noticeable warm shift — studio lights are slightly warm
    vignetteStrength: 0.05,   // Very subtle lens vignetting
  },
  daily: {
    noisePercent: 1.5,
    blurRadius: 0.5,
    contrastDelta: -0.05,
    saturationDelta: -0.05,
    colorTempShift: 5,
    vignetteStrength: 0,
  },
  behind_scenes: {
    noisePercent: 1.0,
    blurRadius: 0.3,
    contrastDelta: -0.1,
    saturationDelta: -0.03,
    colorTempShift: 8,
    vignetteStrength: 0,
  },
  travel: {
    noisePercent: 0.5,
    blurRadius: 0,
    contrastDelta: 0.05,
    saturationDelta: 0.1,
    colorTempShift: 3,
    vignetteStrength: 0.15,
  },
  travel_portrait: {
    noisePercent: 0.4,
    blurRadius: 0,
    contrastDelta: 0.03,
    saturationDelta: 0.08,
    colorTempShift: 4,
    vignetteStrength: 0.10,
  },
  travel_food: {
    noisePercent: 0.3,
    blurRadius: 0,
    contrastDelta: 0.05,
    saturationDelta: 0.15,     // Extra saturation for food colors
    colorTempShift: 6,         // Warm restaurant lighting
    vignetteStrength: 0.08,
  },
  travel_street: {
    noisePercent: 2.0,          // Higher grain — film simulation (Portra 400 feel)
    blurRadius: 0,
    contrastDelta: -0.08,       // Slightly lower contrast — film characteristic
    saturationDelta: -0.10,     // Desaturated — classic chrome / film look
    colorTempShift: -3,         // Cool shift for teal-orange color grade
    vignetteStrength: 0.20,     // Stronger vignetting — vintage lens feel
  },
};

/**
 * Mulberry32 PRNG — 从种子生成确定性随机数，返回 [0, 1) 范围内的值。
 * 用于同一组图片使用一致的滤镜参数。
 */
export function mulberry32(seed: number): () => number {
  let t = seed | 0;
  return () => {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 根据内容风格返回处理参数。
 * @param style 内容风格
 * @param groupSeed 可选种子，使同组图片参数一致（±3% 变化）；不传则 ±10% 随机变化
 */
export function getProcessingParams(style: ContentStyle, groupSeed?: number): ProcessingParams {
  // All styles now get some processing — even cos gets subtle realism treatment
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

/**
 * 对图片应用后处理滤镜，模拟真实拍摄效果。
 * 所有风格都会处理——cos 极轻、travel_street 胶片风、daily 手机感。
 * @param imagePath 输入图片路径
 * @param style 内容风格
 * @param groupSeed 同组图片统一种子
 * @returns 输出图片路径（新 _processed 路径）
 */
export async function postProcessImage(
  imagePath: string,
  style: ContentStyle,
  groupSeed?: number,
): Promise<string> {
  const params = getProcessingParams(style, groupSeed);
  if (params.skip) return imagePath;

  const { Jimp } = await import('jimp');
  const image = await Jimp.read(imagePath);

  // 轻微模糊模拟手机镜头
  if (params.blurRadius > 0) {
    image.blur(Math.max(1, Math.round(params.blurRadius)));
  }

  // 对比度调整
  if (params.contrastDelta !== 0) {
    image.contrast(params.contrastDelta);
  }

  // 色温偏移：红通道 +shift，蓝通道 -shift*0.5
  if (params.colorTempShift !== 0) {
    image.color([
      { apply: 'red', params: [Math.round(params.colorTempShift)] },
      { apply: 'blue', params: [Math.round(-params.colorTempShift * 0.5)] },
    ]);
  }

  // 饱和度调整
  if (params.saturationDelta !== 0) {
    const absSat = Math.round(Math.abs(params.saturationDelta) * 100);
    if (absSat > 0) {
      image.color([
        { apply: params.saturationDelta > 0 ? 'saturate' : 'desaturate', params: [absSat] },
      ]);
    }
  }

  // 噪点：随机扰动像素模拟感光噪声
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

  // 晕影：边缘压暗（travel 风格）
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
