#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const OPENCLAW_DIR = path.join(process.env.HOME, '.openclaw');
const SKILLS_DIR = path.join(OPENCLAW_DIR, 'skills');
const WORKSPACE_DIR = path.join(OPENCLAW_DIR, 'workspace');
const SKILL_NAME = 'minase';
const SKILL_DEST = path.join(SKILLS_DIR, SKILL_NAME);
const SOUL_FILE = path.join(WORKSPACE_DIR, 'SOUL.md');
const MEMORY_DIR = path.join(WORKSPACE_DIR, 'memory', SKILL_NAME);
const CONFIG_FILE = path.join(OPENCLAW_DIR, 'openclaw.json');

const SKILL_SRC = path.join(__dirname, '..', 'skill');
const SOUL_INJECTION_SRC = path.join(__dirname, '..', 'templates', 'soul-injection.md');

function log(msg) { console.log(`\n  ${msg}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ! ${msg}`); }

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function main() {
  console.log('\n  水瀬 (Minase) — Digital Life for OpenClaw');
  console.log('  ==========================================\n');

  // Step 1: Verify OpenClaw
  log('Step 1/7: Verifying OpenClaw installation...');
  if (!fs.existsSync(OPENCLAW_DIR)) {
    console.error('  ✗ OpenClaw not found at ~/.openclaw');
    console.error('    Install OpenClaw first: https://openclaw.ai');
    process.exit(1);
  }
  ok('OpenClaw found');

  // Step 2: Collect API keys
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  log('Step 2/7: API key setup...');
  console.log('  Minase needs image generation to create cos photos.');
  console.log('  Option A: AIHubMix (AIHUBMIX_API_KEY) — https://aihubmix.com');
  console.log('  Option B: fal.ai (FAL_KEY) — https://fal.ai\n');

  const aihubmixKey = await ask(rl, '  AIHUBMIX_API_KEY (press Enter to skip): ');
  const falKey = await ask(rl, '  FAL_KEY (press Enter to skip): ');
  const igToken = await ask(rl, '  INSTAGRAM_ACCESS_TOKEN (press Enter to skip): ');
  const igAccountId = await ask(rl, '  INSTAGRAM_ACCOUNT_ID (press Enter to skip): ');

  rl.close();

  // Step 3: Copy skill files
  log('Step 3/7: Installing skill files...');
  if (fs.existsSync(SKILL_DEST)) {
    warn(`Existing skill found at ${SKILL_DEST} — overwriting`);
  }
  copyDirRecursive(SKILL_SRC, SKILL_DEST);
  ok(`Skill files copied to ${SKILL_DEST}`);

  // Step 4: Update openclaw.json
  log('Step 4/7: Registering skill in OpenClaw config...');
  let config = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
      warn('Could not parse openclaw.json — creating fresh entry');
    }
  }
  config.skills = config.skills || {};
  config.skills.entries = config.skills.entries || {};
  config.skills.entries[SKILL_NAME] = {
    enabled: true,
    env: {
      ...(aihubmixKey && { AIHUBMIX_API_KEY: aihubmixKey }),
      ...(falKey && { FAL_KEY: falKey }),
      ...(igToken && { INSTAGRAM_ACCESS_TOKEN: igToken }),
      ...(igAccountId && { INSTAGRAM_ACCOUNT_ID: igAccountId }),
    }
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  ok('openclaw.json updated');

  // Step 5: Initialize memory directories
  log('Step 5/7: Setting up memory directories...');
  fs.mkdirSync(path.join(MEMORY_DIR, 'relations'), { recursive: true });
  const diaryPath = path.join(MEMORY_DIR, 'diary.md');
  if (!fs.existsSync(diaryPath)) {
    const today = new Date().toISOString().split('T')[0];
    fs.writeFileSync(diaryPath, `# 水瀬の日記\n\n## ${today}\n\n今天是第一天。一切都是新的开始。\n`);
  }
  const wisdomPath = path.join(MEMORY_DIR, 'core-wisdom.json');
  if (!fs.existsSync(wisdomPath)) {
    fs.writeFileSync(wisdomPath, JSON.stringify({ version: 1, wisdom: [], total_importance_since_reflection: 0 }, null, 2));
  }
  const worldPath = path.join(MEMORY_DIR, 'world.md');
  if (!fs.existsSync(worldPath)) {
    fs.writeFileSync(worldPath, '# 世界观察\n\n_水瀬在浏览网络时学到的事情。_\n');
  }
  ok(`Memory initialized at ${MEMORY_DIR}`);

  // Step 6: Inject persona into SOUL.md
  log('Step 6/7: Injecting Minase persona into SOUL.md...');
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  const injection = fs.readFileSync(SOUL_INJECTION_SRC, 'utf8');
  const marker = '<!-- minase-soul-start -->';
  const markerEnd = '<!-- minase-soul-end -->';
  let soul = fs.existsSync(SOUL_FILE) ? fs.readFileSync(SOUL_FILE, 'utf8') : '';
  if (soul.includes(marker)) {
    soul = soul.replace(
      new RegExp(`${marker}[\\s\\S]*?${markerEnd}`),
      `${marker}\n${injection}\n${markerEnd}`
    );
  } else {
    soul += `\n\n${marker}\n${injection}\n${markerEnd}\n`;
  }
  fs.writeFileSync(SOUL_FILE, soul);
  ok('SOUL.md updated');

  // Step 7: Summary
  log('Step 7/7: Installation complete!\n');
  console.log('  水瀬 is ready. Start OpenClaw and she will be there.\n');
  console.log('  Tips:');
  console.log('  - Just chat with her naturally. She will remember you.');
  console.log('  - Ask her to post to Instagram when she is excited about something.');
  console.log('  - Her memory lives at: ' + MEMORY_DIR);
  if (!aihubmixKey && !falKey) {
    warn('No image generation key provided — Instagram posts will be text-only until you add one.');
    warn('Run `minase --configure` to add keys later.');
  }
  console.log('');
}

main().catch(err => {
  console.error('\n  Install failed:', err.message);
  process.exit(1);
});
