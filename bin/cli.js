#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execSync, execFileSync } = require('child_process');
const YAML = require('yaml');

const OPENCLAW_DIR = path.join(process.env.HOME, '.openclaw');
const SKILLS_DIR = path.join(OPENCLAW_DIR, 'skills');
const WORKSPACE_DIR = path.join(OPENCLAW_DIR, 'workspace');
const SOUL_FILE = path.join(WORKSPACE_DIR, 'SOUL.md');
const CONFIG_FILE = path.join(OPENCLAW_DIR, 'openclaw.json');

const ALIVE_SRC = path.join(__dirname, '..', 'alive');
const DIST_SRC = path.join(__dirname, '..', 'dist-alive');
const E2E_REAL_DAY = path.join(__dirname, '..', 'e2e', 'e2e-real-day.ts');
const PERSONAS_DIR = path.join(ALIVE_SRC, 'personas');
const TEMPLATES_DIR = path.join(ALIVE_SRC, 'templates');

const REFERENCE_FILES = ['front.png', 'half-body.png', 'full-body.png', 'left-profile.png'];

// ─── .env File Loader ────────────────────────────────────────────────────────

/**
 * Parse a .env file and return key-value pairs.
 * Supports: KEY=VALUE, KEY="VALUE", KEY='VALUE', comments (#), empty lines.
 * Does NOT override existing process.env values (unless force=true).
 */
function loadEnvFile(envPath, { force = false } = {}) {
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, 'utf8');
  const vars = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
    if (force || !process.env[key]) {
      process.env[key] = val;
    }
  }
  return vars;
}

/**
 * Find and load .env file from CLI args (--env-file <path>) or default locations.
 * Search order:
 *   1. --env-file <path> (explicit)
 *   2. .env in CWD
 *   3. .env in project root (alive repo root)
 * Returns the loaded vars object (empty if no .env found).
 */
function autoLoadEnvFile() {
  const cliArgs = process.argv.slice(2);
  const envFileIdx = cliArgs.indexOf('--env-file');
  if (envFileIdx !== -1 && envFileIdx + 1 < cliArgs.length) {
    const envPath = path.resolve(cliArgs[envFileIdx + 1]);
    if (!fs.existsSync(envPath)) {
      console.error(`  ✗ --env-file specified but not found: ${envPath}`);
      process.exit(1);
    }
    const vars = loadEnvFile(envPath);
    ok(`Loaded ${Object.keys(vars).length} vars from ${envPath}`);
    return vars;
  }
  // Auto-detect .env in CWD or project root
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '..', '.env'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const vars = loadEnvFile(candidate);
      if (Object.keys(vars).length > 0) {
        ok(`Auto-loaded ${Object.keys(vars).length} vars from ${candidate}`);
        return vars;
      }
    }
  }
  return {};
}

// ─── Preflight Dependency Check ──────────────────────────────────────────────

/**
 * Comprehensive environment preflight check.
 * Checks ALL required dependencies upfront and reports them clearly.
 * If any REQUIRED dependency is missing, prints instructions and exits.
 *
 * @param {object} options
 * @param {boolean} options.opsEnabled - Whether ops features are needed (XHS/Douyin)
 * @returns {{ warnings: string[] }} Non-fatal warnings
 */
function preflightCheck({ opsEnabled = false } = {}) {
  console.log('\n  ╭─────────────────────────────────────────────╮');
  console.log('  │       🔍 Preflight Dependency Check          │');
  console.log('  ╰─────────────────────────────────────────────╯\n');

  const errors = [];   // Fatal — will stop install
  const warnings = []; // Non-fatal — install continues with reduced features

  // ── 1. Node.js version ──
  const [nodeMajor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 18) {
    errors.push({
      name: 'Node.js >= 18',
      status: `current: v${process.versions.node}`,
      fix: 'Install Node.js 18+: https://nodejs.org/ or use nvm: nvm install 18',
    });
  } else {
    ok(`Node.js v${process.versions.node}`);
  }

  // ── 2. OpenClaw directory (~/.openclaw) ──
  if (!fs.existsSync(OPENCLAW_DIR)) {
    errors.push({
      name: 'OpenClaw (~/.openclaw)',
      status: 'not found',
      fix: 'Install OpenClaw first: https://openclaw.ai',
    });
  } else {
    ok(`OpenClaw directory found (~/.openclaw)`);
  }

  // ── 3. Git ──
  let gitAvailable = false;
  try {
    execSync('git --version', { stdio: 'ignore', timeout: 5000 });
    gitAvailable = true;
    ok('git available');
  } catch {
    if (opsEnabled) {
      errors.push({
        name: 'git',
        status: 'not found',
        fix: 'Install git: sudo apt install -y git  (required for platform skills auto-download)',
      });
    } else {
      warnings.push('git not found — auto-download of platform skills disabled');
      warn('git not found — auto-download of platform skills will be disabled');
    }
  }

  // ── 4. OpenClaw CLI (optional but recommended) ──
  const clawAvailable = isOpenClawCLIAvailable();
  if (clawAvailable) {
    ok('OpenClaw CLI available');
  } else {
    warnings.push('OpenClaw CLI not found — cron scheduling & ClawHub skills disabled');
    warn('OpenClaw CLI not found — cron scheduling & ClawHub skills will be disabled');
  }

  // ── Ops-specific checks (only when ops enabled) ──
  if (opsEnabled) {
    // ── 5. uv (Python package manager) ──
    let uvAvailable = false;
    try {
      const uvVer = execSync('uv --version', { encoding: 'utf8', timeout: 5000 }).trim();
      uvAvailable = true;
      ok(`uv available (${uvVer})`);
    } catch {
      errors.push({
        name: 'uv (Python package manager)',
        status: 'not found',
        fix: 'Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh\n         Then restart your shell or run: source $HOME/.local/bin/env',
      });
    }

    // ── 6. Python 3.10+ ──
    if (uvAvailable) {
      try {
        const pyVer = execSync('uv run python --version', { encoding: 'utf8', timeout: 10000 }).trim();
        ok(`Python available (${pyVer})`);
      } catch {
        try {
          const pyVer = execSync('python3 --version', { encoding: 'utf8', timeout: 5000 }).trim();
          ok(`Python available (${pyVer})`);
        } catch {
          errors.push({
            name: 'Python 3.10+',
            status: 'not found',
            fix: 'Install Python 3.10+: sudo apt install -y python3 python3-venv',
          });
        }
      }
    }

    // ── 7. Chrome / Chromium (auto-detect & persist) ──
    let chromeFound = false;
    let detectedChromePath = null;

    // Well-known binary names to search via $PATH
    const chromeCandidates = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];
    // Well-known absolute paths for macOS / snap / flatpak / Windows WSL
    const chromeAbsolutePaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',        // macOS
      '/Applications/Chromium.app/Contents/MacOS/Chromium',                  // macOS Chromium
      '/usr/bin/google-chrome-stable',                                       // Linux apt
      '/usr/bin/chromium-browser',                                           // Debian/Ubuntu
      '/usr/bin/chromium',                                                   // Arch/Fedora
      '/snap/bin/chromium',                                                  // snap
      '/usr/lib/chromium/chromium',                                          // some distros
    ];

    // 1) Check explicit CHROME_BIN first
    if (process.env.CHROME_BIN) {
      try {
        execSync(`"${process.env.CHROME_BIN}" --version`, { stdio: 'ignore', timeout: 5000 });
        chromeFound = true;
        detectedChromePath = process.env.CHROME_BIN;
        ok(`Chrome available (CHROME_BIN=${process.env.CHROME_BIN})`);
      } catch {
        warn(`CHROME_BIN set but not working: ${process.env.CHROME_BIN}`);
      }
    }

    // 2) Search $PATH candidates
    if (!chromeFound) {
      for (const bin of chromeCandidates) {
        try {
          const resolved = execSync(`which ${bin}`, { encoding: 'utf8', timeout: 2000 }).trim();
          if (resolved) {
            chromeFound = true;
            detectedChromePath = resolved;
            ok(`Chrome auto-detected: ${resolved}`);
            break;
          }
        } catch { /* try next */ }
      }
    }

    // 3) Search well-known absolute paths (macOS .app bundles, snap, etc.)
    if (!chromeFound) {
      for (const absPath of chromeAbsolutePaths) {
        if (fs.existsSync(absPath)) {
          try {
            execSync(`"${absPath}" --version`, { stdio: 'ignore', timeout: 5000 });
            chromeFound = true;
            detectedChromePath = absPath;
            ok(`Chrome auto-detected: ${absPath}`);
            break;
          } catch { /* exists but won't run */ }
        }
      }
    }

    // Persist the detected path so downstream code (setupPlatformBridgeSkills,
    // Python CDP scripts) can use it without re-scanning.
    if (chromeFound && detectedChromePath) {
      if (!process.env.CHROME_BIN) {
        process.env.CHROME_BIN = detectedChromePath;
        ok(`CHROME_BIN auto-set → ${detectedChromePath}`);
      }
    }

    if (!chromeFound) {
      const isMac = os.platform() === 'darwin';
      errors.push({
        name: 'Chrome / Chromium',
        status: 'not found',
        fix: isMac
          ? 'Install Chrome: brew install --cask google-chrome'
          : [
              'Install Chrome/Chromium:',
              '    Ubuntu/Debian: sudo apt install -y chromium-browser',
              '    Or: wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo dpkg -i google-chrome-stable_current_amd64.deb',
            ].join('\n         '),
      });
    }

    // ── 8. Headless display check (Xvfb / DISPLAY) ──
    const isLinux = os.platform() === 'linux';
    const hasDisplay = !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
    if (isLinux && !hasDisplay) {
      // Check if Chrome supports --headless=new (modern headless mode)
      // This is informational — not a hard error since Chrome can run headless
      warnings.push('No DISPLAY set — Chrome will run in headless mode. Login flows may need special handling.');
      warn('No DISPLAY set — Chrome will run in headless mode');
      warn('For login flows, consider: sudo apt install -y xvfb && Xvfb :99 & export DISPLAY=:99');
    }
  }

  // ── Report ──
  if (errors.length > 0) {
    console.log('\n  ┌──────────────────────────────────────────────┐');
    console.log('  │  ✗ MISSING REQUIRED DEPENDENCIES              │');
    console.log('  └──────────────────────────────────────────────┘\n');
    for (const err of errors) {
      console.log(`  ✗ ${err.name}: ${err.status}`);
      console.log(`    Fix: ${err.fix}\n`);
    }
    console.log('  Install the dependencies above, then re-run the command.\n');
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.log('');
    ok(`Preflight check passed (${warnings.length} warning${warnings.length > 1 ? 's' : ''})`);
  } else {
    console.log('');
    ok('Preflight check passed — all dependencies OK');
  }

  return { warnings };
}

// External ClawHub skills required by ops scripts
const REQUIRED_CLAWHUB_SKILLS = [
  'daily-hot-news',      // trend-analyzer: 微博/知乎/B站热榜
  'douyin-hot-trend',    // trend-analyzer: 抖音热搜
  'yt-dlp-downloader',   // competitor-tracker, performance-tracker: 抖音视频信息
  'tiktok-growth',       // topic-generator: 短视频 hook 创意
];

function log(msg) { console.log(`\n  ${msg}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ! ${msg}`); }

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

/**
 * Mask a secret for display in prompts.
 * "sk-abcdefghijxyz" → "sk-a...xyz"
 * Returns empty string if no value so callers can show a plain prompt.
 */
