/**
 * e2e/shared/setup.ts
 * Shared E2E test infrastructure: sandbox initialization, API key loading,
 * mock environment setup, and base-path lifecycle management.
 */

import * as fs from 'fs';
import * as path from 'path';
import { setBasePaths, resetBasePaths } from '../../skill/scripts/file-utils';
import {
  DEFAULT_MOMENTUM, DEFAULT_UNDERTONE,
  DEFAULT_FLOW_STATE, DEFAULT_CHAIN_STATE,
  DEFAULT_POST_IMPULSE, DEFAULT_PHOTO_GALLERY,
} from '../../skill/scripts/types';

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const SANDBOX_DIR = path.join(PROJECT_ROOT, 'e2e', 'sandbox');
export const SANDBOX_MEMORY = path.join(SANDBOX_DIR, 'memory', 'minase');
export const SKILL_DIR = path.join(PROJECT_ROOT, 'skill');
export const OUTPUT_DIR = path.join(PROJECT_ROOT, 'e2e', 'e2e-output');

/**
 * Default state files for sandbox initialization.
 * Pass overrides to replace specific files' content.
 */
function buildDefaults(overrides?: Record<string, unknown>): Record<string, unknown> {
  const defaults: Record<string, unknown> = {
    'emotion-state.json': {
      mood: { valence: 0.3, arousal: 0.5, description: '刚醒来' },
      energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
      last_updated: null, recent_cause: '初始化',
      momentum: { ...DEFAULT_MOMENTUM },
      undertone: { ...DEFAULT_UNDERTONE },
      impulse_history: [],
      consecutive_high_stress: 0,
      threshold_break_cooldown: 0,
    },
    'intent-pool.json': { intents: [], last_updated: null },
    'schedule-today.json': { date: null, rigid: [], flexible: [], generated_by: null },
    'event-queue.json': { events: [], max_size: 50 },
    'heartbeat-log.json': { logs: [], retention_days: 7 },
    'core-wisdom.json': { version: 1, wisdom: [], total_importance_since_reflection: 0 },
    'preferences.json': { cos_characters: [], content_style: [], active_hours: [], social_platforms: [] },
    'aspirations.json': { aspirations: [] },
    'personality-drift.json': { base: 'ESTP', modifiers: [] },
    'post-history.json': { posts: [] },
    'vitality-state.json': { vitality: 80, consecutive_low_days: 0, last_updated: null, last_recovery_date: null },
    'confidence-state.json': { confidence: 1.0, last_updated: null, streak: 0 },
    'post-impulse.json': { ...DEFAULT_POST_IMPULSE, value: 75 },
    'inspiration.json': {
      instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: 0 },
      acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: 0 },
      visual_trends: { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: 0 },
      self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: 0 },
      xiaohongshu_trends: { feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [], saved_inspirations: [], updated_at: 0 },
    },
    'flow-state.json': { ...DEFAULT_FLOW_STATE },
    'pending-chains.json': { ...DEFAULT_CHAIN_STATE },
    'photo-gallery.json': { ...DEFAULT_PHOTO_GALLERY },
  };

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      defaults[key] = value;
    }
  }

  return defaults;
}

export interface InitSandboxOptions {
  /** Override default state file contents. Key = filename, value = JSON-serializable data. */
  overrides?: Record<string, unknown>;
  /** Extra directories to create under SANDBOX_MEMORY. */
  extraDirs?: string[];
}

/**
 * Initialize a clean sandbox with default state files.
 * Cleans up previous sandbox and output directories.
 */
export function initSandbox(options: InitSandboxOptions = {}): void {
  // Clean up any previous run
  if (fs.existsSync(SANDBOX_DIR)) fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
  if (fs.existsSync(OUTPUT_DIR)) fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });

  // Create directory structure
  const dirs = [
    SANDBOX_MEMORY,
    path.join(SANDBOX_MEMORY, 'photo-roll'),
    path.join(SANDBOX_MEMORY, 'relations', 'social', 'instagram'),
    path.join(SANDBOX_MEMORY, 'inspiration-refs'),
    OUTPUT_DIR,
    path.join(OUTPUT_DIR, 'state-snapshots'),
    path.join(OUTPUT_DIR, 'images'),
    path.join(OUTPUT_DIR, 'final-state'),
    ...(options.extraDirs ?? []),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write default state files
  const defaults = buildDefaults(options.overrides);
  for (const [file, data] of Object.entries(defaults)) {
    fs.writeFileSync(path.join(SANDBOX_MEMORY, file), JSON.stringify(data, null, 2));
  }

  // Text files
  fs.writeFileSync(path.join(SANDBOX_MEMORY, 'diary.md'), '# 水瀬の日記\n');
  fs.writeFileSync(path.join(SANDBOX_MEMORY, 'world.md'), '# 世界観察\n\n_水瀬在浏览网络时学到的事情。_\n');

  // Social meta
  fs.writeFileSync(
    path.join(SANDBOX_MEMORY, 'relations', 'social', 'meta.json'),
    JSON.stringify({
      instagram_following: [],
      xiaohongshu_following: [],
      stats: { core: 0, familiar: 0, cognitive: 0, dormant: 0 },
    }, null, 2),
  );
}

