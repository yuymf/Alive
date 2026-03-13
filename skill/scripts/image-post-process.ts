#!/usr/bin/env node
/**
 * image-post-process.ts
 * 对 AI 生成图片进行后处理，模拟手机拍摄质感。
 * 按内容风格应用不同滤镜组合（噪点、模糊、色温、晕影）。
 * cos 风格跳过处理，保留 AI 渲染原图。
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
  if (style === 'cos') return { ...EMPTY_PARAMS };

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
 * 对图片应用后处理滤镜，模拟手机拍摄效果。
 * cos 风格直接返回原路径，不做任何修改。
 * @param imagePath 输入图片路径
 * @param style 内容风格
 * @param groupSeed 同组图片统一种子
 * @returns 输出图片路径（原路径或新 _processed 路径）
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
