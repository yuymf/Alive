// alive/scripts/utils/file-utils.ts
// Safe file I/O with backup and fallback — generalized for any persona

import * as fs from 'fs';
import * as path from 'path';

let _memoryBaseOverride: string | null = null;
let _skillBaseOverride: string | null = null;
let _personaName: string = process.env.ALIVE_PERSONA ?? 'default';

/** Set the active persona name (determines memory directory). */
export function setPersonaName(name: string): void {
  _personaName = name.toLowerCase().replace(/\s+/g, '-');
}

/** Get the active persona name. */
export function getPersonaName(): string {
  return _personaName;
}

function getMemoryBase(): string {
  return _memoryBaseOverride ?? path.join(process.env.HOME!, '.openclaw', 'workspace', 'memory', _personaName);
}

function getSkillBase(): string {
  return _skillBaseOverride ?? path.join(process.env.HOME!, '.openclaw', 'skills', 'alive');
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

export const PATHS = {
  // === Core state ===
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
  get vitalityState() { return path.join(getMemoryBase(), 'vitality-state.json'); },
  get confidenceState() { return path.join(getMemoryBase(), 'confidence-state.json'); },
  get flowState() { return path.join(getMemoryBase(), 'flow-state.json'); },
  get pendingChains() { return path.join(getMemoryBase(), 'pending-chains.json'); },

  // === Social ===
  get socialMeta() { return path.join(getMemoryBase(), 'relations', 'social-meta.json'); },
  get socialDir() { return path.join(getMemoryBase(), 'relations', 'social'); },

  // === Platform content (used by platform sub-skills) ===
  get inspiration() { return path.join(getMemoryBase(), 'inspiration.json'); },
  get postHistory() { return path.join(getMemoryBase(), 'post-history.json'); },
  get photoRoll() { return path.join(getMemoryBase(), 'photo-roll'); },
  get photoGallery() { return path.join(getMemoryBase(), 'photo-gallery.json'); },
  get workImpulse() { return path.join(getMemoryBase(), 'work-impulse.json'); },
  get inspirationRefs() { return path.join(getMemoryBase(), 'inspiration-refs'); },
  get searchState() { return path.join(getMemoryBase(), 'search-state.json'); },
  get travelState() { return path.join(getMemoryBase(), 'travel-state.json'); },
  get pendingEngagement() { return path.join(getMemoryBase(), 'pending-engagement.json'); },
  get outboundHistory() { return path.join(getMemoryBase(), 'outbound-history.json'); },

  // === Skill discovery ===
  get skillNeeds() { return path.join(getMemoryBase(), 'skill-needs.json'); },

  // === Persona-specific infra (per-persona in memory dir) ===
  get cronSchedule() { return path.join(getMemoryBase(), 'cron-schedule.json'); },
  get personaConfig() { return path.join(getMemoryBase(), 'persona.yaml'); },
  get referencesDir() { return path.join(getMemoryBase(), 'assets', 'references'); },

  // === Shared skill infra (global, not per-persona) ===
  get skillRegistry() { return path.join(getSkillBase(), 'skill-registry.json'); },
  get subSkillsDir() { return path.join(getSkillBase(), 'sub-skills'); },
  get assetsDir() { return path.join(getSkillBase(), 'assets'); },

  // === Legacy fallback paths (skill directory — for migration compat) ===
  get skillPersonaConfig() { return path.join(getSkillBase(), 'persona.yaml'); },
};

/**
 * Read JSON file with backup fallback.
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
 * Write JSON file with .bak backup before overwrite.
 */
export function writeJSON<T>(filePath: string, data: T): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, filePath + '.bak');
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function appendText(filePath: string, text: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, text);
}

export function readText(filePath: string, fallback = ''): string {
  if (!fs.existsSync(filePath)) return fallback;
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Read a prompt template from templates/ directory.
 */
export function readTemplate(templateName: string): string {
  const installedPath = path.join(getSkillBase(), 'templates', templateName);
  if (fs.existsSync(installedPath)) return fs.readFileSync(installedPath, 'utf8');

  const devPath = path.join(__dirname, '..', '..', 'templates', templateName);
  if (fs.existsSync(devPath)) return fs.readFileSync(devPath, 'utf8');

  throw new Error(`Template not found: ${templateName} (tried ${installedPath} and ${devPath})`);
}

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

export function writeSocialRelation(dirPath: string, relation: { id: string }): void {
  writeJSON(path.join(dirPath, `${relation.id}.json`), relation);
}
