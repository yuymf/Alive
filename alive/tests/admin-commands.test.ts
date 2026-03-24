// alive/tests/admin-commands.test.ts
// Tests for the /alive slash-command handler

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import YAML from 'yaml';
import { parseCommand, handleCommand, dispatch } from '../scripts/admin/command-handler';
import type { ParsedCommand } from '../scripts/admin/command-handler';
import { setBasePaths, resetBasePaths, PATHS, writeJSON, readJSON } from '../scripts/utils/file-utils';
import { clearPersonaCache } from '../scripts/persona/persona-loader';
import type { EmotionState, VitalityState, FlowState, IntentPool, WisdomStore, HeartbeatLog } from '../scripts/utils/types';
import { DEFAULT_MOMENTUM, DEFAULT_UNDERTONE, DEFAULT_FLOW_STATE } from '../scripts/utils/types';

// ── Sandbox Setup ──────────────────────────────────────────────────

let tmpDir: string;
let memoryDir: string;
let skillDir: string;

function makeTestEmotion(overrides: Partial<EmotionState> = {}): EmotionState {
  return {
    mood: { valence: 0.3, arousal: 0.5, description: 'calm' },
    energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
    last_updated: '2026-03-24T10:00:00Z', recent_cause: 'test',
    momentum: { ...DEFAULT_MOMENTUM },
    undertone: { ...DEFAULT_UNDERTONE },
    impulse_history: [], consecutive_high_stress: 0, threshold_break_cooldown: 0,
    ...overrides,
  };
}

const TEST_PERSONA_YAML = `
meta:
  name: "TestChar"
  name_reading: "testchar"
  id: "testchar"
  age: 20
  tagline: "Test character"
personality:
  mbti: "ENFP"
  core_traits: ["curious", "creative"]
voice:
  language: "zh-CN"
  style: "活泼"
  sample_lines: ["嗨！"]
schedule:
  wake_hour: 9
  sleep_hour: 1
  timezone: "Asia/Tokyo"
  active_peaks: [14, 21]
sub_skills:
  - web-search
  - instagram
platform_config:
  instagram:
    follower_baseline: 2500
    avg_engagement: 150
`;

const TEST_SCHEMA_YAML = `
mbti_baselines:
  ENFP: { valence: 0.4, arousal: 0.6, energy: 0.5, stress: 0.2, creativity: 0.6, sociability: 0.7 }
  default: { valence: 0.2, arousal: 0.4, energy: 0.5, stress: 0.2, creativity: 0.4, sociability: 0.4 }
`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-admin-test-'));
  memoryDir = path.join(tmpDir, 'memory');
  skillDir = path.join(tmpDir, 'skill');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(path.join(memoryDir, 'relations'), { recursive: true });

  // Write test persona
  fs.writeFileSync(path.join(skillDir, 'persona.yaml'), TEST_PERSONA_YAML);
  fs.writeFileSync(path.join(skillDir, 'persona-schema.yaml'), TEST_SCHEMA_YAML);

  // Create empty sub-skills dirs for testing
  fs.mkdirSync(path.join(skillDir, 'sub-skills', 'web-search'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'sub-skills', 'web-search', 'manifest.json'), '{"name":"web-search"}');

  setBasePaths(memoryDir, skillDir);
  clearPersonaCache();
});

