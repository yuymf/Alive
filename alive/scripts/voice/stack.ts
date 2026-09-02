import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { repoRootFromHere } from '../host/install';
import { loadAliveEnv } from '../utils/file-utils';
import {
  DEFAULT_LIVEKIT_KEY,
  DEFAULT_LIVEKIT_SECRET,
  DEFAULT_LIVEKIT_URL,
  findVoiceAgentScript,
  formatVoiceCheck,
  portOpen,
  readVoiceStackStatus,
  voxcpmUrl,
  workerPort,
} from './config';
import { readLiveKitConfig } from './livekit-token';
import { startVoiceServer } from './server';

function which(bin: string): string | null {
  const result = spawnSync('which', [bin], { encoding: 'utf8' });
  const loc = (result.stdout || '').trim();
  return result.status === 0 && loc ? loc : null;
}

function pythonBin(): string | null {
  return which('python3') || which('python');
}

function isLocalLiveKit(url: string): boolean {
  return /127\.0\.0\.1:7880|localhost:7880/.test(url);
}

export function applyLocalLiveKitDevEnv(): void {
  if ((process.env.LIVEKIT_URL || '').trim()) return;
  process.env.LIVEKIT_URL = DEFAULT_LIVEKIT_URL;
  process.env.LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || DEFAULT_LIVEKIT_KEY;
  process.env.LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || DEFAULT_LIVEKIT_SECRET;
}

function startChild(label: string, command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  child.on('exit', (code) => {
    if (code && code !== 0) console.error(`[alive voice] ${label} exited ${code}`);
  });
  return child;
}

export async function printVoiceCheck(): Promise<string> {
  loadAliveEnv();
  const status = await readVoiceStackStatus();
  const text = formatVoiceCheck(status);
  process.stdout.write(`${text}\n`);
  return text;
}

export async function startVoiceStack(opts: { checkOnly?: boolean; livekitDev?: boolean } = {}): Promise<void> {
  loadAliveEnv();
  if (opts.livekitDev) applyLocalLiveKitDevEnv();

  if (opts.checkOnly) {
    await printVoiceCheck();
    return;
  }

  const children: ChildProcess[] = [];
  const cfg = readLiveKitConfig();

  if (cfg && isLocalLiveKit(cfg.url) && !(await portOpen(7880))) {
    const livekit = which('livekit-server');
    if (livekit) {
      console.log('[alive voice] starting livekit-server --dev');
      children.push(startChild('livekit-server', livekit, ['--dev', '--bind', '127.0.0.1']));
    } else {
      console.warn('[alive voice] livekit-server 不在 PATH。macOS: brew install livekit。见 USAGE.md');
    }
  }

  const py = pythonBin();
  const agent = findVoiceAgentScript();
  if (cfg && py && fs.existsSync(agent)) {
    const wPort = workerPort();
    if (!(await portOpen(wPort))) {
      console.log(`[alive voice] starting LiveKit agent ${path.basename(agent)}`);
      children.push(startChild('agent', py, [agent, 'start'], {
        LIVEKIT_URL: cfg.url,
        LIVEKIT_API_KEY: cfg.apiKey,
        LIVEKIT_API_SECRET: cfg.apiSecret,
        AGENT_NAME: process.env.AGENT_NAME || 'alive-voice',
        ALIVE_VOICE_URL: `http://127.0.0.1:${process.env.ALIVE_VOICE_PORT || '8766'}`,
        VOXCPM_URL: voxcpmUrl(),
      }));
    }
  } else if (cfg && !py) {
    console.warn('[alive voice] 没找到 python3，LiveKit Agent 起不来。见 USAGE.md 第 5 节。');
  } else if (cfg && !fs.existsSync(agent)) {
    console.warn(`[alive voice] 找不到 agent.py: ${agent}`);
  }

  startVoiceServer();
  const root = repoRootFromHere();
  const usage = path.join(root, 'USAGE.md');
  console.log(`[alive voice] 配置说明 ${fs.existsSync(usage) ? usage : 'USAGE.md'}`);

  const stop = () => {
    for (const child of children) {
      if (!child.killed) child.kill('SIGTERM');
    }
  };
  process.on('SIGINT', () => {
    stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stop();
    process.exit(0);
  });
}
