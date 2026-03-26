import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import YAML from 'yaml';
import { regularTick } from '../scripts/lifecycle/heartbeat-tick';
import { PATHS, readJSON, setBasePaths, resetBasePaths, writeJSON } from '../scripts/utils/file-utils';
import { clearTimeOverride, setTimeOverride } from '../scripts/utils/time-utils';
import { clearPersonaCache } from '../scripts/persona/persona-loader';
import { clearRouteTable } from '../scripts/router/skill-router';
import type { IntentPool, PersonaConfig } from '../scripts/utils/types';

let tmpDir: string;

const persona: PersonaConfig = {
  meta: { name: 'TestChar', tagline: '测试角色' },
  personality: { mbti: 'INFP', core_traits: ['creative'] },
  voice: { language: 'zh', style: '平静', sample_lines: [] },
  schedule: { wake_hour: 8, sleep_hour: 23, timezone: 'system', active_peaks: [14, 21] },
  features: {
    skill_discovery: false,
    random_events: false,
    social_graph: false,
    flow_states: false,
    procrastination: false,
    personality_drift: false,
    content_browse: false,
    emotion: false,
    intent: false,
    vitality: false,
    confidence: false,
    work_impulse: false,
  },
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-intent-feature-'));
  setBasePaths(tmpDir, tmpDir);
  fs.mkdirSync(path.join(tmpDir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'persona.yaml'), YAML.stringify(persona));
  fs.writeFileSync(path.join(tmpDir, 'templates', 'heartbeat-prompt.md'), 'heartbeat decision');
  setTimeOverride(new Date('2026-03-24T14:00:00'));
  clearPersonaCache();
  clearRouteTable();
});

afterEach(() => {
  clearTimeOverride();
  clearPersonaCache();
  clearRouteTable();
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('regularTick intent feature flag', () => {
  it('does not mutate the intent pool when features.intent is disabled', async () => {
    const initialPool: IntentPool = {
      intents: [{
        id: 'intent-1',
        category: 'produce',
        description: '写点东西',
        intensity: 4,
        source: 'accumulation',
        born_at: '2026-03-24T10:00:00.000Z',
        decay_rate: 0.5,
        satisfied_at: null,
        resistance: 2,
        skipped_count: 0,
        last_attempted: null,
      }],
      last_updated: null,
    };
    writeJSON(PATHS.intentPool, initialPool);

    const llm = {
      callJSON: async <T>() => ({
        inner_monologue: '',
        new_impulses: [],
        suppressed_intents: [],
        chosen_actions: [],
      }) as T,
      call: async () => '',
    };

    await regularTick(llm);

    const updatedPool = readJSON<IntentPool>(PATHS.intentPool, { intents: [], last_updated: null });
    expect(updatedPool.intents).toEqual(initialPool.intents);
  });
});
