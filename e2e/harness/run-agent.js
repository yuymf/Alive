#!/usr/bin/env node
// e2e/harness/run-agent.js
// Standalone script to run openclaw agent and write JSON output to a file.
// Usage: node run-agent.js <output-file> <message>

const { execSync } = require('child_process');
const fs = require('fs');

const outputFile = process.argv[2];
const message = process.argv.slice(3).join(' ');
const logFile = outputFile + '.log';

fs.writeFileSync(logFile, `[run-agent] start: outputFile=${outputFile}, message=${message}\n`);

if (!outputFile || !message) {
  fs.appendFileSync(logFile, '[run-agent] missing args\n');
  process.exit(1);
}

try {
  const escaped = message.replace(/'/g, "'\\''");
  const cmd = `/opt/homebrew/bin/openclaw agent --agent main -m '${escaped}' --json`;
  fs.appendFileSync(logFile, `[run-agent] cmd=${cmd}\n`);
  // Clean env: remove npm/vitest/node vars that may confuse openclaw
  const cleanEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('npm_') || k.startsWith('VITEST') || k === 'INIT_CWD' || k === 'NODE_OPTIONS') continue;
    cleanEnv[k] = v;
  }
  cleanEnv.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
  const result = execSync(cmd, { encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024, env: cleanEnv });
  fs.appendFileSync(logFile, `[run-agent] result.length=${result.length}\n`);
  fs.writeFileSync(outputFile, result);
} catch (err) {
  const stdout = err.stdout || '';
  const stderr = err.stderr || '';
  fs.appendFileSync(logFile, `[run-agent] error: ${err.message}\n`);
  fs.appendFileSync(logFile, `[run-agent] stdout.len=${stdout.length}, stderr.len=${stderr.length}\n`);
  fs.appendFileSync(logFile, `[run-agent] stderr: ${stderr.slice(0, 200)}\n`);
  fs.writeFileSync(outputFile, stdout || JSON.stringify({ error: stderr || err.message }));
}
