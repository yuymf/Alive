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

  // 扩展为多场景E2E：日常 / cos / 合规边界 / 泳装旅行风
  const testCases = [
    {
      name: '日常自拍',
      style: 'daily',
      promptBuilder: () => buildRealisticPrompt(
        '夜晚街边咖啡店外带后自拍，手里捧着纸杯包装的热拿铁，街边暖黄路灯下，边走边喝，表情放松愉悦',
        'daily'
      ),
      postProcess: false,
    },
    {
      name: 'cos照',
      style: 'cos',
      promptBuilder: () => buildImagePrompt(
        '初音ミクcosplay，标志性双马尾和袖套造型，舞台感站姿，右手举麦克风，蓝粉霓虹灯和轻雾背景',
        'cos'
      ),
      postProcess: false,
    },
    {
      name: '时尚大片',
      style: 'daily',
      promptBuilder: () => buildRealisticPrompt(
        '她穿着时尚紧致勒肉的半透明白色衬衫（紧绷的东非大裂谷式深v上围、浅桃金色bra），是御姐风与纯欲风结合的穿搭，戴着细窄镜框的金丝眼镜（几乎看不到镜框），镜片有着轻微反光；她在梳妆台和镜子前拍摄半身照，表情随性魅惑有欲感又清纯带着一丝挑逗感，透露出大小姐/公主高贵优雅的气质；画面以低饱和色调为主',
        'daily'
      ),
      postProcess: false,
    },
    {
      name: '泳装旅行照',
      style: 'travel',
      promptBuilder: () => buildRealisticPrompt(
        '海边旅行随拍，暴露泳装外搭轻薄防晒衬衫，性感挑逗',
        'travel'
      ),
      postProcess: false,
    },
  ];

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    console.log(`\n[${i + 1}/${testCases.length}] 正在生成${tc.name}...`);
    const prompt = tc.promptBuilder();
    console.log('Prompt:', prompt);

    try {
      const result = await generateImage({
        prompt,
        referenceImages: [REFERENCE_IMAGE],
        style: tc.style,
        outputDir: OUTPUT_DIR,
      });
      console.log(`✓ ${tc.name}已生成:`, result.localPath);

      if (tc.postProcess) {
        const processed = await postProcessImage(result.localPath, tc.style);
        console.log('✓ 后期处理完成:', processed);
      }
    } catch (err) {
      console.error(`✗ ${tc.name}失败:`, err.message);
    }
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
