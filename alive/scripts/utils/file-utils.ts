// alive/scripts/utils/file-utils.ts
// Safe file I/O with backup and fallback — generalized for any persona

import * as fs from 'fs';
import * as os from 'os';
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
  if (_memoryBaseOverride) return _memoryBaseOverride;
  // Multi-agent layout: non-main personas use ~/.openclaw/workspace-{persona}/memory/{persona}
  // Main/default persona uses ~/.openclaw/workspace/memory/{persona}
  const home = os.homedir();
  if (_personaName === 'main' || _personaName === 'default') {
    return path.join(home, '.openclaw', 'workspace', 'memory', _personaName);
  }
  // Check if isolated agent workspace exists; fall back to legacy layout
  const isolatedPath = path.join(home, '.openclaw', `workspace-${_personaName}`, 'memory', _personaName);
  const legacyPath = path.join(home, '.openclaw', 'workspace', 'memory', _personaName);
  if (fs.existsSync(isolatedPath)) return isolatedPath;
  if (fs.existsSync(legacyPath)) return legacyPath;
  // Default to isolated path for new installs
  return isolatedPath;
}

function getSkillBase(): string {
  return _skillBaseOverride ?? path.join(os.homedir(), '.openclaw', 'skills', 'alive');
}

function getRepoRoot(): string {
  return path.join(__dirname, '..', '..', '..');
}

function resolveTunablePromptPath(relativePath: string): string | null {
  const installedPath = path.join(getSkillBase(), 'tunable', 'prompts', relativePath);
  if (fs.existsSync(installedPath)) return installedPath;

  const devPath = path.join(getRepoRoot(), 'eval', 'tunable', 'prompts', relativePath);
  if (fs.existsSync(devPath)) return devPath;

  return null;
}

export function readTunablePrompt(relativePath: string): string | null {
  const resolved = resolveTunablePromptPath(relativePath);
  if (!resolved) return null;
  return fs.readFileSync(resolved, 'utf8');
}

/**
 * Read and JSON.parse a tunable config file under eval/tunable/prompts/.
 * Returns null (not throws) when the file is missing OR fails to parse — caller
 * must supply its own defaults in that case. This keeps tunable overrides safe
 * by construction: a broken tunable file never takes precedence over baked-in
 * constants.
 */
export function readTunableJSON<T>(relativePath: string): T | null {
  const raw = readTunablePrompt(relativePath);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error(`[tunable] failed to parse ${relativePath}:`, err);
    return null;
  }
}

