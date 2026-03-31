// e2e/harness/openclaw-driver.ts
// OpenClaw CLI 封装 — spawn/pipe 交互、超时保护、输出捕获
//
// Key design decisions:
// - Lifecycle scripts: run directly via `node`, with full env from openclaw.json
// - Slash commands: run via `openclaw agent -m` (non-interactive, requires gateway)
// - Chat: same as slash commands but tagged differently for the report
// - Cron list: try gateway first, fallback to reading cron-schedule.json
// - Gateway: auto-start if not running (needed for agent/cron commands)

import { spawn, execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { getConfig } from './harness.config';
import { addInteraction, type Phase } from './harness-context';
import { loadApiKeys } from '../shared/setup';

// Resolve openclaw binary path once
const OPENCLAW_BIN = (() => {
  // Try common locations
  const candidates = [
    '/opt/homebrew/bin/openclaw',
    '/usr/local/bin/openclaw',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Fallback to which
  try {
    return execSync('which openclaw', { encoding: 'utf8', timeout: 3_000 }).trim();
  } catch {
    return 'openclaw';
  }
})();

// === Types ===

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

export interface InstallResult extends ExecResult {
  readonly success: boolean;
}

export interface ScriptResult extends ExecResult {
  readonly success: boolean;
}

export interface SessionResult {
  readonly response: string;
  readonly durationMs: number;
  readonly rawStdout: string;
  readonly rawStderr: string;
}

// === Low-Level Helpers ===

export function execWithTimeout(
  command: string,
  args: string[],
  options: {
    timeout: number;
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
  },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
    }, options.timeout);

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    if (options.stdin) {
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    }

    proc.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      if (killed) {
        reject(new Error(`Command timed out after ${options.timeout}ms: ${command} ${args.join(' ')}\nstdout: ${stdout}\nstderr: ${stderr}`));
      } else {
        resolve({ stdout, stderr, exitCode: code ?? 1, durationMs });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Load alive skill env vars from openclaw.json.
 * Returns a record suitable for spreading into process env.
 */
function loadSkillEnv(): Record<string, string> {
  const keys = loadApiKeys('alive');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(keys)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/**
 * Check if the openclaw gateway is running by probing TCP port 18789.
 * Pure Node.js — no external commands needed.
 */
export function isGatewayRunning(): boolean {
  try {
    // Synchronous TCP probe via spawnSync + node one-liner
    const result = spawnSync('node', ['-e', `
      const net = require('net');
      const s = net.createConnection({host:'127.0.0.1',port:18789});
      s.setTimeout(2000);
      s.on('connect',()=>{process.exit(0)});
      s.on('error',()=>{process.exit(1)});
      s.on('timeout',()=>{process.exit(1)});
    `], { timeout: 5_000, stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Try to ensure the gateway is running. Returns true if running after attempt.
 */
export function ensureGateway(): boolean {
  if (isGatewayRunning()) return true;
  console.log('  ⚙ Starting openclaw gateway...');
  try {
    execSync(`${OPENCLAW_BIN} gateway install --force 2>&1`, { encoding: 'utf8', timeout: 15_000, shell: true });
    // Wait for startup
    execSync('sleep 3', { timeout: 5_000, shell: true });
    return isGatewayRunning();
  } catch {
    console.log('  ⚠ Could not start gateway — chat tests will fail');
    return false;
  }
}

// === High-Level Driver Functions ===

/**
 * Install alive skill via cli.js.
 * Auto-answers interactive prompts with Enter (accept defaults).
 */
export async function install(personaPath: string): Promise<InstallResult> {
  const config = getConfig();
  const absPersona = path.resolve(personaPath);

  // Send lots of newlines to auto-accept all prompts (env config, confirmations)
  const autoAnswer = '\n'.repeat(30);

  const result = await execWithTimeout(
    'node',
    [path.resolve('bin/cli.js'), '--persona', absPersona],
    {
      timeout: config.timeouts.install,
      stdin: autoAnswer,
    },
  );

  addInteraction({
    timestamp: new Date().toISOString(),
    source: 'session-stdout',
    phase: 'install',
    response: result.stdout,
    metadata: { stderr: result.stderr, exitCode: result.exitCode },
  });

  return { ...result, success: result.exitCode === 0 };
}

/**
 * Uninstall alive skill via cli.js.
 * Auto-answers: 'y' to confirm, then Enter to keep memory.
 */
export async function uninstall(personaPath: string): Promise<ExecResult> {
  const config = getConfig();
  const absPersona = path.resolve(personaPath);

  // First prompt: "Continue? (y/N)" → 'y'
  // Second prompt: "Keep memory data? (Y/n)" → Enter (default Y = keep)
  const autoAnswer = 'y\n\n';

  const result = await execWithTimeout(
    'node',
    [path.resolve('bin/cli.js'), '--uninstall', '--persona', absPersona],
    {
      timeout: config.timeouts.install,
      stdin: autoAnswer,
    },
  );

  addInteraction({
    timestamp: new Date().toISOString(),
    source: 'session-stdout',
    phase: 'cleanup',
    response: result.stdout,
    metadata: { stderr: result.stderr, exitCode: result.exitCode },
  });

  return result;
}

/**
 * Run a lifecycle script directly (morning-plan, heartbeat-tick, night-reflect).
 * Loads full env from openclaw.json so LLM calls work.
 */
export async function runLifecycleScript(
  script: 'morning-plan' | 'heartbeat-tick' | 'night-reflect',
): Promise<ScriptResult> {
  const config = getConfig();

  // Try multiple possible paths (install layout varies)
  const candidates = [
    path.join(config.skillDir, 'scripts', 'lifecycle', `${script}.js`),
    path.join(config.skillDir, 'lifecycle', `${script}.js`),
  ];
  const scriptPath = candidates.find(p => fs.existsSync(p));

  if (!scriptPath) {
    return {
      stdout: '',
      stderr: `Script not found. Tried:\n${candidates.join('\n')}`,
      exitCode: 1,
      durationMs: 0,
      success: false,
    };
  }

  // Load full env: process.env + skill env from openclaw.json + overrides
  const skillEnv = loadSkillEnv();

  const result = await execWithTimeout(
    'node',
    [scriptPath],
    {
      timeout: config.timeouts.cron,
      env: {
        ...skillEnv,
        ALIVE_PERSONA: config.personaSlug,
        E2E_MOCK_CRON: '1',
      },
    },
  );

  addInteraction({
    timestamp: new Date().toISOString(),
    source: 'session-stdout',
    phase: 'heartbeat',
    response: result.stdout,
    metadata: {
      script,
      scriptPath,
      stderr: result.stderr,
      exitCode: result.exitCode,
    },
  });

  return { ...result, success: result.exitCode === 0 };
}

/**
 * List cron jobs. Tries gateway first, falls back to reading cron-schedule.json.
 */
export function listCrons(): string {
  // Try gateway first
  try {
    const out = execSync(`${OPENCLAW_BIN} cron list`, { encoding: 'utf8', timeout: 10_000 });
    return out;
  } catch {
    // Fallback: read cron-schedule.json from memory dir
    const config = getConfig();
    const cronFile = path.join(config.memoryDir, 'cron-schedule.json');
    if (fs.existsSync(cronFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(cronFile, 'utf8'));
        // Format cron entries as text for assertion matching
        const jobs = data.jobs || data;
        if (Array.isArray(jobs)) {
          return jobs.map((j: { name?: string; expression?: string }) =>
            `${j.name || 'unknown'} ${j.expression || ''}`
          ).join('\n');
        }
        return JSON.stringify(data);
      } catch {
        return '';
      }
    }

    // Second fallback: check if openclaw config has cron entries registered
    const configFile = path.join(config.openclawHome, 'openclaw.json');
    if (fs.existsSync(configFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        const crons = raw.cron?.entries || raw.cron?.jobs || [];
        if (Array.isArray(crons)) {
          return crons.map((c: { name?: string }) => c.name || '').join('\n');
        }
        return JSON.stringify(raw.cron || {});
      } catch {
        return '';
      }
    }

    return '';
  }
}

/**
 * Run openclaw agent command, capturing output via temp file
 * (vitest workers intercept stdout from child_process.spawn).
 */
function runAgentCommand(message: string, timeout: number): { stdout: string; stderr: string; exitCode: number; durationMs: number } {
  const tmpOut = path.join(require('os').tmpdir(), `harness-agent-${Date.now()}.json`);
  const logFile = tmpOut + '.log';
  const runAgentScript = path.resolve('e2e/harness/run-agent.js');
  const start = Date.now();
  try {
    spawnSync('node', [runAgentScript, tmpOut, message], {
      timeout,
      stdio: 'ignore',
      env: { ...process.env, PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
    });
  } catch {
    // may fail but script still writes output
  }
  const durationMs = Date.now() - start;
  const stdout = fs.existsSync(tmpOut) ? fs.readFileSync(tmpOut, 'utf8') : '';
  // Read and print the debug log
  if (fs.existsSync(logFile)) {
    const log = fs.readFileSync(logFile, 'utf8');
    console.log(`  [run-agent.log] ${log.trim()}`);
    try { fs.unlinkSync(logFile); } catch {}
  }
  try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  return { stdout, stderr: '', exitCode: stdout ? 0 : 1, durationMs };
}

/**
 * Run a slash command via `openclaw agent -m`.
 * Requires gateway to be running.
 */
export async function runSlashCommand(command: string): Promise<SessionResult> {
  const config = getConfig();
  const result = runAgentCommand(command, config.timeouts.session);

  // Extract text from JSON response if possible
  let response = result.stdout;
  try {
    const json = JSON.parse(result.stdout);
    const payloads = json.result?.payloads || [];
    response = payloads.map((p: { text?: string }) => p.text || '').join('\n');
  } catch {
    // Use raw stdout if not JSON
  }

  addInteraction({
    timestamp: new Date().toISOString(),
    source: 'slash-command',
    phase: 'slash',
    prompt: command,
    response,
    elapsed_ms: result.durationMs,
    metadata: { stderr: result.stderr, exitCode: result.exitCode, rawStdout: result.stdout },
  });

  return { response, durationMs: result.durationMs, rawStdout: result.stdout, rawStderr: result.stderr };
}

/**
 * Send a chat message via `openclaw agent -m`.
 * Requires gateway to be running.
 */
export async function chat(message: string): Promise<SessionResult> {
  const config = getConfig();
  const result = runAgentCommand(message, config.timeouts.chat);

  // Extract text from JSON response
  let response = result.stdout;
  try {
    const json = JSON.parse(result.stdout);
    const payloads = json.result?.payloads || [];
    response = payloads.map((p: { text?: string }) => p.text || '').join('\n');
  } catch {
    // Use raw stdout
  }

  addInteraction({
    timestamp: new Date().toISOString(),
    source: 'chat',
    phase: 'chat',
    prompt: message,
    response,
    elapsed_ms: result.durationMs,
    metadata: { stderr: result.stderr, exitCode: result.exitCode, rawStdout: result.stdout },
  });

  return { response, durationMs: result.durationMs, rawStdout: result.stdout, rawStderr: result.stderr };
}

/**
 * Read a memory file from the real memory directory.
 */
export function readMemoryFile<T>(relativePath: string, fallback: T): T {
  const config = getConfig();
  const fullPath = path.join(config.memoryDir, relativePath);
  if (!fs.existsSync(fullPath)) return fallback;
  try {
    const raw = fs.readFileSync(fullPath, 'utf8');
    return relativePath.endsWith('.json') ? JSON.parse(raw) : raw as unknown as T;
  } catch {
    return fallback;
  }
}

/**
 * Check if openclaw CLI is available.
 */
export function isOpenclawAvailable(): boolean {
  try {
    execSync(`${OPENCLAW_BIN} --version`, { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
