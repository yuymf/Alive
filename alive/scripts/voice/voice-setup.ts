import * as fs from 'fs';
import * as path from 'path';
import { getAliveHome } from '../utils/file-utils';
import { voxcpmUrl, voxcpmVoice } from './config';

export function getVoicesRootDir(): string {
  return process.env.VOXCPM_VOICE_DIR || path.join(getAliveHome(), 'voices');
}

export function getVoiceDir(name = voxcpmVoice()): string {
  return path.join(getVoicesRootDir(), name);
}

export function ensureVoiceDir(name = voxcpmVoice()): string {
  const dir = getVoiceDir(name);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function hasVoiceSample(name = voxcpmVoice()): boolean {
  const dir = getVoiceDir(name);
  const refWav = path.join(dir, 'ref.wav');
  if (!fs.existsSync(refWav)) return false;
  try {
    const stat = fs.statSync(refWav);
    return stat.isFile() && stat.size > 100;
  } catch {
    return false;
  }
}

export function getVoiceInfo(name = voxcpmVoice()): {
  name: string;
  hasSample: boolean;
  refPath: string;
  promptPath: string;
  promptText: string;
} {
  const dir = getVoiceDir(name);
  const refPath = path.join(dir, 'ref.wav');
  const promptPath = path.join(dir, 'prompt.txt');
  let promptText = '';
  if (fs.existsSync(promptPath)) {
    try {
      promptText = fs.readFileSync(promptPath, 'utf8').trim();
    } catch {}
  }
  return {
    name,
    hasSample: hasVoiceSample(name),
    refPath,
    promptPath,
    promptText,
  };
}

/**
 * If VoxCPM server is running, register the voice via POST /v1/voices
 */
export async function registerVoiceToVoxCpm(
  name: string,
  wavPath: string,
  promptText = '',
  serverUrl = voxcpmUrl(),
): Promise<boolean> {
  try {
    const url = `${serverUrl.replace(/\/+$/, '')}/v1/voices`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        wav_path: wavPath,
        prompt_text: promptText,
      }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}