function maskSecret(val) {
  if (!val || val.length <= 7) return val || '';
  return `${val.slice(0, 4)}...${val.slice(-3)}`;
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

/**
 * Recursively merge compiled JS/d.ts/map files from dist-alive/ into skillDest/.
 * This overlays the compiled output on top of the source tree so that
 * require('…/index.js') works at runtime (e.g. sub-skills loaded by skill-router).
 */
function copyBuiltScripts(src, dest) {
  if (!fs.existsSync(src)) {
    warn(`Built scripts not found at ${src} — run npm run build before packaging`);
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyBuiltScripts(srcPath, destPath);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts') || entry.name.endsWith('.js.map') || entry.name.endsWith('.d.ts.map')) {
      fs.copyFileSync(srcPath, destPath);
    }
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

// ─── Cron Helpers ────────────────────────────────────────────────────────────

/**
 * List all cron jobs from OpenClaw CLI (returns [] on failure).
 */
function listCronJobs() {
  try {
    const raw = execFileSync('openclaw', ['cron', 'list', '--json'], { timeout: 10000, encoding: 'utf8' });
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : (parsed?.jobs ?? []);
  } catch {
    return [];
  }
}

/**
 * Remove a cron job by its exact name.
 * `openclaw cron remove` only accepts <id>, so we list jobs first and match by name.
 */
function removeCronByName(name) {
  const jobs = listCronJobs();
  const matches = jobs.filter(j => j.name === name);
  for (const job of matches) {
    try {
      execFileSync('openclaw', ['cron', 'remove', job.id], { timeout: 10000, encoding: 'utf8', stdio: 'pipe' });
    } catch { /* may already be gone */ }
  }
  return matches.length;
}

// ─── Cron Reconciliation ─────────────────────────────────────────────────────

/**
 * Build the desired cron job specs for a persona.
 * Respects automation config: brief_delivery, enable_heartbeat_cron, silent_background_jobs.
 */
function buildCronSpecs({ persona, skillSlug, personaSlug, personaName }) {
  const automation = persona.ops?.automation ?? {};
  const enableHeartbeat = automation.enable_heartbeat_cron !== false; // default true
  const silentBg = automation.silent_background_jobs === true;
  const briefDelivery = automation.brief_delivery ?? 'wecom-target';

  const specs = [];

  // Heartbeat jobs (morning/tick/night) — skip if persona disables them
  if (enableHeartbeat) {
    specs.push(
      { name: `${skillSlug}:${personaSlug}:morning`, cron: '0 7 * * *', message: `[cron:morning] 执行${personaName}晨规划。`, timeout: 180, noDeliver: false },
      { name: `${skillSlug}:${personaSlug}:tick`, cron: '0 8-22 * * *', message: `[cron:tick] 执行${personaName}心跳。`, timeout: 120, noDeliver: false },
      { name: `${skillSlug}:${personaSlug}:night`, cron: '0 23 * * *', message: `[cron:night] 执行${personaName}夜反思。`, timeout: 300, noDeliver: false },
    );
  }

  // Ops jobs (only if ops.enabled)
  if (persona.ops && persona.ops.enabled) {
    const briefTimeParts = (persona.ops.brief_time || '08:30').split(':');
    // Use total-minutes subtraction to handle hour borrow correctly (e.g. 08:05 → 07:55)
    const rawHour = parseInt(briefTimeParts[0], 10);
    const rawMin = parseInt(briefTimeParts[1] || '30', 10);
    const totalMinutes = ((rawHour * 60 + rawMin) - 10 + 1440) % 1440; // +1440 handles midnight wrap
    const briefHour = Math.floor(totalMinutes / 60);
    const briefMin = totalMinutes % 60;
    const strategyDay = persona.ops.strategy_day ?? 1;
    const stratTimeParts = (persona.ops.strategy_time || '08:00').split(':');
    const stratHour = parseInt(stratTimeParts[0], 10);
    const stratMin = parseInt(stratTimeParts[1] || '0', 10);

    // ops-brief: for session delivery, use isolated + --no-deliver
    // (the brief script itself handles sending via openclaw message send)
    const briefNoDeliver = briefDelivery === 'session';
    const briefSession = 'isolated';

    specs.push(
      { name: `${skillSlug}:${personaSlug}:ops-brief`, cron: `${briefMin} ${briefHour} * * *`, message: `[cron:ops-brief] 执行${personaName}运营简报。`, timeout: 180, noDeliver: briefNoDeliver, session: briefSession },
    );

    // Background ops jobs (always-on)
    const bgJobs = [
      { name: `${skillSlug}:${personaSlug}:ops-trends`, cron: '0 * * * *', message: `[cron:ops-trends] 执行${personaName}运营趋势收集。`, timeout: 120 },
      { name: `${skillSlug}:${personaSlug}:ops-competitor-analysis`, cron: '0 6 * * *', message: `[cron:ops-competitor-analysis] 执行${personaName}竞品帖子采集与分析。`, timeout: 300 },
    ];
    for (const job of bgJobs) {
      specs.push({ ...job, noDeliver: silentBg });
    }

    // Strategy-dependent ops jobs (only when strategy_enabled)
    const strategyEnabled = persona.ops?.strategy_enabled === true;
    if (strategyEnabled) {
      const strategyJobs = [
        { name: `${skillSlug}:${personaSlug}:ops-performance`, cron: '0 */4 * * *', message: `[cron:ops-performance] 执行${personaName}内容表现数据采集。`, timeout: 120 },
        { name: `${skillSlug}:${personaSlug}:ops-analyze`, cron: '5 */4 * * *', message: `[cron:ops-analyze] 执行${personaName}内容表现分析。`, timeout: 120 },
        { name: `${skillSlug}:${personaSlug}:ops-strategy`, cron: `${stratMin} ${stratHour} * * ${strategyDay}`, message: `[cron:ops-strategy] 执行${personaName}周度内容策略生成。`, timeout: 300 },
      ];
      for (const job of strategyJobs) {
        specs.push({ ...job, noDeliver: silentBg });
      }
    }

    // Ops-browse: register when heartbeat is disabled (cron-only mode)
    if (!enableHeartbeat) {
      const browseInterval = persona.ops?.browse_interval || '0 */3 * * *';
      specs.push({
        name: `${skillSlug}:${personaSlug}:ops-browse`,
        cron: browseInterval,
        message: `[cron:ops-browse] 执行${personaName}内容浏览。`,
        timeout: 120,
        noDeliver: silentBg,
      });
    }
  }

  return specs;
}

/**
 * Reconcile cron jobs: remove all existing jobs for this persona prefix, then add desired specs.
 * This ensures idempotent registration — no duplicates.
 */
function reconcileCronJobs({ specs, skillSlug, personaSlug }) {
  const prefix = `${skillSlug}:${personaSlug}:`;

  // 1. List all existing jobs
  let existingJobs = [];
  try {
    const raw = execFileSync('openclaw', ['cron', 'list', '--json'], { timeout: 10000, encoding: 'utf8' });
    const parsed = JSON.parse(raw);
    existingJobs = Array.isArray(parsed) ? parsed : (parsed?.jobs ?? []);
  } catch (err) {
    warn(`Could not list cron jobs: ${err.message}`);
  }

  // 2. Remove all jobs matching this persona's prefix (by id for reliability)
  const toRemove = existingJobs.filter(j => String(j.name || '').startsWith(prefix));
  for (const job of toRemove) {
    try {
      execFileSync('openclaw', ['cron', 'remove', job.id], { timeout: 10000, encoding: 'utf8', stdio: 'pipe' });
    } catch { /* may already be gone */ }
  }
  if (toRemove.length > 0) {
    ok(`Removed ${toRemove.length} existing cron jobs for ${prefix}*`);
  }

  // 3. Add desired specs
  for (const spec of specs) {
    const args = [
      'cron', 'add',
      '--name', spec.name,
      '--cron', spec.cron,
      '--session', spec.session || 'isolated',
      '--message', spec.message,
      '--timeout-seconds', String(spec.timeout),
      '--exact',
      '--json',
    ];
    if (spec.noDeliver) {
      args.push('--no-deliver');
    }
    try {
      execFileSync('openclaw', args, { timeout: 10000, encoding: 'utf8' });
      ok(`Registered cron: ${spec.name} (${spec.cron})${spec.noDeliver ? ' [no-deliver]' : ''}`);
    } catch (err) {
      warn(`Failed to register cron ${spec.name}: ${err.message}`);
    }
  }
}

/**
 * Check which external ClawHub skills are installed and install missing ones.
 * Only runs when ops is enabled for the persona.
 */
function installRequiredClawHubSkills() {
  if (!isOpenClawCLIAvailable()) {
    warn('OpenClaw CLI not available — skipping ClawHub skill dependency check');
    return;
  }

  // Get list of installed skills
  let installedSkills = [];
  try {
    // openclaw skills list --json outputs JSON to stderr, not stdout
    const result = require('child_process').spawnSync('openclaw', ['skills', 'list', '--json'], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 10 * 1024 * 1024,
    });
    // Try stdout first, fall back to stderr (openclaw may output JSON to either)
    const listOutput = (result.stdout && result.stdout.trim()) || (result.stderr && result.stderr.trim()) || '';
    const parsed = JSON.parse(listOutput);
    // Handle both array format and { skills: [...] } format
    const skillList = Array.isArray(parsed) ? parsed : (parsed.skills || []);
    installedSkills = skillList.map(s => (typeof s === 'string' ? s : s.name || s.slug || '')).filter(Boolean);
  } catch {
    // If listing fails, we cannot determine which skills are already installed.
    // Instead of assuming all are missing (which would re-install everything),
    // we fall back to trying to install each skill directly — the install
    // command is idempotent and will skip already-installed skills.
    warn('Could not list installed skills — will check each dependency individually');
    const missing = [...REQUIRED_CLAWHUB_SKILLS]; // all need to be checked
    if (missing.length === 0) {
      ok(`All ${REQUIRED_CLAWHUB_SKILLS.length} ClawHub skill dependencies are installed`);
      return;
    }
    log(`Checking ${missing.length} ClawHub skill dependencies individually...`);
    let installed = 0;
    let failed = 0;
    const MAX_RETRIES = 3;

    for (let i = 0; i < missing.length; i++) {
      const skill = missing[i];
      let success = false;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          execSync(`openclaw skills install ${skill}`, {
            encoding: 'utf8',
            timeout: 60000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          ok(`ClawHub skill ready: ${skill}`);
          installed++;
          success = true;
          break;
        } catch (err) {
          const msg = err.message || '';
          const is429 = msg.includes('429') || msg.includes('Rate limit') || msg.includes('rate limit');
          if (is429 && attempt < MAX_RETRIES) {
            const delay = attempt * 5;
            warn(`Rate limited checking ${skill} — retrying in ${delay}s (attempt ${attempt}/${MAX_RETRIES})...`);
            execSync(`sleep ${delay}`);
          } else {
            warn(`Failed to check ClawHub skill: ${skill} — ${msg || 'unknown error'}`);
            failed++;
            break;
          }
        }
      }

      if (success && i < missing.length - 1) {
        execSync('sleep 3');
      }
    }

    if (failed > 0) {
      warn(`${failed} skill(s) failed to install. Some ops features may be limited.`);
      console.log('  You can install them manually: openclaw skills install <name>');
    }
    if (installed > 0) {
      ok(`${installed} ClawHub skill(s) ready`);
    }
    return;
  }

  const missing = REQUIRED_CLAWHUB_SKILLS.filter(s => !installedSkills.includes(s));

  if (missing.length === 0) {
    ok(`All ${REQUIRED_CLAWHUB_SKILLS.length} ClawHub skill dependencies are installed`);
    return;
  }

  log(`Installing ${missing.length} missing ClawHub skill dependencies...`);
  let installed = 0;
  let failed = 0;
  const MAX_RETRIES = 3;

  for (let i = 0; i < missing.length; i++) {
    const skill = missing[i];
    let success = false;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        execSync(`openclaw skills install ${skill}`, {
          encoding: 'utf8',
          timeout: 60000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        ok(`Installed ClawHub skill: ${skill}`);
        installed++;
        success = true;
        break;
      } catch (err) {
        const msg = err.message || '';
        const is429 = msg.includes('429') || msg.includes('Rate limit') || msg.includes('rate limit');
        if (is429 && attempt < MAX_RETRIES) {
          const delay = attempt * 5; // 5s, 10s backoff
          warn(`Rate limited installing ${skill} — retrying in ${delay}s (attempt ${attempt}/${MAX_RETRIES})...`);
          execSync(`sleep ${delay}`);
        } else {
          warn(`Failed to install ClawHub skill: ${skill} — ${msg || 'unknown error'}`);
          failed++;
          break;
        }
      }
    }

    // Delay between skills to avoid rate limiting
    if (success && i < missing.length - 1) {
      execSync('sleep 3');
    }
  }

  if (failed > 0) {
    warn(`${failed} skill(s) failed to install. Some ops features may be limited.`);
    console.log('  You can install them manually: openclaw skills install <name>');
  }
  if (installed > 0) {
    ok(`${installed} ClawHub skill(s) newly installed`);
  }
}

/**
 * Check and setup Python platform bridge skills (xiaohongshu-skills, douyin-skills).
 * These are local Python packages stored in ~/.openclaw/skills/, NOT ClawHub packages.
 *
 * In headless environments (no DISPLAY), runs a lightweight health check:
 *   - check-login (verifies Chrome can start and reach the site)
 *   - Non-interactive: skips login prompt, just verifies the CLI works
 *
 * Headless server improvements:
 *   - Auto-detects headless (no DISPLAY on Linux) and adjusts Chrome flags
 *   - Passes --no-sandbox flag when running as root
 *   - Provides clear cookie-import instructions for headless environments
 *   - Distinguishes "Chrome won't start" from "not logged in" errors
 *
 * @param {boolean} nonInteractive - Skip prompts (CI / headless install)
 */
function setupPlatformBridgeSkills(nonInteractive = false) {
  const HOME = process.env.HOME;
  const skillsBase = path.join(HOME, '.openclaw', 'skills');

  // Detect headless environment
  const isLinux = os.platform() === 'linux';
  const hasDisplay = !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
  const isHeadless = isLinux && !hasDisplay;
  const isRoot = process.getuid && process.getuid() === 0;

  if (isHeadless) {
    log('Headless environment detected — adjusting platform skill setup...');
  }

  // Verify uv is available (required to run Python skills)
  try {
    execSync('uv --version', { stdio: 'ignore', timeout: 5000 });
  } catch {
    warn('uv not found — Python platform skills (XHS, Douyin) will not work.');
    warn('Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh');
    return;
  }

  // Verify Chrome is available (required for CDP)
  let chromeAvailable = false;
  let chromeBinPath = process.env.CHROME_BIN || null;

  // If preflightCheck already found Chrome and set CHROME_BIN, skip re-scanning
  if (chromeBinPath) {
    try {
      execSync(`"${chromeBinPath}" --version`, { stdio: 'ignore', timeout: 5000 });
      chromeAvailable = true;
    } catch {
      chromeBinPath = null; // stale CHROME_BIN, re-detect
    }
  }

  // Re-detect if needed (covers direct calls without preflightCheck)
  if (!chromeBinPath) {
    const candidates = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];
    const absPathFallbacks = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
    ];
    for (const c of candidates) {
      try {
        const resolved = execSync(`which ${c}`, { encoding: 'utf8', timeout: 2000 }).trim();
        if (resolved) { chromeBinPath = resolved; break; }
      } catch { /* next */ }
    }
    if (!chromeBinPath) {
      for (const p of absPathFallbacks) {
        if (fs.existsSync(p)) { chromeBinPath = p; break; }
      }
    }
    if (chromeBinPath) {
      chromeAvailable = true;
      process.env.CHROME_BIN = chromeBinPath;
      ok(`Chrome auto-detected: ${chromeBinPath}`);
    }
  }

  if (chromeBinPath) {
    chromeAvailable = true;
    // On headless Linux, verify Chrome can actually start
    if (isHeadless) {
      try {
        const chromeFlags = isRoot ? '--headless=new --no-sandbox --disable-gpu' : '--headless=new --disable-gpu';
        execSync(`"${chromeBinPath}" ${chromeFlags} --dump-dom about:blank`, {
          stdio: 'ignore',
          timeout: 10000,
        });
        ok(`Chrome verified in headless mode: ${chromeBinPath}`);
      } catch (err) {
        warn(`Chrome found at ${chromeBinPath} but headless test failed: ${err.message}`);
        if (isRoot) {
          warn('Running as root — ensure --no-sandbox is passed to Chrome');
          warn('Try: CHROME_FLAGS="--no-sandbox" or set in the platform skill config');
        }
        // Chrome binary exists but may not work — continue anyway, health check will catch it
      }
    }
  }

  if (!chromeAvailable) {
    warn('Chrome/Chromium not found — XHS and Douyin CDP features will not work.');
    warn('Install: sudo apt install -y chromium-browser  OR  set CHROME_BIN env var');
  }

  // Ensure git is available for auto-download
  let gitAvailable = false;
  try {
    execSync('git --version', { stdio: 'ignore', timeout: 5000 });
    gitAvailable = true;
  } catch { /* git not found */ }

  const PLATFORM_SKILLS = [
    {
      name: 'xiaohongshu-skills',
      repo: 'https://github.com/autoclaw-cc/xiaohongshu-skills.git',
      dir: path.join(skillsBase, 'xiaohongshu-skills'),
      cli: path.join(skillsBase, 'xiaohongshu-skills', 'scripts', 'cli.py'),
      checkCmd: ['check-login'],
      envNote: 'Login via: uv run --directory ~/.openclaw/skills/xiaohongshu-skills python scripts/cli.py check-login',
    },
    {
      name: 'douyin-skills',
      repo: 'https://github.com/yuymf/douyin-skills.git',
      dir: path.join(skillsBase, 'douyin-skills'),
      cli: path.join(skillsBase, 'douyin-skills', 'scripts', 'cli.py'),
      checkCmd: ['check-login'],
      envNote: 'Login via: uv run --directory ~/.openclaw/skills/douyin-skills python scripts/cli.py check-login',
    },
  ];

  for (const skill of PLATFORM_SKILLS) {
    // Auto-download: if skill directory doesn't exist, clone from GitHub
    if (!fs.existsSync(skill.dir)) {
      if (!gitAvailable) {
        warn(`${skill.name} not found at ${skill.dir} and git is not available — skipping`);
        warn(`Install git, then re-run, or manually clone: git clone ${skill.repo} ${skill.dir}`);
        continue;
      }
      log(`${skill.name} not found — downloading from ${skill.repo}...`);
      try {
        // Ensure parent directory exists
        fs.mkdirSync(skillsBase, { recursive: true });
        execSync(`git clone --depth 1 ${skill.repo} ${skill.dir}`, {
          stdio: 'pipe',
          timeout: 120000,
          env: { ...process.env },
        });
        ok(`${skill.name} downloaded successfully`);
      } catch (err) {
        warn(`${skill.name} download failed: ${err.message}`);
        warn(`Manual install: git clone ${skill.repo} ${skill.dir}`);
        continue;
      }
    } else {
      // Directory exists — try to update (git pull) to get latest version
      const gitDir = path.join(skill.dir, '.git');
      if (gitAvailable && fs.existsSync(gitDir)) {
        try {
          execSync('git pull --ff-only', {
            cwd: skill.dir,
            stdio: 'pipe',
            timeout: 30000,
          });
          ok(`${skill.name} updated to latest`);
        } catch {
          // pull failed (offline, dirty state, etc.) — not fatal, continue with current version
          ok(`${skill.name} directory found (update skipped)`);
        }
      } else {
        ok(`${skill.name} directory found`);
      }
    }

    if (!fs.existsSync(skill.cli)) {
      warn(`${skill.name} CLI not found at ${skill.cli} — directory may be incomplete`);
      warn(`Try: rm -rf ${skill.dir} && git clone ${skill.repo} ${skill.dir}`);
      continue;
    }

    // Install Python dependencies via uv
    try {
      execSync(`uv sync --directory ${skill.dir}`, {
        stdio: 'pipe',
        timeout: 120000,
        env: { ...process.env },
      });
      ok(`${skill.name} Python dependencies installed`);
    } catch (err) {
      warn(`${skill.name} uv sync failed: ${err.message}`);
      warn('Check your Python version (>= 3.10) and internet connection');
    }

    // Health check: verify CLI starts and Chrome is reachable (headless safe)
    if (!chromeAvailable) {
      warn(`${skill.name} health check skipped (Chrome not available)`);
      continue;
    }

    try {
      // Build Chrome env for headless environments
      const chromeEnv = { ...process.env };
      if (isHeadless) {
        chromeEnv.CI = '1';
        // Pass headless Chrome flags if not already set
        if (!chromeEnv.CHROME_FLAGS && isRoot) {
          chromeEnv.CHROME_FLAGS = '--no-sandbox';
        }
        if (chromeBinPath && !chromeEnv.CHROME_BIN) {
          chromeEnv.CHROME_BIN = chromeBinPath;
        }
      }
      if (nonInteractive) {
        chromeEnv.CI = '1';
      }

      const result = require('child_process').spawnSync(
        'uv',
        ['run', '--directory', skill.dir, 'python', skill.cli, ...skill.checkCmd],
        {
          encoding: 'utf8',
          timeout: 30000,
          env: chromeEnv,
        },
      );
      const output = (result.stdout || '') + (result.stderr || '');
      if (result.status === 0) {
        try {
          const parsed = JSON.parse((result.stdout || '').trim());
          if (parsed.logged_in) {
            ok(`${skill.name} health check: logged in ✓`);
          } else {
            warn(`${skill.name} health check: Chrome started but not logged in`);
            if (isHeadless) {
              console.log('');
              console.log('  ┌─ Headless Login Guide ─────────────────────────────────────┐');
              console.log('  │ On a headless server, you cannot login interactively.       │');
              console.log('  │                                                             │');
              console.log('  │ Option 1: Cookie Import (recommended)                       │');
              console.log('  │   1. Login on your local machine (with browser)              │');
              console.log('  │   2. Copy cookies to server:                                 │');
              console.log(`  │      scp ~/.openclaw/skills/${skill.name}/cookies.json \\   │`);
              console.log('  │          server:~/.openclaw/skills/' + skill.name + '/      │');
              console.log('  │                                                             │');
              console.log('  │ Option 2: Virtual Display (Xvfb)                            │');
              console.log('  │   sudo apt install -y xvfb                                  │');
              console.log('  │   xvfb-run uv run --directory ~/.openclaw/skills/           │');
              console.log(`  │     ${skill.name} python scripts/cli.py login             │`);
              console.log('  └─────────────────────────────────────────────────────────────┘');
              console.log('');
            } else {
              warn(skill.envNote);
            }
          }
        } catch {
          ok(`${skill.name} health check: CLI responded`);
        }
      } else {
        warn(`${skill.name} health check failed (exit ${result.status})`);
        if (output.includes('未找到 Chrome') || output.includes('Chrome not found')) {
          warn('Chrome not found — set CHROME_BIN env var or install Chrome');
        } else if (output.includes('no-sandbox') || output.includes('Running as root without --no-sandbox')) {
          warn('Chrome sandbox error — try: export CHROME_FLAGS="--no-sandbox"');
          warn('Or run Chrome with: --no-sandbox flag');
        } else if (output.includes('ModuleNotFoundError') || output.includes('ImportError')) {
          warn(`${skill.name} missing Python dependencies — re-run: uv sync --directory ${skill.dir}`);
        } else if (output.includes('DISPLAY') || output.includes('cannot open display')) {
          warn('No display available — this is expected on headless servers');
          warn('Chrome should run in headless mode. Set: CHROME_FLAGS="--headless=new"');
        } else {
          warn(`Output: ${output.slice(0, 300)}`);
        }
      }
    } catch (err) {
      warn(`${skill.name} health check error: ${err.message}`);
    }
  }

  // Summary for headless environments
  if (isHeadless) {
    console.log('');
    log('═══ Headless Server Notes ═══');
    console.log('  Platform skills (XHS/Douyin) require logged-in cookies to work.');
    console.log('  On a headless server, the recommended approach is:');
    console.log('    1. Login on a machine with a browser (your local Mac/PC)');
    console.log('    2. Export and copy the cookies.json to the server');
    console.log('    3. Alternatively, use Xvfb: sudo apt install xvfb && xvfb-run <login-command>');
    console.log('');
  }
}

