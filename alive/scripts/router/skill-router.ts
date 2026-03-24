// alive/scripts/router/skill-router.ts
// Intent → Sub-skill routing engine

import * as fs from 'fs';
import * as path from 'path';
import {
  SubSkillManifest, SubSkill, SubSkillContext, SubSkillResult,
  IntentCategory, ResolvedIntent, EmotionState, PersonaConfig,
  FeedbackEvent, MemoryAccessor, SocialGraphAccessor, SocialRelation,
  getEnabledSubSkills,
} from '../utils/types';
import { PATHS, readJSON, writeJSON, readText, appendText, readAllJSON, writeSocialRelation } from '../utils/file-utils';

// === Route Table ===

interface RouteEntry {
  skillName: string;
  action: string;
  priority: number;
  manifest: SubSkillManifest;
  skillModule: SubSkill;
}

// intent category → sorted route entries
type RouteTable = Record<string, RouteEntry[]>;

let _routeTable: RouteTable | null = null;
let _loadedSkills: Map<string, SubSkill> = new Map();

/**
 * Load sub-skills from a single directory into the route table.
 * If allowList is provided, only loads skills whose manifest name is in the list.
 * Returns the number of skills loaded.
 */
function loadSkillsFromDir(dir: string, table: RouteTable, allowList?: Set<string>): number {
  if (!fs.existsSync(dir)) return 0;

  let loaded = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const manifestPath = path.join(dir, entry.name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifest: SubSkillManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

      // Filter: skip skills not in the allow list (if provided)
      if (allowList && !allowList.has(manifest.name)) {
        continue;
      }

      // Try to load the skill module
      const indexPath = path.join(dir, entry.name, 'scripts', 'index.js');
      if (!fs.existsSync(indexPath)) continue;

      const skillModule: SubSkill = require(indexPath);
      _loadedSkills.set(manifest.name, skillModule);

      for (const binding of manifest.intent_bindings) {
        if (!table[binding.intent]) table[binding.intent] = [];
        table[binding.intent].push({
          skillName: manifest.name,
          action: binding.action,
          priority: binding.priority,
          manifest,
          skillModule,
        });
      }
      loaded++;
    } catch (err) {
      console.error(`Failed to load sub-skill ${entry.name}: ${(err as Error).message}`);
    }
  }

  return loaded;
}

/**
 * Scan sub-skills directory and build the route table.
 * Scans both top-level sub-skills and the platform/ subdirectory.
 *
 * @param subSkillsDir - Override sub-skills directory (for testing)
 * @param persona - If provided, only loads sub-skills listed in persona.sub_skills.
 *                  If persona.sub_skills is undefined/empty, no sub-skills are loaded.
 *                  If persona is not provided, loads ALL sub-skills (backward compat / testing).
 */
export function buildRouteTable(subSkillsDir?: string, persona?: PersonaConfig): RouteTable {
  const dir = subSkillsDir ?? PATHS.subSkillsDir;
  const table: RouteTable = {};

  // Build allow-list from persona config (if provided)
  let allowList: Set<string> | undefined;
  if (persona) {
    const enabled = getEnabledSubSkills(persona);
    allowList = new Set(enabled);
    if (allowList.size === 0) {
      // No sub-skills enabled — return empty table
      _routeTable = table;
      return table;
    }
  }

  // Load top-level sub-skills (e.g. web-search, send-message, instagram)
  loadSkillsFromDir(dir, table, allowList);

  // Load platform sub-skills (e.g. platform/generate-image, platform/gallery)
  const platformDir = path.join(dir, 'platform');
  loadSkillsFromDir(platformDir, table, allowList);

  // Sort each intent's routes by priority (descending)
  for (const key of Object.keys(table)) {
    table[key].sort((a, b) => b.priority - a.priority);
  }

  _routeTable = table;
  return table;
}

/**
 * Get the route table (lazy-builds on first call).
 * Pass persona to enable sub-skill filtering on first build.
 */
export function getRouteTable(persona?: PersonaConfig): RouteTable {
  if (!_routeTable) _routeTable = buildRouteTable(undefined, persona);
  return _routeTable;
}

/**
 * Clear cached route table (for testing or hot-reload).
 */
export function clearRouteTable(): void {
  _routeTable = null;
  _loadedSkills.clear();
}

/**
 * Resolve an intent category to a sub-skill action.
 * Returns null if no sub-skill handles this intent.
 */
export function resolveRoute(intentCategory: string): RouteEntry | null {
  const table = getRouteTable();
  const routes = table[intentCategory];
  if (!routes || routes.length === 0) return null;
  return routes[0]; // highest priority
}

/**
 * Resolve a sub-skill route by skill name (e.g. "instagram", "social-engagement").
 * This searches all route entries for a matching skillName, regardless of intent category.
 * Returns null if no sub-skill with that name is registered.
 */
export function resolveRouteBySkillName(skillName: string): RouteEntry | null {
  const table = getRouteTable();
  for (const routes of Object.values(table)) {
    for (const route of routes) {
      if (route.skillName === skillName) return route;
    }
  }
  return null;
}

// === Fuzzy Skill Name Resolution ===

/**
 * Keyword → registered skill name mapping for LLM hallucination recovery.
 * When LLM outputs a non-existent skill name (e.g. "social-media-posting"),
 * we try to fuzzy-match it to an actual registered skill.
 */
