import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { initMemory, repoRootFromHere } from '../scripts/host/install';
import { writePresence } from '../scripts/host/presence';
import { clearPersonaCache } from '../scripts/persona/persona-loader';
import { resetBasePaths, setPersonaName } from '../scripts/utils/file-utils';
import { createVoiceServer } from '../scripts/voice/server';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve(addr.port);
    });
    server.on('error', reject);
  });
}

async function json(port: number, pathname: string, opts: { method?: string; body?: unknown } = {}) {
  const resp = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: resp.status, body: await resp.json() as Record<string, unknown> };
}

describe('voice server', () => {
  const prevUserHome = process.env.HOME;
  const prevHome = process.env.ALIVE_HOME;
  const prevPersona = process.env.ALIVE_PERSONA;
  const prevKey = process.env.LLM_API_KEY;
  const prevLivekit = {
    url: process.env.LIVEKIT_URL,
    key: process.env.LIVEKIT_API_KEY,
    secret: process.env.LIVEKIT_API_SECRET,
  };
  let tmp = '';
  let server: http.Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    if (prevUserHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevUserHome;
    if (prevHome === undefined) delete process.env.ALIVE_HOME;
    else process.env.ALIVE_HOME = prevHome;
    if (prevPersona === undefined) delete process.env.ALIVE_PERSONA;
    else process.env.ALIVE_PERSONA = prevPersona;
    if (prevKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = prevKey;
    if (prevLivekit.url === undefined) delete process.env.LIVEKIT_URL;
    else process.env.LIVEKIT_URL = prevLivekit.url;
    if (prevLivekit.key === undefined) delete process.env.LIVEKIT_API_KEY;
    else process.env.LIVEKIT_API_KEY = prevLivekit.key;
    if (prevLivekit.secret === undefined) delete process.env.LIVEKIT_API_SECRET;
    else process.env.LIVEKIT_API_SECRET = prevLivekit.secret;
    resetBasePaths();
    clearPersonaCache();
  });

  function boot() {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-voice-'));
    process.env.HOME = tmp;
    process.env.ALIVE_HOME = tmp;
    delete process.env.ALIVE_PERSONA;
    delete process.env.LLM_API_KEY;
    delete process.env.LIVEKIT_URL;
    delete process.env.STT_PROVIDER;
    delete process.env.CARTESIA_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    resetBasePaths();
    setPersonaName('minase');
    clearPersonaCache();
    initMemory(tmp, 'minase', repoRootFromHere());
    writePresence({
      activity: '在阳台上修图',
      inner: '这光还能再暖一点',
      schedule: [{ time: '16:00', activity: '自拍' }],
    });
  }

  it('GET /api/life returns persona, presence, and livekit=false', async () => {
    boot();
    server = createVoiceServer();
    const port = await listen(server);
    const { status, body } = await json(port, '/api/life');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.livekit).toBe(false);
    expect(body.personaName).toBe('水瀬');
    expect(body.activity).toBe('在阳台上修图');
    expect((body.schedule as Array<{ activity: string }>)[0].activity).toBe('自拍');
    expect(body.voxcpm).toBe(false);
    expect(body.stt).toBe('none');
  });

  it('GET /api/prompt returns the voice system prompt', async () => {
    boot();
    server = createVoiceServer();
    const port = await listen(server);
    const resp = await fetch(`http://127.0.0.1:${port}/api/prompt`);
    const prompt = await resp.text();
    expect(resp.status).toBe(200);
    expect(prompt).toContain('水瀬');
    expect(prompt).toContain('实时语音');
  });

  it('GET /api/check lists the voice stack', async () => {
    boot();
    server = createVoiceServer();
    const port = await listen(server);
    const resp = await fetch(`http://127.0.0.1:${port}/api/check`);
    const text = await resp.text();
    expect(resp.status).toBe(200);
    expect(text).toContain('LiveKit');
    expect(text).toContain('VoxCPM');
    expect(text).toContain('USAGE.md');
  });

  it('POST /token is 503 when LiveKit is not configured', async () => {
    boot();
    server = createVoiceServer();
    const port = await listen(server);
    const { status, body } = await json(port, '/token', { method: 'POST', body: {} });
    expect(status).toBe(503);
    expect(body.error).toBe('livekit-not-configured');
    expect(body.mode).toBe('direct');
  });

  it('POST /api/turn answers offline without LLM_API_KEY', async () => {
    boot();
    server = createVoiceServer();
    const port = await listen(server);
    const { status, body } = await json(port, '/api/turn', { method: 'POST', body: { text: '在吗' } });
    expect(status).toBe(200);
    expect(body.offline).toBe(true);
    expect(String(body.reply)).toContain('在阳台上修图');
  });

  it('GET / serves the call page', async () => {
    boot();
    server = createVoiceServer();
    const port = await listen(server);
    const resp = await fetch(`http://127.0.0.1:${port}/`);
    const html = await resp.text();
    expect(resp.status).toBe(200);
    expect(html).toContain('micButton');
    expect(html).toContain('LiveKit');
    expect(html).toContain('/api/life');
  });
});