/**
 * Migrate from legacy skill slug (e.g. "minase") to "alive".
 * Renames skill directory and moves config entry in openclaw.json.
 * Called once before any command runs.
 */
function migrateFromLegacySlug() {
  const ALIVE_SLUG = 'alive';
  const aliveDest = path.join(SKILLS_DIR, ALIVE_SLUG);

  // If alive/ already exists, nothing to migrate
  if (fs.existsSync(aliveDest)) return;

  // Scan for a legacy skill directory that contains persona.yaml (the old non-"alive" slug)
  if (!fs.existsSync(SKILLS_DIR)) return;
  const candidates = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== ALIVE_SLUG)
    .filter(d => fs.existsSync(path.join(SKILLS_DIR, d.name, 'persona.yaml')));

  if (candidates.length === 0) return;

  // Use the first match (there should only be one alive-like skill)
  const legacySlug = candidates[0].name;
  const legacyDir = path.join(SKILLS_DIR, legacySlug);

  log(`Migrating legacy skill "${legacySlug}" → "${ALIVE_SLUG}"...`);

  // 1. Rename skill directory
  fs.renameSync(legacyDir, aliveDest);
  ok(`Renamed ${legacyDir} → ${aliveDest}`);

  // 2. Migrate openclaw.json config entry
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const entries = config.skills?.entries;
      if (entries && entries[legacySlug] && !entries[ALIVE_SLUG]) {
        entries[ALIVE_SLUG] = entries[legacySlug];
        delete entries[legacySlug];
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        ok(`Migrated openclaw.json: ${legacySlug} → ${ALIVE_SLUG}`);
      }
    } catch {
      warn('Could not migrate openclaw.json — you may need to update it manually');
    }
  }

  // 3. Migrate cron jobs (remove all jobs whose name starts with the legacy slug prefix)
  if (isOpenClawCLIAvailable()) {
    const allJobs = listCronJobs();
    const legacyJobs = allJobs.filter(j => String(j.name || '').startsWith(legacySlug + ':'));
    for (const job of legacyJobs) {
      try {
        execFileSync('openclaw', ['cron', 'remove', job.id], { timeout: 10000, encoding: 'utf8', stdio: 'pipe' });
      } catch { /* may already be gone */ }
    }
    if (legacyJobs.length > 0) {
      ok(`Removed ${legacyJobs.length} legacy cron jobs for "${legacySlug}:*"`);
    }
    warn('Legacy cron jobs removed — they will be re-registered on next install/reinstall.');
  }

  // 4. Migrate SOUL.md markers
  if (fs.existsSync(SOUL_FILE)) {
    try {
      let soul = fs.readFileSync(SOUL_FILE, 'utf8');
      const oldMarker = `<!-- ${legacySlug}-soul-start -->`;
      const oldEnd = `<!-- ${legacySlug}-soul-end -->`;
      const newMarker = `<!-- ${ALIVE_SLUG}-soul-start -->`;
      const newEnd = `<!-- ${ALIVE_SLUG}-soul-end -->`;
      if (soul.includes(oldMarker)) {
        soul = soul.replace(oldMarker, newMarker).replace(oldEnd, newEnd);
        fs.writeFileSync(SOUL_FILE, soul);
        ok('Updated SOUL.md markers');
      }
    } catch { /* best effort */ }
  }

  log(`Migration complete! Skill is now at ~/.openclaw/skills/${ALIVE_SLUG}/\n`);
}

/**
 * Check if reference images exist in the given references directory.
 */
function checkReferenceImages(referencesDir) {
  if (!fs.existsSync(referencesDir)) return { existing: 0, total: 4, missing: REFERENCE_FILES };
  const missing = [];
  let existing = 0;
  for (const f of REFERENCE_FILES) {
    if (fs.existsSync(path.join(referencesDir, f))) {
      existing++;
    } else {
      missing.push(f);
    }
  }
  return { existing, total: REFERENCE_FILES.length, missing };
}

/**
 * Resolve the reference_image path from persona config.
 * If relative, resolves against the persona YAML file directory.
 */
function resolveRefImageFromPersona(persona, personaYamlDir) {
  const refImage = persona.meta && persona.meta.reference_image;
  if (!refImage) return null;
  if (path.isAbsolute(refImage)) return refImage;
  return path.resolve(personaYamlDir, refImage);
}

/**
 * Run generateReferences via npx tsx.
 * This calls the TypeScript function from within the installed skill directory.
 * Uses a temporary file + execFileSync to avoid shell injection risks with user-supplied paths.
 */
function runGenerateReferences(sourcePath, outputDir, env) {
  // Use an absolute import path so the script works from /tmp or any cwd.
  const projectRoot = path.resolve(__dirname, '..');
  const importPath = path.join(projectRoot, 'alive/sub-skills/platform/generate-image/scripts/generate-references').replace(/\\/g, '/');
  const tmpScript = path.join(os.tmpdir(), `alive-gen-refs-${Date.now()}.ts`);
  const scriptContent = [
    `const { generateReferences } = require('${importPath}');`,
    `generateReferences(${JSON.stringify(sourcePath)}, ${JSON.stringify(outputDir)}).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });`,
  ].join('\n');
  fs.writeFileSync(tmpScript, scriptContent);
  try {
    execFileSync('npx', ['tsx', tmpScript], {
      stdio: 'inherit',
      timeout: 5 * 60 * 1000, // 5 minutes
      env: { ...process.env, ...env },
      cwd: projectRoot,
    });
    return true;
  } catch (err) {
    console.error(`  ✗ Reference image generation failed: ${err.message}`);
    return false;
  } finally {
    try { fs.unlinkSync(tmpScript); } catch { /* best-effort cleanup */ }
  }
}

/**
 * Setup reference images for a persona.
 * - Checks if reference images already exist
 * - Tries to use reference_image from persona YAML
 * - Falls back to asking user for a source image path
 * - Runs AI generation of multi-angle references
 *
 * @param {object} options
 * @param {object} options.persona - Parsed persona config
 * @param {string} options.personaYamlDir - Directory of persona YAML (for resolving relative paths)
 * @param {string} options.skillDest - Installed skill destination path (skill dir)
 * @param {string} [options.memoryDir] - Per-persona memory directory (preferred for references)
 * @param {object} options.rl - readline interface
 * @param {object} [options.env] - Extra env vars (API keys etc.)
 * @param {boolean} [options.nonInteractive] - Skip prompts (for real-day-test etc.)
 * @returns {Promise<boolean>} Whether references are ready
 */
