// e2e/harness/harness.config.ts
// Harness 配置 — 类型定义 + 默认值 + 环境变量覆盖

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

function resolveConfig(): HarnessConfig {
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
    tickCount: Number(process.env.HARNESS_TICK_COUNT) || 2,
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
