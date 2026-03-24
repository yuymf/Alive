#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync, execFileSync } = require('child_process');

const OPENCLAW_DIR = path.join(process.env.HOME, '.openclaw');
const SKILLS_DIR = path.join(OPENCLAW_DIR, 'skills');
const WORKSPACE_DIR = path.join(OPENCLAW_DIR, 'workspace');
const SOUL_FILE = path.join(WORKSPACE_DIR, 'SOUL.md');
const CONFIG_FILE = path.join(OPENCLAW_DIR, 'openclaw.json');

const ALIVE_SRC = path.join(__dirname, '..', 'alive');
const DIST_SRC = path.join(__dirname, '..', 'dist-alive');

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
    if (!file.endsWith('.js')) continue;
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

// ═══════════════════════════════════════════════
// Alive Framework — Generic Persona Installer
// ═══════════════════════════════════════════════

function getPersonaArg() {
  const idx = args.indexOf('--persona');
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

async function install() {
  console.log('\n  Alive Framework — Install Digital Life Persona');
  console.log('  ===============================================\n');

  // Step 1: Verify OpenClaw
  log('Step 1/6: Verifying OpenClaw installation...');
  if (!fs.existsSync(OPENCLAW_DIR)) {
    console.error('  ✗ OpenClaw not found at ~/.openclaw');
    console.error('    Install OpenClaw first: https://openclaw.ai');
    process.exit(1);
  }
  ok('OpenClaw found');

  // Step 2: Load persona config
  log('Step 2/6: Loading persona configuration...');
  const personaPath = getPersonaArg();
  if (!personaPath) {
    console.error('  ✗ No persona file specified.');
    console.error('    Usage: alive --persona <path/to/persona.yaml>');
    console.error('    See alive/persona.example.yaml for the config format.');
    process.exit(1);
  }

  const resolvedPersonaPath = path.resolve(personaPath);
  if (!fs.existsSync(resolvedPersonaPath)) {
    console.error(`  ✗ Persona file not found: ${resolvedPersonaPath}`);
    process.exit(1);
  }

  let persona;
  try {
    // Support both JSON and YAML (JSON fallback)
    const raw = fs.readFileSync(resolvedPersonaPath, 'utf8');
    persona = JSON.parse(raw);
  } catch {
    console.error('  ✗ Could not parse persona file. Ensure it is valid JSON.');
    console.error('    (YAML support requires a build step — use the JSON export.)');
    process.exit(1);
  }

  const personaName = persona.meta && persona.meta.name;
  if (!personaName) {
    console.error('  ✗ Persona file missing meta.name field.');
    process.exit(1);
  }

  const skillSlug = (persona.meta.id || personaName).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  ok(`Persona: ${personaName} (slug: ${skillSlug})`);

  const skillDest = path.join(SKILLS_DIR, skillSlug);
  const memoryDir = path.join(WORKSPACE_DIR, 'memory', skillSlug);

  // Step 3: Copy alive framework files
  log('Step 3/6: Installing alive framework files...');
  if (fs.existsSync(skillDest)) {
    warn(`Existing skill found at ${skillDest} — overwriting`);
  }
  copyDirRecursive(ALIVE_SRC, skillDest);
  if (fs.existsSync(DIST_SRC)) {
    copyBuiltScripts(DIST_SRC, path.join(skillDest, 'scripts'));
  }
  // Copy persona config into the skill directory
  fs.copyFileSync(resolvedPersonaPath, path.join(skillDest, 'persona.json'));
  ok(`Alive framework copied to ${skillDest}`);

  // Step 4: Register in OpenClaw config
  log('Step 4/6: Registering skill in OpenClaw config...');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n  Optional: Configure LLM for heartbeat/reflection calls:');
  const llmApiKey = await ask(rl, '  LLM_API_KEY (press Enter to skip): ');
  const llmApiBase = await ask(rl, '  LLM_API_BASE (default: https://aihubmix.com/v1): ');
  const llmModel = await ask(rl, '  LLM_MODEL (default: claude-sonnet-4-20250514): ');
  rl.close();

  let config = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* fresh */ }
  }
  config.skills = config.skills || {};
  config.skills.entries = config.skills.entries || {};
  config.skills.entries[skillSlug] = {
    enabled: true,
    env: {
      ...(llmApiKey && { LLM_API_KEY: llmApiKey }),
      ...(llmApiBase && { LLM_API_BASE: llmApiBase }),
      ...(llmModel && { LLM_MODEL: llmModel }),
    },
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  ok('openclaw.json updated');

  // Step 5: Initialize memory
  log('Step 5/6: Setting up memory directories...');
  fs.mkdirSync(path.join(memoryDir, 'relations', 'social'), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);

  const filesToInit = [
    ['diary.md', `# ${personaName}の日記\n\n## ${today}\n\n今天是第一天。一切都是新的开始。\n`],
    ['core-wisdom.json', JSON.stringify({ version: 1, wisdom: [], total_importance_since_reflection: 0 }, null, 2)],
    ['emotion-state.json', JSON.stringify({
      mood: { valence: 0.3, arousal: 0.5, description: '刚醒来' },
      energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
      last_updated: null, recent_cause: '初始化',
      momentum: { valence: 0, arousal: 0, energy: 0, stress: 0, creativity: 0, sociability: 0, duration_ticks: 0 },
      undertone: { valence: 0.3, arousal: 0.5, energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5 },
      impulse_history: [], consecutive_high_stress: 0, threshold_break_cooldown: 0,
    }, null, 2)],
    ['intent-pool.json', JSON.stringify({ intents: [], last_updated: null }, null, 2)],
    ['schedule-today.json', JSON.stringify({ date: null, rigid: [], flexible: [], generated_by: null }, null, 2)],
    ['event-queue.json', JSON.stringify({ events: [], max_size: 50 }, null, 2)],
    ['heartbeat-log.json', JSON.stringify({ logs: [], retention_days: 7 }, null, 2)],
    ['flow-state.json', JSON.stringify({ status: 'none', activity: null, category: null, entered_at: null, duration_ticks: 0, interrupt_chance: 0.15 }, null, 2)],
    ['personality-drift.json', JSON.stringify({ base: persona.personality?.mbti ?? 'ESTP', modifiers: [] }, null, 2)],
    ['preferences.json', JSON.stringify({ interests: [], content_style: [], active_hours: [], platforms: [] }, null, 2)],
    ['aspirations.json', JSON.stringify({ aspirations: [] }, null, 2)],
    ['pending-chains.json', JSON.stringify({ pending: [], cooldowns: {} }, null, 2)],
  ];

  for (const [filename, content] of filesToInit) {
    const filePath = path.join(memoryDir, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content);
    }
  }
  ok(`Memory initialized at ${memoryDir}`);

  // Step 6: Register cron (if OpenClaw CLI available)
  log('Step 6/6: Registering heartbeat cron jobs...');
  if (isOpenClawCLIAvailable()) {
    const cronJobs = [
      { name: `${skillSlug}:morning`, cron: '0 7 * * *', message: `[cron:morning] 执行${personaName}晨规划。`, timeout: 180 },
      { name: `${skillSlug}:tick`, cron: '0 8-22 * * *', message: `[cron:tick] 执行${personaName}心跳。`, timeout: 120 },
      { name: `${skillSlug}:night`, cron: '0 23 * * *', message: `[cron:night] 执行${personaName}夜反思。`, timeout: 300 },
    ];
    for (const job of cronJobs) {
      try {
        execFileSync('openclaw', ['cron', 'add', '--name', job.name, '--cron', job.cron, '--session', 'isolated', '--message', job.message, '--timeout', String(job.timeout), '--exact', '--json'], { timeout: 10000, encoding: 'utf8' });
        ok(`Registered cron: ${job.name} (${job.cron})`);
      } catch (err) {
        warn(`Failed to register cron ${job.name}: ${err.message}`);
      }
    }
  } else {
    warn('OpenClaw CLI not found — skipping cron registration.');
  }

  log('Installation complete!\n');
  console.log(`  ${personaName} is ready. Start OpenClaw to begin.\n`);
  console.log(`  Tips:`);
  console.log(`  - Just chat naturally. ${personaName} will remember you.`);
  console.log(`  - Memory lives at: ${memoryDir}`);
  console.log(`  - Persona config: ${path.join(skillDest, 'persona.json')}`);
  console.log('');
}