async function setupReferenceImages({ persona, personaYamlDir, skillDest, memoryDir: memDir, rl, env = {}, nonInteractive = false }) {
  // Use per-persona memory directory for references (matches PATHS.referencesDir at runtime).
  // Falls back to skill directory only if no memoryDir is provided.
  const referencesDir = memDir
    ? path.join(memDir, 'assets', 'references')
    : path.join(skillDest, 'assets', 'references');
  const { existing, total, missing } = checkReferenceImages(referencesDir);

  if (existing === total) {
    ok(`Reference images found (${existing}/${total})`);
    return true;
  }

  if (existing > 0) {
    warn(`Partial reference images: ${existing}/${total} (missing: ${missing.join(', ')})`);
  } else {
    log('No reference images found. Reference images are needed for AI image generation.');
  }

  // Step A: Try to find source image from persona config
  let sourcePath = resolveRefImageFromPersona(persona, personaYamlDir);
  if (sourcePath && !fs.existsSync(sourcePath)) {
    warn(`reference_image in persona.yaml not found: ${sourcePath}`);
    sourcePath = null;
  }

  // Step B: Ask user if no source image configured (interactive mode)
  if (!sourcePath && !nonInteractive) {
    console.log('\n  To generate reference images, provide a clear source photo of the character.');
    console.log('  Requirements: front-facing, good lighting, no obstructions.');
    console.log('  Supported formats: PNG, JPG, JPEG, WEBP\n');
    const userPath = await ask(rl, '  Source image path (press Enter to skip): ');
    const trimmed = userPath.trim().replace(/^['"]|['"]$/g, ''); // strip quotes from drag-drop
    if (trimmed) {
      const resolved = path.resolve(trimmed);
      if (fs.existsSync(resolved)) {
        sourcePath = resolved;
      } else {
        warn(`File not found: ${resolved}`);
      }
    }
  }

  if (!sourcePath) {
    warn('Skipping reference image generation.');
    console.log('  You can set up references later:');
    console.log('    alive --setup-references --persona <path/to/persona.yaml>');
    console.log('  Or manually place images in:');
    console.log(`    ${referencesDir}/`);
    console.log(`    Required files: ${REFERENCE_FILES.join(', ')}`);
    return false;
  }

  // Step C: Copy source to references dir as source.png
  fs.mkdirSync(referencesDir, { recursive: true });
  const sourceBackup = path.join(referencesDir, 'source' + path.extname(sourcePath));
  fs.copyFileSync(sourcePath, sourceBackup);
  ok(`Source image saved: ${sourceBackup}`);

  // Step D: Check if API keys are available
  const mergedEnv = { ...process.env, ...env };
  const hasAIHubMix = !!mergedEnv.AIHUBMIX_API_KEY;
  const hasFal = !!mergedEnv.FAL_KEY;

  if (!hasAIHubMix && !hasFal) {
    warn('No image generation API key configured (AIHUBMIX_API_KEY or FAL_KEY).');
    console.log('  Source image saved. Generate references later:');
    console.log('    alive --setup-references --persona <path/to/persona.yaml>');
    return false;
  }

  // Step E: Generate multi-angle references
  log('Generating multi-angle reference images (this may take a few minutes)...');
  const success = runGenerateReferences(sourceBackup, referencesDir, env);

  if (success) {
    const after = checkReferenceImages(referencesDir);
    ok(`Reference images ready: ${after.existing}/${after.total}`);
    if (after.missing.length > 0) {
      warn(`Still missing: ${after.missing.join(', ')} — you can re-run --setup-references`);
    }
    return after.existing > 0;
  }

  warn('Reference generation had errors. You can retry later:');
  console.log('    alive --setup-references --persona <path/to/persona.yaml>');
  return false;
}

/**
 * Write (or replace) the alive soul section in SOUL.md.
 * Reads templates/soul-injection.md, injects persona fields, writes to SOUL.md.
 */
function writeSoulSection(persona) {
  const skillSlug = 'alive';
  const personaId = (persona.meta.id || (persona.meta.name_reading || persona.meta.name)).toLowerCase().replace(/\s+/g, '-');
  const marker = `<!-- ${skillSlug}-soul-start -->`;
  const markerEnd = `<!-- ${skillSlug}-soul-end -->`;
  const personaName = persona.meta.name;

  // Read soul-injection.md template
  const templatePath = path.join(TEMPLATES_DIR, 'soul-injection.md');
  if (!fs.existsSync(templatePath)) {
    warn(`soul-injection.md not found at ${templatePath} — skipping soul injection`);
    return;
  }
  let template = fs.readFileSync(templatePath, 'utf8');

  // Strip YAML frontmatter (--- ... ---)
  template = template.replace(/^---[\s\S]*?---\n*/, '');

  // Inject persona placeholders
  template = injectPersonaTemplate(template, persona);

  const section = [
    '',
    marker,
    template.trim(),
    markerEnd,
    '',
  ].join('\n');

  if (!fs.existsSync(SOUL_FILE)) {
    warn('SOUL.md not found — skipping soul injection');
    return;
  }

  let soul = fs.readFileSync(SOUL_FILE, 'utf8');

  // Remove old section if present (safe regex escape)
  if (soul.includes(marker)) {
    const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedMarkerEnd = markerEnd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    soul = soul.replace(new RegExp(`\n*${escapedMarker}[\\s\\S]*?${escapedMarkerEnd}\n*`), '\n');
  }

  // Append new section
  soul = soul.trimEnd() + '\n' + section;
  fs.writeFileSync(SOUL_FILE, soul);
  ok(`SOUL.md updated with ${personaName} identity (${personaId}) from soul-injection.md`);
}

/**
 * Lightweight persona template injection for CLI context (pure JS, no TS imports).
 * Mirrors the replace logic from persona-loader.ts injectPersona().
 */
function injectPersonaTemplate(template, p) {
  const behaviorsTable = generateBehaviorsTableCLI(p);
  const sampleLinesFormatted = (p.voice?.sample_lines || []).map(s => `- 「${s}」`).join('\n');
  const mixedLanguagesTable = generateMixedLanguagesTableCLI(p);
  // Consistent with personaSlug generation: id OR name_reading OR name
  const personaId = (p.meta.id || (p.meta.name_reading || p.meta.name)).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');

  // conversation style
  const convStyle = p.conversation_style || { mode: 'balanced', traits: [] };
  const modeDescriptions = {
    'topic-driver': '你主导对话。对方说什么，你先用自己的经历和见解去接，然后自然展开。不要被动等问题。',
    'responsive': '你认真听，想好了再说。不急着接话，但说出来的有分量。',
    'balanced': '自然聊天。有话说就说，没话说不硬聊。',
  };
  let convDescription = modeDescriptions[convStyle.mode] || modeDescriptions['balanced'];
  if (convStyle.traits && convStyle.traits.length) {
    convDescription += '\n\n对话习惯：\n' + convStyle.traits.map(t => `- ${t}`).join('\n');
  }
  if (convStyle.anti_patterns && convStyle.anti_patterns.length) {
    convDescription += '\n\n对话禁忌：\n' + convStyle.anti_patterns.map(t => `- ${t}`).join('\n');
  }

  // banned expressions
  const bannedExpressionsFormatted = (p.voice?.banned_expressions || []).map(e => `- "${e}"`).join('\n');

  // conversation examples
  const convExamples = p.voice?.conversation_examples || [];
  const convExamplesFormatted = convExamples.map(e =>
    `**场景：** ${e.context}\n✗ "${e.bad}"\n✓ "${e.good}"`
  ).join('\n\n');

  // session greeting examples
  const sessionGreetingExamples = (p.voice?.session_greeting_examples || '').trim();

  return template
    .replace(/{persona\.meta\.name}/g, p.meta.name || '')
    .replace(/{persona\.meta\.name_reading}/g, p.meta.name_reading || p.meta.name || '')
    .replace(/{persona\.meta\.age}/g, String(p.meta.age ?? ''))
    .replace(/{persona\.meta\.tagline}/g, p.meta.tagline || '')
    .replace(/{persona\.meta\.id}/g, personaId)
    .replace(/{persona\.personality\.core_traits}/g, (p.personality?.core_traits || []).join('、'))
    .replace(/{persona\.personality\.quirks}/g, (p.personality?.quirks || []).join('、'))
    .replace(/{persona\.personality\.values}/g, (p.personality?.values || []).join('、'))
    .replace(/{persona\.personality\.mbti}/g, p.personality?.mbti || '')
    .replace(/{persona\.personality\.description}/g, (p.personality?.description || '').trim())
    .replace(/{persona\.intimacy\.levels}/g, String(p.intimacy?.levels ?? 5))
    .replace(/{persona\.intimacy\.behaviors_table}/g, behaviorsTable)
    .replace(/{persona\.schedule\.wake_hour}/g, String(p.schedule?.wake_hour ?? 8))
    .replace(/{persona\.schedule\.sleep_hour}/g, String(p.schedule?.sleep_hour ?? 23))
    .replace(/{persona\.schedule\.time_descriptions}/g, (p.schedule?.time_descriptions || '').trim())
    .replace(/{persona\.voice\.style_description}/g, p.voice?.style_description || p.voice?.style || '')
    .replace(/{persona\.voice\.language_description}/g, p.voice?.language_description || `${p.voice?.language || 'zh-CN'} 为主`)
    .replace(/{persona\.voice\.mixed_languages_table}/g, mixedLanguagesTable)
    .replace(/{persona\.voice\.sample_lines_formatted}/g, sampleLinesFormatted)
    .replace(/{persona\.conversation_style\.description}/g, convDescription)
    .replace(/{persona\.conversation_style\.mode}/g, convStyle.mode)
    .replace(/{persona\.voice\.banned_expressions_formatted}/g, bannedExpressionsFormatted)
    .replace(/{persona\.voice\.conversation_examples_formatted}/g, convExamplesFormatted)
    .replace(/{persona\.voice\.session_greeting_examples}/g, sessionGreetingExamples);
}

function generateBehaviorsTableCLI(p) {
  const behaviors = p.intimacy?.behaviors;
  if (!behaviors || Object.keys(behaviors).length === 0) return '';
  const rows = Object.entries(behaviors)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([level, desc]) => `| ${level} | ${desc} |`);
  return `| 等级 | 行为变化 |\n|------|---------|\n${rows.join('\n')}`;
}

function generateMixedLanguagesTableCLI(p) {
  if (!p.voice?.mixed_languages) return '';
  const rows = [];
  for (const [, words] of Object.entries(p.voice.mixed_languages)) {
    for (const word of words) {
      rows.push(`| ${word} | 常用 |`);
    }
  }
  if (rows.length === 0) return '';
  return `| 词 | 使用场景 |\n|-----|---------|\n${rows.join('\n')}`;
}

// ═══════════════════════════════════════════════
// Alive Framework — Generic Persona Installer
// ═══════════════════════════════════════════════

/**
 * Scan the built-in personas/ directory and return parsed persona summaries.
 */
function listBuiltinPersonas() {
  if (!fs.existsSync(PERSONAS_DIR)) return [];
  const personas = [];
  for (const file of fs.readdirSync(PERSONAS_DIR)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    const filePath = path.join(PERSONAS_DIR, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = YAML.parse(raw);
      if (parsed?.meta?.name) {
        personas.push({
          file,
          path: filePath,
          name: parsed.meta.name,
          nameReading: parsed.meta.name_reading || '',
          tagline: parsed.meta.tagline || '',
          mbti: parsed.personality?.mbti || '',
          traits: (parsed.personality?.core_traits || []).slice(0, 3),
          language: parsed.voice?.language || '',
        });
      }
    } catch { /* skip malformed files */ }
  }
  return personas;
}

/**
 * Interactive persona selection — beautiful CLI menu.
 * Returns the resolved path to the selected persona YAML, or null if cancelled.
 */
async function selectPersonaInteractive(rl) {
  const personas = listBuiltinPersonas();
  if (personas.length === 0) {
    console.error('  ✗ No built-in personas found in alive/personas/');
    console.error('    Use: alive --persona <path/to/persona.yaml>');
    return null;
  }

  console.log('  ╭─────────────────────────────────────────────╮');
  console.log('  │         🌟 Alive — Choose Your Persona       │');
  console.log('  ╰─────────────────────────────────────────────╯\n');

  for (let i = 0; i < personas.length; i++) {
    const p = personas[i];
    const num = `  ${i + 1}`.slice(-3);
    const traitsStr = p.traits.length > 0 ? p.traits.join(' · ') : '';
    const mbtiTag = p.mbti ? `[${p.mbti}]` : '';

    console.log(`  ${num}. ${p.name}${p.nameReading ? ` (${p.nameReading})` : ''}  ${mbtiTag}`);
    if (p.tagline) console.log(`      ${p.tagline}`);
    if (traitsStr) console.log(`      ✦ ${traitsStr}`);
    console.log('');
  }

  console.log(`    0. Cancel — I'll provide my own persona.yaml\n`);

  const answer = await ask(rl, `  Select [1-${personas.length}]: `);
  const choice = parseInt(answer.trim(), 10);

  if (isNaN(choice) || choice === 0) {
    console.log('\n  Cancelled. Use: alive --persona <path/to/persona.yaml>\n');
    return null;
  }

  if (choice < 1 || choice > personas.length) {
    console.log('\n  Invalid selection.\n');
    return null;
  }

  const selected = personas[choice - 1];
  console.log(`\n  ✓ Selected: ${selected.name}${selected.nameReading ? ` (${selected.nameReading})` : ''}\n`);
  return selected.path;
}

function getPersonaArg() {
  const idx = args.indexOf('--persona');
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

/**
 * Parse a persona YAML file.
 * Returns the parsed object or exits with an error.
 */
function parsePersonaFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return YAML.parse(raw);
}

/**
 * Copy persona YAML file into skill directory as persona.yaml.
 * This is the canonical persona config used at runtime.
 */
function installPersonaConfig(resolvedPersonaPath, skillDest) {
  fs.copyFileSync(resolvedPersonaPath, path.join(skillDest, 'persona.yaml'));
}

async function install() {
  console.log('\n  Alive Framework — Install Digital Life Persona');
  console.log('  ===============================================\n');

  // Step 0: Load .env file (before anything else)
  const envVars = autoLoadEnvFile();

  // Step 1: Load persona config (needed for preflight to know if ops is enabled)
  log('Step 1/8: Loading persona configuration...');
  let personaPath = getPersonaArg();
  let resolvedPersonaPath;

  if (!personaPath) {
    // No --persona flag: enter interactive selection
    const rl0 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const selectedPath = await selectPersonaInteractive(rl0);
    rl0.close();

    if (!selectedPath) {
      process.exit(0);
    }
    resolvedPersonaPath = selectedPath;
  } else {
    resolvedPersonaPath = path.resolve(personaPath);
  }

  if (!fs.existsSync(resolvedPersonaPath)) {
    console.error(`  ✗ Persona file not found: ${resolvedPersonaPath}`);
    process.exit(1);
  }

  let persona;
  try {
    persona = parsePersonaFile(resolvedPersonaPath);
  } catch (err) {
    console.error(`  ✗ Could not parse persona file: ${err.message}`);
    process.exit(1);
  }

  const personaName = persona.meta && persona.meta.name;
  if (!personaName) {
    console.error('  ✗ Persona file missing meta.name field.');
    process.exit(1);
  }

  const personaSlug = (persona.meta.id || personaName).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  const skillSlug = 'alive';
  ok(`Persona: ${personaName} (persona: ${personaSlug}, skill: ${skillSlug})`);

  // Step 1.5: Preflight dependency check — MUST pass before continuing
  const opsEnabled = !!(persona.ops && persona.ops.enabled);
  preflightCheck({ opsEnabled });

  const skillDest = path.join(SKILLS_DIR, skillSlug);
  const memoryDir = path.join(WORKSPACE_DIR, 'memory', personaSlug);

  // Step 2: Build TypeScript → dist-alive (ensures JS is up-to-date)
  log('Step 2/8: Building TypeScript...');
  const tsconfig = path.join(__dirname, '..', 'tsconfig.alive.json');
  if (fs.existsSync(tsconfig)) {
    try {
      execSync('npx tsc -p tsconfig.alive.json', {
        cwd: path.join(__dirname, '..'),
        stdio: 'pipe',
        timeout: 60000,
      });
      ok('TypeScript compiled successfully');
    } catch (err) {
      warn(`TypeScript compilation failed: ${err.stderr?.toString().slice(0, 200) || err.message}`);
      warn('Continuing — runtime may fail if .js files are missing in dist-alive/');
    }
  } else {
    warn('tsconfig.alive.json not found — skipping build');
  }

  // Step 3: Copy alive framework files
  log('Step 3/8: Installing alive framework files...');
  if (fs.existsSync(skillDest)) {
    warn(`Existing skill found at ${skillDest} — overwriting`);
  }
  copyDirRecursive(ALIVE_SRC, skillDest);
  if (fs.existsSync(DIST_SRC)) {
    copyBuiltScripts(DIST_SRC, skillDest);
  }
  // Copy persona config into BOTH skill directory (legacy compat) and memory directory (per-persona)
  installPersonaConfig(resolvedPersonaPath, skillDest);
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.copyFileSync(resolvedPersonaPath, path.join(memoryDir, 'persona.yaml'));
  ok(`Alive framework copied to ${skillDest}`);
  ok(`Persona config copied to ${path.join(memoryDir, 'persona.yaml')}`);

  // Initialize competitor profiles markdown from persona config
  try {
    const { initProfilesFromPersona } = require(path.join(skillDest, 'scripts', 'ops', 'competitor-memory.js'));
    const { setBasePaths } = require(path.join(skillDest, 'scripts', 'utils', 'file-utils.js'));
    setBasePaths(memoryDir, skillDest);
    if (persona.ops?.competitors?.length) {
      initProfilesFromPersona(persona.ops.competitors);
      ok(`Initialized ${persona.ops.competitors.length} competitor profile docs`);
    }
  } catch (err) {
    // Non-fatal: profiles will be initialized on first ops-trends run if build exists
    warn(`Could not initialize competitor profiles: ${err.message}`);
  }

  // Step 4: Register in OpenClaw config
  log('Step 4/8: Registering skill in OpenClaw config...');

  // Load any existing env keys so we can preserve them if the user presses Enter
  let existingEnv = {};
  let config = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      existingEnv = config.skills?.entries?.[skillSlug]?.env || {};
      const keyCount = Object.keys(existingEnv).length;
      if (keyCount > 0) {
        ok(`Found ${keyCount} existing env keys (press Enter to keep each one)`);
      }
    } catch { /* fresh config */ }
  }

  // Determine env values: .env file > existing config > interactive prompt
  // If .env file provided required keys, skip interactive prompts entirely
  const envFromFile = envVars;
  const hasEnvFile = Object.keys(envFromFile).length > 0;

  let llmApiKey, llmApiBase, llmModel, imageApiKey;

  if (hasEnvFile && (envFromFile.LLM_API_KEY || existingEnv.LLM_API_KEY)) {
    // Non-interactive: use .env values, falling back to existing config
    llmApiKey = envFromFile.LLM_API_KEY || '';
    llmApiBase = envFromFile.LLM_API_BASE || '';
    llmModel = envFromFile.LLM_MODEL || '';
    imageApiKey = envFromFile.AIHUBMIX_API_KEY || '';
    ok('Using env from .env file (non-interactive mode)');
    if (llmApiKey) ok(`LLM_API_KEY: ${maskSecret(llmApiKey || existingEnv.LLM_API_KEY)}`);
    if (llmApiBase || existingEnv.LLM_API_BASE) ok(`LLM_API_BASE: ${llmApiBase || existingEnv.LLM_API_BASE}`);
    if (llmModel || existingEnv.LLM_MODEL) ok(`LLM_MODEL: ${llmModel || existingEnv.LLM_MODEL}`);
  } else {
    // Interactive mode: prompt for each key
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const hintLlmKey = maskSecret(existingEnv.LLM_API_KEY);
    const hintBase = existingEnv.LLM_API_BASE || '';
    const hintModel = existingEnv.LLM_MODEL || '';
    const hintImageKey = maskSecret(existingEnv.AIHUBMIX_API_KEY);

    console.log('\n  Optional: Configure LLM for heartbeat/reflection calls:');
    llmApiKey = await ask(rl, hintLlmKey
      ? `  LLM_API_KEY (current: ${hintLlmKey}, Enter to keep): `
      : '  LLM_API_KEY (press Enter to skip): ');
    llmApiBase = await ask(rl, hintBase
      ? `  LLM_API_BASE (current: ${hintBase}, Enter to keep): `
      : '  LLM_API_BASE (default: https://aihubmix.com/v1): ');
    llmModel = await ask(rl, hintModel
      ? `  LLM_MODEL (current: ${hintModel}, Enter to keep): `
      : '  LLM_MODEL (default: claude-sonnet-4-20250514): ');

    console.log('\n  Optional: Configure image generation API key (for reference image generation):');
    imageApiKey = await ask(rl, hintImageKey
      ? `  AIHUBMIX_API_KEY (current: ${hintImageKey}, Enter to keep): `
      : '  AIHUBMIX_API_KEY (press Enter to skip): ');

    rl.close();
  }

  config.skills = config.skills || {};
  config.skills.entries = config.skills.entries || {};

  config.skills.entries[skillSlug] = {
    enabled: true,
    env: {
      ...existingEnv,
      ...(llmApiKey && { LLM_API_KEY: llmApiKey }),
      ...(llmApiBase && { LLM_API_BASE: llmApiBase }),
      ...(llmModel && { LLM_MODEL: llmModel }),
      ...(imageApiKey && { AIHUBMIX_API_KEY: imageApiKey }),
      ALIVE_PERSONA: personaSlug,
    },
  };

  // Clean up legacy keys that are no longer recognized by OpenClaw
  delete config.skills.allow;
  delete config.skills.installs;

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  ok('openclaw.json updated (entries)');

  // Step 5: Setup reference images
  log('Step 5/8: Setting up reference images for AI image generation...');
  const envForRefs = {
    ...(imageApiKey && { AIHUBMIX_API_KEY: imageApiKey }),
  };
  const rlForRefs = hasEnvFile ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  await setupReferenceImages({
    persona,
    personaYamlDir: path.dirname(resolvedPersonaPath),
    skillDest,
    memoryDir,
    rl: rlForRefs,
    env: envForRefs,
    nonInteractive: hasEnvFile,
  });
  if (rlForRefs) rlForRefs.close();

  // Step 6: Initialize memory
  log('Step 6/8: Setting up memory directories...');
  fs.mkdirSync(path.join(memoryDir, 'relations', 'social'), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);

  const filesToInit = [
    ['diary.md', `# ${personaName}的日记\n\n## ${today}\n\n今天是第一天。一切都是新的开始。\n`],
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

  // Step 7: Install external ClawHub skill dependencies (if ops enabled)
  if (persona.ops && persona.ops.enabled) {
    log('Step 7/8: Installing ClawHub skill dependencies for ops...');
    installRequiredClawHubSkills();
  }

  // Step 7b: Setup Python platform bridge skills (XHS + Douyin CDP)
  if (persona.ops && persona.ops.enabled) {
    log('Step 7b: Checking Python platform bridge skills (XHS / Douyin)...');
    setupPlatformBridgeSkills(/* nonInteractive= */ true);
  }

  // Step 8: Register cron (if OpenClaw CLI available)
  log(`Step ${persona.ops && persona.ops.enabled ? '8/8' : '7/7'}: Registering heartbeat cron jobs...`);
  if (isOpenClawCLIAvailable()) {
    const specs = buildCronSpecs({ persona, skillSlug, personaSlug, personaName });
    reconcileCronJobs({ specs, skillSlug, personaSlug });
  } else {
    warn('OpenClaw CLI not found — skipping cron registration.');
  }

  // Step 8: Install alive-admin plugin
  log('Step 8: Installing alive-admin plugin...');
  if (isOpenClawCLIAvailable()) {
    const pluginDir = path.join(skillDest, 'plugin');
    if (fs.existsSync(pluginDir)) {
      try {
        // Remove existing plugin to avoid "plugin already exists" error
        const existingPluginDir = path.join(OPENCLAW_DIR, 'extensions', 'alive-admin');
        if (fs.existsSync(existingPluginDir)) {
          try { execSync('openclaw plugins uninstall alive-admin', { stdio: 'ignore', timeout: 10000 }); } catch { /* ignore */ }
          // If uninstall didn't remove it, force-remove the directory
          if (fs.existsSync(existingPluginDir)) {
            fs.rmSync(existingPluginDir, { recursive: true, force: true });
          }
        }
        execFileSync('openclaw', ['plugins', 'install', '--link', pluginDir], {
          timeout: 15000, encoding: 'utf8', stdio: 'pipe',
        });
        ok('alive-admin plugin installed');
      } catch (err) {
        warn(`Failed to install alive-admin plugin: ${err.message}`);
        warn('You can install it manually: openclaw plugins install --link ~/.openclaw/skills/alive/plugin');
      }
    } else {
      warn('Plugin directory not found — skipping plugin install');
    }
  }

  // Write persona identity to SOUL.md
  writeSoulSection(persona);

  log('Installation complete!\n');
  console.log(`  ${personaName} is ready. Start OpenClaw to begin.\n`);
  console.log(`  Tips:`);
  console.log(`  - Just chat naturally. ${personaName} will remember you.`);
  console.log(`  - Memory lives at: ${memoryDir}`);
  console.log(`  - Persona config: ${path.join(memoryDir, 'persona.yaml')}`);
  console.log(`  - Switch persona: alive --switch-persona --persona <path>`);
  console.log('');
}

