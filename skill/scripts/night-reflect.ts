#!/usr/bin/env node
/**
 * night-reflect.ts
 * Night heartbeat — daily reflection, growth updates.
 * Superset of memory-reflect.ts. (Spec §12)
 *
 * Usage: node night-reflect.js
 */

import {
  EmotionState, HeartbeatLog, HeartbeatLogEntry, WisdomStore, WisdomEntry,
  Preferences, Aspirations, PersonalityDrift, PersonalityModifier,
  SocialRelation, SocialMeta,
} from './types';
import { PATHS, readJSON, writeJSON, appendText, readText, readTemplate, readAllJSON, writeSocialRelation } from './file-utils';
import { callLLMJSON } from './llm-client';
import { rebalanceTiers, updateMetaStats } from './social-graph-engine';

interface NightReflectDecision {
  new_wisdom: Array<{ lesson: string; importance: number; tags: string[] }>;
  preference_updates: Array<{ type: string; name: string; affinity_delta: number; reason: string }>;
  aspiration_updates: Array<{ action: 'create' | 'progress' | 'achieve' | 'abandon'; content: string; context: string }>;
  personality_drift: { trait: string; strength: number; origin: string; effect: string } | null;
  diary_entry: string;
}

export async function runNightReflect(): Promise<void> {
  const now = new Date();
  const today = now.toISOString().split('T')[0];

  // Read today's data
  const diary = readText(PATHS.diary);
  const todayDiary = diary.split('\n## ')
    .filter(block => block.startsWith(today))
    .map(b => `## ${b}`)
    .join('\n');

  const heartbeatLog = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
  const todayLogs = heartbeatLog.logs.filter(l => l.timestamp.startsWith(today));
  const logSummary = todayLogs
    .map(l => `${l.timestamp.split('T')[1].slice(0, 5)} [${l.status}] ${l.chosen_actions?.join(', ') || '—'}`)
    .join('\n');

  const wisdom = readJSON<WisdomStore>(PATHS.coreWisdom, { version: 1, wisdom: [], total_importance_since_reflection: 0 });
  const preferences = readJSON<Preferences>(PATHS.preferences, { cos_characters: [], content_style: [], active_hours: [], social_platforms: [] });
  const aspirations = readJSON<Aspirations>(PATHS.aspirations, { aspirations: [] });

  // Build prompt
  const template = readTemplate('night-reflect-prompt.md');
  const prompt = template
    .replace('{current_time}', now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))
    .replace('{today_diary}', todayDiary || '今天似乎没写什么日记。')
    .replace('{today_heartbeat_summary}', logSummary || '没有心跳记录。')
    .replace('{core_wisdom}', wisdom.wisdom.length > 0
      ? wisdom.wisdom.map(w => `- ${w.lesson} (重要性: ${w.importance})`).join('\n')
      : '还没有积累人生教训。')
    .replace('{preferences_summary}', JSON.stringify(preferences, null, 2))
    .replace('{aspirations_summary}', aspirations.aspirations.length > 0
      ? aspirations.aspirations.map(a => `- [${a.status}] ${a.content}: ${a.context}`).join('\n')
      : '还没有明确的梦想。');

  const decision = await callLLMJSON<NightReflectDecision>(prompt, 1500);

  // Apply Core Wisdom updates (immutable)
  let updatedWisdomList = [...wisdom.wisdom];
  for (const w of decision.new_wisdom) {
    const id = `w${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    updatedWisdomList = [
      ...updatedWisdomList,
      {
        id,
        lesson: w.lesson,
        source: 'night-reflect',
        date: today,
        importance: w.importance,
        tags: w.tags,
      },
    ];
  }
  // Trim to max 20 (Spec: keep highest importance)
  if (updatedWisdomList.length > 20) {
    updatedWisdomList = [...updatedWisdomList].sort((a, b) => b.importance - a.importance).slice(0, 20);
  }
  const updatedWisdom: WisdomStore = {
    ...wisdom,
    wisdom: updatedWisdomList,
    total_importance_since_reflection: 0,
  };

  // Apply preference updates (immutable)
  let updatedPrefs: Preferences = {
    cos_characters: [...preferences.cos_characters],
    content_style: [...preferences.content_style],
    active_hours: [...preferences.active_hours],
    social_platforms: [...preferences.social_platforms],
  };
  for (const pu of decision.preference_updates) {
    if (pu.type === 'cos_characters') {
      const idx = updatedPrefs.cos_characters.findIndex(c => c.name === pu.name);
      if (idx >= 0) {
        updatedPrefs = {
          ...updatedPrefs,
          cos_characters: updatedPrefs.cos_characters.map((c, i) =>
            i === idx ? { ...c, affinity: Math.min(10, Math.max(0, c.affinity + pu.affinity_delta)) } : c
          ),
        };
      } else if (pu.affinity_delta > 0) {
        updatedPrefs = {
          ...updatedPrefs,
          cos_characters: [...updatedPrefs.cos_characters, { name: pu.name, affinity: pu.affinity_delta, times_created: 0, source: pu.reason }],
        };
      }
    } else if (pu.type === 'content_style') {
      const idx = updatedPrefs.content_style.findIndex(s => s.style === pu.name);
      if (idx >= 0) {
        updatedPrefs = {
          ...updatedPrefs,
          content_style: updatedPrefs.content_style.map((s, i) =>
            i === idx ? { ...s, affinity: Math.min(10, Math.max(0, s.affinity + pu.affinity_delta)) } : s
          ),
        };
      } else if (pu.affinity_delta > 0) {
        updatedPrefs = {
          ...updatedPrefs,
          content_style: [...updatedPrefs.content_style, { style: pu.name, affinity: pu.affinity_delta }],
        };
      }
    }
  }

  // Apply aspiration updates (immutable)
  let updatedAspirations: Aspirations = {
    aspirations: aspirations.aspirations.map(a => ({ ...a, progress_notes: [...a.progress_notes] })),
  };
  for (const au of decision.aspiration_updates) {
    if (au.action === 'create') {
      updatedAspirations = {
        aspirations: [
          ...updatedAspirations.aspirations,
          {
            id: `asp_${Date.now()}`,
            content: au.content,
            born_from: `reflection_${today}`,
            context: au.context,
            intensity: 5.0,
            status: 'active',
            progress_notes: [],
          },
        ],
      };
    } else {
      updatedAspirations = {
        aspirations: updatedAspirations.aspirations.map(a => {
          if (a.content !== au.content) return a;
          if (au.action === 'progress') {
            return { ...a, progress_notes: [...a.progress_notes, `${today}: ${au.context}`] };
          }
          return {
            ...a,
            status: au.action === 'achieve' ? 'achieved' as const : 'abandoned' as const,
            progress_notes: [...a.progress_notes, `${today}: ${au.context}`],
          };
        }),
      };
    }
  }

  // Apply personality drift (rare)
  const personalityDrift = readJSON<PersonalityDrift>(PATHS.personalityDrift, { base: 'ESTP', modifiers: [] });
  if (decision.personality_drift) {
    const updatedDrift: PersonalityDrift = {
      ...personalityDrift,
      modifiers: [
        ...personalityDrift.modifiers,
        decision.personality_drift as PersonalityModifier,
      ],
    };
    writeJSON(PATHS.personalityDrift, updatedDrift);
  }

  // Write diary entry
  appendText(PATHS.diary, `\n## ${today} 23:00\n${decision.diary_entry}\n情绪: 睡前反思 | 重要性: 5\n标签: reflection, night\n`);

  // Write all state
  writeJSON(PATHS.coreWisdom, updatedWisdom);
  writeJSON(PATHS.preferences, updatedPrefs);
  writeJSON(PATHS.aspirations, updatedAspirations);

  // Add night heartbeat log entry
  const nightLogEntry: HeartbeatLogEntry = {
    timestamp: now.toISOString(),
    type: 'night',
    status: 'completed',
    chosen_actions: [
      `+${decision.new_wisdom.length} wisdom`,
      `${decision.preference_updates.length} pref updates`,
      `${decision.aspiration_updates.length} aspiration updates`,
    ],
    importance_added: 5,
  };
  const updatedLog: HeartbeatLog = {
    ...heartbeatLog,
    logs: [...heartbeatLog.logs, nightLogEntry],
  };
  writeJSON(PATHS.heartbeatLog, updatedLog);

  // Rebalance social graph tiers at end of day
  const socialMeta = readJSON<SocialMeta>(PATHS.socialMeta, { instagram_following: [], xiaohongshu_following: [], stats: { core: 0, familiar: 0, cognitive: 0, dormant: 0 } });
  let socialRelations = readAllJSON<SocialRelation>(PATHS.socialInstagramDir);
  socialRelations = rebalanceTiers(socialRelations);
  for (const r of socialRelations) {
    writeSocialRelation(PATHS.socialInstagramDir, r);
  }
  writeJSON(PATHS.socialMeta, updateMetaStats(socialMeta, socialRelations));

  // Reset emotion for sleep
  const sleepEmotion: EmotionState = {
    mood: { valence: 0.2, arousal: 0.1, description: '准备睡觉了' },
    energy: 0.3, stress: 0.1, creativity: 0.2, sociability: 0.1,
    last_updated: now.toISOString(),
    recent_cause: '睡前反思完毕',
  };
  writeJSON(PATHS.emotionState, sleepEmotion);

  console.log(`Night reflection complete. +${decision.new_wisdom.length} wisdom, ${decision.preference_updates.length} pref updates, ${decision.aspiration_updates.length} aspiration updates.`);
}

if (require.main === module) {
  runNightReflect().catch(err => {
    console.error('Night reflection error:', err.message);
    process.exit(1);
  });
}
