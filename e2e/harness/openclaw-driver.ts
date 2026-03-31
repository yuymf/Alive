// e2e/harness/openclaw-driver.ts
// OpenClaw CLI 封装 — spawn/pipe 交互、超时保护、输出捕获

import { spawn, execSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './harness.config';
import { addInteraction, type Phase } from './harness-context';

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

export function runSession(
  input: string,
  options: { timeout: number; phase: Phase },
): Promise<SessionResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const proc = spawn('openclaw', [], {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let responseSent = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
    }, options.timeout);

    proc.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;

      if (!responseSent && (stdout.includes('>') || stdout.includes('❯'))) {
        responseSent = true;
        proc.stdin.write(input + '\n');

        setTimeout(() => {
          proc.stdin.write('/exit\n');
        }, options.timeout * 0.8);
      }
    });

    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('close', () => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      resolve({ response: stdout, durationMs, rawStdout: stdout, rawStderr: stderr });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// === High-Level Driver Functions ===

export async function install(personaPath: string): Promise<InstallResult> {
  const config = getConfig();
  const absPersona = path.resolve(personaPath);
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

export async function uninstall(personaPath: string): Promise<ExecResult> {
  const config = getConfig();
  const absPersona = path.resolve(personaPath);
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

export async function runLifecycleScript(
  script: 'morning-plan' | 'heartbeat-tick' | 'night-reflect',
): Promise<ScriptResult> {
  const config = getConfig();
  const scriptPath = path.join(config.skillDir, 'scripts', 'lifecycle', `${script}.js`);

  if (!fs.existsSync(scriptPath)) {
    return {
      stdout: '',
      stderr: `Script not found: ${scriptPath}`,
      exitCode: 1,
      durationMs: 0,
      success: false,
    };
  }

  const result = await execWithTimeout(
    'node',
    [scriptPath],
    {
      timeout: config.timeouts.cron,
      env: {
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
      stderr: result.stderr,
      exitCode: result.exitCode,
    },
  });

  return { ...result, success: result.exitCode === 0 };
}

export function listCrons(): string {
  try {
    return execSync('openclaw cron list', { encoding: 'utf8', timeout: 10_000 });
  } catch {
    return '';
  }
}

export async function runSlashCommand(command: string): Promise<SessionResult> {
  const config = getConfig();
  const result = await runSession(command, {
    timeout: config.timeouts.session,
    phase: 'slash',
  });

  addInteraction({
    timestamp: new Date().toISOString(),
    source: 'slash-command',
    phase: 'slash',
    prompt: command,
    response: result.response,
    elapsed_ms: result.durationMs,
  });

  return result;
}

export async function chat(message: string): Promise<SessionResult> {
  const config = getConfig();
  const result = await runSession(message, {
    timeout: config.timeouts.chat,
    phase: 'chat',
  });

  addInteraction({
    timestamp: new Date().toISOString(),
    source: 'chat',
    phase: 'chat',
    prompt: message,
    response: result.response,
    elapsed_ms: result.durationMs,
  });

  return result;
}

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

export function isOpenclawAvailable(): boolean {
  try {
    execSync('openclaw --version', { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
