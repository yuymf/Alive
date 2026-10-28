import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_FLOW_STATE } from '../utils/types';

function writeIfMissing(filePath: string, data: unknown): void {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** Seed the files `alive status` and the first heartbeat need. */
export function seedPersonaMemory(memoryRoot: string): void {
  const now = new Date().toISOString();
  writeIfMissing(path.join(memoryRoot, 'state', 'emotion-state.json'), {
    mood: { valence: 0.2, arousal: 0.4, description: 'baseline' },
    energy: 0.5,
    stress: 0.2,
    creativity: 0.4,
    sociability: 0.4,
    last_updated: now,
    recent_cause: 'init',
    momentum: { valence: 0, arousal: 0, energy: 0, stress: 0, creativity: 0, sociability: 0, duration_ticks: 0 },
    undertone: {
      valence: 0.2,
      arousal: 0.4,
      energy: 0.5,
      stress: 0.2,
      creativity: 0.4,
      sociability: 0.4,
    },
  });
  writeIfMissing(path.join(memoryRoot, 'state', 'vitality-state.json'), {
    vitality: 100,
    last_updated: now,
    consecutive_low_days: 0,
  });
  writeIfMissing(path.join(memoryRoot, 'state', 'confidence-state.json'), {
    confidence: 1,
    streak: 0,
    last_updated: now,
  });
  writeIfMissing(path.join(memoryRoot, 'state', 'flow-state.json'), DEFAULT_FLOW_STATE);
  writeIfMissing(path.join(memoryRoot, 'queues', 'intent-pool.json'), {
    intents: [],
    last_updated: now,
  });
  writeIfMissing(path.join(memoryRoot, 'queues', 'heartbeat-log.json'), { logs: [] });
  const diary = path.join(memoryRoot, 'diary.md');
  if (!fs.existsSync(diary)) fs.writeFileSync(diary, '', 'utf8');
}

export function upsertEnvFile(envPath: string, updates: Record<string, string>): void {
  const current: Record<string, string> = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      current[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  }
  const merged = { ...current, ...updates };
  const body = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, body, 'utf8');
  try {
    fs.chmodSync(envPath, 0o600);
  } catch {
    // best-effort on platforms without chmod
  }
}
