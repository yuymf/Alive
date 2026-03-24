// alive/scripts/lifecycle/memory-reflect.ts
// Reads high-importance memories, generates Core Wisdom via LLM reflection.
// Triggered when total_importance_since_reflection >= threshold.
//
// Generalized from skill/scripts/memory-reflect.ts
// - Hardcoded 'minase' path → dynamic via file-utils
// - callLLMJSON import → LLMClient interface injection
// - Template path → readTemplate from file-utils

import { PATHS, readJSON, writeJSON, readText, readTemplate } from '../utils/file-utils';
import { now, getLocalDate } from '../utils/time-utils';
import type { WisdomStore, WisdomEntry } from '../utils/types';
import type { LLMClient } from '../utils/llm-client';

// ── Configuration ────────────────────────────────────────────────

const DEFAULT_THRESHOLD = 100;
const MAX_WISDOM_ENTRIES = 20;
const MIN_IMPORTANCE = 6;

// ── Helpers ──────────────────────────────────────────────────────

function loadWisdom(): WisdomStore {
  return readJSON<WisdomStore>(PATHS.coreWisdom, {
    version: 1,
    wisdom: [],
    total_importance_since_reflection: 0,
  });
}

/**
 * Extract high-importance diary entries (importance >= minImportance).
 */
export function extractHighImportanceMemories(diaryContent: string, minImportance = MIN_IMPORTANCE): string[] {
  const blocks = diaryContent.split(/\n## /);
  return blocks
    .filter(block => {
      const match = block.match(/重要性: (\d+)/);
      return match && parseInt(match[1]) >= minImportance;
    })
    .slice(-20) // most recent 20 high-importance entries
    .map(b => b.trim());
}

// ── Main ─────────────────────────────────────────────────────────

export interface ReflectOptions {
  /** Force reflection even if threshold not reached */
  force?: boolean;
  /** Override threshold (default 100) */
  threshold?: number;
}

export interface ReflectResult {
  reflected: boolean;
  newEntries: number;
  reason: string;
}

/**
 * Run memory reflection: read diary → extract high-importance → LLM → update wisdom.
 *
 * @param llm - Injected LLM client (alive never imports a concrete LLM SDK)
 * @param options - Reflection options
 */
export async function reflect(llm: LLMClient, options: ReflectOptions = {}): Promise<ReflectResult> {
  const { force = false, threshold = DEFAULT_THRESHOLD } = options;
  const wisdom = loadWisdom();

  if (!force && wisdom.total_importance_since_reflection < threshold) {
    return {
      reflected: false,
      newEntries: 0,
      reason: `threshold-not-reached (${wisdom.total_importance_since_reflection}/${threshold})`,
    };
  }

  const diary = readText(PATHS.diary);
  if (!diary) {
    return { reflected: false, newEntries: 0, reason: 'no-diary' };
  }

  const highMemories = extractHighImportanceMemories(diary);
  if (highMemories.length === 0) {
    return { reflected: false, newEntries: 0, reason: 'no-high-importance-memories' };
  }

  // Load reflection prompt template
  let template: string;
  try {
    template = readTemplate('reflection-prompt.md');
  } catch {
    return { reflected: false, newEntries: 0, reason: 'template-not-found' };
  }

  const prompt = template
    .replace('{high_importance_memories}', highMemories.join('\n\n---\n\n'))
    .replace(/```[\s\S]*?```/g, match => match.slice(3, -3).trim());

  console.log('[memory-reflect] Running reflection...');

  let newLessons: WisdomEntry[];
  try {
    newLessons = await llm.callJSON<WisdomEntry[]>(prompt, 2000);
  } catch (err) {
    console.error(`[memory-reflect] LLM reflection failed: ${(err as Error).message}`);
    return { reflected: false, newEntries: 0, reason: `llm-error: ${(err as Error).message}` };
  }

  // Add new wisdom entries
  const todayStr = getLocalDate();
  const newEntries: WisdomEntry[] = newLessons.map(lesson => ({
    ...lesson,
    id: `w${now().getTime()}_${Math.random().toString(36).slice(2, 6)}`,
    date: todayStr,
    source: 'reflection',
  }));

  const allWisdom = [...wisdom.wisdom, ...newEntries];

  // Trim oldest low-importance if over limit
  const trimmedWisdom = allWisdom.length > MAX_WISDOM_ENTRIES
    ? [...allWisdom]
        .sort((a, b) => b.importance - a.importance || b.date.localeCompare(a.date))
        .slice(0, MAX_WISDOM_ENTRIES)
    : allWisdom;

  const updatedStore: WisdomStore = {
    ...wisdom,
    wisdom: trimmedWisdom,
    total_importance_since_reflection: 0,
  };
  writeJSON(PATHS.coreWisdom, updatedStore);

  console.log(`[memory-reflect] Reflection complete. Added ${newLessons.length} new wisdom entries.`);

  return {
    reflected: true,
    newEntries: newLessons.length,
    reason: 'ok',
  };
}