export function renderTunablePrompt(
  template: string,
  vars: Record<string, string | number | boolean | null | undefined>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = vars[key];
    return value === null || value === undefined ? '' : String(value);
  });
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
  // === Subdirectory helpers ===
  get personaDir() { return path.join(getMemoryBase(), 'persona'); },
  get stateDir() { return path.join(getMemoryBase(), 'state'); },
  get queuesDir() { return path.join(getMemoryBase(), 'queues'); },

  // === persona/ — Core identity (low-frequency changes) ===
  get personaConfig() { return path.join(getMemoryBase(), 'persona', 'persona.yaml'); },
  get coreWisdom() { return path.join(getMemoryBase(), 'persona', 'core-wisdom.json'); },
  get preferences() { return path.join(getMemoryBase(), 'persona', 'preferences.json'); },
  get aspirations() { return path.join(getMemoryBase(), 'persona', 'aspirations.json'); },
  get skillNeeds() { return path.join(getMemoryBase(), 'persona', 'skill-needs.json'); },

  // === state/ — Real-time state (high-frequency reads/writes) ===
  get emotionState() { return path.join(getMemoryBase(), 'state', 'emotion-state.json'); },
  get confidenceState() { return path.join(getMemoryBase(), 'state', 'confidence-state.json'); },
  get flowState() { return path.join(getMemoryBase(), 'state', 'flow-state.json'); },
  get vitalityState() { return path.join(getMemoryBase(), 'state', 'vitality-state.json'); },
  get inspirationState() { return path.join(getMemoryBase(), 'state', 'inspiration-state.json'); },
  get keywordState() { return path.join(getMemoryBase(), 'state', 'keyword-state.json'); },
  get searchState() { return path.join(getMemoryBase(), 'state', 'search-state.json'); },
  get contentPatterns() { return path.join(getMemoryBase(), 'state', 'content-patterns.json'); },
  get personalityDrift() { return path.join(getMemoryBase(), 'state', 'personality-drift.json'); },
  get scheduleToday() { return path.join(getMemoryBase(), 'state', 'schedule-today.json'); },
  get contentTaste() { return path.join(getMemoryBase(), 'state', 'content-taste.json'); },
  get travelState() { return path.join(getMemoryBase(), 'state', 'travel-state.json'); },
  get workImpulse() { return path.join(getMemoryBase(), 'state', 'work-impulse.json'); },
  get contentStrategy() { return path.join(getMemoryBase(), 'state', 'content-strategy.json'); },

  // === queues/ — Transient queues & logs ===
  get intentPool() { return path.join(getMemoryBase(), 'queues', 'intent-pool.json'); },
  get eventQueue() { return path.join(getMemoryBase(), 'queues', 'event-queue.json'); },
  get heartbeatLog() { return path.join(getMemoryBase(), 'queues', 'heartbeat-log.json'); },
  get pendingChains() { return path.join(getMemoryBase(), 'queues', 'pending-chains.json'); },
  get reviewQueue() { return path.join(getMemoryBase(), 'queues', 'review-queue.json'); },
  get postAnalysisLog() { return path.join(getMemoryBase(), 'queues', 'post-analysis-log.json'); },
  get personaReportLog() { return path.join(getMemoryBase(), 'queues', 'persona-report-log.json'); },
  get competitorLog() { return path.join(getMemoryBase(), 'queues', 'competitor-log.json'); },
  get discoveryPool() { return path.join(getMemoryBase(), 'queues', 'discovery-pool.json'); },
  get opsBriefLog() { return path.join(getMemoryBase(), 'queues', 'ops-brief-log.json'); },
  get performanceLog() { return path.join(getMemoryBase(), 'queues', 'performance-log.json'); },
  get analysisLog() { return path.join(getMemoryBase(), 'queues', 'analysis-log.json'); },
  get trendHistory() { return path.join(getMemoryBase(), 'queues', 'trend-history.json'); },
  get trendsCache() { return path.join(getMemoryBase(), 'queues', 'trends-cache.json'); },
  get searchKeywordCache() { return path.join(getMemoryBase(), 'queues', 'search-keyword-cache.json'); },
  get competitorPosts() { return path.join(getMemoryBase(), 'queues', 'competitor-posts.json'); },
  get competitorAnalysis() { return path.join(getMemoryBase(), 'queues', 'competitor-analysis.json'); },
  get candidateAccounts() { return path.join(getMemoryBase(), 'queues', 'candidate-accounts.json'); },
  get postHistory() { return path.join(getMemoryBase(), 'queues', 'post-history.json'); },
  get pendingEngagement() { return path.join(getMemoryBase(), 'queues', 'pending-engagement.json'); },
  get outboundHistory() { return path.join(getMemoryBase(), 'queues', 'outbound-history.json'); },
  get healthReport() { return path.join(getMemoryBase(), 'queues', 'health-report.json'); },
  get audiencePerception() { return path.join(getMemoryBase(), 'queues', 'audience-perception.json'); },
  get directionIdeaCache() { return path.join(getMemoryBase(), 'queues', 'direction-idea-cache.json'); },
  /**
   * Per-persona log of directions the user has explicitly queried via
   * `/idea <direction>`. The ops-browse cron reads this file to pre-fetch
   * those directions on the next round so subsequent `/idea <same>` calls
   * hit the cache instead of running an inline search.
   */
  get activeDirections() { return path.join(getMemoryBase(), 'queues', 'active-directions.json'); },

  // === Social (unchanged) ===
  get socialMeta() { return path.join(getMemoryBase(), 'relations', 'social-meta.json'); },
  get socialDir() { return path.join(getMemoryBase(), 'relations', 'social'); },

  // === Root-level files (remain at memory base) ===
  get diary() { return path.join(getMemoryBase(), 'diary.md'); },
  get world() { return path.join(getMemoryBase(), 'world.md'); },
  get cronSchedule() { return path.join(getMemoryBase(), 'cron-schedule.json'); },
  get formulaStore() { return path.join(getMemoryBase(), 'formula-store.json'); },
  get tagVocabulary() { return path.join(getMemoryBase(), 'tag-vocabulary.json'); },
  get positioningReport() { return path.join(getMemoryBase(), 'positioning-report.json'); },
  get positioningReportPrev() { return path.join(getMemoryBase(), 'positioning-report.prev.json'); },
  get photoGallery() { return path.join(getMemoryBase(), 'photo-gallery.json'); },
  get inspiration() { return path.join(getMemoryBase(), 'inspiration.json'); },
  get photoRoll() { return path.join(getMemoryBase(), 'photo-roll'); },
  get inspirationRefs() { return path.join(getMemoryBase(), 'inspiration-refs'); },
  get competitorsDir() { return path.join(getMemoryBase(), 'competitors'); },
  get hitBreakdownsDir() { return path.join(getMemoryBase(), 'hit-breakdowns'); },
  get referencesDir() { return path.join(getMemoryBase(), 'assets', 'references'); },

  // === Shared skill infra (global, not per-persona) ===
  get skillRegistry() { return path.join(getSkillBase(), 'skill-registry.json'); },
  get subSkillsDir() { return path.join(getSkillBase(), 'sub-skills'); },
  get assetsDir() { return path.join(getSkillBase(), 'assets'); },

  // === Global runtime logs (shared across all personas) ===
  get runtimeDir() {
    if (_memoryBaseOverride) return path.join(_memoryBaseOverride, '..', '_runtime');
    // Use the agent's workspace for runtime logs
    const home = os.homedir();
    if (_personaName === 'main' || _personaName === 'default') {
      return path.join(home, '.openclaw', 'workspace', 'runtime');
    }
    const isolatedRuntime = path.join(home, '.openclaw', `workspace-${_personaName}`, 'runtime');
    const legacyRuntime = path.join(home, '.openclaw', 'workspace', 'runtime');
    if (fs.existsSync(path.dirname(isolatedRuntime))) return isolatedRuntime;
    return legacyRuntime;
  },
  get llmCallLog() { return path.join(this.runtimeDir, 'llm-call-log.jsonl'); },

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
      } catch (err) {
        console.warn(`[file-utils] Failed to parse ${target}: ${(err as Error).message}${suffix === '' ? ', trying .bak' : ''}`);
      }
    }
  }
  return defaultValue;
}

