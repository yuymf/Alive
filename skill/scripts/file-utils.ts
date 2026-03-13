// skill/scripts/file-utils.ts
// Safe file I/O with backup and fallback (Spec §13)

import * as fs from 'fs';
import * as path from 'path';

let _memoryBaseOverride: string | null = null;
let _skillBaseOverride: string | null = null;

function getMemoryBase(): string {
  return _memoryBaseOverride ?? path.join(process.env.HOME!, '.openclaw', 'workspace', 'memory', 'minase');
}

function getSkillBase(): string {
  return _skillBaseOverride ?? path.join(process.env.HOME!, '.openclaw', 'skills', 'minase');
}

/** Override base paths for testing (sandbox isolation). */
export function setBasePaths(memoryBase: string, skillBase: string): void {
  _memoryBaseOverride = memoryBase;
  _skillBaseOverride = skillBase;
}

/** Clear base path overrides, restoring defaults. */
export function resetBasePaths(): void {
  _memoryBaseOverride = null;
  _skillBaseOverride = null;
}

/** @deprecated Use PATHS getters directly. Kept for backward compatibility. */
export const MEMORY_BASE = undefined as unknown as string;
/** @deprecated Use PATHS getters directly. Kept for backward compatibility. */
export const SKILL_BASE = undefined as unknown as string;

// Redefine as getters on module.exports for CJS compatibility
Object.defineProperty(exports, 'MEMORY_BASE', { get: getMemoryBase, enumerable: true });
Object.defineProperty(exports, 'SKILL_BASE', { get: getSkillBase, enumerable: true });

export const PATHS = {
  get emotionState() { return path.join(getMemoryBase(), 'emotion-state.json'); },
  get intentPool() { return path.join(getMemoryBase(), 'intent-pool.json'); },
  get scheduleToday() { return path.join(getMemoryBase(), 'schedule-today.json'); },
  get eventQueue() { return path.join(getMemoryBase(), 'event-queue.json'); },
  get preferences() { return path.join(getMemoryBase(), 'preferences.json'); },
  get aspirations() { return path.join(getMemoryBase(), 'aspirations.json'); },
  get personalityDrift() { return path.join(getMemoryBase(), 'personality-drift.json'); },
  get heartbeatLog() { return path.join(getMemoryBase(), 'heartbeat-log.json'); },
  get diary() { return path.join(getMemoryBase(), 'diary.md'); },
  get coreWisdom() { return path.join(getMemoryBase(), 'core-wisdom.json'); },
  get world() { return path.join(getMemoryBase(), 'world.md'); },
  get socialMeta() { return path.join(getMemoryBase(), 'relations', 'social', 'meta.json'); },
  get socialInstagramDir() { return path.join(getMemoryBase(), 'relations', 'social', 'instagram'); },
  get cronSchedule() { return path.join(getSkillBase(), 'cron-schedule.json'); },
  get inspiration() { return path.join(getMemoryBase(), 'inspiration.json'); },
  get postHistory() { return path.join(getMemoryBase(), 'post-history.json'); },
  get vitalityState() { return path.join(getMemoryBase(), 'vitality-state.json'); },
  get confidenceState() { return path.join(getMemoryBase(), 'confidence-state.json'); },
  get photoRoll() { return path.join(getMemoryBase(), 'photo-roll'); },
  get photoGallery() { return path.join(getMemoryBase(), 'photo-gallery.json'); },
  get referenceImage() { return path.join(getSkillBase(), 'assets', 'references', 'minase-reference.png'); },
  get postImpulse() { return path.join(getMemoryBase(), 'post-impulse.json'); },
  get inspirationRefs() { return path.join(getMemoryBase(), 'inspiration-refs'); },
  get references() { return path.join(getSkillBase(), 'assets', 'references'); },
  get flowState() { return path.join(getMemoryBase(), 'flow-state.json'); },
  get pendingChains() { return path.join(getMemoryBase(), 'pending-chains.json'); },
};

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
