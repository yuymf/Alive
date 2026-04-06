// alive/scripts/admin/command-handler.ts
// Slash-command handler for /alive admin commands.
// Runs in tool-dispatch mode — bypasses LLM persona context entirely.
// Never touches diary, relations, or emotion via conversation hooks.

import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import { readJSON, readText, writeJSON, PATHS, setPersonaName, getPersonaName } from '../utils/file-utils';
import { loadPersona, clearPersonaCache, getScheduleConfig } from '../persona/persona-loader';
import {
  generatePersonaQuick,
  generatePersonaGuided,
  generatePersonaQuickAsync,
  generatePersonaGuidedAsync,
  savePersona,
  formatPersonaPreview,
  getAvailableMBTI,
  getTraitPool,
  getScheduleTypes,
  type QuickCreateOptions,
  type GuidedCreateOptions,
} from './persona-creator';
import type {
  EmotionState, IntentPool, VitalityState, ConfidenceState,
  FlowState, HeartbeatLog, WisdomStore, PersonaConfig,
  ScheduleToday, Preferences, PostHistory, PhotoGallery,
  FeaturesConfig,
} from '../utils/types';
import {
  DEFAULT_FLOW_STATE,
  DEFAULT_FEATURES,
  isFeatureEnabled,
  hydrateEmotionState,
} from '../utils/types';

// ── Result type ────────────────────────────────────────────────────

export interface CommandResult {
  /** Markdown-formatted response shown to the user */
  output: string;
  /** If true, the response is an error message */
  error?: boolean;
}

// ── Parser ─────────────────────────────────────────────────────────

export interface ParsedCommand {
  subcommand: string;
  args: string[];
  flags: Record<string, string>;
}

/**
 * Parse a raw slash-command string.
 * Accepts formats:
 *   /alive status
 *   /alive:status
 *   /alive schedule --wake 9 --sleep 1
 */