const SKILL_ALIAS_KEYWORDS: Record<string, string[]> = {
  'instagram': ['instagram', 'ig', 'insta', 'post', 'posting', 'photo-post', 'social-media-post', 'photo-share', 'photo-sharing'],
  'social-engagement': ['social', 'engagement', 'comment', 'reply', 'interact', 'live', 'stream', 'streaming', 'live-stream', 'live-streaming', 'broadcast', 'collab'],
  'send-message': ['message', 'chat', 'dm', 'send-msg'],
  'content-browse': ['browse', 'feed', 'scroll', 'inspiration', 'explore', 'discover'],
  'web-search': ['search', 'research', 'google', 'lookup', 'query'],
  'voice-tts': ['voice', 'tts', 'audio', 'speak'],
};

/**
 * Try to fuzzy-match an unknown skill name to a registered skill.
 * Only returns a match if the resolved skill is actually in the route table.
 */
export function fuzzyResolveSkillName(unknownName: string): RouteEntry | null {
  const lower = unknownName.toLowerCase().replace(/[_\s]+/g, '-');

  for (const [skillName, keywords] of Object.entries(SKILL_ALIAS_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw) || kw.includes(lower))) {
      const route = resolveRouteBySkillName(skillName);
      if (route) {
        console.log(`[router] Fuzzy-matched "${unknownName}" → "${skillName}"`);
        return route;
      }
    }
  }
  return null;
}

/**
 * Get all registered intent categories that have sub-skill handlers.
 */
export function getHandledIntents(): string[] {
  return Object.keys(getRouteTable());
}

/**
 * Get all registered sub-skill manifests.
 */
export function getRegisteredSkills(): SubSkillManifest[] {
  const table = getRouteTable();
  const seen = new Set<string>();
  const manifests: SubSkillManifest[] = [];

  for (const routes of Object.values(table)) {
    for (const route of routes) {
      if (seen.has(route.skillName)) continue;
      seen.add(route.skillName);
      manifests.push(route.manifest);
    }
  }

  return manifests;
}

/**
 * Build a SubSkillContext for executing a sub-skill action.
 */
export function buildContext(
  persona: PersonaConfig,
  emotion: EmotionState,
  vitality: number,
  confidence: number,
  intent: ResolvedIntent,
  llmClient: { callJSON<T>(prompt: string, maxTokens?: number): Promise<T>; call(prompt: string, maxTokens?: number): Promise<string> },
  skillConfig: Record<string, unknown> = {},
): SubSkillContext {
  // Build memory accessor
  const memory: MemoryAccessor = {
    readDiary(lastNDays = 7): string {
      const diary = readText(PATHS.diary);
      if (lastNDays <= 0) return diary;
      const lines = diary.split('\n');
      return lines.slice(-lastNDays * 20).join('\n'); // rough approximation
    },
    appendDiary(entry: string): void {
      appendText(PATHS.diary, entry);
    },
    readJSON<T>(key: string, fallback: T): T {
      const memBase = path.dirname(PATHS.diary);
      return readJSON(path.join(memBase, `${key}.json`), fallback);
    },
    writeJSON<T>(key: string, data: T): void {
      const memBase = path.dirname(PATHS.diary);
      writeJSON(path.join(memBase, `${key}.json`), data);
    },
  };

  // Build social graph accessor
  const socialGraph: SocialGraphAccessor = {
    getRelations(platform?: string): SocialRelation[] {
      const all = readAllJSON<SocialRelation>(PATHS.socialDir);
      if (!platform) return all;
      return all.filter(r => r.platform === platform);
    },
    updateRelation(id: string, update: Partial<SocialRelation>): void {
      const all = readAllJSON<SocialRelation>(PATHS.socialDir);
      const existing = all.find(r => r.id === id);
      if (existing) {
        writeSocialRelation(PATHS.socialDir, { ...existing, ...update, id });
      }
    },
  };

  return {
    persona,
    emotion,
    vitality,
    confidence,
    intent,
    memory,
    socialGraph,
    llm: llmClient,
    config: skillConfig,
  };
}

/**
 * Execute a sub-skill action and return the result.
 */
export async function executeSubSkill(
  route: RouteEntry,
  context: SubSkillContext,
): Promise<SubSkillResult> {
  const actionFn = route.skillModule.actions[route.action];
  if (!actionFn) {
    throw new Error(`Sub-skill ${route.skillName} has no action "${route.action}"`);
  }

  console.log(`[router] Executing ${route.skillName}.${route.action} for intent: ${context.intent.description}`);
  return actionFn(context);
}

/**
 * Collect all events.json from installed sub-skills.
 * Returns merged event definitions for the random events engine.
 * Scans both top-level and platform/ sub-skills.
 */
export function collectSubSkillEvents(): Array<{ source: string; events: unknown[] }> {
  const dir = PATHS.subSkillsDir;
  const results: Array<{ source: string; events: unknown[] }> = [];

  function scanDir(scanPath: string): void {
    if (!fs.existsSync(scanPath)) return;

    for (const entry of fs.readdirSync(scanPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const eventsPath = path.join(scanPath, entry.name, 'events.json');
      if (!fs.existsSync(eventsPath)) continue;

      try {
        const events = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
        results.push({ source: entry.name, events: Array.isArray(events) ? events : events.events ?? [] });
      } catch {
        console.error(`Failed to load events from sub-skill ${entry.name}`);
      }
    }
  }

  scanDir(dir);
  scanDir(path.join(dir, 'platform'));

  return results;
}
