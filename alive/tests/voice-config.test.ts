import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_NAME, formatVoiceCheck, sttProvider, voxcpmUrl } from '../scripts/voice/config';

describe('voice config', () => {
  const prev = { ...process.env };

  afterEach(() => {
    for (const key of ['STT_PROVIDER', 'CARTESIA_API_KEY', 'OPENAI_API_KEY', 'LLM_API_KEY', 'VOXCPM_URL']) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  });

  it('defaults VoxCPM URL and agent name', () => {
    delete process.env.VOXCPM_URL;
    expect(voxcpmUrl()).toBe('http://127.0.0.1:8000');
    expect(DEFAULT_AGENT_NAME).toBe('alive-voice');
  });

  it('picks STT from keys', () => {
    delete process.env.STT_PROVIDER;
    delete process.env.CARTESIA_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.LLM_API_KEY;
    expect(sttProvider()).toBe('none');
    process.env.CARTESIA_API_KEY = 'ck';
    expect(sttProvider()).toBe('cartesia');
  });

  it('formats a check list', () => {
    const text = formatVoiceCheck({
      livekit: true,
      livekitUrl: 'ws://127.0.0.1:7880',
      agentName: 'alive-voice',
      voxcpm: false,
      voxcpmUrl: 'http://127.0.0.1:8000',
      voxcpmVoice: 'default',
      stt: 'none',
      llm: false,
      worker: false,
      workerPort: 8081,
      voicePort: 8766,
      agentScript: '/tmp/agent.py',
    });
    expect(text).toContain('LiveKit');
    expect(text).toContain('VoxCPM');
    expect(text).toContain('USAGE.md');
    expect(text).toContain('✗');
  });
});

describe('livekit host', () => {
  it('maps ws to http for RoomService', async () => {
    const { livekitHttpHost } = await import('../scripts/voice/livekit-token');
    expect(livekitHttpHost('ws://127.0.0.1:7880')).toBe('http://127.0.0.1:7880');
    expect(livekitHttpHost('wss://example.livekit.cloud')).toBe('https://example.livekit.cloud');
  });
});