export function parseCommand(raw: string): ParsedCommand {
  const trimmed = raw.trim();

  // Strip the leading "/alive" or "/alive:" prefix
  let rest: string;
  if (trimmed.startsWith('/alive:')) {
    rest = trimmed.slice('/alive:'.length).trim();
  } else if (trimmed.startsWith('/alive ')) {
    rest = trimmed.slice('/alive '.length).trim();
  } else if (trimmed === '/alive') {
    rest = 'help';
  } else {
    rest = trimmed;
  }

  const tokens = tokenize(rest);
  const subcommand = tokens[0] ?? 'help';
  const args: string[] = [];
  const flags: Record<string, string> = {};

  let i = 1;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = 'true';
        i++;
      }
    } else {
      args.push(tok);
      i++;
    }
  }

  return { subcommand, args, flags };
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (const ch of input) {
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

// ── Dispatcher ─────────────────────────────────────────────────────

/**
 * Proxy ops sub-commands to ops-command-handler.
 * E.g. "/alive brief" → node ops-command-handler.js brief
 *      "/alive post 1" → node ops-command-handler.js post 1
 */
function cmdOpsProxy(cmd: ParsedCommand): CommandResult {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const opsHandlerPath = path.resolve(__dirname, '../ops/ops-command-handler.js');
  const opsArgs = [cmd.subcommand, ...cmd.args];
  try {
    const output = execFileSync('node', [opsHandlerPath, ...opsArgs], {
      timeout: 120_000,
      encoding: 'utf8' as const,
      env: { ...process.env },
    });
    return { output: (output as string).trim() || '✅ Done.' };
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr?.toString().trim() ?? '';
    return { output: `❌ ${stderr || (err as Error).message}`, error: true };
  }
}

const COMMANDS: Record<string, (cmd: ParsedCommand) => CommandResult | Promise<CommandResult>> = {
  help: cmdHelp,
  status: cmdStatus,
  emotion: cmdEmotion,
  schedule: cmdSchedule,
  skills: cmdSkills,
  features: cmdFeatures,
  platform: cmdPlatform,
  memory: cmdMemory,
  reset: cmdReset,
  create: cmdCreate,
  strategy: cmdOpsStrategy,
  'confirm-strategy': cmdOpsConfirmStrategy,
  insights: cmdOpsInsights,
  patterns: cmdOpsPatterns,
  // ── Ops 子命令 — 转发到 ops-command-handler ──────────────────
  brief: cmdOpsProxy,
  trends: cmdOpsProxy,
  idea: cmdOpsProxy,
  post: cmdOpsProxy,
  analyze: cmdOpsProxy,
  advice: cmdOpsProxy,
};

/**
 * Handle a parsed /alive command.
 * Returns a Markdown-formatted result, never throws.
 */
export async function handleCommand(cmd: ParsedCommand): Promise<CommandResult> {
  const handler = COMMANDS[cmd.subcommand];
  if (!handler) {
    return {
      output: `❌ Unknown command: \`${cmd.subcommand}\`\n\nRun \`/alive help\` for available commands.`,
      error: true,
    };
  }
  try {
    return await handler(cmd);
  } catch (err) {
    return {
      output: `❌ Error executing \`${cmd.subcommand}\`: ${(err as Error).message}`,
      error: true,
    };
  }
}

/**
 * Top-level entry: parse raw input and execute.
 */
export async function dispatch(raw: string): Promise<CommandResult> {
  const cmd = parseCommand(raw);
  return handleCommand(cmd);
}

// ── Command Implementations ────────────────────────────────────────

function cmdHelp(): CommandResult {
  return {
    output: `## 🛠 Alive Admin Commands

| Command | Description |
|---------|-------------|
| \`/alive status\` | 查看角色综合状态 |
| \`/alive emotion\` | 查看情绪详情 |
| \`/alive emotion --reset\` | 重置情绪到 MBTI 基线 |
| \`/alive schedule\` | 查看作息配置 |
| \`/alive schedule --wake <hour> --sleep <hour>\` | 修改作息时间 |
| \`/alive schedule --timezone <tz>\` | 修改时区 |
| \`/alive skills\` | 列出已启用的子技能 |
| \`/alive features\` | 查看 feature flags 开关状态 |
| \`/alive platform\` | 查看平台配置 |
| \`/alive memory\` | 查看记忆统计 |
| \`/alive memory --prune-diary <days>\` | 清理超过 N 天的日记 |
| \`/alive reset <target>\` | 重置指定状态 (emotion/vitality/flow/intents/all) |
| \`/alive create\` | 随机生成一个新角色 |
| \`/alive create <name> <tagline>\` | 用指定名字和定位生成角色 |
| \`/alive create --guided\` | 引导模式，逐步填写角色信息 |

## 📊 运营工作台命令

| Command | Description |
|---------|-------------|
| \`/alive brief\` | 生成今日运营简报（热点+选题+建议） |
| \`/alive trends\` | 查看当前热点趋势 |
| \`/alive idea [方向]\` | 手动生成选题（可指定方向） |
| \`/alive post [N]\` | 查看选题列表 / 第N个选题详情 |
| \`/alive analyze <URL>\` | 爆款帖子拆解分析 |
| \`/alive advice\` | 人设契合度建议 |

> ⚡ 这些命令不经过角色人格、不写入日记、不影响记忆。`,
  };
}

function cmdStatus(): CommandResult {
  const persona = safeLoadPersona();
  if (!persona) return personaNotFound();

  const rawEmotion = readJSON<Record<string, unknown>>(PATHS.emotionState, null as unknown as Record<string, unknown>);
  const emotion = rawEmotion ? hydrateEmotionState(rawEmotion) : null;
  const rawVitality = readJSON<Record<string, unknown>>(PATHS.vitalityState, { vitality: 100 });
  const vitalityVal = (rawVitality as { vitality?: number }).vitality ?? (rawVitality as { health?: number }).health ?? 100;
  const vitality = { vitality: vitalityVal, last_updated: null, consecutive_low_days: 0 };
  const rawConfidence = readJSON<Record<string, unknown>>(PATHS.confidenceState, { confidence: 1.0 });
  const confidenceVal = (rawConfidence as { confidence?: number }).confidence ?? 1.0;
  const streakVal = (rawConfidence as { streak?: number }).streak ?? 0;
  const confidence = { confidence: confidenceVal, streak: streakVal, last_updated: null };
  const flow = readJSON<FlowState>(PATHS.flowState, DEFAULT_FLOW_STATE);
  const schedule = getScheduleConfig(persona);

  const moodLabel = emotion ? describeMood(emotion.mood.valence) : 'N/A';
  const energyBar = emotion ? bar(emotion.energy) : 'N/A';
  const stressBar = emotion ? bar(emotion.stress) : 'N/A';

  return {
    output: `## 📊 ${persona.meta.name} — Status

| Field | Value |
|-------|-------|
| **Name** | ${persona.meta.name} (${persona.meta.name_reading ?? ''}) |
| **MBTI** | ${persona.personality.mbti} |
| **Mood** | ${moodLabel} (valence: ${emotion?.mood.valence?.toFixed(2) ?? 'N/A'}) |
| **Energy** | ${energyBar} ${emotion?.energy?.toFixed(2) ?? 'N/A'} |
| **Stress** | ${stressBar} ${emotion?.stress?.toFixed(2) ?? 'N/A'} |
| **Vitality** | ${bar(vitality.vitality / 100)} ${vitality.vitality.toFixed(0)} |
| **Confidence** | ${confidence.confidence.toFixed(2)} (streak: ${confidence.streak}) |
| **Flow** | ${flow.status} ${flow.activity ? `(${flow.activity})` : ''} |
| **Schedule** | wake ${schedule.wake_hour}:00 → sleep ${schedule.sleep_hour}:00 (${schedule.timezone}) |
| **Active peaks** | ${schedule.active_peaks.join(', ')}h |`,
  };
}

function cmdEmotion(cmd: ParsedCommand): CommandResult {
  if (cmd.flags['reset'] !== undefined) {
    return resetEmotion();
  }

  const rawEmotion = readJSON<Record<string, unknown>>(PATHS.emotionState, null as unknown as Record<string, unknown>);
  if (!rawEmotion) {
    return { output: '⚠️ No emotion state found. The heartbeat has not run yet.' };
  }
  const emotion = hydrateEmotionState(rawEmotion);

  const momentum = emotion.momentum;
  const recentImpulses = (emotion.impulse_history ?? []).slice(-5);

  let impulseTable = '';
  if (recentImpulses.length > 0) {
    impulseTable = '\n### Recent Impulses\n\n| Time | Cause | Importance |\n|------|-------|------------|\n';
    for (const imp of recentImpulses) {
      impulseTable += `| ${imp.timestamp?.slice(11, 16) ?? '?'} | ${imp.cause} | ${imp.importance} |\n`;
    }
  }

  return {
    output: `## 🎭 Emotion Detail

| Dimension | Value | Bar |
|-----------|-------|-----|
| Valence | ${emotion.mood.valence.toFixed(2)} | ${signedBar(emotion.mood.valence)} |
| Arousal | ${emotion.mood.arousal.toFixed(2)} | ${bar(emotion.mood.arousal)} |
| Energy | ${emotion.energy.toFixed(2)} | ${bar(emotion.energy)} |
| Stress | ${emotion.stress.toFixed(2)} | ${bar(emotion.stress)} |
| Creativity | ${emotion.creativity.toFixed(2)} | ${bar(emotion.creativity)} |
| Sociability | ${emotion.sociability.toFixed(2)} | ${bar(emotion.sociability)} |

**Mood description:** ${emotion.mood.description}
**Recent cause:** ${emotion.recent_cause}
**Last updated:** ${emotion.last_updated ?? 'never'}
**High-stress streak:** ${emotion.consecutive_high_stress} ticks
**Momentum duration:** ${momentum.duration_ticks} ticks
${impulseTable}`,
  };
}

function cmdSchedule(cmd: ParsedCommand): CommandResult {
  const persona = safeLoadPersona();
  if (!persona) return personaNotFound();

  // If any flags, it's a modify operation
  if (cmd.flags['wake'] || cmd.flags['sleep'] || cmd.flags['timezone']) {
    return modifySchedule(cmd.flags);
  }

  const schedule = getScheduleConfig(persona);
  const todaySchedule = readJSON<ScheduleToday>(PATHS.scheduleToday, { date: null, rigid: [], flexible: [], generated_by: null });

  let todayInfo = '';
  if (todaySchedule.date) {
    todayInfo = `\n### Today (${todaySchedule.date})\n`;
    if (todaySchedule.rigid.length > 0) {
      todayInfo += '\n**Rigid:**\n';
      for (const r of todaySchedule.rigid) {
        todayInfo += `- ${r.start}–${r.end}: ${r.activity}\n`;
      }
    }
    if (todaySchedule.flexible.length > 0) {
      todayInfo += '\n**Flexible:**\n';
      for (const f of todaySchedule.flexible) {
        todayInfo += `- ${f.activity} (preferred: ${f.preferred_time})\n`;
      }
    }
  }

  return {
    output: `## ⏰ Schedule Config

| Setting | Value |
|---------|-------|
| Wake hour | ${schedule.wake_hour}:00 |
| Sleep hour | ${schedule.sleep_hour}:00 |
| Timezone | ${schedule.timezone} |
| Active peaks | ${schedule.active_peaks.map(h => `${h}:00`).join(', ')} |

> Modify: \`/alive schedule --wake 9 --sleep 1 --timezone Asia/Tokyo\`
${todayInfo}`,
  };
}

function cmdSkills(): CommandResult {
  const persona = safeLoadPersona();
  if (!persona) return personaNotFound();

  const enabledSkills = persona.sub_skills;
  if (!enabledSkills || enabledSkills.length === 0) {
    return { output: '## 🧩 Sub-Skills\n\nNo sub-skills enabled in persona.yaml.\n\n> Add skills via `persona.yaml → sub_skills: [\"skill-name\", ...]`' };
  }

  // Check which sub-skill directories actually exist
  const subSkillsDir = PATHS.subSkillsDir;
  const platformDir = path.join(subSkillsDir, 'platform');

  const rows = enabledSkills.map(name => {
    const directPath = path.join(subSkillsDir, name, 'manifest.json');
    const platformPath = path.join(platformDir, name, 'manifest.json');
    const exists = fs.existsSync(directPath) || fs.existsSync(platformPath);
    return `| ${name} | ${exists ? '✅ installed' : '⚠️ not found'} |`;
  });

  return {
    output: `## 🧩 Sub-Skills

| Skill | Status |
|-------|--------|
${rows.join('\n')}

> Sub-skills are configured in \`persona.yaml → sub_skills\`.`,
  };
}

function cmdFeatures(): CommandResult {
  const persona = safeLoadPersona();
  if (!persona) return personaNotFound();

  const allFeatureKeys = Object.keys(DEFAULT_FEATURES) as Array<keyof typeof DEFAULT_FEATURES>;
  const rows = allFeatureKeys.map(key => {
    const enabled = isFeatureEnabled(persona, key);
    const explicit = persona.features?.[key];
    const source = explicit !== undefined ? 'persona.yaml' : 'default';
    return `| ${key} | ${enabled ? '✅ ON' : '❌ OFF'} | ${source} |`;
  });

  // Also show any extra custom feature flags from persona
  const extraKeys = Object.keys(persona.features ?? {}).filter(k => !allFeatureKeys.includes(k as keyof typeof DEFAULT_FEATURES));
  for (const key of extraKeys) {
    const enabled = persona.features?.[key];
    rows.push(`| ${key} | ${enabled ? '✅ ON' : '❌ OFF'} | persona.yaml (custom) |`);
  }

  return {
    output: `## ⚙️ Feature Flags

| Feature | Status | Source |
|---------|--------|--------|
${rows.join('\n')}

> Configure in \`persona.yaml → features\`:
> \`\`\`yaml
> features:
>   skill_discovery: true
>   random_events: true
>   flow_states: false
> \`\`\``,
  };
}

function cmdPlatform(): CommandResult {
  const persona = safeLoadPersona();
  if (!persona) return personaNotFound();

  const platformConfig = persona.platform_config;
  if (!platformConfig || Object.keys(platformConfig).length === 0) {
    return { output: '## 🌐 Platform Config\n\nNo platform_config defined in persona.yaml.' };
  }

  let output = '## 🌐 Platform Config\n\n';
  for (const [platform, config] of Object.entries(platformConfig)) {
    output += `### ${platform}\n\n`;
    output += '```json\n' + JSON.stringify(config, null, 2) + '\n```\n\n';
  }
  output += '> Platform configs are defined in `persona.yaml → platform_config`.';
  return { output };
}

function cmdMemory(): CommandResult {
  if (!fs.existsSync(path.dirname(PATHS.diary))) {
    return { output: '⚠️ Memory directory not found. Has the persona been initialized?' };
  }

  // Diary stats
  const diary = readText(PATHS.diary, '');
  const diaryDates = diary.match(/^## \d{4}-\d{2}-\d{2}/gm) ?? [];
  const diaryLines = diary.split('\n').length;

  // Wisdom stats
  const wisdom = readJSON<WisdomStore>(PATHS.coreWisdom, { version: 1, wisdom: [], total_importance_since_reflection: 0 });

  // Heartbeat log (handle legacy format: { entries, lastUpdate })
  let hbLog = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 30 });
  if (!hbLog.logs && (hbLog as any).entries) {
    hbLog = { logs: (hbLog as any).entries, retention_days: 30 };
  }
  hbLog = { ...hbLog, logs: hbLog.logs ?? [] };

  // Intent pool (handle legacy format: { pool, lastUpdate })
  let intentPool = readJSON<IntentPool>(PATHS.intentPool, { intents: [], last_updated: null });
  if (!intentPool.intents && (intentPool as any).pool) {
    intentPool = { intents: (intentPool as any).pool, last_updated: (intentPool as any).lastUpdate ?? null };
  }
  intentPool = { ...intentPool, intents: intentPool.intents ?? [] };
  const activeIntents = intentPool.intents.filter(i => !i.satisfied_at);

  // Relations
  const relDir = path.dirname(PATHS.socialMeta);
  let relationCount = 0;
  if (fs.existsSync(relDir)) {
    relationCount = fs.readdirSync(relDir).filter(f => f.endsWith('.json') && f !== 'social-meta.json').length;
  }

  // Post history
  const postHistory = readJSON<PostHistory>(PATHS.postHistory, { posts: [] });

  // Gallery
  const gallery = readJSON<PhotoGallery>(PATHS.photoGallery, { photos: [] });

  return {
    output: `## 📦 Memory Statistics

| Store | Count |
|-------|-------|
| Diary days | ${diaryDates.length} |
| Diary lines | ${diaryLines} |
| Core wisdom entries | ${wisdom.wisdom.length} |
| Importance since reflection | ${wisdom.total_importance_since_reflection} |
| Heartbeat logs | ${hbLog.logs.length} |
| Active intents | ${activeIntents.length} / ${intentPool.intents.length} |
| Relations | ${relationCount} |
| Post history | ${postHistory.posts.length} |
| Gallery photos | ${gallery.photos.length} |

> Memory path: \`~/.openclaw/workspace/memory/${getPersonaName()}/\``,
  };
}