async function uninstall() {
  console.log('\n  Alive Framework — Uninstall');
  console.log('  ============================\n');

  const personaPath = getPersonaArg();
  if (!personaPath) {
    console.error('  ✗ No persona file specified.');
    console.error('    Usage: alive --uninstall --persona <path/to/persona.yaml>');
    process.exit(1);
  }

  let persona;
  try {
    persona = parsePersonaFile(path.resolve(personaPath));
  } catch (err) {
    console.error(`  ✗ Could not parse persona file: ${err.message}`);
    process.exit(1);
  }

  const personaName = persona.meta?.name;
  const personaSlug = (persona.meta?.id || personaName || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  const skillSlug = 'alive';
  if (!personaSlug) {
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
  const memoryDir = path.join(WORKSPACE_DIR, 'memory', personaSlug);

  log('Removing skill files...');
  removeDirSafe(skillDest, 'Skill directory');

  log('Removing config from openclaw.json...');
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (config.skills?.entries?.[skillSlug]) {
        delete config.skills.entries[skillSlug];
      }
      // Clean up legacy keys that are no longer recognized by OpenClaw
      if (config.skills) { delete config.skills.allow; delete config.skills.installs; }
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
      ok(`Removed ${skillSlug} from openclaw.json (entries)`);
    } catch {
      warn('Could not parse openclaw.json — skipped');
    }
  }

  log('Removing cron jobs...');
  if (isOpenClawCLIAvailable()) {
    const allJobs = listCronJobs();
    // Only remove jobs for this specific persona prefix (not all alive:* jobs)
    const toRemove = allJobs.filter(j => {
      const name = String(j.name || '');
      return name.startsWith(`${skillSlug}:${personaSlug}:`);
    });
    for (const job of toRemove) {
      try {
        execFileSync('openclaw', ['cron', 'remove', job.id], { timeout: 10000, encoding: 'utf8', stdio: 'pipe' });
        ok(`Removed cron: ${job.name}`);
      } catch { /* may already be gone */ }
    }
  }

  // Remove alive-admin plugin
  if (isOpenClawCLIAvailable()) {
    try {
      execSync('openclaw plugins uninstall alive-admin', { stdio: 'ignore' });
      ok('Removed alive-admin plugin');
    } catch {
      // Plugin may not be installed; ignore
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

async function update() {
  console.log('\n  Alive Framework — Update (code-only, preserves memory & config)');
  console.log('  ================================================================\n');

  // Step 1: Verify OpenClaw
  log('Step 1/3: Verifying OpenClaw installation...');
  if (!fs.existsSync(OPENCLAW_DIR)) {
    console.error('  ✗ OpenClaw not found at ~/.openclaw');
    console.error('    Install OpenClaw first: https://openclaw.ai');
    process.exit(1);
  }
  ok('OpenClaw found');

  // Step 2: Load persona config
  log('Step 2/3: Loading persona configuration...');
  const personaPath = getPersonaArg();
  if (!personaPath) {
    console.error('  ✗ No persona file specified.');
    console.error('    Usage: alive --update --persona <path/to/persona.yaml>');
    process.exit(1);
  }

  const resolvedPersonaPath = path.resolve(personaPath);
  if (!fs.existsSync(resolvedPersonaPath)) {
    console.error(`  ✗ Persona file not found: ${resolvedPersonaPath}`);
    process.exit(1);
  }

  let persona;
  try {
    persona = parsePersonaFile(resolvedPersonaPath);
  } catch (err) {
    console.error(`  ✗ Could not parse persona file: ${err.message}`);
    process.exit(1);
  }

  const personaName = persona.meta?.name;
  if (!personaName) {
    console.error('  ✗ Persona file missing meta.name field.');
    process.exit(1);
  }

  const skillSlug = 'alive';
  const skillDest = path.join(SKILLS_DIR, skillSlug);

  if (!fs.existsSync(skillDest)) {
    console.error(`  ✗ Skill not found at ${skillDest}`);
    console.error('    Run a full install first: alive --persona <path/to/persona.yaml>');
    process.exit(1);
  }
  ok(`Persona: ${personaName} (skill: ${skillSlug})`);

  // Step 3: Build TypeScript → dist-alive (ensures JS is up-to-date)
  log('Step 3/4: Building TypeScript...');
  const tsconfig = path.join(__dirname, '..', 'tsconfig.alive.json');
  if (fs.existsSync(tsconfig)) {
    try {
      execSync('npx tsc -p tsconfig.alive.json', {
        cwd: path.join(__dirname, '..'),
        stdio: 'pipe',
        timeout: 60000,
      });
      ok('TypeScript compiled successfully');
    } catch (err) {
      warn(`TypeScript compilation failed: ${err.message}`);
      warn('Continuing with existing dist-alive/ (may be stale)');
    }
  } else {
    warn('tsconfig.alive.json not found — skipping build');
  }

  // Step 4: Update framework files only (preserves memory, config, cron)
  log('Step 4/4: Updating alive framework files...');

  // Remove old skill files but preserve persona.yaml first
  // Overwrite framework files
  copyDirRecursive(ALIVE_SRC, skillDest);
  if (fs.existsSync(DIST_SRC)) {
    copyBuiltScripts(DIST_SRC, skillDest);
  }
  // Always update persona config from source as persona.yaml
  installPersonaConfig(resolvedPersonaPath, skillDest);
  ok(`Framework files updated at ${skillDest}`);

  // Refresh SOUL.md with latest soul-injection.md template
  writeSoulSection(persona);

  log('Update complete!\n');
  console.log(`  ${personaName} code updated. Memory, config, and cron jobs are untouched.\n`);
}

async function reinstall() {
  console.log('\n  Alive Framework — Reinstall (full clean + fresh install)');
  console.log('  ========================================================\n');

  // Step 1: Load persona config
  log('Step 1/9: Loading persona configuration...');
  const personaPath = getPersonaArg();
  if (!personaPath) {
    console.error('  ✗ No persona file specified.');
    console.error('    Usage: alive --reinstall --persona <path/to/persona.yaml>');
    process.exit(1);
  }

  const resolvedPersonaPath = path.resolve(personaPath);
  if (!fs.existsSync(resolvedPersonaPath)) {
    console.error(`  ✗ Persona file not found: ${resolvedPersonaPath}`);
    process.exit(1);
  }

  let persona;
  try {
    persona = parsePersonaFile(resolvedPersonaPath);
  } catch (err) {
    console.error(`  ✗ Could not parse persona file: ${err.message}`);
    process.exit(1);
  }

  const personaName = persona.meta?.name;
  if (!personaName) {
    console.error('  ✗ Persona file missing meta.name field.');
    process.exit(1);
  }

  const personaSlug = (persona.meta.id || personaName).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  const skillSlug = 'alive';
  ok(`Persona: ${personaName} (persona: ${personaSlug}, skill: ${skillSlug})`);

  // Capture existing env keys before we wipe the config entry
  let capturedEnv = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      capturedEnv = cfg.skills?.entries?.[skillSlug]?.env || {};
      const keyCount = Object.keys(capturedEnv).length;
      if (keyCount > 0) {
        ok(`Found ${keyCount} existing env keys — will offer to keep them after reinstall`);
      }
    } catch { /* ignore */ }
  }

  const skillDest = path.join(SKILLS_DIR, skillSlug);
  const memoryDir = path.join(WORKSPACE_DIR, 'memory', personaSlug);

  // Confirm
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await ask(rl, `  ⚠ This will WIPE all memory, config, and cron for ${personaName} and reinstall from scratch.\n    Continue? (y/N): `);
  if (answer.trim().toLowerCase() !== 'y') {
    console.log('\n  Cancelled.\n');
    rl.close();
    process.exit(0);
  }

  // Step 2: Remove old skill files
  log('Step 2/9: Removing old skill files...');
  removeDirSafe(skillDest, 'Skill directory');

  // Step 3: Remove old memory
  log('Step 3/9: Clearing memory data...');
  removeDirSafe(memoryDir, 'Memory data');

  // Step 4: Remove old config entry
  log('Step 4/9: Removing old config entry...');
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

  // Step 5: Remove old cron jobs & clean SOUL.md
  log('Step 5/9: Removing old cron jobs & cleaning SOUL.md...');
  if (isOpenClawCLIAvailable()) {
    const allJobs = listCronJobs();
    // Only remove jobs for this specific persona prefix (not all alive:* jobs)
    const toRemove = allJobs.filter(j => {
      const name = String(j.name || '');
      return name.startsWith(`${skillSlug}:${personaSlug}:`);
    });
    for (const job of toRemove) {
      try {
        execFileSync('openclaw', ['cron', 'remove', job.id], { timeout: 10000, encoding: 'utf8', stdio: 'pipe' });
        ok(`Removed cron: ${job.name}`);
      } catch { /* may already be gone */ }
    }
  } else {
    warn('OpenClaw CLI not found — skipping cron removal.');
  }

  // Clean SOUL.md
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

  // ─── Fresh install begins ───

  // Step 5.5: Build TypeScript → dist-alive (ensures JS is up-to-date)
  log('Step 5.5/9: Building TypeScript...');
  const tsconfig = path.join(__dirname, '..', 'tsconfig.alive.json');
  if (fs.existsSync(tsconfig)) {
    try {
      execSync('npx tsc -p tsconfig.alive.json', {
        cwd: path.join(__dirname, '..'),
        stdio: 'pipe',
        timeout: 60000,
      });
      ok('TypeScript compiled successfully');
    } catch (err) {
      warn(`TypeScript compilation failed: ${err.stderr?.toString().slice(0, 200) || err.message}`);
      warn('Continuing — runtime may fail if .js files are missing in dist-alive/');
    }
  } else {
    warn('tsconfig.alive.json not found — skipping build');
  }

  // Step 6: Install framework files
  log('Step 6/9: Installing alive framework files...');
  copyDirRecursive(ALIVE_SRC, skillDest);
  if (fs.existsSync(DIST_SRC)) {
    copyBuiltScripts(DIST_SRC, skillDest);
  }
  installPersonaConfig(resolvedPersonaPath, skillDest);
  // Also copy to memory directory for per-persona isolation
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.copyFileSync(resolvedPersonaPath, path.join(memoryDir, 'persona.yaml'));
  ok(`Alive framework copied to ${skillDest}`);
  ok(`Persona config copied to ${path.join(memoryDir, 'persona.yaml')}`);

  // Step 7: Register in OpenClaw config
  log('Step 7/9: Registering skill in OpenClaw config...');

  const hintLlmKey = maskSecret(capturedEnv.LLM_API_KEY);
  const hintBase = capturedEnv.LLM_API_BASE || '';
  const hintModel = capturedEnv.LLM_MODEL || '';
  const hintImageKey = maskSecret(capturedEnv.AIHUBMIX_API_KEY);

  console.log('\n  Optional: Configure LLM for heartbeat/reflection calls:');
  const llmApiKey = await ask(rl, hintLlmKey
    ? `  LLM_API_KEY (current: ${hintLlmKey}, Enter to keep): `
    : '  LLM_API_KEY (press Enter to skip): ');
  const llmApiBase = await ask(rl, hintBase
    ? `  LLM_API_BASE (current: ${hintBase}, Enter to keep): `
    : '  LLM_API_BASE (default: https://aihubmix.com/v1): ');
  const llmModel = await ask(rl, hintModel
    ? `  LLM_MODEL (current: ${hintModel}, Enter to keep): `
    : '  LLM_MODEL (default: claude-sonnet-4-20250514): ');

  console.log('\n  Optional: Configure image generation API key (for reference image generation):');
  const imageApiKey = await ask(rl, hintImageKey
    ? `  AIHUBMIX_API_KEY (current: ${hintImageKey}, Enter to keep): `
    : '  AIHUBMIX_API_KEY (press Enter to skip): ');

  let config = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* fresh */ }
  }
  config.skills = config.skills || {};
  config.skills.entries = config.skills.entries || {};
  config.skills.entries[skillSlug] = {
    enabled: true,
    env: {
      ...capturedEnv,
      ...(llmApiKey && { LLM_API_KEY: llmApiKey }),
      ...(llmApiBase && { LLM_API_BASE: llmApiBase }),
      ...(llmModel && { LLM_MODEL: llmModel }),
      ...(imageApiKey && { AIHUBMIX_API_KEY: imageApiKey }),
      ALIVE_PERSONA: personaSlug,
    },
  };
  // Clean up legacy keys that are no longer recognized by OpenClaw
  delete config.skills.allow;
  delete config.skills.installs;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  ok('openclaw.json updated (entries)');

  // Step 8: Setup reference images
  log('Step 8/9: Setting up reference images...');
  const envForRefs = {
    ...(imageApiKey && { AIHUBMIX_API_KEY: imageApiKey }),
  };
  await setupReferenceImages({
    persona,
    personaYamlDir: path.dirname(resolvedPersonaPath),
    skillDest,
    memoryDir,
    rl,
    env: envForRefs,
  });

  // Step 9: Initialize fresh memory
  log('Step 9/9: Setting up fresh memory & cron...');
  fs.mkdirSync(path.join(memoryDir, 'relations', 'social'), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);

  const filesToInit = [
    ['diary.md', `# ${personaName}的日记\n\n## ${today}\n\n今天是第一天。一切都是新的开始。\n`],
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
    fs.writeFileSync(filePath, content); // Always overwrite — this is a fresh reinstall
  }
  ok(`Fresh memory initialized at ${memoryDir}`);

  // Register cron
  if (isOpenClawCLIAvailable()) {
    const specs = buildCronSpecs({ persona, skillSlug, personaSlug, personaName });
    reconcileCronJobs({ specs, skillSlug, personaSlug });
  } else {
    warn('OpenClaw CLI not found — skipping cron registration.');
  }

  // Install alive-admin plugin
  if (isOpenClawCLIAvailable()) {
    const pluginDir = path.join(skillDest, 'plugin');
    if (fs.existsSync(pluginDir)) {
      try {
        // Remove existing plugin to avoid "plugin already exists" error
        const existingPluginDir = path.join(OPENCLAW_DIR, 'extensions', 'alive-admin');
        if (fs.existsSync(existingPluginDir)) {
          try { execSync('openclaw plugins uninstall alive-admin', { stdio: 'ignore', timeout: 10000 }); } catch { /* ignore */ }
          if (fs.existsSync(existingPluginDir)) {
            fs.rmSync(existingPluginDir, { recursive: true, force: true });
          }
        }
        execFileSync('openclaw', ['plugins', 'install', '--link', pluginDir], {
          timeout: 15000, encoding: 'utf8', stdio: 'pipe',
        });
        ok('alive-admin plugin installed');
      } catch (err) {
        warn(`Failed to install alive-admin plugin: ${err.message}`);
        warn('You can install it manually: openclaw plugins install --link ~/.openclaw/skills/alive/plugin');
      }
    } else {
      warn('Plugin directory not found — skipping plugin install');
    }
  }

  rl.close();

  // Write persona identity to SOUL.md
  writeSoulSection(persona);

  log('Reinstall complete!\n');
  console.log(`  ${personaName} has been fully reset and reinstalled.\n`);
  console.log(`  Tips:`);
  console.log(`  - All memory has been wiped. ${personaName} starts fresh.`);
  console.log(`  - Memory lives at: ${memoryDir}`);
  console.log(`  - Persona config: ${path.join(memoryDir, 'persona.yaml')}`);
  console.log(`  - Switch persona: alive --switch-persona --persona <path>`);
  console.log('');
}