export interface ApiKeys {
  LLM_API_KEY?: string;
  LLM_API_BASE?: string;
  LLM_MODEL?: string;
  AIHUBMIX_API_KEY?: string;
  IMGURL_TOKEN?: string;
  INSTAGRAM_USERNAME?: string;
  INSTAGRAM_PASSWORD?: string;
  INSTAGRAM_TOTP_SECRET?: string;
  XHS_SKILLS_DIR?: string;
}

const OPENCLAW_ENV_KEYS: Array<keyof ApiKeys> = [
  'LLM_API_KEY',
  'LLM_API_BASE',
  'LLM_MODEL',
  'AIHUBMIX_API_KEY',
  'IMGURL_TOKEN',
  'INSTAGRAM_USERNAME',
  'INSTAGRAM_PASSWORD',
  'INSTAGRAM_TOTP_SECRET',
  'XHS_SKILLS_DIR',
];

/**
 * Load Minase runtime env from ~/.openclaw/openclaw.json.
 * Returns the loaded keys (does NOT set process.env).
 */
export function loadApiKeys(): ApiKeys {
  const keys: ApiKeys = {};
  try {
    const configPath = path.join(process.env.HOME!, '.openclaw', 'openclaw.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const minaseEnv = config?.skills?.entries?.minase?.env ?? {};
    for (const key of OPENCLAW_ENV_KEYS) {
      const value = minaseEnv[key];
      if (value) keys[key] = value;
    }
  } catch {
    console.error('Warning: Could not load openclaw config for Minase env');
  }
  return keys;
}

/**
 * Apply API keys to process.env. Returns the key names that were set.
 */
export function applyApiKeys(keys: ApiKeys, exclude?: string[]): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(keys)) {
    if (value && !(exclude ?? []).includes(key)) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

export interface MockEnvFlags {
  instagram?: boolean;
  xhs?: boolean;
  cron?: boolean;
  inlinePipeline?: boolean;
  imgurl?: boolean;
}

/**
 * Set E2E_MOCK_* environment variables. Returns a restore() function that
 * resets all modified env vars to their previous values.
 */
export function setupMockEnv(flags: MockEnvFlags): () => void {
  const saved: Record<string, string | undefined> = {};

  const envMap: Record<string, boolean | undefined> = {
    E2E_MOCK_INSTAGRAM: flags.instagram,
    E2E_MOCK_XHS: flags.xhs,
    E2E_MOCK_CRON: flags.cron,
    E2E_INLINE_PIPELINE: flags.inlinePipeline,
    E2E_MOCK_IMGURL: flags.imgurl,
  };

  for (const [key, enable] of Object.entries(envMap)) {
    if (enable !== undefined) {
      saved[key] = process.env[key];
      if (enable) {
        process.env[key] = '1';
      } else {
        delete process.env[key];
      }
    }
  }

  return () => {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  };
}

/**
 * Set base paths for sandbox, run fn, and guarantee resetBasePaths() is called.
 */
export async function withSandboxBasePaths<T>(fn: () => Promise<T>): Promise<T> {
  setBasePaths(SANDBOX_MEMORY, SKILL_DIR);
  try {
    return await fn();
  } finally {
    resetBasePaths();
  }
}

/**
 * Capture console.log and console.error output.
 */
export function captureConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(`[LOG] ${args.map(String).join(' ')}`);
    origLog(...args);
  };
  console.error = (...args: unknown[]) => {
    logs.push(`[ERR] ${args.map(String).join(' ')}`);
    origErr(...args);
  };
  return { logs, restore: () => { console.log = origLog; console.error = origErr; } };
}