function cmdReset(cmd: ParsedCommand): CommandResult {
  const target = cmd.args[0];
  if (!target) {
    return {
      output: `⚠️ Specify what to reset: \`emotion\`, \`vitality\`, \`flow\`, \`intents\`, or \`all\`.\n\nExample: \`/alive reset emotion\``,
    };
  }

  const results: string[] = [];

  const targets = target === 'all' ? ['emotion', 'vitality', 'flow', 'intents'] : [target];

  for (const t of targets) {
    switch (t) {
      case 'emotion':
        results.push(resetEmotionInternal());
        break;
      case 'vitality':
        writeJSON(PATHS.vitalityState, { vitality: 100, last_updated: new Date().toISOString(), consecutive_low_days: 0 });
        results.push('✅ Vitality reset to 100');
        break;
      case 'flow':
        writeJSON(PATHS.flowState, { ...DEFAULT_FLOW_STATE });
        results.push('✅ Flow state reset to none');
        break;
      case 'intents':
        writeJSON(PATHS.intentPool, { intents: [], last_updated: new Date().toISOString() });
        results.push('✅ Intent pool cleared');
        break;
      default:
        results.push(`❌ Unknown reset target: \`${t}\``);
    }
  }

  return { output: `## 🔄 Reset\n\n${results.join('\n')}` };
}