async function realDayTest() {
  console.log('\n  Alive Framework — Real Day E2E Test');
  console.log('  =====================================\n');

  // Step 1: Load persona config
  log('Step 1/5: Loading persona configuration...');
  const personaPath = getPersonaArg();
  if (!personaPath) {
    console.error('  ✗ No persona file specified.');
    console.error('    Usage: alive --real-day-test --persona <path/to/persona.yaml>');
    process.exit(1);
  }

  const resolvedPersonaPath = path.resolve(personaPath);
  if (!fs.existsSync(resolvedPersonaPath)) {
    console.error(`  ✗ Persona file not found: ${resolvedPersonaPath}`);
    process.exit(1);
  }

  let persona;
  try {
    persona = parsePersonaFile(resolvedPersonaPath);
  } catch (err) {
    console.error(`  ✗ Could not parse persona file: ${err.message}`);
    process.exit(1);
  }

  const personaName = persona.meta?.name;
  if (!personaName) {
    console.error('  ✗ Persona file missing meta.name field.');
    process.exit(1);
  }

  // Keep raw persona content in memory — the source file may live inside the
  // skill directory that we are about to delete in the uninstall step.
  const personaRawContent = fs.readFileSync(resolvedPersonaPath, 'utf8');

  const personaSlug = (persona.meta.id || personaName).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  const skillSlug = 'alive';
  ok(`Persona: ${personaName} (persona: ${personaSlug}, skill: ${skillSlug})`);

  const skillDest = path.join(SKILLS_DIR, skillSlug);
  const memoryDir = path.join(WORKSPACE_DIR, 'memory', personaSlug);

  // Step 2: Check if existing config has env keys — preserve them
  log('Step 2/5: Loading existing API keys from openclaw.json...');
  let existingEnv = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      existingEnv = config.skills?.entries?.[skillSlug]?.env || {};
      const keyCount = Object.keys(existingEnv).length;
      if (keyCount > 0) {
        ok(`Found ${keyCount} existing env keys (will preserve them)`);
      } else {
        warn('No existing env keys found — you may need to configure them first');
      }
    } catch {
      warn('Could not parse openclaw.json');
    }
  }

  // Step 3: Uninstall existing skill (non-interactive)
  log('Step 3/5: Uninstalling existing skill (non-interactive)...');
  if (fs.existsSync(skillDest)) {
    removeDirSafe(skillDest, 'Skill directory');
  } else {
    warn('No existing skill directory found');
  }
  if (fs.existsSync(memoryDir)) {
    removeDirSafe(memoryDir, 'Memory data');
  }
  // Remove cron jobs for this persona only (not all alive:* jobs)
  if (isOpenClawCLIAvailable()) {
    const allJobs = listCronJobs();
    const toRemove = allJobs.filter(j => {
      const name = String(j.name || '');
      return name.startsWith(`${skillSlug}:${personaSlug}:`);
    });
    for (const job of toRemove) {
      try {
        execFileSync('openclaw', ['cron', 'remove', job.id], { timeout: 10000, encoding: 'utf8', stdio: 'pipe' });
      } catch { /* may already be gone */ }
    }
  }
  // Clean SOUL.md
  if (fs.existsSync(SOUL_FILE)) {
    let soul = fs.readFileSync(SOUL_FILE, 'utf8');
    const marker = `<!-- ${skillSlug}-soul-start -->`;
    const markerEnd = `<!-- ${skillSlug}-soul-end -->`;
    if (soul.includes(marker)) {
      soul = soul.replace(new RegExp(`\n*${marker}[\\s\\S]*?${markerEnd}\n*`), '\n');
      fs.writeFileSync(SOUL_FILE, soul);
    }
  }
  ok('Old installation cleaned');

  // Step 4: Fresh install (non-interactive — reuse existing env keys)
  log('Step 4/5: Building and installing (non-interactive)...');
  const tsconfig3 = path.join(__dirname, '..', 'tsconfig.alive.json');
  if (fs.existsSync(tsconfig3)) {
    try {
      execSync('npx tsc -p tsconfig.alive.json', { cwd: path.join(__dirname, '..'), stdio: 'pipe', timeout: 60000 });
      ok('TypeScript compiled');
    } catch { warn('TypeScript compilation failed — continuing with existing dist'); }
  }

  // Copy alive framework files
  copyDirRecursive(ALIVE_SRC, skillDest);
  if (fs.existsSync(DIST_SRC)) {
    copyBuiltScripts(DIST_SRC, path.join(skillDest, 'scripts'));
  }
  // Write persona as persona.yaml (canonical format) to both skill and memory dirs
  fs.writeFileSync(path.join(skillDest, 'persona.yaml'), personaRawContent);
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'persona.yaml'), personaRawContent);
  ok(`Framework copied to ${skillDest}`);

  // Register in config with preserved env keys
  let config = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* fresh */ }
  }
  config.skills = config.skills || {};
  config.skills.entries = config.skills.entries || {};
  config.skills.entries[skillSlug] = {
    enabled: true,
    env: { ...existingEnv, ALIVE_PERSONA: personaSlug },
  };
  // Clean up legacy keys that are no longer recognized by OpenClaw
  delete config.skills.allow;
  delete config.skills.installs;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  ok('openclaw.json updated (entries)');

  // Setup reference images (non-interactive — auto-detect from persona config)
  log('Setting up reference images (non-interactive)...');
  await setupReferenceImages({
    persona,
    personaYamlDir: path.dirname(resolvedPersonaPath),
    skillDest,
    memoryDir,
    rl: null,
    env: existingEnv,
    nonInteractive: true,
  });

  // Initialize memory
  fs.mkdirSync(path.join(memoryDir, 'relations', 'social'), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);

  const filesToInit = [
    ['diary.md', `# ${personaName}的日记\n\n## ${today}\n\n今天是第一天。一切都是新的开始。\n`],
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
    fs.writeFileSync(filePath, content);
  }
  ok(`Fresh memory initialized at ${memoryDir}`);

  // Register cron (optional)
  if (isOpenClawCLIAvailable()) {
    const specs = buildCronSpecs({ persona, skillSlug, personaSlug, personaName });
    reconcileCronJobs({ specs, skillSlug, personaSlug });
  }

  ok('Fresh install complete');

  // Write persona identity to SOUL.md
  writeSoulSection(persona);

  // Step 5: Run real-day test
  log('Step 5/5: Launching real-day E2E test...');
  console.log(`  Running: npx tsx ${E2E_REAL_DAY} --slug ${personaSlug}\n`);

  const dryRun = args.includes('--dry-run');
  const tsxArgs = [E2E_REAL_DAY, '--slug', personaSlug];
  if (dryRun) tsxArgs.push('--dry-run');

  try {
    // Use execFileSync to run tsx with the E2E script
    // This keeps output streaming to the terminal
    const { execFileSync: exec } = require('child_process');
    exec('npx', ['tsx', ...tsxArgs], {
      stdio: 'inherit',
      timeout: 60 * 60 * 1000, // 1 hour timeout
      env: { ...process.env },
    });
    log('Real-day test completed successfully!\n');
  } catch (err) {
    if (err.status) {
      console.error(`\n  Real-day test exited with code ${err.status}`);
    } else {
      console.error(`\n  Real-day test failed: ${err.message}`);
    }
    process.exit(err.status || 1);
  }
}

