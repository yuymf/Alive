#!/usr/bin/env node
/**
 * generate-references.ts
 * Generates multi-angle reference images (front, half-body, full-body, left-profile)
 * from the single minase-reference.png using the configured image provider (AIHubMix or fal.ai).
 *
 * Idempotent: skips files that already exist.
 * Usage: node dist/generate-references.js
 */

import * as fs from 'fs';
import * as path from 'path';
import { PATHS } from './file-utils';
import { callImageProvider, getImageEntry, loadReferenceBase64 } from './generate-image';

interface ReferenceSpec {
  filename: string;
  prompt: string;
  aspectRatio: string;
}

const REFERENCE_SPECS: ReferenceSpec[] = [
  {
    filename: 'front.png',
    prompt: [
      '根据参考图中的女性，生成她的正面半身证件照风格参考图。',
      '要求：正面直视镜头，肩部以上，白色/浅灰纯色背景，均匀柔光。',
      '严格匹配参考图的五官轮廓、发型发色、肤色。',
      '表情自然放松，不要夸张。这是用于AI生成的角色参考图，需要清晰展示面部特征。',
    ].join('\n'),
    aspectRatio: '1:1',
  },
  {
    filename: 'half-body.png',
    prompt: [
      '根据参考图中的女性，生成她的半身参考图（腰部以上）。',
      '要求：正面或微侧（10-15度），腰部以上可见，白色/浅灰纯色背景，均匀柔光。',
      '严格匹配参考图的五官轮廓、发型发色、体型比例。',
      '自然站姿，双手自然下垂或轻放身前。这是用于AI生成的角色参考图。',
    ].join('\n'),
    aspectRatio: '3:4',
  },
  {
    filename: 'full-body.png',
    prompt: [
      '根据参考图中的女性，生成她的全身参考图（头到脚）。',
      '要求：正面站立，全身从头到脚完整可见，白色/浅灰纯色背景，均匀柔光。',
      '严格匹配参考图的五官轮廓、发型发色、体型比例、身高感。',
      '自然站姿。这是用于AI生成的角色参考图，需要完整展示体型特征。',
    ].join('\n'),
    aspectRatio: '3:4',
  },
  {
    filename: 'left-profile.png',
    prompt: [
      '根据参考图中的女性，生成她的左侧面（90度侧脸）参考图。',
      '要求：面朝左侧，肩部以上，展示侧面轮廓，白色/浅灰纯色背景，均匀柔光。',
      '严格匹配参考图的面部轮廓线、鼻梁形状、发型发色。',
      '这是用于AI生成的角色参考图，需要清晰展示侧面五官轮廓。',
    ].join('\n'),
    aspectRatio: '1:1',
  },
];

async function generateReferences(): Promise<void> {
  const refsDir = PATHS.references;
  const sourcePath = PATHS.referenceImage;

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source reference image not found: ${sourcePath}`);
  }

  fs.mkdirSync(refsDir, { recursive: true });
  const sourceBase64 = loadReferenceBase64(sourcePath);

  let generated = 0;
  let skipped = 0;

  for (const spec of REFERENCE_SPECS) {
    const outPath = path.join(refsDir, spec.filename);

    if (fs.existsSync(outPath)) {
      console.log(`[skip] ${spec.filename} already exists`);
      skipped++;
      continue;
    }

    const entry = getImageEntry();
    console.log(`[gen] ${spec.filename} (via ${entry === 'FAI' ? 'fal.ai' : 'AIHubMix'})...`);
    try {
      const { imageData } = await callImageProvider(
        spec.prompt,
        [sourceBase64],
        spec.aspectRatio,
      );
      fs.writeFileSync(outPath, imageData);
      console.log(`[ok] ${spec.filename} (${Math.round(imageData.length / 1024)}KB)`);
      generated++;
    } catch (err) {
      console.error(`[fail] ${spec.filename}: ${(err as Error).message}`);
    }
  }

  console.log(`\nDone: ${generated} generated, ${skipped} skipped`);
}

if (require.main === module) {
  generateReferences().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}

export { generateReferences };
