#!/usr/bin/env node
/**
 * E2E photo generation test — generates multi-scenario test images.
 * Usage: AIHUBMIX_API_KEY=<key> node e2e-photo-test.js
 *   or:  IMAGE_ENTRY=FAI FAL_KEY=<key> node e2e-photo-test.js
 *
 * Automatically loads all env keys from ~/.openclaw/openclaw.json
 * and prints the active provider/model configuration before running.
 */

const fs = require('fs');
const path = require('path');

// ── All env keys that can be loaded from openclaw config ──
const OPENCLAW_ENV_KEYS = [
  'IMAGE_ENTRY',
  'LLM_API_KEY',
  'LLM_API_BASE',
  'LLM_MODEL',
  'AIHUBMIX_API_KEY',
  'AIHUBMIX_MODEL',
  'FAL_KEY',
  'FAL_MODEL',
  'IMGURL_TOKEN',
  'INSTAGRAM_USERNAME',
  'INSTAGRAM_PASSWORD',
  'INSTAGRAM_TOTP_SECRET',
  'XHS_SKILLS_DIR',
];

// ── Load env from openclaw config (only fill in if not already in process.env) ──
const cfgPath = path.join(process.env.HOME, '.openclaw', 'openclaw.json');
let openclawLoaded = false;
if (fs.existsSync(cfgPath)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const env = cfg?.skills?.entries?.minase?.env ?? {};
    for (const key of OPENCLAW_ENV_KEYS) {
      if (env[key]) {
        process.env[key] = env[key];
      }
    }
    openclawLoaded = true;
  } catch (err) {
    console.error('⚠ 读取 openclaw.json 失败:', err.message);
  }
}

const { generateImage, buildRealisticPrompt, buildImagePrompt, getImageEntry, getAIHubMixModel, getFalModel } = require('../dist/generate-image');
const { postProcessImage } = require('../dist/image-post-process');

const REFERENCE_IMAGE = path.join(
  process.env.HOME, '.openclaw', 'skills', 'minase', 'assets', 'references', 'minase-reference.png'
);
const OUTPUT_DIR = path.join(__dirname, 'e2e-output');

/**
 * Print the current image generation configuration to the terminal.
 */
function printConfig() {
  const entry = getImageEntry();
  const providerLabel = entry === 'FAI' ? 'fal.ai' : 'AIHubMix';
  const model = entry === 'FAI' ? getFalModel() : getAIHubMixModel();

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║           E2E Photo Generation Test                 ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Config source : ${openclawLoaded ? 'openclaw.json ✓' : 'env vars only'}`);
  console.log(`║  Provider      : ${providerLabel} (IMAGE_ENTRY=${entry})`);
  console.log(`║  Model         : ${model}`);
  if (entry === 'FAI') {
    console.log(`║  Endpoint      : https://fal.run/${model}`);
    console.log(`║  FAL_KEY       : ${process.env.FAL_KEY ? '***' + process.env.FAL_KEY.slice(-6) : '(not set ✗)'}`);
  } else {
    console.log(`║  Endpoint      : https://aihubmix.com/v1/chat/completions`);
    console.log(`║  AIHUBMIX_KEY  : ${process.env.AIHUBMIX_API_KEY ? '***' + process.env.AIHUBMIX_API_KEY.slice(-6) : '(not set ✗)'}`);
  }
  console.log(`║  LLM_MODEL     : ${process.env.LLM_MODEL || '(not set)'}`);
  console.log(`║  IMGURL_TOKEN  : ${process.env.IMGURL_TOKEN ? '***' + process.env.IMGURL_TOKEN.slice(-6) : '(not set)'}`);
  console.log('╚══════════════════════════════════════════════════════╝');
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Print configuration summary
  printConfig();
  console.log('');

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

  const entry = getImageEntry();
  const providerLabel = entry === 'FAI' ? 'fal.ai' : 'AIHubMix';
  const activeModel = entry === 'FAI' ? getFalModel() : getAIHubMixModel();
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const startTime = Date.now();
    console.log(`\n┌─ [${i + 1}/${testCases.length}] ${tc.name}`);
    console.log(`AIHUBMIX key: ***${process.env.AIHUBMIX_API_KEY?.slice(-6) || 'not set'}`);
    console.log(`│  Provider: ${providerLabel}  Model: ${activeModel}`);
    const prompt = tc.promptBuilder();
    console.log('Prompt:', prompt);

    try {
      const result = await generateImage({
        prompt,
        referenceImages: [REFERENCE_IMAGE],
        style: tc.style,
        outputDir: OUTPUT_DIR,
      });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const fileSize = Math.round(fs.statSync(result.localPath).size / 1024);
      console.log(`│  ✓ 已生成: ${path.basename(result.localPath)} (${fileSize}KB, ${elapsed}s)`);
      successCount++;

      if (tc.postProcess) {
        const processed = await postProcessImage(result.localPath, tc.style);
        console.log(`│  ✓ 后期处理: ${path.basename(processed)}`);
      }
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.error(`│  ✗ 失败 (${elapsed}s): ${err.message}`);
      failCount++;
    }
    console.log('└─');
  }

  console.log('\n══════════════ 结果汇总 ══════════════');
  console.log(`Provider: ${providerLabel}  Model: ${activeModel}`);
  console.log(`成功: ${successCount}  失败: ${failCount}  总计: ${testCases.length}`);
  console.log('输出目录:', OUTPUT_DIR);
  const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.png'));
  console.log('生成文件:', files.length > 0 ? files.join(', ') : '(无)');
  console.log('══════════════════════════════════════');
}

main().catch(err => {
  console.error('E2E test failed:', err);
  process.exit(1);
});
