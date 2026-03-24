// alive/sub-skills/voice-tts/scripts/tts-provider.ts
// TTS provider abstraction layer — supports Noiz (cloud) and Kokoro (local).
//
// Phase 1: Noiz via HTTP API (Guest Mode, no API key needed).
// Phase 2: Kokoro local backend, ref_audio voice cloning.

const NOIZ_API_BASE = 'https://api.noiz.ai/v1';
const NOIZ_GUEST_ENDPOINT = `${NOIZ_API_BASE}/tts/guest`;
const NOIZ_AUTH_ENDPOINT = `${NOIZ_API_BASE}/tts/synthesize`;
const DEFAULT_VOICE_ID = 'zf_xiaoni';
const DEFAULT_LANG = 'zh';
const DEFAULT_SPEED = 1.0;
const TTS_TIMEOUT_MS = 15_000;

// ── Types ────────────────────────────────────────────────────────

export interface TTSOptions {
  provider: 'noiz' | 'kokoro';
  voiceId?: string;
  refAudio?: string;        // Phase 2: voice cloning reference
  lang?: string;
  speed?: number;
  emotion?: Record<string, number>;  // e.g. { Joy: 0.6, Tenderness: 0.3 }
}

export interface TTSResult {
  audioBuffer: Buffer;
  format: 'mp3' | 'opus' | 'wav';
  durationMs?: number;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Synthesize speech from text using the configured TTS provider.
 * Returns audio data as a Buffer.
 */
export async function synthesize(text: string, opts: TTSOptions): Promise<TTSResult> {
  if (!text.trim()) {
    throw new Error('[tts-provider] Empty text — nothing to synthesize');
  }

  switch (opts.provider) {
    case 'noiz':
      return synthesizeNoiz(text, opts);
    case 'kokoro':
      return synthesizeKokoro(text, opts);
    default:
      throw new Error(`[tts-provider] Unknown provider: ${opts.provider}`);
  }
}

// ── Noiz Backend ─────────────────────────────────────────────────

/**
 * Noiz TTS via HTTP API.
 * Without NOIZ_API_KEY → Guest Mode (limited voices, shorter audio).
 * With NOIZ_API_KEY → Full Mode (all voices, cloning, longer audio).
 */
async function synthesizeNoiz(text: string, opts: TTSOptions): Promise<TTSResult> {
  const apiKey = process.env.NOIZ_API_KEY;
  const isGuest = !apiKey;
  const endpoint = isGuest ? NOIZ_GUEST_ENDPOINT : NOIZ_AUTH_ENDPOINT;

  const body: Record<string, unknown> = {
    text: text.slice(0, 500),  // Safety: limit text length
    voice_id: opts.voiceId ?? DEFAULT_VOICE_ID,
    language: opts.lang ?? DEFAULT_LANG,
    speed: opts.speed ?? DEFAULT_SPEED,
    format: 'mp3',
  };

  // Add emotion parameters if provided
  if (opts.emotion && Object.keys(opts.emotion).length > 0) {
    body.emotion = opts.emotion;
  }

  // Phase 2: voice cloning reference
  if (opts.refAudio && !isGuest) {
    body.ref_audio_path = opts.refAudio;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => '(no body)');
      throw new Error(`Noiz API HTTP ${res.status}: ${errorText.slice(0, 200)}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    if (audioBuffer.length < 100) {
      throw new Error(`Noiz API returned suspiciously small audio (${audioBuffer.length} bytes)`);
    }

    return {
      audioBuffer,
      format: 'mp3',
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`[tts-provider] Noiz API timeout after ${TTS_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Kokoro Backend (Phase 2 placeholder) ─────────────────────────

/**
 * Kokoro: local offline TTS.
 * Requires python3 + kokoro package installed locally.
 * Phase 2 implementation — currently throws not-implemented.
 */
async function synthesizeKokoro(_text: string, _opts: TTSOptions): Promise<TTSResult> {
  // TODO Phase 2: implement local Kokoro TTS via child_process
  // execFileSync('python3', ['tts.py', '-t', text, '--backend', 'kokoro', ...])
  throw new Error('[tts-provider] Kokoro backend not yet implemented (Phase 2)');
}
