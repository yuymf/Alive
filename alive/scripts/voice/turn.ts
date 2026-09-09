import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { callLLM } from '../utils/llm-client';
import { buildVoiceSystemPrompt } from './persona-prompt';
import { saveChatTurn } from '../host/chat';
import { getPersonaName } from '../utils/file-utils';

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

export async function runVoiceTurn(userText: string): Promise<{ reply: string; source?: string; offline?: boolean }> {
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
        `（电话实时通话中）对方刚说：${user}。请用你的电话口吻回复一到两句话。`,
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

  if (!reply) {
    const { loadVoiceLife } = require('./persona-prompt');
    const life = loadVoiceLife();
    reply = life.activity
      ? `在呢。我这边在${life.activity}，你说。`
      : '在呢。你说。';
    return { reply, offline: true, source: 'offline' };
  }

  try {
    saveChatTurn({ user, reply });
  } catch {
    // chat save needs memory; voice still answers
  }
  return { reply, source };
}
