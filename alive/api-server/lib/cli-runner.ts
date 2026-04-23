import { spawn } from 'child_process';
import * as path from 'path';

const CLI_PATH = path.resolve(__dirname, '../../..', 'dist-alive/scripts/ops/ops-command-handler.js');
const TIMEOUT_MS = 360_000;

export function spawnCli(command: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    const child = spawn('node', [CLI_PATH, command, ...args], {
      env,
      timeout: TIMEOUT_MS,
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