/**
 * Write JSON file atomically with .bak backup before overwrite.
 * Writes to a temp file first, then renames — rename is atomic on POSIX,
 * so a crash mid-write cannot corrupt both the target and backup.
 */
export function writeJSON<T>(filePath: string, data: T): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  // 1. Write to temp file first
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  // 2. Backup existing file (if any)
  if (fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, filePath + '.bak');
    } catch {
      // Backup failure is non-fatal; proceed with the write
    }
  }
  // 3. Atomic rename (same filesystem, so this is atomic on POSIX)
  fs.renameSync(tmpPath, filePath);
}

const LOCK_STALE_MS = 30_000;

/**
 * Execute a callback while holding an advisory file lock.
 * Prevents concurrent read-modify-write races on the same file.
 * Lock is automatically released when the callback completes or throws.
 */
export async function withFileLock<T>(filePath: string, fn: () => T | Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const lockContent = `${process.pid}\n${Date.now()}`;

  // Acquire lock (spin with backoff)
  let acquired = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      // O_EXCL ensures atomic creation — fails if file already exists
      fs.writeFileSync(lockPath, lockContent, { flag: 'wx' });
      acquired = true;
      break;
    } catch {
      // Check if existing lock is stale
      try {
        const existing = fs.readFileSync(lockPath, 'utf8');
        const lockTime = parseInt(existing.split('\n')[1] ?? '0', 10);
        if (Date.now() - lockTime > LOCK_STALE_MS) {
          // Stale lock — remove and retry
          try { fs.unlinkSync(lockPath); } catch { /* race ok */ }
          continue;
        }
      } catch {
        // Lock file disappeared between our check — retry
        continue;
      }
      // Wait with exponential backoff
      await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
    }
  }

  if (!acquired) {
    throw new Error(`Failed to acquire file lock for ${filePath} after 10 attempts`);
  }

  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* already removed */ }
  }
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
 *
 * Tunable override priority:
 * 1. <skillBase>/tunable/prompts/lifecycle/<templateName>
 * 2. <repoRoot>/eval/tunable/prompts/lifecycle/<templateName>
 * 3. legacy templates locations
 */
