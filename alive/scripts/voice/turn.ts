import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import YAML from 'yaml';
import { callLLM } from '../utils/llm-client';
import { buildVoiceSystemPrompt } from './persona-prompt';
import { saveChatTurn } from '../host/chat';
import { getPersonaName, loadAliveEnv } from '../utils/file-utils';

function findHermesBinary(): string | null {
  const custom = process.env.HERMES_BIN;
  if (custom && fs.existsSync(custom)) return custom;
  const localBin = path.join(os.homedir(), '.local', 'bin', 'hermes');
  if (fs.existsSync(localBin)) return localBin;
  return null;
}

function findHermesProfile(): string | null {
  if (process.env.HERMES_PROFILE) return process.env.HERMES_PROFILE;
  const profilesDir = path.join(os.homedir(), '.hermes', 'profiles');
  if (!fs.existsSync(profilesDir)) return null;
  const persona = getPersonaName().toLowerCase(); // e.g. "ace-taffy"
  const entries = fs.readdirSync(profilesDir);
  for (const entry of entries) {
    const norm = entry.toLowerCase();
    if (norm === persona || persona.includes(norm) || norm.includes(persona)) {
      return entry;
    }
  }
  if (entries.length === 1) return entries[0];
  return null;
}

function queryHermesOneShot(bin: string, profile: string, prompt: string, timeoutMs = 12000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-p', profile, '-z', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Hermes query timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) {
        resolve(out.trim());
      } else {
        reject(new Error(err.trim() || `Hermes exited with code ${code}`));
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

export interface VoiceTurnAction {
  skill: string;
  description: string;
  result?: unknown;
}

export interface VoiceTurnResult {
  reply: string;
  source?: string;
  offline?: boolean;
  error?: string;
  actions?: VoiceTurnAction[];
}

export async function runVoiceTurn(userText: string): Promise<VoiceTurnResult> {
  loadAliveEnv();
  const user = userText.trim();
  if (!user) return { reply: '嗯？' };

  let reply = '';
  let source = 'offline';

  const hermesBin = findHermesBinary();
  const hermesProfile = findHermesProfile();

  // 1. If Hermes profile configures a local provider (like LM Studio on 127.0.0.1), use fast direct call
  const initialKey = process.env.LLM_API_KEY;
  const initialBase = process.env.LLM_API_BASE;
  const initialModel = process.env.LLM_MODEL;
  let injectedLocal = false;

  if (hermesProfile && !initialKey) {
    try {
      const cfgPath = path.join(os.homedir(), '.hermes', 'profiles', hermesProfile, 'config.yaml');
      if (fs.existsSync(cfgPath)) {
        const doc = YAML.parse(fs.readFileSync(cfgPath, 'utf8'));
        const baseUrl = doc?.model?.base_url || doc?.model?.baseUrl;
        if (baseUrl && (baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost'))) {
          const probe = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(600) });
          if (probe.ok) {
            process.env.LLM_API_KEY = 'lm-studio';
            process.env.LLM_API_BASE = baseUrl;
            process.env.LLM_MODEL = doc?.model?.default || doc?.model?.model || 'gemma-4-e4b-it';
            injectedLocal = true;
          }
        }
      }
    } catch {}
  }

  // 2. Direct LLM call if credentials are available (takes 2-4s vs 18s of Hermes subshell)
  if (process.env.LLM_API_KEY) {
    try {
      const system = buildVoiceSystemPrompt();
      const result = await callLLM(`${system}\n\n对方刚说：${user}\n\n用电话口气回一句到两句。`, 'voice-turn', {
        system,
        temperature: 0.8,
      });
      reply = (result.content || '').trim();
      if (reply) source = `llm:${process.env.LLM_MODEL || 'local'}`;
    } catch (err) {
      console.warn(`[voice] callLLM error: ${(err as Error).message}`);
    }
  }

  if (injectedLocal) {
    if (!initialKey) delete process.env.LLM_API_KEY;
    if (!initialBase) delete process.env.LLM_API_BASE;
    if (!initialModel) delete process.env.LLM_MODEL;
  }

  // 3. Fallback to Hermes profile with a 12-second timeout
  if (!reply) {
    const hermesBin = findHermesBinary();
    const hermesProfile = findHermesProfile();
    if (hermesBin && hermesProfile) {
      try {
        reply = await queryHermesOneShot(
          hermesBin,
          hermesProfile,
          `（电话实时通话中）对方刚说：${user}。请用你的电话口吻回复一到两句话。`,
          12000,
        );
        if (reply) source = `hermes:${hermesProfile}`;
      } catch (err) {
        console.warn(`[voice] Hermes query failed: ${(err as Error).message}`);
      }
    }
  }

  // 4. In-character offline fallback
  if (!reply) {
    const { loadVoiceLife } = require('./persona-prompt');
    let life: any = {};
    try { life = loadVoiceLife(); } catch {}
    const isTaffy = (life.personaName || '').includes('塔菲') || getPersonaName().includes('taffy');
    if (isTaffy) {
      reply = '在呢在呢喵！你说呀，塔菲在听着呢~';
    } else {
      reply = life.activity
        ? `在呢。我这边在${life.activity}，你说。`
        : '在呢。你说。';
    }
    return { reply, offline: true, source: 'offline' };
  }

  try {
    saveChatTurn({ user, reply });
  } catch {
    // chat save needs memory; voice still answers
  }
  return { reply, source };
}