// ── Internal Helpers ───────────────────────────────────────────────

function resetEmotion(): CommandResult {
  const msg = resetEmotionInternal();
  return { output: `## 🔄 Emotion Reset\n\n${msg}` };
}

function resetEmotionInternal(): string {
  const persona = safeLoadPersona();
  if (!persona) return '❌ Persona not found — cannot determine MBTI baseline.';

  // Load MBTI baselines from persona-schema.yaml
  const schemaPath = path.join(path.dirname(PATHS.personaConfig), 'persona-schema.yaml');
  let baseline: Record<string, number> | null = null;

  if (fs.existsSync(schemaPath)) {
    try {
      const schema = YAML.parse(fs.readFileSync(schemaPath, 'utf8'));
      const mbti = persona.personality.mbti.toUpperCase();
      baseline = schema?.mbti_baselines?.[mbti] ?? schema?.mbti_baselines?.default ?? null;
    } catch { /* use fallback */ }
  }

  if (!baseline) {
    baseline = { valence: 0.2, arousal: 0.4, energy: 0.5, stress: 0.2, creativity: 0.4, sociability: 0.4 };
  }

  const now = new Date().toISOString();
  const resetState: EmotionState = {
    mood: {
      valence: baseline.valence ?? 0.2,
      arousal: baseline.arousal ?? 0.4,
      description: 'reset to baseline',
    },
    energy: baseline.energy ?? 0.5,
    stress: baseline.stress ?? 0.2,
    creativity: baseline.creativity ?? 0.4,
    sociability: baseline.sociability ?? 0.4,
    last_updated: now,
    recent_cause: 'admin reset via /alive',
    momentum: { valence: 0, arousal: 0, energy: 0, stress: 0, creativity: 0, sociability: 0, duration_ticks: 0 },
    undertone: {
      valence: baseline.valence ?? 0.2,
      arousal: baseline.arousal ?? 0.4,
      energy: baseline.energy ?? 0.5,
      stress: baseline.stress ?? 0.2,
      creativity: baseline.creativity ?? 0.4,
      sociability: baseline.sociability ?? 0.4,
    },
    impulse_history: [],
    consecutive_high_stress: 0,
    threshold_break_cooldown: 0,
  };

  writeJSON(PATHS.emotionState, resetState);
  return `✅ Emotion reset to ${persona.personality.mbti} baseline`;
}

