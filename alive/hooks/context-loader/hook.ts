// alive/hooks/context-loader/hook.ts
// OpenClaw Hook: Context Loader
// Runs at conversation start — loads persona, memory, and emotional context.

import * as path from 'path';
import { readJSON, readText, PATHS, setPersonaName } from '../../scripts/utils/file-utils';
import type { EmotionState, WisdomStore, PersonaConfig } from '../../scripts/utils/types';
import { hydrateEmotionState } from '../../scripts/utils/types';
import { injectPersona } from '../../scripts/persona/persona-loader';

export interface ContextLoaderResult {
  persona: PersonaConfig;
  emotionState: EmotionState;
  coreWisdom: WisdomStore;
  recentDiary: string;
  relationFile: string | null;
  personality: string;
  memoryProtocol: string;
}

/**
 * Load all context needed for the start of a conversation.
 *
 * This implements the Conversation Start Protocol from SKILL.md:
 * 1. Read core-wisdom.json
 * 2. Read relations/{user_id}.json if known
 * 3. Read last 7 days of diary.md
 * 4. Read emotion-state.json
 * 5. Load personality.md and memory.md
 */
export async function loadContext(
  persona: PersonaConfig,
  userId?: string,
): Promise<ContextLoaderResult> {
  // Initialize persona name for path resolution
  setPersonaName(persona.meta.name);

  // 1. Core wisdom
  const coreWisdom = readJSON<WisdomStore>(PATHS.coreWisdom, {
    version: 1,
    wisdom: [],
    total_importance_since_reflection: 0,
  });

  // 2. Relations for this user
  let relationFile: string | null = null;
  if (userId) {
    const relPath = path.join(path.dirname(PATHS.socialMeta), `${userId}.json`);
    const relData = readText(relPath, '');
    if (relData) relationFile = relData;
  }

  // 3. Recent diary (last 7 days — scan for ## date headers)
  const fullDiary = readText(PATHS.diary, '');
  const recentDiary = extractRecentDiary(fullDiary, 7);

  // 4. Emotion state
  const rawEmotion = readJSON<Record<string, unknown>>(PATHS.emotionState, {});
  const emotionState = Object.keys(rawEmotion).length > 0
    ? hydrateEmotionState(rawEmotion)
    : getDefaultEmotionState();

  // 5. Templates (inject persona placeholders into personality.md)
  const rawPersonality = readText(
    path.join(getTemplatesDir(), 'personality.md'),
    '# Personality\n(not loaded)',
  );
  const personality = injectPersona(rawPersonality, persona);
  const rawMemoryProtocol = readText(
    path.join(getProtocolsDir(), 'memory.md'),
    '# Memory Protocol\n(not loaded)',
  );
  const memoryProtocol = injectPersona(rawMemoryProtocol, persona);

  return {
    persona,
    emotionState,
    coreWisdom,
    recentDiary,
    relationFile,
    personality,
    memoryProtocol,
  };
}

// === Internal Helpers ===

function getTemplatesDir(): string {
  // Dev mode: relative to this file
  return path.resolve(__dirname, '..', '..', 'templates');
}

function getProtocolsDir(): string {
  return path.resolve(__dirname, '..', '..', 'protocols');
}

function extractRecentDiary(fullDiary: string, days: number): string {
  if (!fullDiary) return '';

  const lines = fullDiary.split('\n');
  const dateHeaders: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (/^## \d{4}-\d{2}-\d{2}/.test(lines[i])) {
      dateHeaders.push(i);
    }
  }

  if (dateHeaders.length === 0) {
    // No date headers — return last ~140 lines as approximation
    return lines.slice(-days * 20).join('\n');
  }

  // Take last N date sections
  const startIdx = dateHeaders.length > days
    ? dateHeaders[dateHeaders.length - days]
    : dateHeaders[0];

  return lines.slice(startIdx).join('\n');
}

function getDefaultEmotionState(): EmotionState {
  return {
    mood: { valence: 0.2, arousal: 0.4, description: 'calm' },
    energy: 0.5,
    stress: 0.2,
    creativity: 0.4,
    sociability: 0.4,
    last_updated: null,
    recent_cause: 'session start',
    momentum: {
      valence: 0, arousal: 0, energy: 0,
      stress: 0, creativity: 0, sociability: 0,
      duration_ticks: 0,
    },
    undertone: {
      valence: 0.2, arousal: 0.4, energy: 0.5,
      stress: 0.2, creativity: 0.4, sociability: 0.4,
    },
    impulse_history: [],
    consecutive_high_stress: 0,
    threshold_break_cooldown: 0,
  };
}
