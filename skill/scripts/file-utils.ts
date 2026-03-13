// skill/scripts/file-utils.ts
// Safe file I/O with backup and fallback (Spec §13)

import * as fs from 'fs';
import * as path from 'path';

export const MEMORY_BASE = path.join(
  process.env.HOME!,
  '.openclaw', 'workspace', 'memory', 'minase'
);

export const SKILL_BASE = path.join(
  process.env.HOME!,
  '.openclaw', 'skills', 'minase'
);

export const PATHS = {
  emotionState: path.join(MEMORY_BASE, 'emotion-state.json'),
  intentPool: path.join(MEMORY_BASE, 'intent-pool.json'),
  scheduleToday: path.join(MEMORY_BASE, 'schedule-today.json'),
  eventQueue: path.join(MEMORY_BASE, 'event-queue.json'),
  preferences: path.join(MEMORY_BASE, 'preferences.json'),
  aspirations: path.join(MEMORY_BASE, 'aspirations.json'),
  personalityDrift: path.join(MEMORY_BASE, 'personality-drift.json'),
  heartbeatLog: path.join(MEMORY_BASE, 'heartbeat-log.json'),
  diary: path.join(MEMORY_BASE, 'diary.md'),
  coreWisdom: path.join(MEMORY_BASE, 'core-wisdom.json'),
  world: path.join(MEMORY_BASE, 'world.md'),
  socialMeta: path.join(MEMORY_BASE, 'relations', 'social', 'meta.json'),
  socialInstagramDir: path.join(MEMORY_BASE, 'relations', 'social', 'instagram'),
  cronSchedule: path.join(SKILL_BASE, 'cron-schedule.json'),
  inspiration: path.join(MEMORY_BASE, 'inspiration.json'),
  postHistory: path.join(MEMORY_BASE, 'post-history.json'),
  vitalityState: path.join(MEMORY_BASE, 'vitality-state.json'),
  confidenceState: path.join(MEMORY_BASE, 'confidence-state.json'),
  photoRoll: path.join(MEMORY_BASE, 'photo-roll'),
  referenceImage: path.join(SKILL_BASE, 'assets', 'minase-reference.png'),
  postImpulse: path.join(MEMORY_BASE, 'post-impulse.json'),
  inspirationRefs: path.join(MEMORY_BASE, 'inspiration-refs'),
  references: path.join(SKILL_BASE, 'assets', 'references'),
  flowState: path.join(MEMORY_BASE, 'flow-state.json'),
  pendingChains: path.join(MEMORY_BASE, 'pending-chains.json'),
} as const;

/**
 * Read JSON file with backup fallback (Spec §13 file corruption).
 * If primary fails, try .bak. If .bak fails, return defaultValue.
 */
export function readJSON<T>(filePath: string, defaultValue: T): T {
  for (const suffix of ['', '.bak']) {
    const target = filePath + suffix;
    if (fs.existsSync(target)) {
      try {
        return JSON.parse(fs.readFileSync(target, 'utf8'));
      } catch {
        // Try next
      }
    }
  }
  return defaultValue;
}

/**
 * Write JSON file with .bak backup before overwrite (Spec §13).
 */
export function writeJSON<T>(filePath: string, data: T): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, filePath + '.bak');
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Append text to a file, creating it if needed.
 */
export function appendText(filePath: string, text: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, text);
}

/**
 * Read text file, return empty string if not found.
 */
export function readText(filePath: string, fallback = ''): string {
  if (!fs.existsSync(filePath)) return fallback;
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Read a prompt template from templates/ directory.
 * Works both in development (dist/ → skill/templates/) and
 * installed (scripts/ → ../templates/) contexts.
 */
export function readTemplate(templateName: string): string {
  // Try installed path first: ~/.openclaw/skills/minase/templates/
  const installedPath = path.join(__dirname, '..', 'templates', templateName);
  if (fs.existsSync(installedPath)) return fs.readFileSync(installedPath, 'utf8');

  // Fallback for development: dist/ → skill/templates/
  const devPath = path.join(__dirname, '..', 'skill', 'templates', templateName);
  if (fs.existsSync(devPath)) return fs.readFileSync(devPath, 'utf8');

  throw new Error(`Template not found: ${templateName} (tried ${installedPath} and ${devPath})`);
}

/**
 * Read all JSON files in a directory as an array.
 */
export function readAllJSON<T>(dirPath: string): T[] {
  if (!fs.existsSync(dirPath)) return [];
  const results: T[] = [];
  for (const file of fs.readdirSync(dirPath)) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(dirPath, file);
    try {
      results.push(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch {
      // Skip corrupt files
    }
  }
  return results;
}

/**
 * Write a social relation to its file by id.
 */
export function writeSocialRelation(dirPath: string, relation: { id: string }): void {
  writeJSON(path.join(dirPath, `${relation.id}.json`), relation);
}
