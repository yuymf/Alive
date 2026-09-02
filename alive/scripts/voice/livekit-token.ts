import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';
import { agentName } from './config';

export interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

export function readLiveKitConfig(): LiveKitConfig | null {
  const url = (process.env.LIVEKIT_URL || '').trim();
  const apiKey = (process.env.LIVEKIT_API_KEY || process.env.LIVEKIT_KEY || '').trim();
  const apiSecret = (process.env.LIVEKIT_API_SECRET || process.env.LIVEKIT_SECRET || '').trim();
  if (!url || !apiKey || !apiSecret) return null;
  return { url, apiKey, apiSecret };
}

export function livekitConfigured(): boolean {
  return readLiveKitConfig() !== null;
}

export function livekitHttpHost(url: string): string {
  return url.replace(/^ws/i, 'http');
}

export async function dispatchVoiceAgent(
  cfg: LiveKitConfig,
  room: string,
  name = agentName(),
): Promise<boolean> {
  try {
    const client = new AgentDispatchClient(livekitHttpHost(cfg.url), cfg.apiKey, cfg.apiSecret);
    await client.createDispatch(room, name);
    return true;
  } catch (err) {
    console.warn(`[voice] dispatch ${name} skipped: ${(err as Error).message}`);
    return false;
  }
}

export async function createRoomAndToken(opts: {
  roomBase?: string;
  identity?: string;
  name?: string;
}): Promise<{ token: string; room: string; identity: string; livekit_url: string; dispatched: boolean }> {
  const cfg = readLiveKitConfig();
  if (!cfg) throw new Error('LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET 未配置');

  const identity = opts.identity || `owner-${Math.random().toString(36).slice(2, 8)}`;
  const room = `${opts.roomBase || 'alive-room'}-${Math.random().toString(16).slice(2, 6)}`;
  const host = livekitHttpHost(cfg.url);

  try {
    const rooms = new RoomServiceClient(host, cfg.apiKey, cfg.apiSecret);
    await rooms.createRoom({ name: room });
  } catch (err) {
    const msg = (err as Error).message || '';
    if (!/already|409/i.test(msg)) {
      console.warn(`[voice] createRoom skipped: ${msg}`);
    }
  }

  const dispatched = await dispatchVoiceAgent(cfg, room);

  const access = new AccessToken(cfg.apiKey, cfg.apiSecret, {
    identity,
    name: opts.name || identity,
    ttl: '2h',
  });
  access.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
  const token = await access.toJwt();

  return { token, room, identity, livekit_url: cfg.url, dispatched };
}
