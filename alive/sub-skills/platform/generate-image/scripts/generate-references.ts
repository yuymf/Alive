/**
 * generate-image/scripts/generate-references.ts
 * Generates multi-angle reference images from a source reference.
 * Migrated from skill/scripts/generate-references.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { callImageProvider, getImageEntry, loadReferenceBase64 } from './provider';

interface ReferenceSpec {
  filename: string;
  prompt: string;
  aspectRatio: string;
}

const REFERENCE_SPECS: ReferenceSpec[] = [
  {
    filename: 'front.png',
    prompt: '根据参考图中的女性，生成她的正面半身证件照风格参考图。\n要求：正面直视镜头，肩部以上，白色/浅灰纯色背景，均匀柔光。\n严格匹配参考图的五官轮廓、发型发色、肤色。\n表情自然放松，不要夸张。这是用于AI生成的角色参考图，需要清晰展示面部特征。',
    aspectRatio: '1:1',
  },
  {
    filename: 'half-body.png',
    prompt: '根据参考图中的女性，生成她的半身参考图（腰部以上）。\n要求：正面或微侧（10-15度），腰部以上可见，白色/浅灰纯色背景，均匀柔光。\n严格匹配参考图的五官轮廓、发型发色、体型比例。\n自然站姿，双手自然下垂或轻放身前。这是用于AI生成的角色参考图。',
    aspectRatio: '3:4',
  },
  {
    filename: 'full-body.png',
    prompt: '根据参考图中的女性，生成她的全身参考图（头到脚）。\n要求：正面站立，全身从头到脚完整可见，白色/浅灰纯色背景，均匀柔光。\n严格匹配参考图的五官轮廓、发型发色、体型比例、身高感。\n自然站姿。这是用于AI生成的角色参考图，需要完整展示体型特征。',
    aspectRatio: '3:4',
  },
  {
    filename: 'left-profile.png',
    prompt: '根据参考图中的女性，生成她的左侧面（90度侧脸）参考图。\n要求：面朝左侧，肩部以上，展示侧面轮廓，白色/浅灰纯色背景，均匀柔光。\n严格匹配参考图的面部轮廓线、鼻梁形状、发型发色。\n这是用于AI生成的角色参考图，需要清晰展示侧面五官轮廓。',
    aspectRatio: '1:1',
  },
];

/**
 * Generate multi-angle reference images from a source.
 * @param sourcePath Path to the source reference image
 * @param outputDir Directory to save generated references
 */
export async function generateReferences(sourcePath: string, outputDir: string): Promise<void> {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source reference image not found: ${sourcePath}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const sourceBase64 = loadReferenceBase64(sourcePath);

  let generated = 0;
  let skipped = 0;

  for (const spec of REFERENCE_SPECS) {
    const outPath = path.join(outputDir, spec.filename);
    if (fs.existsSync(outPath)) {
      console.log(`[skip] ${spec.filename} already exists`);
      skipped++;
      continue;
    }

    const entry = getImageEntry();
    console.log(`[gen] ${spec.filename} (via ${entry === 'FAI' ? 'fal.ai' : 'AIHubMix'})...`);
    try {
      const { imageData } = await callImageProvider(spec.prompt, [sourceBase64], spec.aspectRatio);
      fs.writeFileSync(outPath, imageData);
      console.log(`[ok] ${spec.filename} (${Math.round(imageData.length / 1024)}KB)`);
      generated++;
    } catch (err) {
      console.error(`[fail] ${spec.filename}: ${(err as Error).message}`);
    }
  }

  console.log(`\nDone: ${generated} generated, ${skipped} skipped`);
}