async function uninstall() {
  console.log('\n  Alive Framework — Uninstall');
  console.log('  ============================\n');

  const personaPath = getPersonaArg();
  if (!personaPath) {
    console.error('  ✗ No persona file specified.');
    console.error('    Usage: alive --uninstall --persona <path/to/persona.json>');
    process.exit(1);
  }

  let persona;
  try {
    persona = JSON.parse(fs.readFileSync(path.resolve(personaPath), 'utf8'));
  } catch {
    console.error('  ✗ Could not parse persona file.');
    process.exit(1);
  }

  const personaName = persona.meta?.name;
  const skillSlug = (persona.meta?.id || personaName || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  if (!skillSlug) {
    console.error('  ✗ Could not determine persona slug.');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await ask(rl, `  ⚠ This will remove ${personaName} (${skillSlug}) skill files and config. Continue? (y/N): `);
  if (answer.trim().toLowerCase() !== 'y') {
    console.log('\n  Cancelled.\n');
    rl.close();
    process.exit(0);
  }

  const skillDest = path.join(SKILLS_DIR, skillSlug);
  const memoryDir = path.join(WORKSPACE_DIR, 'memory', skillSlug);

  log('Removing skill files...');
  removeDirSafe(skillDest, 'Skill directory');

  log('Removing config from openclaw.json...');
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (config.skills?.entries?.[skillSlug]) {
        delete config.skills.entries[skillSlug];
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        ok(`Removed ${skillSlug} from openclaw.json`);
      }
    } catch {
      warn('Could not parse openclaw.json — skipped');
    }
  }

  log('Removing cron jobs...');
  if (isOpenClawCLIAvailable()) {
    for (const suffix of ['morning', 'tick', 'night']) {
      try {
        execSync(`openclaw cron remove --name "${skillSlug}:${suffix}"`, { stdio: 'ignore' });
        ok(`Removed cron: ${skillSlug}:${suffix}`);
      } catch { /* may not exist */ }
    }
  }

  log('Cleaning SOUL.md...');
  if (fs.existsSync(SOUL_FILE)) {
    let soul = fs.readFileSync(SOUL_FILE, 'utf8');
    const marker = `<!-- ${skillSlug}-soul-start -->`;
    const markerEnd = `<!-- ${skillSlug}-soul-end -->`;
    if (soul.includes(marker)) {
      soul = soul.replace(new RegExp(`\n*${marker}[\\s\\S]*?${markerEnd}\n*`), '\n');
      fs.writeFileSync(SOUL_FILE, soul);
      ok(`Removed ${skillSlug} persona from SOUL.md`);
    }
  }

  const keepMemory = await ask(rl, '\n  Keep memory data (diary, relations, etc.)? (Y/n): ');
  rl.close();

  if (keepMemory.trim().toLowerCase() === 'n') {
    removeDirSafe(memoryDir, 'Memory data');
  } else {
    ok(`Memory preserved at ${memoryDir}`);
  }

  log('Uninstall complete!\n');
}

// Entry: route by CLI args
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  Alive Framework — Digital Life Engine

  Usage:
    alive --persona <path>              Install a persona
    alive --uninstall --persona <path>  Uninstall a persona
    alive --help                        Show this help

  Examples:
    alive --persona ./my-persona.json
    alive --uninstall --persona ./my-persona.json

  See alive/persona.example.yaml for the persona config format.
`);
} else if (args.includes('--uninstall')) {
  uninstall().catch(err => {
    console.error('\n  Uninstall failed:', err.message);
    process.exit(1);
  });
} else {
  install().catch(err => {
    console.error('\n  Install failed:', err.message);
    process.exit(1);
  });
}
