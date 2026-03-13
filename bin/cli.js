#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { execSync, execFileSync } = require('child_process');
const os = require('os');

const OPENCLAW_DIR = path.join(process.env.HOME, '.openclaw');
const SKILLS_DIR = path.join(OPENCLAW_DIR, 'skills');
const WORKSPACE_DIR = path.join(OPENCLAW_DIR, 'workspace');
const SKILL_NAME = 'minase';
const SKILL_DEST = path.join(SKILLS_DIR, SKILL_NAME);
const SOUL_FILE = path.join(WORKSPACE_DIR, 'SOUL.md');
const MEMORY_DIR = path.join(WORKSPACE_DIR, 'memory', SKILL_NAME);
const CONFIG_FILE = path.join(OPENCLAW_DIR, 'openclaw.json');
const XHS_SKILLS_DIR = path.join(SKILLS_DIR, 'xiaohongshu-skills');

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
    execSync('which openclaw', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isXhsSkillsInstalled() {
  return fs.existsSync(path.join(XHS_SKILLS_DIR, 'scripts', 'cli.py'));
}

function isUvAvailable() {
  try {
    execSync('which uv', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getPythonVersion() {
  try {
    const output = execSync('python3 --version', { encoding: 'utf8' }).trim();
    const match = output.match(/(\d+)\.(\d+)/);
    if (match) return { major: parseInt(match[1]), minor: parseInt(match[2]) };
  } catch { /* not found */ }
  return null;
}

function probeXhsCli() {
  try {
    const cliPath = path.join(XHS_SKILLS_DIR, 'scripts', 'cli.py');
    execSync(`uv run --directory "${XHS_SKILLS_DIR}" python "${cliPath}" check-login`, { stdio: 'ignore', timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

function probeXhsCliVerbose() {
  try {
    const cliPath = path.join(XHS_SKILLS_DIR, 'scripts', 'cli.py');
    const output = execSync(`uv run --directory "${XHS_SKILLS_DIR}" python "${cliPath}" check-login`, { encoding: 'utf8', timeout: 60000 });
    return JSON.parse(output);
  } catch (err) {
    // check-login exits 1 when not logged in but still outputs JSON
    if (err.stdout) {
      try { return JSON.parse(err.stdout); } catch { /* fall through */ }
    }
    return null;
  }
}

function registerCronJobs() {
  // Pre-flight: check if Gateway is reachable by listing jobs
  let existingJobs = [];
  try {
    const raw = execFileSync('openclaw', ['cron', 'list', '--json'], { timeout: 10000, encoding: 'utf8' });
    existingJobs = JSON.parse(raw);
  } catch {
    warn('OpenClaw Gateway is not running — cannot register cron jobs.');
    warn('Start the Gateway first, then re-run: npx minase@latest');
    warn('Or register manually after starting Gateway:');
    warn('  openclaw cron add --name "minase:morning" --cron "0 7 * * *" --session isolated --message "[cron:morning] 执行水瀬晨规划。运行: node ~/.openclaw/skills/minase/scripts/morning-plan.js" --timeout 180');
    warn('  openclaw cron add --name "minase:tick" --cron "0 8-22 * * *" --session isolated --message "[cron:tick] 执行水瀬心跳。运行: node ~/.openclaw/skills/minase/scripts/heartbeat-tick.js" --timeout 120');
    warn('  openclaw cron add --name "minase:night" --cron "0 23 * * *" --session isolated --message "[cron:night] 执行水瀬夜反思。运行: node ~/.openclaw/skills/minase/scripts/night-reflect.js" --timeout 300');
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
    { key: 'XHS_SKILLS_DIR', label: 'XiaoHongShu skills dir' },
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

async function reinstall() {
  console.log('\n  水瀬 (Minase) — Reinstall (dev mode)');
  console.log('  ======================================\n');

  // Read existing env config before destroying anything
  let existingEnv = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      existingEnv = (config.skills && config.skills.entries && config.skills.entries[SKILL_NAME] && config.skills.entries[SKILL_NAME].env) || {};
      if (Object.keys(existingEnv).length > 0) {
        ok(`Found existing env config (${Object.keys(existingEnv).length} keys)`);
      } else {
        warn('No existing env config found — reinstall will have no API keys set');
      }
    } catch {
      warn('Could not parse openclaw.json — proceeding without env');
    }
  }

  // Silent uninstall: skill files, config entry, cron, hooks, SOUL injection, memory
  log('Removing skill files...');
  removeDirSafe(SKILL_DEST, 'Skill directory');

  log('Removing config from openclaw.json...');
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (config.skills && config.skills.entries && config.skills.entries[SKILL_NAME]) {
        delete config.skills.entries[SKILL_NAME];
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        ok('Removed minase from openclaw.json');
      }
    } catch {
      warn('Could not parse openclaw.json — skipped');
    }
  }

  log('Removing cron jobs...');
  if (isOpenClawCLIAvailable()) {
    removeCronJobs();
  }

  log('Removing hooks...');
  for (const hookName of ['minase-context-loader', 'minase-memory-save']) {
    const hookDir = path.join(OPENCLAW_DIR, 'hooks', hookName);
    if (fs.existsSync(hookDir)) {
      fs.rmSync(hookDir, { recursive: true, force: true });
      ok(`Removed hook: ${hookName}`);
    }
  }

  log('Cleaning SOUL.md...');
  if (fs.existsSync(SOUL_FILE)) {
    let soul = fs.readFileSync(SOUL_FILE, 'utf8');
    const marker = '<!-- minase-soul-start -->';
    const markerEnd = '<!-- minase-soul-end -->';
    if (soul.includes(marker)) {
      soul = soul.replace(new RegExp(`\n*${marker}[\\s\\S]*?${markerEnd}\n*`), '\n');
      fs.writeFileSync(SOUL_FILE, soul);
      ok('Removed minase persona from SOUL.md');
    }
  }

  log('Clearing memory data...');
  removeDirSafe(MEMORY_DIR, 'Memory data');

  ok('Uninstall complete — reinstalling now\n');

  // Reinstall using existing env (no interactive prompts for API keys)
  const {
    AIHUBMIX_API_KEY: aihubmixKey = '',
    IMGURL_TOKEN: imgUrlToken = '',
    INSTAGRAM_USERNAME: igUsername = '',
    INSTAGRAM_PASSWORD: igPassword = '',
    INSTAGRAM_TOTP_SECRET: igTotpSecret = '',
    LLM_API_KEY: llmApiKey = '',
    LLM_API_BASE: llmApiBase = '',
    LLM_MODEL: llmModel = '',
    XHS_SKILLS_DIR: savedXhsDir = '',
  } = existingEnv;

  const xhsInstalled = savedXhsDir ? fs.existsSync(path.join(savedXhsDir, 'scripts', 'cli.py')) : isXhsSkillsInstalled();

  // Step 3: Copy skill files
  log('Step 3/10: Installing skill files...');
  copyDirRecursive(SKILL_SRC, SKILL_DEST);
  copyBuiltScripts(DIST_SRC, path.join(SKILL_DEST, 'scripts'));
  ok(`Skill files copied to ${SKILL_DEST}`);

  // Step 4: Update openclaw.json
  log('Step 4/10: Registering skill in OpenClaw config...');
  let config = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* fresh */ }
  }
  config.skills = config.skills || {};
  config.skills.entries = config.skills.entries || {};
  config.skills.entries[SKILL_NAME] = {
    enabled: true,
    env: { ...existingEnv },
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  ok('openclaw.json updated');

  // Step 5: Initialize memory directories
  log('Step 5/10: Setting up memory directories...');
  fs.mkdirSync(path.join(MEMORY_DIR, 'relations'), { recursive: true });
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  fs.writeFileSync(path.join(MEMORY_DIR, 'diary.md'), `# 水瀬の日記\n\n## ${today}\n\n今天是第一天。一切都是新的开始。\n`);
  fs.writeFileSync(path.join(MEMORY_DIR, 'core-wisdom.json'), JSON.stringify({ version: 1, wisdom: [], total_importance_since_reflection: 0 }, null, 2));
  fs.writeFileSync(path.join(MEMORY_DIR, 'world.md'), '# 世界观察\n\n_水瀬在浏览网络时学到的事情。_\n');
  fs.writeFileSync(path.join(MEMORY_DIR, 'emotion-state.json'), JSON.stringify({"mood":{"valence":0.3,"arousal":0.5,"description":"刚醒来"},"energy":0.6,"stress":0.2,"creativity":0.4,"sociability":0.5,"last_updated":null,"recent_cause":"初始化","momentum":{"valence":0,"arousal":0,"energy":0,"stress":0,"creativity":0,"sociability":0,"duration_ticks":0},"undertone":{"valence":0.3,"arousal":0.5,"energy":0.6,"stress":0.2,"creativity":0.4,"sociability":0.5},"impulse_history":[],"consecutive_high_stress":0,"threshold_break_cooldown":0}, null, 2));
  fs.writeFileSync(path.join(MEMORY_DIR, 'intent-pool.json'), JSON.stringify({"intents":[],"last_updated":null}, null, 2));
  fs.writeFileSync(path.join(MEMORY_DIR, 'schedule-today.json'), JSON.stringify({"date":null,"rigid":[],"flexible":[],"generated_by":null}, null, 2));
  fs.writeFileSync(path.join(MEMORY_DIR, 'event-queue.json'), JSON.stringify({"events":[],"max_size":50}, null, 2));
  fs.writeFileSync(path.join(MEMORY_DIR, 'preferences.json'), JSON.stringify({"cos_characters":[],"content_style":[],"active_hours":[],"social_platforms":[{"platform":"instagram","engagement":0.5,"note":"刚开始经营"}]}, null, 2));
  fs.writeFileSync(path.join(MEMORY_DIR, 'aspirations.json'), JSON.stringify({"aspirations":[]}, null, 2));
  fs.writeFileSync(path.join(MEMORY_DIR, 'personality-drift.json'), JSON.stringify({"base":"ESTP","modifiers":[]}, null, 2));
  fs.writeFileSync(path.join(MEMORY_DIR, 'heartbeat-log.json'), JSON.stringify({"logs":[],"retention_days":7}, null, 2));
  fs.writeFileSync(path.join(MEMORY_DIR, 'flow-state.json'), JSON.stringify({"status":"none","activity":null,"category":null,"entered_at":null,"duration_ticks":0,"interrupt_chance":0.15}, null, 2));
  fs.writeFileSync(path.join(MEMORY_DIR, 'pending-chains.json'), JSON.stringify({"pending":[],"cooldowns":{}}, null, 2));
  fs.mkdirSync(path.join(MEMORY_DIR, 'relations', 'social', 'instagram'), { recursive: true });
  fs.mkdirSync(path.join(MEMORY_DIR, 'relations', 'social', 'xiaohongshu'), { recursive: true });
  fs.mkdirSync(path.join(MEMORY_DIR, 'photo-roll'), { recursive: true });
  fs.writeFileSync(path.join(MEMORY_DIR, 'inspiration.json'), JSON.stringify({
    "instagram_trends": { "hot_styles": [], "high_engagement_patterns": [], "trending_hashtags": [], "updated_at": 0 },
    "acg_hotspots": { "trending_characters": [], "upcoming_events": [], "seasonal_themes": [], "updated_at": 0 },
    "visual_trends": { "composition_styles": [], "color_palettes": [], "scene_ideas": [], "updated_at": 0 },
    "self_performance": { "best_style": "cos", "best_time_slots": [], "best_hashtag_combos": [], "engagement_by_style": {}, "updated_at": 0 }
  }, null, 2));
  fs.writeFileSync(path.join(MEMORY_DIR, 'post-history.json'), JSON.stringify({ "posts": [] }, null, 2));
  fs.writeFileSync(path.join(MEMORY_DIR, 'post-impulse.json'), JSON.stringify({ value: 0, last_post_at: 0, posts_today_date: '', posts_today: 0 }, null, 2));
  fs.mkdirSync(path.join(MEMORY_DIR, 'inspiration-refs'), { recursive: true });
  const srcRefs = path.join(__dirname, '..', 'skill', 'assets', 'references');
  const destRefs = path.join(SKILL_DEST, 'assets', 'references');
  if (fs.existsSync(srcRefs) && !fs.existsSync(destRefs)) {
    fs.mkdirSync(destRefs, { recursive: true });
    for (const file of fs.readdirSync(srcRefs)) {
      fs.copyFileSync(path.join(srcRefs, file), path.join(destRefs, file));
    }
  }
  fs.writeFileSync(path.join(MEMORY_DIR, 'relations', 'social', 'meta.json'), JSON.stringify({"instagram_following":[],"xiaohongshu_following":[],"stats":{"core":0,"familiar":0,"cognitive":0,"dormant":0}}, null, 2));
  const cronSchedulePath = path.join(SKILL_DEST, 'cron-schedule.json');
  const defaultHeartbeats = [{ time: '07:00', type: 'morning' }];
  for (let h = 8; h <= 22; h++) {
    defaultHeartbeats.push({ time: `${String(h).padStart(2, '0')}:00`, type: 'regular' });
  }
  defaultHeartbeats.push({ time: '23:00', type: 'night' });
  fs.writeFileSync(cronSchedulePath, JSON.stringify({ date: null, heartbeats: defaultHeartbeats }, null, 2));
  ok(`Memory initialized at ${MEMORY_DIR}`);

  // Step 6: Deploy hooks
  log('Step 6/10: Deploying memory hooks...');
  const hooksSrc = path.join(SKILL_SRC, 'hooks');
  for (const hookName of ['minase-context-loader', 'minase-memory-save']) {
    const src = path.join(hooksSrc, hookName);
    const dest = path.join(OPENCLAW_DIR, 'hooks', hookName);
    if (fs.existsSync(src)) {
      copyDirRecursive(src, dest);
      ok(`Deployed hook: ${hookName}`);
    }
  }

  // Step 7: Inject persona into SOUL.md
  log('Step 7/10: Injecting Minase persona into SOUL.md...');
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  const injection = fs.readFileSync(SOUL_INJECTION_SRC, 'utf8');
  const marker = '<!-- minase-soul-start -->';
  const markerEnd = '<!-- minase-soul-end -->';
  let soul = fs.existsSync(SOUL_FILE) ? fs.readFileSync(SOUL_FILE, 'utf8') : '';
  if (soul.includes(marker)) {
    soul = soul.replace(new RegExp(`${marker}[\\s\\S]*?${markerEnd}`), `${marker}\n${injection}\n${markerEnd}`);
  } else {
    soul += `\n\n${marker}\n${injection}\n${markerEnd}\n`;
  }
  fs.writeFileSync(SOUL_FILE, soul);
  ok('SOUL.md updated');

  // Step 8: Register heartbeat cron jobs
  log('Step 8/10: Registering heartbeat cron jobs...');
  if (isOpenClawCLIAvailable()) {
    registerCronJobs();
  } else {
    warn('OpenClaw CLI not found in PATH — skipping cron registration');
  }

  // Step 9: Verify XHS CLI (if installed)
  if (xhsInstalled) {
    log('Step 9/10: Verifying XiaoHongShu CLI...');
    const reachable = probeXhsCli();
    if (reachable) {
      ok('xiaohongshu-skills CLI is working');
    } else {
      warn('XiaoHongShu not logged in — run login flow manually');
    }
  } else {
    log('Step 9/10: XiaoHongShu not installed — skipping.');
  }

  // Step 10: Summary
  log('Step 10/10: Reinstall complete!\n');
  console.log('  水瀬 is ready. Restart OpenClaw to pick up the changes.\n');
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

  // 2.6. Remove xiaohongshu-skills
  const keepXhs = await ask(rl, '\n  Remove xiaohongshu-skills? (y/N): ');
  if (keepXhs.trim().toLowerCase() === 'y') {
    removeDirSafe(XHS_SKILLS_DIR, 'xiaohongshu-skills');
  } else if (fs.existsSync(XHS_SKILLS_DIR)) {
    ok(`xiaohongshu-skills preserved at ${XHS_SKILLS_DIR}`);
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
  log('Step 1/10: Verifying OpenClaw installation...');
  if (!fs.existsSync(OPENCLAW_DIR)) {
    console.error('  ✗ OpenClaw not found at ~/.openclaw');
    console.error('    Install OpenClaw first: https://openclaw.ai');
    process.exit(1);
  }
  ok('OpenClaw found');

  // Step 2: Collect API keys
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  log('Step 2/10: API key setup...');
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

  // XiaoHongShu skills setup
  console.log('\n  XiaoHongShu (小红书内容浏览, optional):');
  console.log('  Enables Minase to browse XiaoHongShu for cos trends and inspiration.');
  console.log('  Requires: Python 3.11+, uv, Google Chrome.');
  const xhsSetup = await ask(rl, '  Install xiaohongshu-skills? (y/N): ');
  let xhsInstalled = false;

  if (xhsSetup.trim().toLowerCase() === 'y') {
    // Check uv
    if (!isUvAvailable()) {
      const installUv = await ask(rl, '  uv not found. Install now? (Y/n): ');
      if (installUv.trim().toLowerCase() !== 'n') {
        try {
          execSync('curl -LsSf https://astral.sh/uv/install.sh | sh', { stdio: 'inherit', timeout: 60000 });
          ok('uv installed');
        } catch {
          warn('Failed to install uv. Please install manually: https://docs.astral.sh/uv/');
        }
      }
    } else {
      ok('uv found');
    }

    // Check Python 3.11+
    const pyVer = getPythonVersion();
    if (!pyVer) {
      warn('Python 3 not found. Please install Python 3.11+ before using xiaohongshu-skills.');
    } else if (pyVer.major < 3 || (pyVer.major === 3 && pyVer.minor < 11)) {
      warn(`Python ${pyVer.major}.${pyVer.minor} found, but 3.11+ is required.`);
    } else {
      ok(`Python ${pyVer.major}.${pyVer.minor} found`);
    }

    // Check Chrome
    let chromeFound = false;
    try {
      execSync('which google-chrome || which chromium-browser || which chromium || which "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"', { stdio: 'ignore' });
      chromeFound = true;
      ok('Chrome/Chromium found');
    } catch {
      if (os.platform() === 'linux') {
        warn('Google Chrome or Chromium not found.');
        const installChrome = await ask(rl, '  Install chromium-browser via apt? (Y/n): ');
        if (installChrome.trim().toLowerCase() !== 'n') {
          try {
            execSync('sudo apt-get update -qq && sudo apt-get install -y -qq chromium-browser', { stdio: 'inherit', timeout: 120000 });
            chromeFound = true;
            ok('chromium-browser installed');
          } catch {
            warn('Failed to install chromium-browser. Install manually: sudo apt install chromium-browser');
          }
        }
      } else {
        warn('Google Chrome not found. Install Chrome before using xiaohongshu-skills.');
      }
    }

    // Clone or update repo
    if (isXhsSkillsInstalled()) {
      ok('xiaohongshu-skills already installed');
      const update = await ask(rl, '  Pull latest version? (y/N): ');
      if (update.trim().toLowerCase() === 'y') {
        try {
          execSync(`git -C "${XHS_SKILLS_DIR}" pull`, { stdio: 'inherit', timeout: 60000 });
          ok('xiaohongshu-skills updated');
        } catch (err) {
          warn(`Failed to update: ${err.message}`);
        }
      }
    } else {
      log('Cloning xiaohongshu-skills...');
      try {
        fs.mkdirSync(SKILLS_DIR, { recursive: true });
        execSync(`git clone https://github.com/autoclaw-cc/xiaohongshu-skills.git "${XHS_SKILLS_DIR}"`, { stdio: 'inherit', timeout: 120000 });
        ok(`xiaohongshu-skills cloned to ${XHS_SKILLS_DIR}`);
      } catch (err) {
        warn(`Failed to clone xiaohongshu-skills: ${err.message}`);
        warn('You can install manually: git clone https://github.com/autoclaw-cc/xiaohongshu-skills.git ~/.openclaw/skills/xiaohongshu-skills/');
      }
    }

    // Run uv sync
    if (fs.existsSync(XHS_SKILLS_DIR) && isUvAvailable()) {
      log('Running uv sync...');
      try {
        execSync(`cd "${XHS_SKILLS_DIR}" && uv sync`, { stdio: 'inherit', timeout: 120000 });
        ok('Python dependencies installed');
      } catch (err) {
        warn(`uv sync failed: ${err.message}`);
        warn('Run manually: cd ~/.openclaw/skills/xiaohongshu-skills && uv sync');
      }
    }

    xhsInstalled = isXhsSkillsInstalled();
  }

  rl.close();

  // Check/install Python dependencies for Instagram bridge
  if (igUsername) {
    log('Checking Python dependencies for Instagram bridge...');
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
  log('Step 3/10: Installing skill files...');
  if (fs.existsSync(SKILL_DEST)) {
    warn(`Existing skill found at ${SKILL_DEST} — overwriting`);
  }
  copyDirRecursive(SKILL_SRC, SKILL_DEST);
  copyBuiltScripts(DIST_SRC, path.join(SKILL_DEST, 'scripts'));
  ok(`Skill files copied to ${SKILL_DEST}`);

  // Step 4: Update openclaw.json
  log('Step 4/10: Registering skill in OpenClaw config...');
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
      ...(xhsInstalled && { XHS_SKILLS_DIR: XHS_SKILLS_DIR }),
    }
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  ok('openclaw.json updated');

  // Step 5: Initialize memory directories
  log('Step 5/10: Setting up memory directories...');
  fs.mkdirSync(path.join(MEMORY_DIR, 'relations'), { recursive: true });
  const diaryPath = path.join(MEMORY_DIR, 'diary.md');
  if (!fs.existsSync(diaryPath)) {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
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
    fs.writeFileSync(emotionStatePath, JSON.stringify({"mood":{"valence":0.3,"arousal":0.5,"description":"刚醒来"},"energy":0.6,"stress":0.2,"creativity":0.4,"sociability":0.5,"last_updated":null,"recent_cause":"初始化","momentum":{"valence":0,"arousal":0,"energy":0,"stress":0,"creativity":0,"sociability":0,"duration_ticks":0},"undertone":{"valence":0.3,"arousal":0.5,"energy":0.6,"stress":0.2,"creativity":0.4,"sociability":0.5},"impulse_history":[],"consecutive_high_stress":0,"threshold_break_cooldown":0}, null, 2));
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
  const flowStatePath = path.join(MEMORY_DIR, 'flow-state.json');
  if (!fs.existsSync(flowStatePath)) {
    fs.writeFileSync(flowStatePath, JSON.stringify({"status":"none","activity":null,"category":null,"entered_at":null,"duration_ticks":0,"interrupt_chance":0.15}, null, 2));
  }
  const pendingChainsPath = path.join(MEMORY_DIR, 'pending-chains.json');
  if (!fs.existsSync(pendingChainsPath)) {
    fs.writeFileSync(pendingChainsPath, JSON.stringify({"pending":[],"cooldowns":{}}, null, 2));
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
  // post-impulse.json
  const postImpulsePath = path.join(MEMORY_DIR, 'post-impulse.json');
  if (!fs.existsSync(postImpulsePath)) {
    fs.writeFileSync(postImpulsePath, JSON.stringify({
      value: 0,
      last_post_at: 0,
      posts_today_date: '',
      posts_today: 0,
    }, null, 2));
    console.log('  ✓ post-impulse.json');
  }
  // inspiration-refs/
  const inspirationRefsDir = path.join(MEMORY_DIR, 'inspiration-refs');
  if (!fs.existsSync(inspirationRefsDir)) {
    fs.mkdirSync(inspirationRefsDir, { recursive: true });
    console.log('  ✓ inspiration-refs/');
  }
  // Copy reference images
  const srcRefs = path.join(__dirname, '..', 'skill', 'assets', 'references');
  const destRefs = path.join(SKILL_DEST, 'assets', 'references');
  if (fs.existsSync(srcRefs) && !fs.existsSync(destRefs)) {
    fs.mkdirSync(destRefs, { recursive: true });
    for (const file of fs.readdirSync(srcRefs)) {
      fs.copyFileSync(path.join(srcRefs, file), path.join(destRefs, file));
    }
    console.log('  ✓ reference images');
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
  log('Step 6/10: Deploying memory hooks...');
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
  log('Step 7/10: Injecting Minase persona into SOUL.md...');
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
  log('Step 8/10: Registering heartbeat cron jobs...');
  if (isOpenClawCLIAvailable()) {
    registerCronJobs();
  } else {
    warn('OpenClaw CLI not found in PATH — skipping cron registration.');
    warn('You can register manually later:');
    warn('  openclaw cron add --name "minase:morning" --cron "0 7 * * *" --session isolated --message "[cron:morning] Run morning plan"');
    warn('  openclaw cron add --name "minase:tick" --cron "0 8-22 * * *" --session isolated --message "[cron:tick] Run heartbeat tick"');
    warn('  openclaw cron add --name "minase:night" --cron "0 23 * * *" --session isolated --message "[cron:night] Run night reflection"');
  }

  // Step 9: Verify XHS CLI (if installed)
  if (xhsInstalled) {
    log('Step 9/10: Verifying XiaoHongShu CLI...');
    const reachable = probeXhsCli();
    if (reachable) {
      ok('xiaohongshu-skills CLI is working (logged in)');
    } else {
      warn('XiaoHongShu not logged in yet.');
      // Try verbose probe to get QR code info
      const probeResult = probeXhsCliVerbose();
      if (probeResult && probeResult.qrcode_image_url) {
        console.log('\n  A QR code has been generated for login.');
        console.log('  Option A — Scan QR code:');
        console.log('    1. Open this data URL in a browser to see the QR code:');
        console.log(`       ${probeResult.qrcode_image_url.slice(0, 80)}...`);
        if (probeResult.qrcode_path) {
          console.log(`    Or view the saved image: ${probeResult.qrcode_path}`);
        }
        console.log(`    2. After scanning, run:`);
        console.log(`       cd "${XHS_SKILLS_DIR}" && uv run python scripts/cli.py wait-login`);
      }
      console.log('\n  Option B — Phone verification:');
      console.log(`    1. cd "${XHS_SKILLS_DIR}" && uv run python scripts/cli.py send-code --phone <your_phone>`);
      console.log('    2. uv run python scripts/cli.py verify-code --code <sms_code>');
      console.log('\n  XiaoHongShu browsing will be skipped until login succeeds.');
    }
  } else {
    log('Step 9/10: XiaoHongShu not installed — skipping.');
  }

  // Step 10: Summary
  log('Step 10/10: Installation complete!\n');
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
  if (xhsInstalled) {
    ok('XiaoHongShu integration enabled — she can browse 小红书 for cos trends.');
    console.log(`    Skills dir: ${XHS_SKILLS_DIR}`);
  } else {
    warn('XiaoHongShu not configured — re-run installer to add it.');
  }
  console.log('');
}

// Entry: route by CLI args
const args = process.argv.slice(2);
if (args.includes('--reinstall')) {
  reinstall().catch(err => {
    console.error('\n  Reinstall failed:', err.message);
    process.exit(1);
  });
} else if (args.includes('--uninstall')) {
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