function modifySchedule(flags: Record<string, string>): CommandResult {
  const yamlPath = PATHS.personaConfig;
  if (!fs.existsSync(yamlPath)) return personaNotFound();

  const raw = fs.readFileSync(yamlPath, 'utf8');
  const persona = YAML.parse(raw) as PersonaConfig;

  if (!persona.schedule) {
    persona.schedule = { wake_hour: 8, sleep_hour: 23, timezone: 'system', active_peaks: [14, 21] };
  }

  const changes: string[] = [];

  if (flags['wake']) {
    const hour = parseInt(flags['wake'], 10);
    if (isNaN(hour) || hour < 0 || hour > 23) {
      return { output: '❌ Invalid wake hour. Must be 0–23.', error: true };
    }
    persona.schedule.wake_hour = hour;
    changes.push(`wake_hour → ${hour}`);
  }

  if (flags['sleep']) {
    const hour = parseInt(flags['sleep'], 10);
    if (isNaN(hour) || hour < 0 || hour > 23) {
      return { output: '❌ Invalid sleep hour. Must be 0–23.', error: true };
    }
    persona.schedule.sleep_hour = hour;
    changes.push(`sleep_hour → ${hour}`);
  }

  if (flags['timezone']) {
    persona.schedule.timezone = flags['timezone'];
    changes.push(`timezone → ${flags['timezone']}`);
  }

  if (flags['peaks']) {
    const peaks = flags['peaks'].split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    if (peaks.length > 0) {
      persona.schedule.active_peaks = peaks;
      changes.push(`active_peaks → [${peaks.join(', ')}]`);
    }
  }

  if (changes.length === 0) {
    return { output: '⚠️ No changes specified.', error: true };
  }

  // Write back
  const backupPath = yamlPath + '.bak';
  fs.copyFileSync(yamlPath, backupPath);
  fs.writeFileSync(yamlPath, YAML.stringify(persona, { indent: 2 }));

  // Clear persona cache so next load picks up changes
  clearPersonaCache();

  return {
    output: `## ⏰ Schedule Updated\n\n${changes.map(c => `✅ ${c}`).join('\n')}\n\n> Backup saved to persona.yaml.bak`,
  };
}

