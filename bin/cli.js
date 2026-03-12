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
const DIST_SRC = path.join(__dirname, '..', 'dist');
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

function copyBuiltScripts(src, dest) {
  if (!fs.existsSync(src)) {
    warn(`Built scripts not found at ${src} — run npm run build before packaging`);
    return;
  }

  fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    if (!file.endsWith('.js')) {
      continue;
    }
    fs.copyFileSync(path.join(src, file), path.join(dest, file));
  }
}

function removeDirSafe(dir, label) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    ok(`Removed ${label}: ${dir}`);
  } else {
    warn(`${label} not found: ${dir} — skipped`);
  }
}

function isOpenClawCLIAvailable() {
  try {
    require('child_process').execSync('which openclaw', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function registerCronJobs() {
  const { execFileSync } = require('child_process');

  // Pre-flight: check if Gateway is reachable by listing jobs
  let existingJobs = [];
  try {
    const raw = execFileSync('openclaw', ['cron', 'list', '--json'], { timeout: 10000, encoding: 'utf8' });
    existingJobs = JSON.parse(raw);
  } catch {
    warn('OpenClaw Gateway is not running — cannot register cron jobs.');
    warn('Start the Gateway first, then re-run: npx minase@latest');
    warn('Or register manually after starting Gateway:');
    warn('  openclaw cron add --name "minase:morning" --cron "0 7 * * *" --tz "Asia/Shanghai" --session isolated --message "[cron:morning] 执行水瀬晨规划。运行: node ~/.openclaw/skills/minase/scripts/morning-plan.js" --timeout 180');
    warn('  openclaw cron add --name "minase:tick" --cron "0 8-22 * * *" --tz "Asia/Shanghai" --session isolated --message "[cron:tick] 执行水瀬心跳。运行: node ~/.openclaw/skills/minase/scripts/heartbeat-tick.js" --timeout 120');
    warn('  openclaw cron add --name "minase:night" --cron "0 23 * * *" --tz "Asia/Shanghai" --session isolated --message "[cron:night] 执行水瀬夜反思。运行: node ~/.openclaw/skills/minase/scripts/night-reflect.js" --timeout 300');
    return;
  }

  // Remove existing jobs first (idempotent re-install)
  const existingNames = ['minase:morning', 'minase:tick', 'minase:night'];
  for (const name of existingNames) {
    const existing = existingJobs.find(j => j.name === name);
    if (existing) {
      try {
        execFileSync('openclaw', ['cron', 'rm', existing.id], { timeout: 10000, stdio: 'ignore' });
      } catch { /* best effort */ }
    }
  }

  const jobs = [
    {
      name: 'minase:morning',
      cron: '0 7 * * *',
      message: '[cron:morning] 执行水瀬晨规划。运行: node ~/.openclaw/skills/minase/scripts/morning-plan.js',
      timeout: 180,
    },
    {
      name: 'minase:tick',
      cron: '0 8-22 * * *',
      message: '[cron:tick] 执行水瀬心跳。运行: node ~/.openclaw/skills/minase/scripts/heartbeat-tick.js',
      timeout: 120,
    },
    {
      name: 'minase:night',
      cron: '0 23 * * *',
      message: '[cron:night] 执行水瀬夜反思。运行: node ~/.openclaw/skills/minase/scripts/night-reflect.js',
      timeout: 300,
    },
  ];

  for (const job of jobs) {
    try {
      const output = execFileSync(
        'openclaw',
        [
          'cron', 'add',
          '--name', job.name,
          '--cron', job.cron,
          '--tz', 'Asia/Shanghai',
          '--session', 'isolated',
          '--message', job.message,
          '--timeout', String(job.timeout),
          '--exact',
          '--json',
        ],
        { timeout: 10000, encoding: 'utf8' }
      );
      ok(`Registered cron: ${job.name} (${job.cron})`);
    } catch (err) {
      warn(`Failed to register cron ${job.name}: ${err.message}`);
    }
  }
}

function removeCronJobs() {
  const { execSync } = require('child_process');
  const jobNames = ['minase:morning', 'minase:tick', 'minase:night'];
  for (const name of jobNames) {
    try {
      execSync(`openclaw cron remove --name "${name}"`, { stdio: 'ignore' });
      ok(`Removed cron: ${name}`);
    } catch {
      // Ignore — may not exist
    }
  }
}

async function configure() {
  console.log('\n  水瀬 (Minase) — Configure');
  console.log('  ==========================\n');

  if (!fs.existsSync(CONFIG_FILE)) {
    console.error('  ✗ openclaw.json not found. Run `npx minase` to install first.');
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    console.error('  ✗ Could not parse openclaw.json');
    process.exit(1);
  }

  const existing = (config.skills && config.skills.entries && config.skills.entries[SKILL_NAME] && config.skills.entries[SKILL_NAME].env) || {};

  log('Current key status:');
  const keys = [
    { key: 'AIHUBMIX_API_KEY', label: 'AIHubMix (image gen)' },
    { key: 'IMGURL_TOKEN', label: 'ImgURL (image hosting)' },
    { key: 'INSTAGRAM_USERNAME', label: 'Instagram username' },
    { key: 'INSTAGRAM_PASSWORD', label: 'Instagram password' },
    { key: 'INSTAGRAM_TOTP_SECRET', label: 'Instagram 2FA secret' },
    { key: 'LLM_API_KEY', label: 'LLM API key' },
    { key: 'LLM_API_BASE', label: 'LLM API base URL' },
    { key: 'LLM_MODEL', label: 'LLM model name' },
  ];

  for (const { key, label } of keys) {
    const status = existing[key] ? '✓ set' : '✗ not set';
    console.log(`    ${label} (${key}): ${status}`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  log('Enter new values below. Press Enter to keep existing value.\n');

  const updates = {};
  for (const { key, label } of keys) {
    const hint = existing[key] ? ' (press Enter to keep current)' : '';
    const value = await ask(rl, `  ${label}${hint}: `);
    if (value.trim()) {
      updates[key] = value.trim();
    }
  }

  rl.close();

  const updatedEnv = { ...existing, ...updates };
  config.skills = config.skills || {};
  config.skills.entries = config.skills.entries || {};
  config.skills.entries[SKILL_NAME] = {
    ...(config.skills.entries[SKILL_NAME] || {}),
    enabled: true,
    env: updatedEnv,
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

  const updateCount = Object.keys(updates).length;
  if (updateCount > 0) {
    ok(`Updated ${updateCount} key(s) in openclaw.json`);
  } else {
    log('No changes made.');
  }
  console.log('');
}

async function uninstall() {
  console.log('\n  水瀬 (Minase) — Uninstall');
  console.log('  ==========================\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Confirm
  const answer = await ask(rl, '  ⚠ This will remove Minase skill files and config. Continue? (y/N): ');
  if (answer.trim().toLowerCase() !== 'y') {
    console.log('\n  Cancelled.\n');
    rl.close();
    process.exit(0);
  }

  // 1. Remove skill files
  log('Removing skill files...');
  removeDirSafe(SKILL_DEST, 'Skill directory');

  // 2. Remove from openclaw.json
  log('Removing config from openclaw.json...');
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (config.skills && config.skills.entries && config.skills.entries[SKILL_NAME]) {
        delete config.skills.entries[SKILL_NAME];
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        ok('Removed minase from openclaw.json');
      } else {
        warn('minase entry not found in openclaw.json — skipped');
      }
    } catch {
      warn('Could not parse openclaw.json — skipped');
    }
  }

  // 2.5. Remove cron jobs
  log('Removing cron jobs...');
  if (isOpenClawCLIAvailable()) {
    removeCronJobs();
  } else {
    warn('OpenClaw CLI not found — cron jobs may need manual removal');
  }

  // 2.5b. Remove hooks
  log('Removing hooks...');
  const hooksToRemove = ['minase-context-loader', 'minase-memory-save'];
  for (const hookName of hooksToRemove) {
    const hookDir = path.join(OPENCLAW_DIR, 'hooks', hookName);
    if (fs.existsSync(hookDir)) {
      fs.rmSync(hookDir, { recursive: true, force: true });
      ok(`Removed hook: ${hookName}`);
    }
  }

  // 3. Remove soul injection from SOUL.md
  log('Cleaning SOUL.md...');
  if (fs.existsSync(SOUL_FILE)) {
    let soul = fs.readFileSync(SOUL_FILE, 'utf8');
    const marker = '<!-- minase-soul-start -->';
    const markerEnd = '<!-- minase-soul-end -->';
    if (soul.includes(marker)) {
      soul = soul.replace(new RegExp(`\n*${marker}[\\s\\S]*?${markerEnd}\n*`), '\n');
      fs.writeFileSync(SOUL_FILE, soul);
      ok('Removed minase persona from SOUL.md');
    } else {
      warn('No minase injection found in SOUL.md — skipped');
    }
  }

  // 4. Ask about memory data
  const keepMemory = await ask(rl, '\n  Keep memory data (diary, relations, etc.)? (Y/n): ');
  rl.close();

  if (keepMemory.trim().toLowerCase() === 'n') {
    removeDirSafe(MEMORY_DIR, 'Memory data');
  } else {
    ok(`Memory preserved at ${MEMORY_DIR}`);
  }

  log('Uninstall complete!\n');
}

async function main() {
  console.log('\n  水瀬 (Minase) — Digital Life for OpenClaw');
  console.log('  ==========================================\n');

  // Step 1: Verify OpenClaw
  log('Step 1/9: Verifying OpenClaw installation...');
  if (!fs.existsSync(OPENCLAW_DIR)) {
    console.error('  ✗ OpenClaw not found at ~/.openclaw');
    console.error('    Install OpenClaw first: https://openclaw.ai');
    process.exit(1);
  }
  ok('OpenClaw found');

  // Step 2: Collect API keys
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  log('Step 2/9: API key setup...');
  console.log('  Minase needs image generation to create cos photos.');
  console.log('  AIHubMix (AIHUBMIX_API_KEY) — https://aihubmix.com\n');

  const aihubmixKey = await ask(rl, '  AIHUBMIX_API_KEY (press Enter to skip): ');
  console.log('\n  Image hosting (ImgURL — https://www.imgurl.org):');
  const imgUrlToken = await ask(rl, '  IMGURL_TOKEN (press Enter to skip): ');
  console.log('\n  Instagram login (via instagrapi, uses account credentials):');
  const igUsername = await ask(rl, '  INSTAGRAM_USERNAME (press Enter to skip): ');
  const igPassword = await ask(rl, '  INSTAGRAM_PASSWORD (press Enter to skip): ');
  const igTotpSecret = await ask(rl, '  INSTAGRAM_TOTP_SECRET (optional, for 2FA — press Enter to skip): ');
  console.log('\n  LLM config (OpenAI-compatible API, default: aihubmix):');
  const llmApiKey = await ask(rl, '  LLM_API_KEY (for heartbeat/reflection LLM calls, press Enter to skip): ');
  const llmApiBase = await ask(rl, '  LLM_API_BASE (default: https://aihubmix.com/v1, press Enter to use default): ');
  const llmModel = await ask(rl, '  LLM_MODEL (default: claude-sonnet-4-20250514, press Enter to use default): ');

  rl.close();

  // Check/install Python dependencies for Instagram bridge
  if (igUsername) {
    log('Checking Python dependencies for Instagram bridge...');
    const { execSync } = require('child_process');
    try {
      execSync('python3 -c "import instagrapi"', { stdio: 'ignore' });
      ok('instagrapi already installed');
    } catch {
      console.log('  Installing instagrapi and pyotp via pip...');
      try {
        execSync('pip3 install instagrapi pyotp', { stdio: 'inherit' });
        ok('instagrapi and pyotp installed');
      } catch {
        warn('Failed to install instagrapi. Please run manually: pip3 install instagrapi pyotp');
      }
    }
  }

  // Step 3: Copy skill files
  log('Step 3/9: Installing skill files...');
  if (fs.existsSync(SKILL_DEST)) {
    warn(`Existing skill found at ${SKILL_DEST} — overwriting`);
  }
  copyDirRecursive(SKILL_SRC, SKILL_DEST);
  copyBuiltScripts(DIST_SRC, path.join(SKILL_DEST, 'scripts'));
  ok(`Skill files copied to ${SKILL_DEST}`);

  // Step 4: Update openclaw.json
  log('Step 4/9: Registering skill in OpenClaw config...');
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
      ...(imgUrlToken && { IMGURL_TOKEN: imgUrlToken }),
      ...(igUsername && { INSTAGRAM_USERNAME: igUsername }),
      ...(igPassword && { INSTAGRAM_PASSWORD: igPassword }),
      ...(igTotpSecret && { INSTAGRAM_TOTP_SECRET: igTotpSecret }),
      ...(llmApiKey && { LLM_API_KEY: llmApiKey }),
      ...(llmApiBase && { LLM_API_BASE: llmApiBase }),
      ...(llmModel && { LLM_MODEL: llmModel }),
    }
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  ok('openclaw.json updated');

  // Step 5: Initialize memory directories
  log('Step 5/9: Setting up memory directories...');
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
  const emotionStatePath = path.join(MEMORY_DIR, 'emotion-state.json');
  if (!fs.existsSync(emotionStatePath)) {
    fs.writeFileSync(emotionStatePath, JSON.stringify({"mood":{"valence":0.3,"arousal":0.5,"description":"刚醒来"},"energy":0.6,"stress":0.2,"creativity":0.4,"sociability":0.5,"last_updated":null,"recent_cause":"初始化"}, null, 2));
  }
  const intentPoolPath = path.join(MEMORY_DIR, 'intent-pool.json');
  if (!fs.existsSync(intentPoolPath)) {
    fs.writeFileSync(intentPoolPath, JSON.stringify({"intents":[],"last_updated":null}, null, 2));
  }
  const scheduleTodayPath = path.join(MEMORY_DIR, 'schedule-today.json');
  if (!fs.existsSync(scheduleTodayPath)) {
    fs.writeFileSync(scheduleTodayPath, JSON.stringify({"date":null,"rigid":[],"flexible":[],"generated_by":null}, null, 2));
  }
  const eventQueuePath = path.join(MEMORY_DIR, 'event-queue.json');
  if (!fs.existsSync(eventQueuePath)) {
    fs.writeFileSync(eventQueuePath, JSON.stringify({"events":[],"max_size":50}, null, 2));
  }
  const preferencesPath = path.join(MEMORY_DIR, 'preferences.json');
  if (!fs.existsSync(preferencesPath)) {
    fs.writeFileSync(preferencesPath, JSON.stringify({"cos_characters":[],"content_style":[],"active_hours":[],"social_platforms":[{"platform":"instagram","engagement":0.5,"note":"刚开始经营"}]}, null, 2));
  }
  const aspirationsPath = path.join(MEMORY_DIR, 'aspirations.json');
  if (!fs.existsSync(aspirationsPath)) {
    fs.writeFileSync(aspirationsPath, JSON.stringify({"aspirations":[]}, null, 2));
  }
  const personalityDriftPath = path.join(MEMORY_DIR, 'personality-drift.json');
  if (!fs.existsSync(personalityDriftPath)) {
    fs.writeFileSync(personalityDriftPath, JSON.stringify({"base":"ESTP","modifiers":[]}, null, 2));
  }
  const heartbeatLogPath = path.join(MEMORY_DIR, 'heartbeat-log.json');
  if (!fs.existsSync(heartbeatLogPath)) {
    fs.writeFileSync(heartbeatLogPath, JSON.stringify({"logs":[],"retention_days":7}, null, 2));
  }
  fs.mkdirSync(path.join(MEMORY_DIR, 'relations', 'social', 'instagram'), { recursive: true });
  fs.mkdirSync(path.join(MEMORY_DIR, 'relations', 'social', 'xiaohongshu'), { recursive: true });
  // Photo system
  fs.mkdirSync(path.join(MEMORY_DIR, 'photo-roll'), { recursive: true });
  const inspirationPath = path.join(MEMORY_DIR, 'inspiration.json');
  if (!fs.existsSync(inspirationPath)) {
    fs.writeFileSync(inspirationPath, JSON.stringify({
      "instagram_trends": { "hot_styles": [], "high_engagement_patterns": [], "trending_hashtags": [], "updated_at": 0 },
      "acg_hotspots": { "trending_characters": [], "upcoming_events": [], "seasonal_themes": [], "updated_at": 0 },
      "visual_trends": { "composition_styles": [], "color_palettes": [], "scene_ideas": [], "updated_at": 0 },
      "self_performance": { "best_style": "cos", "best_time_slots": [], "best_hashtag_combos": [], "engagement_by_style": {}, "updated_at": 0 }
    }, null, 2));
  }
  const postHistoryPath = path.join(MEMORY_DIR, 'post-history.json');
  if (!fs.existsSync(postHistoryPath)) {
    fs.writeFileSync(postHistoryPath, JSON.stringify({ "posts": [] }, null, 2));
  }
  const socialMetaPath = path.join(MEMORY_DIR, 'relations', 'social', 'meta.json');
  if (!fs.existsSync(socialMetaPath)) {
    fs.writeFileSync(socialMetaPath, JSON.stringify({"instagram_following":[],"xiaohongshu_following":[],"stats":{"core":0,"familiar":0,"cognitive":0,"dormant":0}}, null, 2));
  }
  const cronSchedulePath = path.join(SKILL_DEST, 'cron-schedule.json');
  if (!fs.existsSync(cronSchedulePath)) {
    const defaultHeartbeats = [
      { time: '07:00', type: 'morning' },
    ];
    for (let h = 8; h <= 22; h++) {
      defaultHeartbeats.push({ time: `${String(h).padStart(2, '0')}:00`, type: 'regular' });
    }
    defaultHeartbeats.push({ time: '23:00', type: 'night' });
    fs.writeFileSync(cronSchedulePath, JSON.stringify({ date: null, heartbeats: defaultHeartbeats }, null, 2));
  }
  ok(`Memory initialized at ${MEMORY_DIR}`);

  // Step 6: Deploy hooks
  log('Step 6/9: Deploying memory hooks...');
  const hooksToInstall = ['minase-context-loader', 'minase-memory-save'];
  const hooksSrc = path.join(SKILL_SRC, 'hooks');
  for (const hookName of hooksToInstall) {
    const src = path.join(hooksSrc, hookName);
    const dest = path.join(OPENCLAW_DIR, 'hooks', hookName);
    if (fs.existsSync(src)) {
      copyDirRecursive(src, dest);
      ok(`Deployed hook: ${hookName}`);
    } else {
      warn(`Hook source not found: ${src} — skipped`);
    }
  }

  // Step 7: Inject persona into SOUL.md
  log('Step 7/9: Injecting Minase persona into SOUL.md...');
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

  // Step 8: Register heartbeat cron jobs
  log('Step 8/9: Registering heartbeat cron jobs...');
  if (isOpenClawCLIAvailable()) {
    registerCronJobs();
  } else {
    warn('OpenClaw CLI not found in PATH — skipping cron registration.');
    warn('You can register manually later:');
    warn('  openclaw cron add --name "minase:morning" --cron "0 7 * * *" --tz "Asia/Shanghai" --session isolated --message "[cron:morning] Run morning plan"');
    warn('  openclaw cron add --name "minase:tick" --cron "0 8-22 * * *" --tz "Asia/Shanghai" --session isolated --message "[cron:tick] Run heartbeat tick"');
    warn('  openclaw cron add --name "minase:night" --cron "0 23 * * *" --tz "Asia/Shanghai" --session isolated --message "[cron:night] Run night reflection"');
  }

  // Step 9: Summary
  log('Step 9/9: Installation complete!\n');
  console.log('  水瀬 is ready. Start OpenClaw and she will be there.\n');
  console.log('  Tips:');
  console.log('  - Just chat with her naturally. She will remember you.');
  console.log('  - Ask her to post to Instagram when she is excited about something.');
  console.log('  - Her memory lives at: ' + MEMORY_DIR);
  if (!aihubmixKey) {
    warn('No image generation key provided — Instagram posts will be text-only until you add one.');
    warn('Run `minase --configure` to add keys later.');
  }
  if (!igUsername || !igPassword) {
    warn('No Instagram credentials provided — posting disabled until you add them.');
  }
  console.log('');
}

// Entry: route by CLI args
const args = process.argv.slice(2);
if (args.includes('--uninstall')) {
  uninstall().catch(err => {
    console.error('\n  Uninstall failed:', err.message);
    process.exit(1);
  });
} else if (args.includes('--configure')) {
  configure().catch(err => {
    console.error('\n  Configure failed:', err.message);
    process.exit(1);
  });
} else {
  main().catch(err => {
    console.error('\n  Install failed:', err.message);
    process.exit(1);
  });
}
