// e2e/harness/harness.config.ts
// Harness 配置 — 类型定义 + 默认值 + 环境变量覆盖 + .env 加载

import * as fs from 'fs';
import * as path from 'path';

export interface HarnessTimeouts {
  readonly install: number;
  readonly cron: number;
  readonly session: number;
  readonly chat: number;
}

export interface HarnessConfig {
  readonly persona: string;
  readonly personaSlug: string;
  readonly timeouts: HarnessTimeouts;
  readonly reportDir: string;
  readonly tickCount: number;
  readonly chatMessages: readonly string[];
  readonly openclawHome: string;
  readonly skillDir: string;
  readonly memoryDir: string;
}

const DEFAULT_PERSONA = 'alive/personas/minase.yaml';
const DEFAULT_SLUG = 'minase';

/**
 * Load .env file from e2e/harness/.env (if exists) into process.env.
 * Supports both KEY=VALUE and KEY: "VALUE" formats (with optional trailing comma).
 */
function loadDotEnv(): void {
  const envPath = path.resolve('e2e/harness/.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  let loaded = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    let key: string | null = null;
    let value: string | null = null;

    // Try KEY=VALUE format first
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      key = trimmed.slice(0, eqIdx).trim();
      value = trimmed.slice(eqIdx + 1).trim();
    } else {
      // Try KEY: "VALUE" or KEY: VALUE format
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        key = trimmed.slice(0, colonIdx).trim();
        value = trimmed.slice(colonIdx + 1).trim();
      }
    }

    if (!key || !value) continue;

    // Strip quotes and trailing commas: "value", → value
    value = value.replace(/^["']/, '').replace(/["'],?$/, '').trim();

    // Don't overwrite existing env vars
    if (!process.env[key]) {
      process.env[key] = value;
      loaded++;
    }
  }
  if (loaded > 0) {
    console.log(`  📂 Loaded ${loaded} env var(s) from ${envPath}`);
  }
}

function resolveConfig(): HarnessConfig {
  // Load .env before resolving config
  loadDotEnv();

  const persona = process.env.HARNESS_PERSONA || DEFAULT_PERSONA;
  const slug = process.env.HARNESS_SLUG || DEFAULT_SLUG;
  const home = process.env.HOME || '~';
  const openclawHome = path.join(home, '.openclaw');

  return {
    persona,
    personaSlug: slug,
    timeouts: {
      install: 30_000,
      cron: 180_000,
      session: 60_000,
      chat: 90_000,
    },
    reportDir: path.resolve('e2e/harness/reports'),
    tickCount: Number(process.env.HARNESS_TICK_COUNT) || 1,
    chatMessages: [
      '你好呀～今天过得怎么样？',
      '最近有什么有趣的事情吗？',
      '感觉你今天心情不错呢',
    ],
    openclawHome,
    skillDir: path.join(openclawHome, 'skills', 'alive'),
    memoryDir: path.join(openclawHome, 'workspace', 'memory', slug),
  };
}

let _config: HarnessConfig | null = null;

export function getConfig(): HarnessConfig {
  if (!_config) {
    _config = resolveConfig();
  }
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
