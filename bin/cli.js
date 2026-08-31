#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function printHelp() {
  process.stdout.write(`Alive — portable digital-life skill for Code Agents

Usage:
  alive init [--project] [--persona <id>] [--home <dir>]
  alive adopt <path|url> [--id <slug>] [--home <dir>]
  alive distill <name|path|url> [--id <slug>] [--name <name>] [--home <dir>]
  alive call [--home <dir>]
  alive tick | morning | night
  alive start
  alive context
  alive remember --user <text> --reply <text>
  alive status | emotion | schedule | memory | help
  alive uninstall [--home <dir>]

init copies this skill into Code Agent skill dirs:
  ~/.agents/skills/alive          (Cursor + Codex)
  ~/.claude/skills/alive          (if ~/.claude exists)
  ~/.cursor/skills/alive          (if ~/.cursor exists)
  ~/.codex/skills/alive           (if ~/.codex exists)
  .agents/skills/alive            (--project)

Memory and .env go to $ALIVE_HOME (default ~/.alive).
Conversation uses the host agent. Heartbeat scripts need LLM_API_KEY.
adopt takes a Nuwa / 永雏塔菲 persona skill (local dir or git URL).
distill turns materials or talk-to-fengge into a skill, then adopts it.
call writes a live-voice invitation for the owner (talk-to-fengge join URL).
`);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) flags[key] = 'true';
      else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function loadHost() {
  const dist = path.join(ROOT, 'dist-alive', 'scripts', 'host');
  try {
    return {
      install: require(path.join(dist, 'install.js')),
      boot: require(path.join(dist, 'boot.js')),
    };
  } catch {
    return null;
  }
}

function ensureBuilt() {
  let host = loadHost();
  if (host) return host;
  const result = spawnSync('npx', ['tsc', '-p', 'tsconfig.json'], {
    cwd: ROOT,
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error('TypeScript build failed. Run npm install && npm run build.');
  }
  host = loadHost();
  if (!host) throw new Error('Build succeeded but host modules were not found in dist-alive/.');
  return host;
}

function cmdInit(flags) {
  const host = ensureBuilt();
  const { detectUserSkillTargets, projectSkillTarget, installSkillTo, initMemory, buildSkill } = host.install;
  buildSkill();
  const persona = flags.persona || 'minase';
  const aliveHome = flags.home || process.env.ALIVE_HOME || path.join(os.homedir(), '.alive');
  const targets = flags.project === 'true'
    ? [projectSkillTarget(process.cwd())]
    : detectUserSkillTargets();

  initMemory(aliveHome, persona, ROOT);
  for (const target of targets) {
    installSkillTo(target.dir, ROOT);
    process.stdout.write(`installed skill → ${target.dir} (${target.reason})\n`);
  }
  process.stdout.write(`memory → ${path.join(aliveHome, 'personas', persona)}\n`);
  process.stdout.write(`env    → ${path.join(aliveHome, '.env')}\n`);
  process.stdout.write('\nNext: add LLM_API_KEY to .env if you want scripted heartbeats.\n');
  process.stdout.write('Then open Claude Code / Cursor / Codex and talk to the persona, or run `alive tick`.\n');
}

async function cmdBoot(command) {
  const host = ensureBuilt();
  await host.boot.boot(command);
}

async function cmdAdmin(raw) {
  ensureBuilt();
  const handler = require(path.join(ROOT, 'dist-alive', 'scripts', 'admin', 'command-handler.js'));
  const result = await handler.dispatch(`/alive ${raw}`);
  if (result.output) process.stdout.write(result.output.endsWith('\n') ? result.output : result.output + '\n');
  if (result.error) process.exitCode = 1;
}

async function cmdStart() {
  const host = ensureBuilt();
  process.stdout.write('alive start — hourly tick (Ctrl+C to stop)\n');
  let lastHour = -1;
  const tick = async () => {
    const hour = new Date().getHours();
    if (hour === lastHour) return;
    lastHour = hour;
    try {
      await host.boot.boot('tick');
    } catch (err) {
      console.error(`❌ ${err.message}`);
    }
  };
  await tick();
  setInterval(tick, 30_000);
}

function cmdUninstall(flags) {
  const aliveHome = flags.home || process.env.ALIVE_HOME || path.join(os.homedir(), '.alive');
  const host = loadHost() || ensureBuilt();
  const targets = host.install.detectUserSkillTargets();
  targets.push(host.install.projectSkillTarget(process.cwd()));
  for (const target of targets) {
    if (fs.existsSync(target.dir)) {
      fs.rmSync(target.dir, { recursive: true, force: true });
      process.stdout.write(`removed ${target.dir}\n`);
    }
  }
  process.stdout.write(`Data left at ${aliveHome} (delete it yourself if you want).\n`);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (flags.help === 'true') {
    printHelp();
    return;
  }
  if (!cmd) {
    const home = flags.home || process.env.ALIVE_HOME || path.join(os.homedir(), '.alive');
    if (!fs.existsSync(path.join(home, '.env'))) return cmdInit(flags);
    printHelp();
    return;
  }
  if (cmd === 'help') return cmdAdmin('help');
  if (cmd === 'init') return cmdInit(flags);
  if (cmd === 'adopt') {
    if (flags.home) process.env.ALIVE_HOME = flags.home;
    const source = positional[1] || '';
    const id = flags.id ? ` --id ${flags.id}` : '';
    return cmdAdmin(`adopt ${source}${id}`.trim());
  }
  if (cmd === 'call') {
    if (flags.home) process.env.ALIVE_HOME = flags.home;
    return cmdAdmin('call');
  }
  if (cmd === 'distill') {
    if (flags.home) process.env.ALIVE_HOME = flags.home;
    const source = positional.slice(1).join(' ');
    const bits = [`distill ${source}`.trim()];
    if (flags.id) bits.push(`--id ${flags.id}`);
    if (flags.name) bits.push(`--name ${flags.name}`);
    if (flags.materials) bits.push(`--materials ${flags.materials}`);
    return cmdAdmin(bits.join(' '));
  }
  if (cmd === 'uninstall') return cmdUninstall(flags);
  if (cmd === 'start') return cmdStart();
  if (cmd === 'tick' || cmd === 'morning' || cmd === 'night') return cmdBoot(cmd);
  if (cmd === 'context') {
    ensureBuilt();
    const chat = require(path.join(ROOT, 'dist-alive', 'scripts', 'host', 'chat.js'));
    const ctx = chat.loadChatContext(flags.userId || flags['user-id']);
    process.stdout.write(ctx.markdown.endsWith('\n') ? ctx.markdown : ctx.markdown + '\n');
    return;
  }
  if (cmd === 'remember') {
    ensureBuilt();
    const chat = require(path.join(ROOT, 'dist-alive', 'scripts', 'host', 'chat.js'));
    const result = chat.saveChatTurn({
      user: flags.user || '',
      reply: flags.reply || '',
      userId: flags.userId || flags['user-id'],
    });
    process.stdout.write(`saved diary intimacy=${result.intimacy} cause=${result.emotionCause}\n`);
    return;
  }
  return cmdAdmin(positional.join(' '));
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
