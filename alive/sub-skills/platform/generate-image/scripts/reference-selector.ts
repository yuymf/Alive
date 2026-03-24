/**
 * generate-image/scripts/reference-selector.ts
 * 根据内容风格和场景描述，选择用于图像生成的面部参考图文件名。
 * Migrated from skill/scripts/reference-selector.ts — pure function, no file I/O deps.
 */

import type { ContentStyle } from './prompt-builder';

const SELFIE_KEYWORDS = ['自拍', '特写', '正脸', '镜子', '脸部', '头像', '近距离', '面部特写', '表情'] as const;
const DISTANT_KEYWORDS = ['远景', '远处', '全景', '风景为主', '人很小', '环境人像'] as const;
const FULLBODY_KEYWORDS = ['全身', '站在', '走在', '全身照', '从头到脚', '仰拍'] as const;
const HALFBODY_KEYWORDS = ['半身', '上半身', '坐着', '坐在', '靠着'] as const;
const SIDE_KEYWORDS = ['侧面', '侧身', '回眸', '回头', '转身', '侧脸', '轮廓'] as const;
const DYNAMIC_KEYWORDS = ['走路', '跑', '跳', '甩发', '转身', '伸懒腰', '撩头发', '弯腰', '蹲下', '正在', '瞬间', '动态'] as const;

function containsAny(text: string, keywords: readonly string[]): boolean {
  return keywords.some(kw => text.includes(kw));
}

export function isSelfieType(style: ContentStyle, sceneDescription: string): boolean {
  if (containsAny(sceneDescription, SELFIE_KEYWORDS)) return true;
  if (containsAny(sceneDescription, DISTANT_KEYWORDS)) return false;

  switch (style) {
    case 'cos':
      return !containsAny(sceneDescription, DISTANT_KEYWORDS);
    case 'daily':
      return containsAny(sceneDescription, SELFIE_KEYWORDS);
    case 'travel':
    case 'travel_portrait':
    case 'behind_scenes':
      return false;
    default:
      return true;
  }
}

export function selectReferences(style: ContentStyle, sceneDescription: string): string[] {
  const isSelfie = containsAny(sceneDescription, SELFIE_KEYWORDS);
  const isDistant = containsAny(sceneDescription, DISTANT_KEYWORDS);
  const isFullBody = containsAny(sceneDescription, FULLBODY_KEYWORDS);
  const isSide = containsAny(sceneDescription, SIDE_KEYWORDS);
  const isDynamic = containsAny(sceneDescription, DYNAMIC_KEYWORDS);

  if (isSelfie) return ['front.png', 'left-profile.png'];
  if (isSide) return ['left-profile.png', 'front.png'];
  if (isDynamic) return ['half-body.png', 'full-body.png', 'front.png'];
  if (isDistant) return ['full-body.png'];
  if (isFullBody) return ['half-body.png', 'full-body.png'];
  if (containsAny(sceneDescription, HALFBODY_KEYWORDS)) return ['front.png', 'half-body.png'];

  switch (style) {
    case 'cos':
      return ['front.png', 'half-body.png', 'full-body.png'];
    case 'daily':
      return ['front.png', 'half-body.png'];
    case 'travel':
    case 'travel_portrait':
      return ['front.png', 'half-body.png', 'full-body.png'];
    case 'travel_street':
      return ['half-body.png', 'full-body.png'];
    case 'travel_food':
      return ['front.png', 'half-body.png'];
    case 'behind_scenes':
      return ['front.png', 'half-body.png'];
    default:
      return ['front.png', 'half-body.png'];
  }
}