// ═══════════════════════════════════════════════
// Switch Persona — hot-swap persona.yaml + memory pointer
// ═══════════════════════════════════════════════

async function switchPersona() {
  console.log('\n  Alive Framework — Switch Persona');
  console.log('  ==================================\n');

  const skillSlug = 'alive';
  const skillDest = path.join(SKILLS_DIR, skillSlug);
  if (!fs.existsSync(skillDest)) {
    console.error(`  ✗ Alive not installed. Run "alive --persona <path>" first.`);
    process.exit(1);
  }

  const personaPath = getPersonaArg();
  if (!personaPath) {
    console.error('  ✗ No persona file specified.');
    console.error('    Usage: alive --switch-persona --persona <path/to/persona.yaml>');
    process.exit(1);
  }

  const resolvedPersonaPath = path.resolve(personaPath);
  if (!fs.existsSync(resolvedPersonaPath)) {
    console.error(`  ✗ Persona file not found: ${resolvedPersonaPath}`);
    process.exit(1);
  }

  let persona;
  try {
    persona = parsePersonaFile(resolvedPersonaPath);
  } catch (err) {
    console.error(`  ✗ Could not parse persona file: ${err.message}`);
    process.exit(1);
  }

  const personaName = persona.meta?.name;
  if (!personaName) {
    console.error('  ✗ Persona file missing meta.name field.');
    process.exit(1);
  }

  const personaSlug = (persona.meta.id || personaName).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  const memoryDir = path.join(WORKSPACE_DIR, 'memory', personaSlug);

  log(`Switching to persona: ${personaName} (${personaSlug})...`);

  // Check if this is a new persona BEFORE creating the directory
  const isNewPersonaMemory = !fs.existsSync(memoryDir);

  // 1. Copy persona.yaml to memory directory (per-persona isolation)
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.copyFileSync(resolvedPersonaPath, path.join(memoryDir, 'persona.yaml'));
  ok(`Persona config saved to ${path.join(memoryDir, 'persona.yaml')}`);

  // Also update skill directory copy (legacy compat)
  installPersonaConfig(resolvedPersonaPath, skillDest);
  ok(`Updated persona.yaml in ${skillDest}`);

  // 2. Update ALIVE_PERSONA in openclaw.json
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (config.skills?.entries?.[skillSlug]) {
        config.skills.entries[skillSlug].env = config.skills.entries[skillSlug].env || {};
        config.skills.entries[skillSlug].env.ALIVE_PERSONA = personaSlug;
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        ok('Updated ALIVE_PERSONA in openclaw.json');
      } else {
        warn('Alive skill entry not found in openclaw.json — run a full install first');
      }
    } catch {
      warn('Could not parse openclaw.json');
    }
  }

  // 3. Initialize memory if needed (first time switching to this persona)
  if (isNewPersonaMemory) {
    log(`First time using ${personaName} — initializing memory...`);
    fs.mkdirSync(path.join(memoryDir, 'relations', 'social'), { recursive: true });
    const today = new Date().toISOString().slice(0, 10);

    const filesToInit = [
      ['diary.md', `# ${personaName}的日记\n\n## ${today}\n\n今天是第一天。一切都是新的开始。\n`],
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
    ok(`Fresh memory created at ${memoryDir}`);
  } else {
    ok(`Existing memory found at ${memoryDir} — preserved`);
  }

  // 4. Check reference images
  log('Checking reference images...');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Load existing env for API keys
  let existingEnv = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      existingEnv = cfg.skills?.entries?.[skillSlug]?.env || {};
    } catch { /* ignore */ }
  }
  // Reference images go to per-persona memory dir (matches PATHS.referencesDir at runtime)
  await setupReferenceImages({
    persona,
    personaYamlDir: path.dirname(resolvedPersonaPath),
    skillDest,
    memoryDir,
    rl,
    env: existingEnv,
  });
  rl.close();

  // 5. Register cron for new persona (reconcile — removes duplicates, respects automation config)
  log('Registering cron for new persona...');
  if (isOpenClawCLIAvailable()) {
    const specs = buildCronSpecs({ persona, skillSlug, personaSlug, personaName });
    reconcileCronJobs({ specs, skillSlug, personaSlug });
  } else {
    warn('OpenClaw CLI not found — skipping cron registration.');
  }

  // Install alive-admin plugin (ensure plugin is registered for new persona)
  if (isOpenClawCLIAvailable()) {
    const pluginDir = path.join(skillDest, 'plugin');
    if (fs.existsSync(pluginDir)) {
      try {
        // Remove existing plugin to avoid "plugin already exists" error
        const existingPluginDir = path.join(OPENCLAW_DIR, 'extensions', 'alive-admin');
        if (fs.existsSync(existingPluginDir)) {
          try { execSync('openclaw plugins uninstall alive-admin', { stdio: 'ignore', timeout: 10000 }); } catch { /* ignore */ }
          if (fs.existsSync(existingPluginDir)) {
            fs.rmSync(existingPluginDir, { recursive: true, force: true });
          }
        }
        execFileSync('openclaw', ['plugins', 'install', '--link', pluginDir], {
          timeout: 15000, encoding: 'utf8', stdio: 'pipe',
        });
        ok('alive-admin plugin installed');
      } catch (err) {
        warn(`Failed to install alive-admin plugin: ${err.message}`);
        warn('You can install it manually: openclaw plugins install --link ~/.openclaw/skills/alive/plugin');
      }
    } else {
      warn('Plugin directory not found — skipping plugin install');
    }
  }

  // 6. Update SOUL.md
  writeSoulSection(persona);

  log('Switch complete!\n');
  console.log(`  Active persona: ${personaName} (${personaSlug})`);
  console.log(`  Memory: ${memoryDir}`);
  console.log(`  Skill: ${skillDest}`);
  console.log(`\n  Restart OpenClaw for the change to take effect.\n`);
}

// ═══════════════════════════════════════════════
// Setup References — standalone reference image generation
// ═══════════════════════════════════════════════

async function setupReferencesCommand() {
  console.log('\n  Alive Framework — Setup Reference Images');
  console.log('  ==========================================\n');

  const skillSlug = 'alive';
  const skillDest = path.join(SKILLS_DIR, skillSlug);
  if (!fs.existsSync(skillDest)) {
    console.error(`  ✗ Alive not installed. Run "alive --persona <path>" first.`);
    process.exit(1);
  }

  const personaPath = getPersonaArg();
  if (!personaPath) {
    console.error('  ✗ No persona file specified.');
    console.error('    Usage: alive --setup-references --persona <path/to/persona.yaml>');
    process.exit(1);
  }

  const resolvedPersonaPath = path.resolve(personaPath);
  if (!fs.existsSync(resolvedPersonaPath)) {
    console.error(`  ✗ Persona file not found: ${resolvedPersonaPath}`);
    process.exit(1);
  }

  let persona;
  try {
    persona = parsePersonaFile(resolvedPersonaPath);
  } catch (err) {
    console.error(`  ✗ Could not parse persona file: ${err.message}`);
    process.exit(1);
  }

  const personaName = persona.meta?.name;
  if (!personaName) {
    console.error('  ✗ Persona file missing meta.name field.');
    process.exit(1);
  }

  ok(`Persona: ${personaName}`);

  const personaSlug = (persona.meta.id || personaName).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  const memoryDir = path.join(WORKSPACE_DIR, 'memory', personaSlug);

  // Load existing env for API keys
  let existingEnv = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      existingEnv = config.skills?.entries?.[skillSlug]?.env || {};
    } catch { /* ignore */ }
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const result = await setupReferenceImages({
    persona,
    personaYamlDir: path.dirname(resolvedPersonaPath),
    skillDest,
    memoryDir,
    rl,
    env: existingEnv,
  });

  rl.close();

  if (result) {
    log('Reference images are ready!\n');
  } else {
    log('Reference image setup incomplete. See instructions above.\n');
  }
}

// ═══════════════════════════════════════════════
// Create Persona — interactive persona creation from CLI
// ═══════════════════════════════════════════════

