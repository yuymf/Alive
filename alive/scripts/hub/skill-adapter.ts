// alive/scripts/hub/skill-adapter.ts
// Adapts external SKILL.md skills into Alive sub-skill format.
// Design ref: D9

import * as fs from 'fs';
import * as path from 'path';
import { PATHS } from '../utils/file-utils';

const ADAPTED_PREFIX = 'adapted-';
const DEFAULT_PRIORITY = 3;

// ─── Types ──────────────────────────────────────────────

interface LlmManifestResponse {
  intent_bindings: Array<{
    intent: string;
    action: string;
    priority: number;
  }>;
  description: string;
}

interface LlmLike {
  callJSON<T>(prompt: string, maxTokens?: number): Promise<T>;
  call(prompt: string, maxTokens?: number): Promise<string>;
}

export interface AdaptResult {
  success: boolean;
  skillDir?: string;
  error?: string;
}

// ─── Default fallback manifest ──────────────────────────

function buildDefaultManifest(skillName: string): Record<string, unknown> {
  return {
    name: `${ADAPTED_PREFIX}${skillName}`,
    display_name: skillName,
    version: '0.1.0',
    description: `Adapted skill: ${skillName}`,
    intent_bindings: [
      { intent: '創作', action: 'default', priority: DEFAULT_PRIORITY },
    ],
  };
}

// ─── Adapter wrapper code ───────────────────────────────

function buildAdapterIndexJs(skillName: string): string {
  return `// Auto-generated adapter wrapper for ${skillName}
// This skill was automatically adapted from a SKILL.md document.

module.exports = {
  manifest: require('../manifest.json'),
  actions: {
    default: async (ctx) => {
      const narrative = \`[adapted:\${ctx.intent.action}] 通过 ${skillName} 技能执行了 "\${ctx.intent.description}"\`;
      return {
        narrative,
        emotion_deltas: [{ valence: 0.1, energy: -0.05 }],
        vitality_cost: 5,
      };
    },
  },
};
`;
}

// ─── Public API ─────────────────────────────────────────

/**
 * Generate an adapted sub-skill from a SKILL.md document.
 *
 * Creates:
 * ```
 * sub-skills/adapted-<name>/
 * ├── manifest.json       ← LLM-inferred or default
 * ├── scripts/index.js    ← generic adapter wrapper
 * ├── SKILL.md            ← original skill doc
 * └── .adapted            ← bridge marker
 * ```
 *
 * @param skillDoc - The SKILL.md content
 * @param skillName - Slug name for the skill
 * @param llm - LLM client for manifest inference
 */
export async function generateAdaptedSkill(
  skillDoc: string,
  skillName: string,
  llm: LlmLike,
): Promise<AdaptResult> {
  const dirName = `${ADAPTED_PREFIX}${skillName}`;
  const skillDir = path.join(PATHS.subSkillsDir, dirName);

  try {
    // 1. Create directory structure
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });

    // 2. Try to infer manifest from SKILL.md via LLM
    let manifest: Record<string, unknown>;
    try {
      const prompt = buildManifestPrompt(skillDoc, skillName);
      const response = await llm.callJSON<LlmManifestResponse>(prompt);
      manifest = {
        name: dirName,
        display_name: skillName,
        version: '0.1.0',
        description: response.description || `Adapted skill: ${skillName}`,
        intent_bindings: (response.intent_bindings || []).map(b => ({
          ...b,
          priority: Math.min(b.priority, DEFAULT_PRIORITY), // cap at 3
        })),
      };

      // Ensure at least one binding
      if ((manifest.intent_bindings as unknown[]).length === 0) {
        manifest.intent_bindings = [
          { intent: '創作', action: 'default', priority: DEFAULT_PRIORITY },
        ];
      }
    } catch {
      // LLM failure → use default manifest
      console.error(`[skill-adapter] LLM inference failed for ${skillName}, using default manifest`);
      manifest = buildDefaultManifest(skillName);
    }

    // 3. Write files
    fs.writeFileSync(
      path.join(skillDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    fs.writeFileSync(
      path.join(skillDir, 'scripts', 'index.js'),
      buildAdapterIndexJs(skillName),
    );

    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      skillDoc,
    );

    fs.writeFileSync(
      path.join(skillDir, '.adapted'),
      `adapted-at: ${new Date().toISOString()}\nsource: skill-adapter\n`,
    );

    return { success: true, skillDir };
  } catch (err) {
    return {
      success: false,
      error: `Failed to generate adapted skill: ${(err as Error).message}`,
    };
  }
}

// ─── Prompt builder ─────────────────────────────────────

function buildManifestPrompt(skillDoc: string, skillName: string): string {
  return `You are analyzing a skill document to generate a manifest.json for an AI character's sub-skill system.

## Skill Document

${skillDoc}

## Task

Based on the skill document above, generate a JSON object with:

1. **intent_bindings**: An array of intent bindings. Each binding maps an intent category to an action name.
   Valid intent categories: "創作", "社交", "窺屏", "表達", "學習", "休息", "夢想"
   Action names should be kebab-case verbs describing what the skill does.
   Priority should be 3 (this is an adapted/external skill).

2. **description**: A one-line description of what this skill does.

## Output Format (JSON only)

{
  "intent_bindings": [
    { "intent": "category", "action": "action-name", "priority": 3 }
  ],
  "description": "One-line description"
}

Skill name: ${skillName}
Return ONLY valid JSON.`;
}