function safeLoadPersona(): PersonaConfig | null {
  try {
    return loadPersona();
  } catch {
    return null;
  }
}

function personaNotFound(): CommandResult {
  return {
    output: '❌ Persona not found. Run `alive --persona <path>` to install one first.',
    error: true,
  };
}

// ── Display Helpers ────────────────────────────────────────────────

function bar(value: number, width: number = 10): string {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function signedBar(value: number, width: number = 10): string {
  // -1 to +1 → center bar
  const half = width / 2;
  const pos = Math.round((value + 1) / 2 * width);
  let result = '';
  for (let i = 0; i < width; i++) {
    if (i === Math.floor(half)) result += '│';
    else if (i < pos && i >= Math.floor(half)) result += '█';
    else if (i >= pos && i < Math.floor(half)) result += '█';
    else result += '░';
  }
  return result;
}

function describeMood(valence: number): string {
  if (valence >= 0.5) return '😊 Very positive';
  if (valence >= 0.2) return '🙂 Positive';
  if (valence >= -0.1) return '😐 Neutral';
  if (valence >= -0.4) return '😕 Slightly down';
  return '😞 Negative';
}

// ── Create Command ─────────────────────────────────────────────────

async function cmdCreate(cmd: ParsedCommand): Promise<CommandResult> {
  // --guided mode: return a structured prompt asking user for input
  if (cmd.flags['guided'] !== undefined) {
    return cmdCreateGuided(cmd);
  }

  // Quick mode: /alive create [name] [tagline]
  const name = cmd.args[0] || undefined;
  const tagline = cmd.args.slice(1).join(' ') || undefined;

  const persona = await generatePersonaQuickAsync({ name, tagline });
  const savedPath = savePersona(persona);
  const preview = formatPersonaPreview(persona);

  return {
    output: `${preview}

---

✅ 角色已保存到: \`${savedPath}\`

> 💡 使用方式:
> - 安装此角色: \`alive --persona ${savedPath}\`
> - 切换到此角色: \`alive --switch-persona --persona ${savedPath}\`
> - 重新随机: \`/alive create\`
> - 指定名字: \`/alive create 陈小鱼 "爱吃甜食的插画师"\`
> - 引导模式: \`/alive create --guided\``,
  };
}

async function cmdCreateGuided(cmd: ParsedCommand): Promise<CommandResult> {
  // Check if user already provided guided answers via flags
  const hasAnswers = cmd.flags['name'] || cmd.args.length > 0;

  if (!hasAnswers) {
    // Return the guided questionnaire
    const mbtiList = getAvailableMBTI();
    const traitSample = getTraitPool().slice(0, 15).join('、');
    const scheduleTypes = getScheduleTypes();
    const scheduleTable = scheduleTypes.map(s => `| ${s.key} | ${s.label} | ${s.desc} |`).join('\n');

    return {
      output: `## 🎨 创建角色 — 引导模式

请按以下格式回复，跳过的项目会随机生成：

\`\`\`
/alive create --guided --name "角色名" --tagline "一句话定位" --age 20 --gender female --mbti ENFP --traits "温柔,治愈系,好奇心旺盛" --occupation "咖啡师" --schedule normal
\`\`\`

### 📋 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| \`--name\` | ✅ | 角色名（中文） |
| \`--tagline\` | ✅ | 一句话定位 |
| \`--age\` | ❌ | 年龄 |
| \`--gender\` | ❌ | female / male / other |
| \`--mbti\` | ❌ | MBTI 类型 |
| \`--traits\` | ❌ | 核心性格词（逗号分隔，2-5 个） |
| \`--occupation\` | ❌ | 职业 |
| \`--occupation-detail\` | ❌ | 职业详细描述 |
| \`--voice-style\` | ❌ | 说话风格描述 |
| \`--schedule\` | ❌ | 作息类型 |

### 🎲 MBTI 可选值
${mbtiList.join(' / ')}

### ✨ 性格词参考
${traitSample}…

### ⏰ 作息类型
| Key | 名称 | 时间 |
|-----|------|------|
${scheduleTable}

> 💡 Tips: 只填 name 和 tagline 也行，其余全部随机生成！`,
    };
  }

  // Parse guided answers from flags
  const name = cmd.flags['name'] || cmd.args[0];
  const tagline = cmd.flags['tagline'] || cmd.args.slice(1).join(' ');

  if (!name) {
    return {
      output: '❌ 引导模式至少需要提供角色名。\n\n用法: `/alive create --guided --name "角色名" --tagline "一句话定位"`',
      error: true,
    };
  }

  if (!tagline) {
    return {
      output: '❌ 引导模式至少需要提供一句话定位。\n\n用法: `/alive create --guided --name "角色名" --tagline "一句话定位"`',
      error: true,
    };
  }

  const guidedOptions: GuidedCreateOptions = {
    name,
    tagline,
    age: cmd.flags['age'] ? parseInt(cmd.flags['age'], 10) : undefined,
    gender: cmd.flags['gender'] as GuidedCreateOptions['gender'],
    mbti: cmd.flags['mbti'],
    coreTraits: cmd.flags['traits']?.split(/[,，]/).map(s => s.trim()).filter(Boolean),
    occupation: cmd.flags['occupation'],
    occupationDetail: cmd.flags['occupation-detail'],
    voiceStyle: cmd.flags['voice-style'],
    scheduleType: cmd.flags['schedule'] as GuidedCreateOptions['scheduleType'],
  };

  const persona = await generatePersonaGuidedAsync(guidedOptions);
  const savedPath = savePersona(persona);
  const preview = formatPersonaPreview(persona);

  return {
    output: `${preview}

---

✅ 角色已保存到: \`${savedPath}\`

> 💡 使用方式:
> - 安装此角色: \`alive --persona ${savedPath}\`
> - 切换到此角色: \`alive --switch-persona --persona ${savedPath}\`
> - 重新生成: \`/alive create --guided --name "${name}" --tagline "${tagline}"\``,
  };
}

// ── Ops: strategy ──────────────────────────────────────────────────

async function cmdOpsStrategy(_cmd: ParsedCommand): Promise<CommandResult> {
  const { loadStrategy } = await import('../ops/strategy-engine');
  const strategy = loadStrategy();
  if (!strategy) {
    return {
      output: '📊 暂无内容策略。\n\n策略将在每周日深夜由 `ops-strategy` cron 任务自动生成，或运行 `/alive confirm-strategy` 手动触发。',
    };
  }
  const { performance_summary: ps, persona_health: ph, next_week_recommendations: rec, status } = strategy;
  const statusLabel = status === 'confirmed' ? '✅ 已确认' : status === 'expired' ? '⌛ 已过期' : '⏳ 待确认';
  const trendIcon = ps.engagement_trend === 'rising' ? '📈' : ps.engagement_trend === 'declining' ? '📉' : '➡️';
  const lines = [
    `📊 本周内容策略  ${statusLabel}`,
    `生成时间: ${strategy.generated_at.slice(0, 10)}`,
    '',
    '━━ 表现摘要 ━━',
    `总发布: ${ps.total_posts} 篇  互动趋势: ${trendIcon} ${ps.engagement_trend}  周变化: ${ps.week_over_week_change >= 0 ? '+' : ''}${ps.week_over_week_change}%`,
    `最佳模板: ${ps.best_performing_template}`,
    `最差模板: ${ps.worst_performing_template}`,
    '',
    '━━ 角色健康度 ━━',
    `综合评分: ${ph.overall_score}/10`,
    '',
    '━━ 下周推荐 ━━',
    `方向: ${rec.content_direction}`,
    `推荐模板: ${rec.recommended_templates.join('、')}`,
    `避免模板: ${rec.avoid_templates.join('、')}`,
  ];
  if (status === 'pending') {
    lines.push('', '回复 `/alive confirm-strategy` 确认策略并生效');
  }
  return { output: lines.join('\n') };
}

// ── Ops: confirm-strategy ──────────────────────────────────────────

async function cmdOpsConfirmStrategy(_cmd: ParsedCommand): Promise<CommandResult> {
  const { confirmStrategy } = await import('../ops/strategy-engine');
  const ok = confirmStrategy();
  if (!ok) {
    return {
      output: '❌ 未找到待确认的策略。请等待 `ops-strategy` cron 任务生成新策略后再确认。',
      error: true,
    };
  }
  return {
    output: '✅ 策略已确认！下周内容生成将按此策略执行。\n\n使用 `/alive strategy` 查看策略详情。',
  };
}

// ── Ops: insights ──────────────────────────────────────────────────

async function cmdOpsInsights(_cmd: ParsedCommand): Promise<CommandResult> {
  const { loadAnalysisLog } = await import('../ops/post-analyzer');
  const log = loadAnalysisLog();
  if (!log || log.entries.length === 0) {
    return {
      output: '📈 暂无内容表现数据。\n\n数据将由 `ops-analyze` cron 任务每4小时自动采集。',
    };
  }
  const recent = log.entries.slice(-10);
  const avgEngagement = recent.reduce((s, e) => s + e.engagement_score, 0) / recent.length;
  const tierCounts: Record<string, number> = {};
  for (const e of recent) {
    tierCounts[e.performance_tier] = (tierCounts[e.performance_tier] ?? 0) + 1;
  }
  const tierSummary = Object.entries(tierCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([tier, count]) => `${tier}: ${count}篇`)
    .join('  ');
  const lines = [
    `📈 内容表现洞察（最近${recent.length}篇）`,
    '',
    `平均互动分: ${avgEngagement.toFixed(1)}`,
    `层级分布: ${tierSummary}`,
    '',
    '━━ 最近发布 ━━',
    ...recent.slice(-5).reverse().map(e =>
      `#${e.item_id}  ${e.performance_tier}  互动${e.engagement_score.toFixed(1)}`
    ),
  ];
  return { output: lines.join('\n') };
}

// ── Ops: patterns ──────────────────────────────────────────────────

async function cmdOpsPatterns(_cmd: ParsedCommand): Promise<CommandResult> {
  const { loadContentPatterns } = await import('../ops/content-analyzer');
  const patterns = loadContentPatterns();
  if (!patterns || patterns.patterns.length === 0) {
    return {
      output: '🔍 暂无内容模式数据。\n\n模式分析将随 `ops-analyze` 任务自动更新。',
    };
  }
  const sorted = [...patterns.patterns].sort((a, b) => (b.success_rate ?? 0) - (a.success_rate ?? 0));
  const lines = [
    `🔍 内容模式分析（共${sorted.length}个）`,
    '',
    '━━ 成功率排行 ━━',
    ...sorted.slice(0, 8).map((p, i) =>
      `${i + 1}. ${p.type}  来源:${p.source}  使用${p.times_used}次  成功率${p.success_rate != null ? (p.success_rate * 100).toFixed(0) + '%' : '未知'}`
    ),
  ];
  return { output: lines.join('\n') };
}

// ── CLI Entry Point ────────────────────────────────────────────────
// When executed as `node command-handler.js <rawArgs>`, parse argv and
// dispatch, printing the result to stdout so the plugin can capture it.

async function main(): Promise<void> {
  const raw = process.argv.slice(2).join(' ').trim() || 'help';
  const result = await dispatch(`/alive ${raw}`);
  if (result.output) {
    process.stdout.write(result.output);
  }
  process.exit(result.error ? 1 : 0);
}

// Only run when invoked directly (not imported as a module)
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((err) => {
    process.stderr.write(`❌ ${err.message}\n`);
    process.exit(1);
  });
}