export function readTemplate(templateName: string): string {
  const tunablePath = resolveTunablePromptPath(path.join('lifecycle', templateName));
  if (tunablePath) return fs.readFileSync(tunablePath, 'utf8');

  const installedPath = path.join(getSkillBase(), 'templates', templateName);
  if (fs.existsSync(installedPath)) return fs.readFileSync(installedPath, 'utf8');

  const devPath = path.join(__dirname, '..', '..', 'templates', templateName);
  if (fs.existsSync(devPath)) return fs.readFileSync(devPath, 'utf8');

  throw new Error(`Template not found: ${templateName} (tried tunable override, ${installedPath} and ${devPath})`);
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

/**
 * Resolve the LLM call log path.
 * Uses PATHS.llmCallLog (global runtime dir) by default.
 * Falls back to the legacy memory-level path if the new file doesn't exist yet.
 */
export function resolveLlmLogPath(): string {
  const newPath = PATHS.llmCallLog;
  if (fs.existsSync(newPath)) return newPath;

  // Legacy fallback: old location was memory root (parent of persona dirs).
  // Use getMemoryBase()'s parent so that test overrides (setBasePaths) are respected.
  const memoryRoot = path.dirname(getMemoryBase());
  const legacyPath = path.join(memoryRoot, 'llm-call-log.jsonl');
  if (fs.existsSync(legacyPath)) return legacyPath;

  // Neither exists; return the new canonical path (will be created on first write)
  return newPath;
}

/**
 * Load skill environment variables from ~/.openclaw/openclaw.json
 * This is needed for cron jobs that run in isolated session mode where process.env
 * is not automatically populated with skill environment variables.
 *
 * Usage: Call this early in cron job entry points (e.g., in ops-brief.ts, ops-trends.ts)
 */
export function loadSkillEnvVars(skillName: string = 'alive'): void {
  try {
    const openclawConfigPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    if (!fs.existsSync(openclawConfigPath)) {
      console.warn(`[loadSkillEnvVars] openclaw.json not found at ${openclawConfigPath}`);
      return;
    }

    const config = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf8'));
    const skillEnv = config?.skills?.entries?.[skillName]?.env;
    if (!skillEnv || typeof skillEnv !== 'object') {
      console.warn(`[loadSkillEnvVars] No env found for skill "${skillName}" in openclaw.json`);
      return;
    }

    // Load all environment variables from openclaw.json into process.env
    // Only override if not already set (allows command-line or parent process env to take precedence)
    let loadedCount = 0;
    for (const [key, value] of Object.entries(skillEnv)) {
      if (typeof value === 'string' && !process.env[key]) {
        process.env[key] = value;
        loadedCount++;
      }
    }
    if (process.env.ALIVE_DEBUG === '1' || process.env.ALIVE_DEBUG === 'true') {
      console.log(`[loadSkillEnvVars] Loaded ${loadedCount} environment variables for skill "${skillName}"`);
    }
  } catch (err) {
    console.error(`[loadSkillEnvVars] Failed to load environment variables:`, err);
  }
}
