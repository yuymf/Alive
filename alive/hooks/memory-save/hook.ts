// alive/hooks/memory-save/hook.ts
// OpenClaw Hook: Memory Save
// Runs at conversation end — persists diary, relations, wisdom, and emotion state.

import * as path from 'path';
import { readJSON, writeJSON, appendText, PATHS } from '../../scripts/utils/file-utils';
import type {
  EmotionState, EmotionDelta, WisdomStore, WisdomEntry, SocialRelation,
} from '../../scripts/utils/types';
import type { LLMClient } from '../../scripts/utils/llm-client';

export interface ConversationSummary {
  /** Auto-generated diary entry for this conversation */
  diaryEntry: string;
  /** Importance score (1-10) — if >= 7, wisdom is updated */
  importanceScore: number;
  /** Optional emotion delta from the conversation */
  emotionDelta?: EmotionDelta;
  /** User relationship updates */
  relationUpdates?: Array<{
    userId: string;
    note: string;
    sentimentShift?: 'positive' | 'neutral' | 'negative';
  }>;
  /** Wisdom extracted from this conversation (if importance >= 7) */
  wisdomExtracted?: string;
}

/**
 * Save conversation context to persistent memory.
 *
 * This implements the Conversation End Protocol from SKILL.md:
 * 1. Write diary entry to diary.md with importance score
 * 2. Update relations/{user_id}.json with new relationship info
 * 3. If importance >= 7, update core-wisdom.json
 * 4. Update emotion-state.json to reflect conversation impact
 */
export async function saveMemory(
  summary: ConversationSummary,
  currentEmotion: EmotionState,
): Promise<void> {
  const now = new Date().toISOString();
  const dateStr = now.slice(0, 10);
  const timeStr = now.slice(11, 16);

  // 1. Append diary entry
  const diaryLine = `\n### ${timeStr}\n${summary.diaryEntry}\n_importance: ${summary.importanceScore}_\n`;
  const fullDiary = readJSON<string>(PATHS.diary, '');
  if (!fullDiary.includes(`## ${dateStr}`)) {
    appendText(PATHS.diary, `\n## ${dateStr}\n`);
  }
  appendText(PATHS.diary, diaryLine);

  // 2. Update relations
  if (summary.relationUpdates) {
    for (const update of summary.relationUpdates) {
      const relPath = path.join(path.dirname(PATHS.socialMeta), `${update.userId}.json`);
      const existing = readJSON<Partial<SocialRelation>>(relPath, {});

      const updatedRelation: Partial<SocialRelation> = {
        ...existing,
        id: update.userId,
        last_interaction: now,
      };

      // Append interaction
      if (!updatedRelation.interaction_history) {
        updatedRelation.interaction_history = [];
      }
      updatedRelation.interaction_history!.push({
        date: now,
        type: 'conversation',
        content: update.note,
      });

      // Adjust sentiment if specified
      if (update.sentimentShift && updatedRelation.relationship) {
        updatedRelation.relationship.sentiment = update.sentimentShift;
      }

      writeJSON(relPath, updatedRelation);
    }
  }

  // 3. Update core wisdom if importance >= 7
  if (summary.importanceScore >= 7 && summary.wisdomExtracted) {
    const wisdom = readJSON<WisdomStore>(PATHS.coreWisdom, {
      version: 1,
      wisdom: [],
      total_importance_since_reflection: 0,
    });

    const newEntry: WisdomEntry = {
      id: `wisdom-${Date.now()}`,
      lesson: summary.wisdomExtracted,
      source: 'conversation',
      date: dateStr,
      importance: summary.importanceScore,
      tags: [],
    };

    wisdom.wisdom.push(newEntry);
    wisdom.total_importance_since_reflection += summary.importanceScore;
    writeJSON(PATHS.coreWisdom, wisdom);
  }

  // 4. Update emotion state
  if (summary.emotionDelta) {
    const updated: EmotionState = {
      ...currentEmotion,
      last_updated: now,
      recent_cause: `conversation (importance: ${summary.importanceScore})`,
    };

    // Apply emotion delta
    const delta = summary.emotionDelta;
    if (delta.valence !== undefined) updated.mood.valence = clamp(updated.mood.valence + delta.valence, -1, 1);
    if (delta.arousal !== undefined) updated.mood.arousal = clamp(updated.mood.arousal + delta.arousal, 0, 1);
    if (delta.energy !== undefined) updated.energy = clamp(updated.energy + delta.energy, 0, 1);
    if (delta.stress !== undefined) updated.stress = clamp(updated.stress + delta.stress, 0, 1);
    if (delta.creativity !== undefined) updated.creativity = clamp(updated.creativity + delta.creativity, 0, 1);
    if (delta.sociability !== undefined) updated.sociability = clamp(updated.sociability + delta.sociability, 0, 1);

    writeJSON(PATHS.emotionState, updated);
  }
}

/**
 * Generate a conversation summary using the LLM.
 * This is a convenience function that hosts can call to auto-generate
 * diary entries from conversation transcripts.
 */
export async function generateSummary(
  llm: LLMClient,
  personaName: string,
  transcript: string,
): Promise<ConversationSummary> {
  const prompt = `You are ${personaName}. Summarize this conversation from your perspective for your diary.

Conversation:
${transcript}

Output JSON:
{
  "diaryEntry": "diary entry in first person, in character voice",
  "importanceScore": 1-10,
  "emotionDelta": { "valence": -0.1 to 0.1, "energy": ..., "stress": ... },
  "wisdomExtracted": "lesson learned (if importance >= 7, else null)"
}`;

  return llm.callJSON<ConversationSummary>(prompt, 500);
}

// === Helpers ===

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
