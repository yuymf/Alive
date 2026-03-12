// skill/scripts/reference-selector.ts
// 根据内容风格和场景描述，选择用于图像生成的面部参考图文件名

import { ContentStyle } from './types';

const SELFIE_KEYWORDS = ['自拍', '特写', '正脸', '镜子', '脸部', '头像', '近距离'] as const;
const DISTANT_KEYWORDS = ['远景', '远处', '全景', '风景为主', '人很小'] as const;
const FULLBODY_KEYWORDS = ['全身', '站在', '走在', '全身照'] as const;
const HALFBODY_KEYWORDS = ['半身', '上半身', '坐着'] as const;

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
    case 'behind_scenes':
      return false;
    default:
      return true;
  }
}

/**
 * 根据内容风格和场景描述选择参考图文件名列表。
 * 返回纯文件名（不含路径），调用方负责拼接完整路径。
 */
export function selectReferences(style: ContentStyle, sceneDescription: string): string[] {
  const isSelfie = containsAny(sceneDescription, SELFIE_KEYWORDS);
  const isDistant = containsAny(sceneDescription, DISTANT_KEYWORDS);
  const isFullBody = containsAny(sceneDescription, FULLBODY_KEYWORDS);

  if (isSelfie) return ['front.png', 'left-profile.png'];
  if (isDistant) return ['full-body.png'];
  if (isFullBody) return ['half-body.png', 'full-body.png'];
  if (containsAny(sceneDescription, HALFBODY_KEYWORDS)) return ['front.png', 'half-body.png'];

  switch (style) {
    case 'cos':
      return ['front.png', 'half-body.png'];
    case 'daily':
      return ['front.png', 'half-body.png'];
    case 'travel':
      return ['half-body.png', 'full-body.png'];
    case 'behind_scenes':
      return ['front.png', 'half-body.png'];
    default:
      return ['front.png', 'half-body.png'];
  }
}
