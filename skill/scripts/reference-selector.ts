// skill/scripts/reference-selector.ts
// 根据内容风格和场景描述，选择用于图像生成的面部参考图文件名
// Enhanced: 支持动态姿势、表情特写、侧面轮廓等多维度参考选择

import { ContentStyle } from './types';

const SELFIE_KEYWORDS = ['自拍', '特写', '正脸', '镜子', '脸部', '头像', '近距离', '面部特写', '表情'] as const;
const DISTANT_KEYWORDS = ['远景', '远处', '全景', '风景为主', '人很小', '环境人像'] as const;
const FULLBODY_KEYWORDS = ['全身', '站在', '走在', '全身照', '从头到脚', '仰拍'] as const;
const HALFBODY_KEYWORDS = ['半身', '上半身', '坐着', '坐在', '靠着'] as const;
const SIDE_KEYWORDS = ['侧面', '侧身', '回眸', '回头', '转身', '侧脸', '轮廓'] as const;
const DYNAMIC_KEYWORDS = ['走路', '跑', '跳', '甩发', '转身', '伸懒腰', '撩头发', '弯腰', '蹲下', '正在', '瞬间', '动态'] as const;

function containsAny(text: string, keywords: readonly string[]): boolean {
  return keywords.some(kw => text.includes(kw));
}

/**
 * 判断场景是否属于近景/自拍类型。
 * 结果用于决定是否将正脸参考图作为主要参考。
 */
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

/**
 * 根据内容风格和场景描述选择参考图文件名列表。
 * 返回纯文件名（不含路径），调用方负责拼接完整路径。
 *
 * 选择策略（按优先级）：
 * 1. 自拍/特写 → front + left-profile（正脸一致性最重要）
 * 2. 侧面/回眸 → left-profile + front（侧面轮廓为主）
 * 3. 动态姿势 → half-body + full-body（需要身体比例参考）
 * 4. 远景 → full-body（身材比例为主）
 * 5. 全身 → half-body + full-body（两种景别交叉参考）
 * 6. 半身 → front + half-body（面部+上身）
 * 7. 默认按风格选择
 */
export function selectReferences(style: ContentStyle, sceneDescription: string): string[] {
  const isSelfie = containsAny(sceneDescription, SELFIE_KEYWORDS);
  const isDistant = containsAny(sceneDescription, DISTANT_KEYWORDS);
  const isFullBody = containsAny(sceneDescription, FULLBODY_KEYWORDS);
  const isSide = containsAny(sceneDescription, SIDE_KEYWORDS);
  const isDynamic = containsAny(sceneDescription, DYNAMIC_KEYWORDS);

  // Selfie/closeup: face identity is paramount
  if (isSelfie) return ['front.png', 'left-profile.png'];

  // Side/profile shots: side reference first
  if (isSide) return ['left-profile.png', 'front.png'];

  // Dynamic poses: body proportions needed, plus face for identity
  if (isDynamic) return ['half-body.png', 'full-body.png', 'front.png'];

  // Distant/environment: full body proportions
  if (isDistant) return ['full-body.png'];

  // Full body shots
  if (isFullBody) return ['half-body.png', 'full-body.png'];

  // Half body shots
  if (containsAny(sceneDescription, HALFBODY_KEYWORDS)) return ['front.png', 'half-body.png'];

  // Style-based defaults (enhanced with face reference for consistency)
  switch (style) {
    case 'cos':
      // Cosplay needs both face accuracy and costume/body fit
      return ['front.png', 'half-body.png', 'full-body.png'];
    case 'daily':
      return ['front.png', 'half-body.png'];
    case 'travel':
    case 'travel_portrait':
      // Travel: body proportions in environment, but still need face
      return ['front.png', 'half-body.png', 'full-body.png'];
    case 'travel_street':
      return ['half-body.png', 'full-body.png'];
    case 'travel_food':
      // Food shots: person usually half-body or less
      return ['front.png', 'half-body.png'];
    case 'behind_scenes':
      return ['front.png', 'half-body.png'];
    default:
      return ['front.png', 'half-body.png'];
  }
}
