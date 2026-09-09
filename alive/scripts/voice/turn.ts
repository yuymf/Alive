import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

function queryHermesOneShot(bin: string, profile: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-p', profile, '-z', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      if (code === 0 && out.trim()) {
        resolve(out.trim());
      } else {
        reject(new Error(err.trim() || `Hermes exited with code ${code}`));
      }
    });
    child.on('error', reject);
  });
}

const SENTENCE_END_PUNCT = /[。！？；!?;]/;

/**
 * 峰哥流式分句切片算法：按句子标点断句，切出完整短句并保留剩余未完成文本。
 * 可用于大模型流式生成时首句极速送入 TTS 合成，将首句延迟缩短至 1~1.5s。
 */
export function splitWithRemainder(text: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  let last = 0;
  for (let j = 0; j < text.length; j++) {
    if (SENTENCE_END_PUNCT.test(text[j])) {
      const s = text.slice(last, j + 1).trim();
      if (s) sentences.push(s);
      last = j + 1;
    }
  }
  return { sentences, remainder: text.slice(last) };
}

export const MAX_VOICE_CONTEXT = 20;

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

  // 1. If Hermes is available and configured, prefer Hermes profile directly
  // (reusing Hermes's credentials pool, memory, and persona without needing LLM_API_KEY)
  if (hermesBin && hermesProfile) {
    try {
      reply = await queryHermesOneShot(
        hermesBin,
        hermesProfile,
        `（实时电话通话中，对方刚说：${user}。请用你的人设口吻以一到两句简短口语回复。禁止客服腔、禁止列点、禁止客套废话）`,
      );
      if (reply) source = `hermes:${hermesProfile}`;
    } catch (err) {
      console.warn(`[voice] Hermes query failed, falling back to direct LLM: ${(err as Error).message}`);
    }
  }

  // 2. If Hermes wasn't used or failed, try standard callLLM
  if (!reply && process.env.LLM_API_KEY) {
    try {
      const system = buildVoiceSystemPrompt();
      const result = await callLLM(`${system}\n\n对方刚说：${user}\n\n用电话口气回一句到三句。`, 'voice-turn', {
        system,
        temperature: 0.8,
      });
      reply = (result.content || '').trim();
      if (reply) source = 'llm-api';
    } catch (err) {
      console.warn(`[voice] callLLM error: ${(err as Error).message}`);
    }
  }

  // 3. In-character offline fallback
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
