#!/usr/bin/env node
/**
 * E2E photo generation test — generates one selfie and one cos photo.
 * Usage: AIHUBMIX_API_KEY=<key> node e2e-photo-test.js
 */

const fs = require('fs');
const path = require('path');

// Load API key from openclaw config if not in env
if (!process.env.AIHUBMIX_API_KEY) {
  const cfgPath = path.join(process.env.HOME, '.openclaw', 'openclaw.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const env = cfg?.skills?.entries?.minase?.env ?? {};
    if (env.AIHUBMIX_API_KEY) process.env.AIHUBMIX_API_KEY = env.AIHUBMIX_API_KEY;
  }
}

const { generateImage, buildRealisticPrompt, buildImagePrompt } = require('../dist/generate-image');
const { postProcessImage } = require('../dist/image-post-process');

const REFERENCE_IMAGE = path.join(
  process.env.HOME, '.openclaw', 'skills', 'minase', 'assets', 'references', 'minase-reference.png'
);
const OUTPUT_DIR = path.join(__dirname, 'e2e-output');

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  if (!fs.existsSync(REFERENCE_IMAGE)) {
    console.error('参考图不存在:', REFERENCE_IMAGE);
    process.exit(1);
  }
  console.log('参考图:', REFERENCE_IMAGE, `(${Math.round(fs.statSync(REFERENCE_IMAGE).size / 1024)}KB)`);
  console.log('输出目录:', OUTPUT_DIR);
  console.log('---');

  // Test 1: 日常自拍 (daily selfie)
  console.log('\n[1/2] 正在生成日常自拍...');
  const dailyPrompt = buildRealisticPrompt('在便利店买零食的自拍，举着一瓶饮料，开心的表情', 'daily');
  console.log('Prompt:', dailyPrompt);

  try {
    const dailyResult = await generateImage({
      prompt: dailyPrompt,
      referenceImages: [REFERENCE_IMAGE],
      style: 'daily',
      outputDir: OUTPUT_DIR,
    });
    console.log('✓ 日常自拍已生成:', dailyResult.localPath);

    // Apply post-processing
    const processed = await postProcessImage(dailyResult.localPath, 'daily');
    console.log('✓ 后期处理完成:', processed);
  } catch (err) {
    console.error('✗ 日常自拍失败:', err.message);
  }

  // Test 2: Cos照 (cosplay photo)
  console.log('\n[2/2] 正在生成cos照...');
  const cosPrompt = buildImagePrompt('初音ミク的cosplay，双马尾造型，展示舞蹈pose，粉色和蓝色灯光的摄影棚', 'cos');
  console.log('Prompt:', cosPrompt);

  try {
    const cosResult = await generateImage({
      prompt: cosPrompt,
      referenceImages: [REFERENCE_IMAGE],
      style: 'cos',
      outputDir: OUTPUT_DIR,
    });
    console.log('✓ cos照已生成:', cosResult.localPath);
    // cos style skips post-processing by design
  } catch (err) {
    console.error('✗ cos照失败:', err.message);
  }

  console.log('\n--- 完成 ---');
  console.log('查看输出:', OUTPUT_DIR);
  const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.png'));
  console.log('生成文件:', files.join(', '));
}

main().catch(err => {
  console.error('E2E test failed:', err);
  process.exit(1);
});
