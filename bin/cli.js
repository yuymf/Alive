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
  alive init [--project] [--agent <id[,id]>] [--persona <id>] [--home <dir>]
             [--hermes [profile]] [--openclaw [agent]]
  alive adopt <path|url> [--id <slug>] [--home <dir>]
  alive distill <name|path|url> [--id <slug>] [--name <name>] [--home <dir>]
  alive call [--home <dir>]
  alive voice [--check] [--livekit-dev]
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
  ~/.hermes/skills/alive          (if ~/.hermes exists)
  ~/.openclaw/skills/alive        (if ~/.openclaw exists)
  .agents/skills/alive            (--project)

--agent installs only to the named hosts (comma-separated):
  agents, claude, cursor, codex, hermes, openclaw

--hermes [profile] initializes a Hermes profile (e.g. \`alive init --hermes taffy\`).
--openclaw [agent] initializes an OpenClaw agent workspace (e.g. \`alive init --openclaw miss-v\`).

Memory and .env go to $ALIVE_HOME (default ~/.alive).
Conversation uses the host agent. Heartbeat reuses a Hermes / OpenClaw
model key when present; otherwise set LLM_API_KEY.
adopt takes a Nuwa / 永雏塔菲 persona skill (local dir or git URL).
distill turns materials or talk-to-fengge into a skill, then adopts it.
call writes a live-voice invitation.
voice / start serve the call page and, when configured, LiveKit + VoxCPM worker.
See USAGE.md.
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
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error('Build failed. Run npm install && npm run build.');
  }
  host = loadHost();
  if (!host) throw new Error('Build succeeded but host modules were not found in dist-alive/.');
  return host;
}

function cmdInit(flags) {
  const host = ensureBuilt();
  const {
    parseAgentFlag,
    resolveUserSkillTargets,
    projectSkillTarget,
    installSkillTo,
    initMemory,
    buildSkill,
    knownAgentIds,
    harvestHostLlm,
    initHermesProfile,
    initOpenClawAgent,
  } = host.install;
  buildSkill();
  const aliveHome = flags.home || process.env.ALIVE_HOME || path.join(os.homedir(), '.alive');

  if (flags.hermes && flags.hermes !== 'true') {
    const res = initHermesProfile({
      profileName: flags.hermes,
      personaId: flags.persona,
      aliveHome,
      root: ROOT,
    });
    process.stdout.write(`✓ Hermes profile "${res.profileName}" initialized with persona "${res.personaName}"!\n`);
    process.stdout.write(`  skill    → ${res.skillDir}\n`);
    process.stdout.write(`  soul     → ${res.soulPath}\n`);
    process.stdout.write(`  memory   → ${path.join(aliveHome, 'personas', res.personaId)}\n`);
    process.stdout.write(`  env      → ${path.join(aliveHome, '.env')}\n`);
    if (res.llmSource) {
      process.stdout.write(`  llm      → reused from ${res.llmSource} (no extra LLM_API_KEY needed)\n`);
    }
    process.stdout.write(`\nTo start real-time chat with ${res.personaName}:\n`);
    process.stdout.write(`  hermes -p ${res.profileName}\n`);
    process.stdout.write(`  hermes -p ${res.profileName} --tui\n`);
    return;
  }

  if (flags.openclaw && flags.openclaw !== 'true') {
    const res = initOpenClawAgent({
      agentName: flags.openclaw,
      personaId: flags.persona,
      aliveHome,
      root: ROOT,
    });
    process.stdout.write(`✓ OpenClaw agent "${res.agentName}" initialized with persona "${res.personaName}"!\n`);
    process.stdout.write(`  workspace → ${res.workspaceDir}\n`);
    process.stdout.write(`  skill     → ${res.skillDir}\n`);
    process.stdout.write(`  soul      → ${res.soulPath}\n`);
    process.stdout.write(`  memory    → ${path.join(aliveHome, 'personas', res.personaId)}\n`);
    process.stdout.write(`  env       → ${path.join(aliveHome, '.env')}\n`);
    if (res.llmSource) {
      process.stdout.write(`  llm       → reused from ${res.llmSource}\n`);
    }
    return;
  }

  const persona = flags.persona || 'minase';
  const rawAgents = flags.agent || flags.agents;
  let agentIds = parseAgentFlag(rawAgents);
  if (flags.hermes === 'true' && !agentIds.includes('hermes')) agentIds.push('hermes');
  if (flags.openclaw === 'true' && !agentIds.includes('openclaw')) agentIds.push('openclaw');

  if ((flags.agent === 'true' || flags.agents === 'true') && agentIds.length === 0) {
    throw new Error(`--agent needs an id. Supported: ${knownAgentIds().join(', ')}`);
  }
  const targets = flags.project === 'true'
    ? [projectSkillTarget(process.cwd())]
    : resolveUserSkillTargets(agentIds);

  initMemory(aliveHome, persona, ROOT);
  for (const target of targets) {
    installSkillTo(target.dir, ROOT);
    process.stdout.write(`installed skill → ${target.dir} (${target.reason})\n`);
  }
  process.stdout.write(`memory → ${path.join(aliveHome, 'personas', persona)}\n`);
  process.stdout.write(`env    → ${path.join(aliveHome, '.env')}\n`);
  const creds = harvestHostLlm(os.homedir(), agentIds);
  if (creds) {
    process.stdout.write(`llm    → reused from ${creds.source} (no extra LLM_API_KEY needed)\n`);
  } else {
    process.stdout.write('\nNext: add LLM_API_KEY to .env if you want scripted heartbeats.\n');
    process.stdout.write('Hermes / OpenClaw users can skip this — Alive reuses that host key.\n');
  }
  process.stdout.write('Then open the host agent and talk to the persona, or run `alive tick`.\n');
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

function loadVoiceStack() {
  ensureBuilt();
  return require(path.join(ROOT, 'dist-alive', 'scripts', 'voice', 'stack.js'));
}

async function cmdVoice(flags) {
  const stack = loadVoiceStack();
  if (flags.check === 'true') return stack.printVoiceCheck();
  return stack.startVoiceStack({ livekitDev: flags['livekit-dev'] === 'true' });
}

async function cmdStart() {
  const host = ensureBuilt();
  const stack = loadVoiceStack();
  await stack.startVoiceStack();
  process.stdout.write('alive start — hourly tick + voice stack (Ctrl+C to stop)\n');
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
  const targets = host.install.allUserSkillTargets();
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
  if (cmd === 'voice') return cmdVoice(flags);
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
