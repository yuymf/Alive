/**
 * instagram-bridge-client.ts
 * Thin client for calling the Python instagram-bridge.py script.
 * Extracted to avoid circular dependency between post-pipeline and inspiration-collector.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

/**
 * Call the Python instagram-bridge.py script with a subcommand and args.
 * Returns parsed JSON from stdout.
 */
export function callInstagramBridge(command: string, args: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Resolve bridge path: works both in installed context (__dirname = scripts/)
    // and development context (__dirname = dist/, bridge at skill/scripts/)
    let bridgePath = path.join(__dirname, 'instagram-bridge.py');
    if (!fs.existsSync(bridgePath)) {
      bridgePath = path.join(__dirname, '..', 'skill', 'scripts', 'instagram-bridge.py');
    }
    if (!fs.existsSync(bridgePath)) {
      return reject(new Error(`instagram-bridge.py not found (tried __dirname and skill/scripts/)`));
    }

    const cliArgs = [bridgePath, command];
    for (const [key, value] of Object.entries(args)) {
      cliArgs.push(`--${key}`, value);
    }

    execFile('python3', cliArgs, { timeout: 120_000 }, (error, stdout, stderr) => {
      if (stderr) console.error(`[ig-bridge] ${stderr.trim()}`);
      if (error) {
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.error) return reject(new Error(parsed.error));
        } catch {
          if (stdout) console.error(`[ig-bridge] Unparseable stdout: ${stdout.slice(0, 200)}`);
        }
        return reject(new Error(`instagram-bridge ${command} failed: ${error.message}`));
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Failed to parse bridge output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}