afterEach(() => {
  resetBasePaths();
  clearPersonaCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Parser Tests ───────────────────────────────────────────────────

describe('parseCommand', () => {
  it('parses /alive status', () => {
    const cmd = parseCommand('/alive status');
    expect(cmd.subcommand).toBe('status');
    expect(cmd.args).toEqual([]);
    expect(cmd.flags).toEqual({});
  });

  it('parses /alive:status (colon format)', () => {
    const cmd = parseCommand('/alive:status');
    expect(cmd.subcommand).toBe('status');
  });

  it('parses bare /alive as help', () => {
    const cmd = parseCommand('/alive');
    expect(cmd.subcommand).toBe('help');
  });

  it('parses flags', () => {
    const cmd = parseCommand('/alive schedule --wake 9 --sleep 1');
    expect(cmd.subcommand).toBe('schedule');
    expect(cmd.flags.wake).toBe('9');
    expect(cmd.flags.sleep).toBe('1');
  });

  it('parses boolean flags', () => {
    const cmd = parseCommand('/alive emotion --reset');
    expect(cmd.subcommand).toBe('emotion');
    expect(cmd.flags.reset).toBe('true');
  });

  it('parses positional args', () => {
    const cmd = parseCommand('/alive reset emotion');
    expect(cmd.subcommand).toBe('reset');
    expect(cmd.args).toEqual(['emotion']);
  });

  it('handles quoted values', () => {
    const cmd = parseCommand('/alive schedule --timezone "America/New_York"');
    expect(cmd.flags.timezone).toBe('America/New_York');
  });
});

// ── Help ───────────────────────────────────────────────────────────

describe('/alive help', () => {
  it('returns help text', () => {
    const result = dispatch('/alive help');
    expect(result.output).toContain('Admin Commands');
    expect(result.output).toContain('/alive status');
    expect(result.error).toBeUndefined();
  });

  it('bare /alive returns help', () => {
    const result = dispatch('/alive');
    expect(result.output).toContain('Admin Commands');
  });
});

// ── Status ─────────────────────────────────────────────────────────

describe('/alive status', () => {
  it('returns full status when data exists', () => {
    writeJSON(PATHS.emotionState, makeTestEmotion());
    writeJSON(PATHS.vitalityState, { vitality: 80, last_updated: null, consecutive_low_days: 0 });
    writeJSON(PATHS.confidenceState, { confidence: 1.1, streak: 3, last_updated: null });
    writeJSON(PATHS.flowState, { ...DEFAULT_FLOW_STATE });

    const result = dispatch('/alive status');
    expect(result.output).toContain('TestChar');
    expect(result.output).toContain('ENFP');
    expect(result.output).toContain('wake 9:00');
    expect(result.error).toBeUndefined();
  });

  it('handles missing emotion gracefully', () => {
    const result = dispatch('/alive status');
    expect(result.output).toContain('TestChar');
    // Should not throw
  });
});

// ── Emotion ────────────────────────────────────────────────────────

describe('/alive emotion', () => {
  it('returns emotion details', () => {
    writeJSON(PATHS.emotionState, makeTestEmotion({
      impulse_history: [{
        delta: { valence: 0.1 },
        cause: 'test impulse',
        importance: 5,
        timestamp: '2026-03-24T10:00:00Z',
        tick_age: 0,
      }],
    }));

    const result = dispatch('/alive emotion');
    expect(result.output).toContain('Emotion Detail');
    expect(result.output).toContain('Valence');
    expect(result.output).toContain('test impulse');
  });

  it('returns warning when no emotion state', () => {
    const result = dispatch('/alive emotion');
    expect(result.output).toContain('No emotion state found');
  });

  it('resets emotion to MBTI baseline with --reset', () => {
    writeJSON(PATHS.emotionState, makeTestEmotion({ mood: { valence: -0.8, arousal: 0.9, description: 'very bad' } }));

    const result = dispatch('/alive emotion --reset');
    expect(result.output).toContain('ENFP baseline');

    const updated = readJSON<EmotionState>(PATHS.emotionState, null as unknown as EmotionState);
    expect(updated.mood.valence).toBe(0.4); // ENFP baseline
    expect(updated.mood.arousal).toBe(0.6);
    expect(updated.recent_cause).toBe('admin reset via /alive');
  });
});

// ── Schedule ───────────────────────────────────────────────────────

describe('/alive schedule', () => {
  it('shows current schedule', () => {
    const result = dispatch('/alive schedule');
    expect(result.output).toContain('9:00');
    expect(result.output).toContain('Asia/Tokyo');
  });

  it('modifies wake and sleep hours', () => {
    const result = dispatch('/alive schedule --wake 7 --sleep 23');
    expect(result.output).toContain('wake_hour → 7');
    expect(result.output).toContain('sleep_hour → 23');

    // Verify persona.yaml was updated
    clearPersonaCache();
    const raw = fs.readFileSync(path.join(skillDir, 'persona.yaml'), 'utf8');
    const updated = YAML.parse(raw);
    expect(updated.schedule.wake_hour).toBe(7);
    expect(updated.schedule.sleep_hour).toBe(23);
  });

  it('modifies timezone', () => {
    const result = dispatch('/alive schedule --timezone "America/New_York"');
    expect(result.output).toContain('America/New_York');
  });

  it('rejects invalid wake hour', () => {
    const result = dispatch('/alive schedule --wake 25');
    expect(result.error).toBe(true);
    expect(result.output).toContain('Invalid');
  });

  it('creates backup before modifying', () => {
    dispatch('/alive schedule --wake 7');
    expect(fs.existsSync(path.join(skillDir, 'persona.yaml.bak'))).toBe(true);
  });
});

// ── Skills ─────────────────────────────────────────────────────────

describe('/alive skills', () => {
  it('lists sub-skills with status', () => {
    const result = dispatch('/alive skills');
    expect(result.output).toContain('web-search');
    expect(result.output).toContain('✅ installed');
    expect(result.output).toContain('instagram');
    expect(result.output).toContain('⚠️ not found');
  });
});

// ── Platform ───────────────────────────────────────────────────────

describe('/alive platform', () => {
  it('shows platform config', () => {
    const result = dispatch('/alive platform');
    expect(result.output).toContain('instagram');
    expect(result.output).toContain('2500');
  });
});

// ── Memory ─────────────────────────────────────────────────────────

describe('/alive memory', () => {
  it('returns memory stats', () => {
    // Create some test data
    fs.writeFileSync(path.join(memoryDir, 'diary.md'), '## 2026-03-23\n### 10:00\nTest entry\n## 2026-03-24\n### 09:00\nAnother\n');
    writeJSON(PATHS.coreWisdom, { version: 1, wisdom: [{ id: 'w1', lesson: 'test', source: 'test', date: '2026-03-24', importance: 8, tags: [] }], total_importance_since_reflection: 8 });
    writeJSON(PATHS.heartbeatLog, { logs: [{ timestamp: '2026-03-24T10:00:00Z', type: 'regular', status: 'completed' }], retention_days: 30 });
    writeJSON(PATHS.intentPool, { intents: [{ id: 'i1', category: '创作', description: 'test', intensity: 5, source: 'accumulation', born_at: '', decay_rate: 0.1, satisfied_at: null, resistance: 4, skipped_count: 0, last_attempted: null }], last_updated: null });

    const result = dispatch('/alive memory');
    expect(result.output).toContain('Diary days');
    expect(result.output).toContain('2'); // 2 diary days
    expect(result.output).toContain('Core wisdom entries');
  });
});

// ── Reset ──────────────────────────────────────────────────────────

describe('/alive reset', () => {
  it('requires a target', () => {
    const result = dispatch('/alive reset');
    expect(result.output).toContain('Specify what to reset');
  });

  it('resets vitality', () => {
    writeJSON(PATHS.vitalityState, { vitality: 30, last_updated: null, consecutive_low_days: 5 });
    const result = dispatch('/alive reset vitality');
    expect(result.output).toContain('Vitality reset to 100');

    const updated = readJSON<VitalityState>(PATHS.vitalityState, { vitality: 0, last_updated: null, consecutive_low_days: 0 });
    expect(updated.vitality).toBe(100);
  });

  it('resets flow state', () => {
    writeJSON(PATHS.flowState, { status: 'flow', activity: 'coding', category: '创作', entered_at: '2026-03-24T10:00:00Z', duration_ticks: 5, interrupt_chance: 0.05, cooldown_remaining: 0 });
    const result = dispatch('/alive reset flow');
    expect(result.output).toContain('Flow state reset');

    const updated = readJSON<FlowState>(PATHS.flowState, DEFAULT_FLOW_STATE);
    expect(updated.status).toBe('none');
  });

  it('clears intent pool', () => {
    writeJSON(PATHS.intentPool, { intents: [{ id: 'i1', category: '创作', description: 'test', intensity: 5, source: 'accumulation', born_at: '', decay_rate: 0.1, satisfied_at: null, resistance: 4, skipped_count: 0, last_attempted: null }], last_updated: null });
    const result = dispatch('/alive reset intents');
    expect(result.output).toContain('Intent pool cleared');

    const updated = readJSON<IntentPool>(PATHS.intentPool, { intents: [], last_updated: null });
    expect(updated.intents).toEqual([]);
  });

  it('resets all', () => {
    writeJSON(PATHS.emotionState, makeTestEmotion());
    writeJSON(PATHS.vitalityState, { vitality: 30, last_updated: null, consecutive_low_days: 5 });
    writeJSON(PATHS.flowState, { status: 'flow', activity: 'coding', category: '创作', entered_at: '2026-03-24T10:00:00Z', duration_ticks: 5, interrupt_chance: 0.05, cooldown_remaining: 0 });
    writeJSON(PATHS.intentPool, { intents: [{ id: 'i1', category: '创作', description: 'test', intensity: 5, source: 'accumulation', born_at: '', decay_rate: 0.1, satisfied_at: null, resistance: 4, skipped_count: 0, last_attempted: null }], last_updated: null });

    const result = dispatch('/alive reset all');
    expect(result.output).toContain('ENFP baseline');
    expect(result.output).toContain('Vitality reset');
    expect(result.output).toContain('Flow state reset');
    expect(result.output).toContain('Intent pool cleared');
  });

  it('rejects unknown target', () => {
    const result = dispatch('/alive reset banana');
    expect(result.output).toContain('Unknown reset target');
  });
});

// ── Unknown Command ────────────────────────────────────────────────

describe('unknown command', () => {
  it('returns error for unknown subcommand', () => {
    const result = dispatch('/alive foobar');
    expect(result.error).toBe(true);
    expect(result.output).toContain('Unknown command');
    expect(result.output).toContain('foobar');
  });
});

// ── Isolation Guarantee ────────────────────────────────────────────

describe('memory isolation', () => {
  it('dispatch does not write to diary', () => {
    const diaryBefore = fs.existsSync(PATHS.diary) ? fs.readFileSync(PATHS.diary, 'utf8') : '';

    dispatch('/alive status');
    dispatch('/alive emotion');
    dispatch('/alive schedule');
    dispatch('/alive skills');
    dispatch('/alive memory');

    const diaryAfter = fs.existsSync(PATHS.diary) ? fs.readFileSync(PATHS.diary, 'utf8') : '';
    expect(diaryAfter).toBe(diaryBefore);
  });

  it('reset commands only touch their target files', () => {
    writeJSON(PATHS.emotionState, makeTestEmotion());
    fs.writeFileSync(PATHS.diary, '## 2026-03-24\noriginal diary\n');

    dispatch('/alive reset emotion');

    // Diary should be untouched
    expect(fs.readFileSync(PATHS.diary, 'utf8')).toContain('original diary');
  });
});
