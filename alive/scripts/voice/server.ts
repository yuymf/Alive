import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { loadAliveEnv, setPersonaName } from '../utils/file-utils';
import { createRoomAndToken, livekitConfigured, readLiveKitConfig } from './livekit-token';
import { buildVoiceSystemPrompt, findPersonaAvatarPath, loadVoiceLife } from './persona-prompt';
import { runVoiceTurn } from './turn';
import { formatVoiceCheck, readVoiceStackStatus } from './config';
import { resolveTeamMember } from './team';
import { clearPersonaCache } from '../persona/persona-loader';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.json': 'application/json; charset=utf-8',
};

export function findVoiceWebDir(): string {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'voice', 'web'),
    path.resolve(__dirname, '..', '..', '..', 'alive', 'voice', 'web'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  throw new Error('alive/voice/web/index.html not found');
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

function text(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function applyPersona(persona: string | undefined): { id: string; agent_name: string; voice: string; worker_port: number } {
  const member = resolveTeamMember(persona);
  setPersonaName(member.id);
  clearPersonaCache();
  return { id: member.id, agent_name: member.agent_name, voice: member.voice, worker_port: member.worker_port };
}

export function createVoiceServer(): http.Server {
  loadAliveEnv();
  const web = findVoiceWebDir();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    try {
      if (req.method === 'GET' && url.pathname === '/api/life') {
        const stack = await readVoiceStackStatus();
        let member;
        try {
          member = applyPersona(url.searchParams.get('persona') || undefined);
        } catch (err) {
          json(res, 400, { error: 'unknown-persona', message: (err as Error).message });
          return;
        }
        const life = loadVoiceLife();
        json(res, 200, {
          ok: true,
          ...stack,
          ...life,
          agent_name: member.agent_name,
          agentName: member.agent_name,
          workerPort: member.worker_port,
          persona: member.id,
          voice: member.voice,
          avatar: life.avatar ? `/api/avatar?persona=${encodeURIComponent(member.id)}` : undefined,
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/avatar') {
        try {
          applyPersona(url.searchParams.get('persona') || undefined);
        } catch (err) {
          json(res, 400, { error: 'unknown-persona', message: (err as Error).message });
          return;
        }
        const avatarPath = findPersonaAvatarPath();
        if (!avatarPath || !fs.existsSync(avatarPath)) {
          json(res, 404, { error: 'avatar not found' });
          return;
        }
        const ext = path.extname(avatarPath).toLowerCase();
        const mime = MIME[ext] || 'image/png';
        res.writeHead(200, {
          'Content-Type': mime,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=60',
        });
        fs.createReadStream(avatarPath).pipe(res);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/check') {
        const stack = await readVoiceStackStatus();
        text(res, 200, `${formatVoiceCheck(stack)}\n`);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/prompt') {
        try {
          applyPersona(url.searchParams.get('persona') || undefined);
        } catch (err) {
          json(res, 400, { error: 'unknown-persona', message: (err as Error).message });
          return;
        }
        text(res, 200, buildVoiceSystemPrompt());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        if (!livekitConfigured()) {
          json(res, 503, { error: 'livekit-not-configured', mode: 'direct' });
          return;
        }
        const raw = await readBody(req);
        const data = raw ? JSON.parse(raw) as { room?: string; identity?: string; name?: string; persona?: string } : {};
        const persona = data.persona || url.searchParams.get('persona') || undefined;
        let member;
        try {
          member = applyPersona(persona);
        } catch (err) {
          json(res, 400, { error: 'unknown-persona', persona, message: (err as Error).message });
          return;
        }
        const token = await createRoomAndToken({
          roomBase: data.room || `alive-${member.id}`,
          identity: data.identity,
          name: data.name || '主人',
          agentName: member.agent_name,
        });
        json(res, 200, { ...token, persona: member.id, voice: member.voice });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/turn') {
        const raw = await readBody(req);
        const data = raw ? JSON.parse(raw) as { text?: string } : {};
        try {
          const result = await runVoiceTurn(data.text || '');
          json(res, 200, result);
        } catch (err) {
          const life = loadVoiceLife();
          console.warn(`[voice] /api/turn error: ${(err as Error).message}`);
          json(res, 200, {
            reply: life.activity
              ? `在呢。我正在${life.activity}，你说。（提示: LLM 返回 ${(err as Error).message}）`
              : `在呢。你说。（提示: LLM 返回 ${(err as Error).message}）`,
            offline: true,
            error: (err as Error).message,
          });
        }
        return;
      }

      let rel = url.pathname === '/' ? '/index.html' : url.pathname;
      rel = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
      const file = path.join(web, rel);
      if (!file.startsWith(web) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        json(res, 404, { error: 'not found' });
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });

  return server;
}

export function startVoiceServer(port = Number(process.env.ALIVE_VOICE_PORT || 8766)): http.Server {
  const server = createVoiceServer();
  const host = (process.env.ALIVE_VOICE_HOST || '127.0.0.1').trim() || '127.0.0.1';
  server.listen(port, host, () => {
    const cfg = readLiveKitConfig();
    const display = host === '0.0.0.0' ? '127.0.0.1' : host;
    console.log(`[alive voice] http://${display}:${port} (bind ${host}) livekit=${cfg ? cfg.url : 'direct'}`);
  });
  return server;
}

if (typeof require !== 'undefined' && require.main === module) {
  startVoiceServer();
}
