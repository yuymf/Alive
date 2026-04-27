import { spawn } from 'child_process';
import * as path from 'path';

const CLI_PATH = path.resolve(__dirname, '../../..', 'dist-alive/scripts/ops/ops-command-handler.js');

// Per-process timeout for the ops CLI subprocess. Default 10 min; override via
// CLI_TIMEOUT_MS env var. Brief/advice commonly run 90–250 s on a cold cache,
// so anything below 300 s will truncate real work.
function resolveTimeoutMs(): number {
  const raw = process.env.CLI_TIMEOUT_MS;
  if (!raw) return 600_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 30_000) {
    console.warn(`[cli-runner] Ignoring invalid CLI_TIMEOUT_MS=${raw}; using default 600s`);
    return 600_000;
  }
  return n;
}

export function spawnCli(command: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    const child = spawn('node', [CLI_PATH, command, ...args], {
      env,
      timeout: resolveTimeoutMs(),
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(stdout.trim());
    });

    child.on('error', reject);
  });
}
