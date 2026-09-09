import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { repoRootFromHere } from '../host/install';

export const DEFAULT_LIVEKIT_URL = 'ws://127.0.0.1:7880';
export const DEFAULT_LIVEKIT_KEY = 'devkey';
export const DEFAULT_LIVEKIT_SECRET = 'secret';
export const DEFAULT_AGENT_NAME = 'alive-voice';
export const DEFAULT_VOXCPM_URL = 'http://127.0.0.1:8000';
export const DEFAULT_WORKER_PORT = 8081;
export const DEFAULT_VOICE_PORT = 8766;

export interface VoiceStackStatus {
  livekit: boolean;
  livekitUrl: string;
  agentName: string;
  voxcpm: boolean;
  voxcpmUrl: string;
  voxcpmVoice: string;
  voiceSample: boolean;
  stt: string;
  llm: boolean;
  worker: boolean;
  workerPort: number;
  voicePort: number;
  agentScript: string;
}

export function agentName(): string {
  return (process.env.AGENT_NAME || DEFAULT_AGENT_NAME).trim() || DEFAULT_AGENT_NAME;
}

export function voxcpmUrl(): string {
  return (process.env.VOXCPM_URL || DEFAULT_VOXCPM_URL).replace(/\/+$/, '');
}

export function voxcpmVoice(): string {
  return (process.env.VOXCPM_VOICE || 'default').trim() || 'default';
}

export function workerPort(): number {
  return Number(process.env.LIVEKIT_WORKER_PORT || DEFAULT_WORKER_PORT);
}

export function voicePort(): number {
  return Number(process.env.ALIVE_VOICE_PORT || DEFAULT_VOICE_PORT);
}

export function sttProvider(): string {
  const named = (process.env.STT_PROVIDER || '').trim().toLowerCase();
  if (named) return named;
  if ((process.env.CARTESIA_API_KEY || '').trim()) return 'cartesia';
  if ((process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '').trim()) return 'openai';
  return 'none';
}

export function findVoiceAgentScript(root = repoRootFromHere()): string {
  const candidates = [
    path.join(root, 'alive', 'voice', 'agent', 'agent.py'),
    path.resolve(__dirname, '..', '..', 'voice', 'agent', 'agent.py'),
    path.resolve(__dirname, '..', '..', '..', 'alive', 'voice', 'agent', 'agent.py'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return candidates[0];
}

export function portOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(400);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

export async function probeHttp(url: string, timeoutMs = 800): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

export async function probeVoxCpm(url = voxcpmUrl()): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if ((parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') && port) {
      if (!(await portOpen(port, parsed.hostname))) return false;
    }
  } catch {
    return false;
  }
  const base = url.replace(/\/+$/, '');
  if (await probeHttp(`${base}/health`, 400)) return true;
  return probeHttp(`${base}/v1/models`, 400);
}

export async function readVoiceStackStatus(): Promise<VoiceStackStatus> {
  const { readLiveKitConfig } = await import('./livekit-token');
  const cfg = readLiveKitConfig();
  const voxUrl = voxcpmUrl();
  const wPort = workerPort();
  let livekitUp = Boolean(cfg);
  if (cfg) {
    try {
      const parsed = new URL(cfg.url.replace(/^ws/i, 'http'));
      const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
      if ((parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') && port) {
        livekitUp = await portOpen(port, parsed.hostname);
      }
    } catch {
      livekitUp = false;
    }
  }
  const { hasVoiceSample } = await import('./voice-setup');
  const vVoice = voxcpmVoice();
  return {
    livekit: livekitUp,
    livekitUrl: cfg?.url || '',
    agentName: agentName(),
    voxcpm: await probeVoxCpm(voxUrl),
    voxcpmUrl: voxUrl,
    voxcpmVoice: vVoice,
    voiceSample: hasVoiceSample(vVoice),
    stt: sttProvider(),
    llm: Boolean((process.env.LLM_API_KEY || '').trim()),
    worker: await portOpen(wPort),
    workerPort: wPort,
    voicePort: voicePort(),
    agentScript: findVoiceAgentScript(),
  };
}

export function formatVoiceCheck(status: VoiceStackStatus): string {
  const row = (ok: boolean, label: string, detail: string) =>
    `${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`;
  return [
    '## Alive 通话栈',
    '',
    row(status.livekit, 'LiveKit', status.livekit ? status.livekitUrl : '未配置 LIVEKIT_URL / KEY / SECRET'),
    row(status.voxcpm, 'VoxCPM', status.voxcpm ? `${status.voxcpmUrl} voice=${status.voxcpmVoice}${status.voiceSample ? ' (已载入克隆样本)' : ' (默认音色)'}` : `${status.voxcpmUrl} 无响应`),
    row(status.stt !== 'none', 'STT', status.stt === 'none' ? '需要 CARTESIA_API_KEY 或 OPENAI_API_KEY' : status.stt),
    row(status.llm, 'LLM', status.llm ? (process.env.LLM_MODEL || '已配置') : '需要 Hermes/OpenClaw 宿主 key 或 LLM_API_KEY'),
    row(status.worker, 'Agent worker', status.worker ? `127.0.0.1:${status.workerPort}` : `还没起来（${status.agentName}）`),
    row(true, '通话页', `http://127.0.0.1:${status.voicePort}`),
    '',
    '手把手：打开仓库根目录的 USAGE.md。',
  ].join('\n');
}