function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return null;
  const val = args[idx + 1];
  if (val && val.startsWith('--')) return null; // next arg is another flag
  return val;
}

async function createPersonaCLI() {
  console.log('\n  Alive Framework — Create New Persona');
  console.log('  ======================================\n');

  const isGuided = args.includes('--guided');

  // Try to load persona-creator from source tree (TypeScript)
  // We use a dynamic require through tsx for the TS module
  let creator;
  try {
    // Try compiled JS first
    const compiledPath = path.join(__dirname, '..', 'dist-alive', 'scripts', 'admin', 'persona-creator.js');
    if (fs.existsSync(compiledPath)) {
      creator = require(compiledPath);
    } else {
      // Fallback: use inline generation (no tsx dependency needed)
      creator = null;
    }
  } catch {
    creator = null;
  }

  if (!isGuided) {
    // ─── Quick Mode ───
    const name = getFlag('name');
    const tagline = getFlag('tagline');

    log('Generating random persona...');

    if (creator) {
      const persona = await creator.generatePersonaQuickAsync({ name: name || undefined, tagline: tagline || undefined });
      const savedPath = creator.savePersona(persona);
      const preview = creator.formatPersonaPreview(persona);
      console.log('\n' + preview + '\n');
      ok(`角色已保存到: ${savedPath}`);
      console.log(`\n  安装此角色: alive --persona ${savedPath}`);
      console.log(`  切换到此角色: alive --switch-persona --persona ${savedPath}\n`);
    } else {
      // Inline fallback generation (no compiled TS available)
      const persona = inlineGeneratePersona(name, tagline);
      const savedPath = inlineSavePersona(persona);
      console.log(`\n  🌟 新角色: ${persona.meta.name}`);
      console.log(`  定位: ${persona.meta.tagline}`);
      console.log(`  MBTI: ${persona.personality.mbti}`);
      console.log(`  性格: ${persona.personality.core_traits.join('、')}`);
      console.log(`  说话风格: ${persona.voice.style}\n`);
      ok(`角色已保存到: ${savedPath}`);
      console.log(`\n  安装此角色: alive --persona ${savedPath}`);
      console.log(`  切换到此角色: alive --switch-persona --persona ${savedPath}\n`);
    }
    return;
  }

  // ─── Guided Mode ───
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('  📝 引导模式 — 逐步创建角色\n');
  console.log('  按 Enter 跳过任何问题（将随机生成）\n');

  // Step 1: Name (required)
  let name = getFlag('name');
  if (!name) {
    name = (await ask(rl, '  角色名（中文）: ')).trim();
    if (!name) {
      name = null; // will be randomly generated
      console.log('  → 将随机生成名字');
    }
  }

  // Step 2: Tagline (required)
  let tagline = getFlag('tagline');
  if (!tagline) {
    tagline = (await ask(rl, '  一句话定位（如"爱做甜品的大学生"）: ')).trim();
    if (!tagline) {
      tagline = null;
      console.log('  → 将随机生成');
    }
  }

  // Step 3: Age
  let age = getFlag('age');
  if (!age) {
    const ageInput = (await ask(rl, '  年龄（可选）: ')).trim();
    age = ageInput || null;
  }

  // Step 3.5: Gender
  let gender = getFlag('gender');
  if (!gender) {
    console.log('\n  性别可选: female(女) / male(男) / other');
    const genderInput = (await ask(rl, '  性别（可选）: ')).trim().toLowerCase();
    gender = genderInput || null;
  }

  // Step 4: MBTI
  let mbti = getFlag('mbti');
  if (!mbti) {
    console.log('\n  MBTI 可选: ESTP ENFP INTJ INFP ENTP ISFJ ENTJ INTP ESFP ISTJ ENFJ ISTP ESFJ INFJ ISFP ESTJ');
    const mbtiInput = (await ask(rl, '  MBTI 类型（可选）: ')).trim().toUpperCase();
    mbti = mbtiInput || null;
  }

  // Step 5: Core Traits
  let traits = getFlag('traits');
  if (!traits) {
    console.log('\n  性格词参考: 元气满满 / 温柔 / 毒舌 / 社恐 / 佛系 / 行动派 / 拖延症 / 文艺 / 吃货 / 傲娇 ...');
    const traitsInput = (await ask(rl, '  核心性格词（逗号分隔，2-5个）: ')).trim();
    traits = traitsInput || null;
  }

  // Step 6: Occupation
  let occupation = getFlag('occupation');
  if (!occupation) {
    const occInput = (await ask(rl, '  职业（如"咖啡店店员"，可选）: ')).trim();
    occupation = occInput || null;
  }

  // Step 7: Schedule type
  let scheduleType = getFlag('schedule');
  if (!scheduleType) {
    console.log('\n  作息类型: early(早起7-23) / normal(正常8-0) / late(晚起10-1) / night(夜猫12-3) / healthy(养生6-22)');
    const schedInput = (await ask(rl, '  作息类型（可选）: ')).trim();
    scheduleType = schedInput || null;
  }

  rl.close();

  log('Generating persona...');

  if (creator) {
    const options = {
      name: name || undefined,
      tagline: tagline || undefined,
      age: age ? parseInt(age, 10) : undefined,
      gender: gender || undefined,
      mbti: mbti || undefined,
      coreTraits: traits ? traits.split(/[,，]/).map(s => s.trim()).filter(Boolean) : undefined,
      occupation: occupation || undefined,
      scheduleType: scheduleType || undefined,
    };

    // Use quick mode if no name/tagline, guided if both present
    let persona;
    if (options.name && options.tagline) {
      persona = await creator.generatePersonaGuidedAsync(options);
    } else {
      persona = await creator.generatePersonaQuickAsync(options);
    }

    const savedPath = creator.savePersona(persona);
    const preview = creator.formatPersonaPreview(persona);
    console.log('\n' + preview + '\n');
    ok(`角色已保存到: ${savedPath}`);
    console.log(`\n  安装此角色: alive --persona ${savedPath}`);
    console.log(`  切换到此角色: alive --switch-persona --persona ${savedPath}\n`);
  } else {
    // Inline fallback
    const persona = inlineGeneratePersona(name, tagline);
    const savedPath = inlineSavePersona(persona);
    console.log(`\n  🌟 新角色: ${persona.meta.name}`);
    console.log(`  定位: ${persona.meta.tagline}`);
    console.log(`  MBTI: ${persona.personality.mbti}`);
    console.log(`  性格: ${persona.personality.core_traits.join('、')}\n`);
    ok(`角色已保存到: ${savedPath}`);
    console.log(`\n  安装此角色: alive --persona ${savedPath}`);
    console.log(`  切换到此角色: alive --switch-persona --persona ${savedPath}\n`);
  }
}

// ── Inline Fallback Generator (no TypeScript dependency) ──────────

function inlinePick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function inlinePickN(arr, n) { return [...arr].sort(() => Math.random() - 0.5).slice(0, n); }

const INLINE_SURNAMES = ['林', '陈', '沈', '苏', '叶', '顾', '白', '秦', '夏', '温', '江', '柳', '宋', '唐'];
const INLINE_GIVEN = ['雨薇', '诗涵', '子墨', '逸尘', '清川', '小鱼', '半夏', '念念', '向晚', '豆豆', '一一', '若水'];
const INLINE_MBTI = ['ESTP', 'ENFP', 'INTJ', 'INFP', 'ENTP', 'ISFJ', 'ENTJ', 'INTP', 'ESFP', 'ISTJ', 'ENFJ', 'ISTP', 'ESFJ', 'INFJ', 'ISFP', 'ESTJ'];
const INLINE_TRAITS = ['元气满满', '温柔', '毒舌', '社恐', '佛系', '行动派', '拖延症', '文艺', '吃货', '傲娇', '好奇心旺盛', '慢热', '话痨', '暖心', '完美主义'];
const INLINE_OCCS = ['大学生', '自由插画师', '便利店店员', '咖啡店店主', '程序员', '视频博主', '花店学徒', '宠物店员'];

function inlineGeneratePersona(name, tagline) {
  const gender = Math.random() > 0.5 ? 'female' : 'male';
  const resolvedName = name || (inlinePick(INLINE_SURNAMES) + inlinePick(INLINE_GIVEN));
  const occ = inlinePick(INLINE_OCCS);
  const resolvedTagline = tagline || occ;
  const mbti = inlinePick(INLINE_MBTI);
  const traits = inlinePickN(INLINE_TRAITS, 3);
  const id = resolvedName.toLowerCase().replace(/[^a-z0-9]/g, '') || `persona-${Date.now().toString(36)}`;
  const genderLabel = gender === 'female' ? '女' : '男';

  return {
    meta: { name: resolvedName, id, gender: genderLabel, tagline: resolvedTagline },
    personality: { mbti, core_traits: traits, quirks: [], values: [], description: `${resolvedName}，${resolvedTagline}。` },
    voice: { language: 'zh-CN', style: '口语化、活泼、短句多。', emoji_density: 'medium', sample_lines: ['你好呀！', '哈哈好的～', '嗯嗯！'] },
    intimacy: { levels: 5, behaviors: { 1: '礼貌有距离', 2: '友善开朗', 3: '放松聊天', 4: '亲近真实', 5: '完全袒露' } },
    schedule: { wake_hour: 8, sleep_hour: 0, timezone: 'Asia/Shanghai', active_peaks: [14, 21] },
    sub_skills: [],
  };
}

function inlineSavePersona(persona) {
  const header = `# Alive 角色预设 — ${persona.meta.name}\n# 由 alive --create 自动生成\n# 生成时间: ${new Date().toISOString().slice(0, 19)}\n\n`;
  const yamlStr = YAML.stringify(persona, { indent: 2 });
  const filename = `${persona.meta.id || 'new-persona'}.yaml`;
  const savePath = path.join(PERSONAS_DIR, filename);

  // Don't overwrite
  let finalPath = savePath;
  let counter = 1;
  while (fs.existsSync(finalPath)) {
    finalPath = path.join(PERSONAS_DIR, `${persona.meta.id || 'new-persona'}-${counter}.yaml`);
    counter++;
  }

  fs.mkdirSync(PERSONAS_DIR, { recursive: true });
  fs.writeFileSync(finalPath, header + yamlStr, 'utf8');
  return finalPath;
}

// Entry: route by CLI args
const args = process.argv.slice(2);

// Auto-migrate from legacy skill slug (e.g. "minase") to "alive"
migrateFromLegacySlug();

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  Alive Framework — Digital Life Engine

  Usage:
    alive                                        Interactive persona selection (built-in presets)
    alive --persona <path>                       Install a persona (full)
    alive --persona <path> --env-file .env       Install with env vars from .env file (non-interactive)
    alive --update --persona <path>              Update code only (preserves memory & config)
    alive --reinstall --persona <path>           Wipe everything & reinstall from scratch
    alive --uninstall --persona <path>           Uninstall a persona
    alive --switch-persona --persona <path>      Switch to a different persona (hot swap)
    alive --setup-references --persona <path>    Generate reference images from source photo
    alive --create                               Create a new random persona (quick mode)
    alive --create --name "名字" --tagline "定位"  Create persona with specified name/tagline
    alive --create --guided                      Create persona with step-by-step guidance
    alive --real-day-test --persona <path>       Uninstall + reinstall + run full day E2E test
    alive --real-day-test --persona <path> --dry-run   Same but skip actual API calls
    alive --help                                 Show this help

  Environment Configuration:
    The installer reads API keys from these sources (in priority order):
      1. --env-file <path>    Explicit .env file path
      2. .env in current dir  Auto-detected
      3. .env in repo root    Auto-detected
      4. Interactive prompts   If no .env file found

    .env file format:
      LLM_API_KEY=sk-your-key-here
      LLM_API_BASE=https://aihubmix.com/v1
      LLM_MODEL=claude-sonnet-4-20250514
      AIHUBMIX_API_KEY=sk-your-image-key    # optional, for reference image generation

    For headless servers, create a .env file before running install to skip prompts.

  The skill is always installed at ~/.openclaw/skills/alive/.
  Each persona gets its own memory directory at ~/.openclaw/workspace/memory/<persona-slug>/.
  Use --switch-persona to hot-swap between personas.

  Built-in Personas:
    Run \`alive\` without arguments to see available built-in personas.
    Add your own .yaml files to alive/personas/ to make them selectable.

  Reference Images:
    During install, you can provide a source photo to auto-generate multi-angle references.
    Or set 'meta.reference_image' in your persona.yaml to auto-detect the source.
    Run --setup-references anytime to generate or regenerate reference images.

  Examples:
    alive                                          # Interactive selection
    alive --persona ./persona.yaml                 # Custom persona (interactive)
    alive --persona ./persona.yaml --env-file .env # Non-interactive with .env
    alive --switch-persona --persona ./another-persona.yaml
    alive --create                                 # Random new persona
    alive --create --name "陈小鱼" --tagline "爱吃甜食的插画师"
    alive --create --guided                        # Step-by-step guided creation
    alive --update --persona ./persona.yaml
    alive --reinstall --persona ./persona.yaml
    alive --uninstall --persona ./persona.yaml
    alive --real-day-test --persona ./persona.yaml

  See alive/persona-schema.yaml for field definitions, or alive/personas/ for examples.
`);
} else if (args.includes('--create')) {
  createPersonaCLI().catch(err => {
    console.error('\n  Create failed:', err.message);
    process.exit(1);
  });
} else if (args.includes('--switch-persona')) {
  switchPersona().catch(err => {
    console.error('\n  Switch failed:', err.message);
    process.exit(1);
  });
} else if (args.includes('--setup-references')) {
  setupReferencesCommand().catch(err => {
    console.error('\n  Setup references failed:', err.message);
    process.exit(1);
  });
} else if (args.includes('--real-day-test')) {
  realDayTest().catch(err => {
    console.error('\n  Real-day test failed:', err.message);
    process.exit(1);
  });
} else if (args.includes('--reinstall')) {
  reinstall().catch(err => {
    console.error('\n  Reinstall failed:', err.message);
    process.exit(1);
  });
} else if (args.includes('--update')) {
  update().catch(err => {
    console.error('\n  Update failed:', err.message);
    process.exit(1);
  });
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
