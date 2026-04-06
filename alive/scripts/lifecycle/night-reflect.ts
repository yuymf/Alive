#!/usr/bin/env node
/**
 * night-reflect.ts
 * Night heartbeat — daily reflection, growth updates, social graph rebalancing.
 * Generalized: no platform-specific preferences, no Instagram social graph.
 */

import {
  EmotionState, HeartbeatLog, HeartbeatLogEntry, WisdomStore, WisdomEntry,
  Preferences, Aspirations, PersonalityDrift, PersonalityModifier,
  SocialRelation, SocialMeta,
  DEFAULT_MOMENTUM,
  FlowState, DEFAULT_FLOW_STATE,
  ChainAndCooldownState, DEFAULT_CHAIN_STATE,
  IntentPool,
  isFeatureEnabled,
  ContentStrategy,
  CompetitorLog,
  ContentTaste, DEFAULT_CONTENT_TASTE,
} from '../utils/types';
import { PATHS, readJSON, writeJSON, appendText, readText, readTemplate, readAllJSON, writeSocialRelation } from '../utils/file-utils';
import { now, getLocalDate, formatLocalTime, setTimezone } from '../utils/time-utils';
import { rebalanceTiers, updateMetaStats } from '../world/social-graph-engine';
import { processChainEvents } from '../world/random-events';
import { getDefaultUndertone, loadPersona, injectPersona } from '../persona/persona-loader';
import { evaluateSkillNeeds, discoverAndInstall, buildSkillNeedsForPrompt } from '../hub/skill-discovery';
import { runDriftAnalysis } from '../engines/personality-drift';

interface NightReflectDecision {
  new_wisdom: Array<{ lesson: string; importance: number; tags: string[] }>;
  preference_updates: Array<{ type: string; name: string; affinity_delta: number; reason: string }>;
  aspiration_updates: Array<{ action: 'create' | 'progress' | 'achieve' | 'abandon'; content: string; context: string }>;
  personality_drift: { trait: string; strength: number; origin: string; effect: string } | null;
  skill_acquisition_plans?: Array<{ need_id: string; search_query: string; priority: number; rationale: string }>;
  diary_entry: string;
}

export async function runNightReflect(
  llm: { callJSON<T>(prompt: string, maxTokens?: number): Promise<T>; call(prompt: string, maxTokens?: number): Promise<string> },
): Promise<void> {
  const persona = loadPersona();
  // Set timezone from persona config before any time operations
  setTimezone(persona.schedule?.timezone ?? null);

  const currentTime = now();
  const today = getLocalDate(currentTime);
  const defaultUndertone = getDefaultUndertone(persona);

  // Read today's data
  const diary = readText(PATHS.diary);
  const todayDiary = diary.split('\n## ')
    .filter(block => block.startsWith(today))
    .map(b => `## ${b}`)
    .join('\n');

  let heartbeatLog = readJSON<HeartbeatLog>(PATHS.heartbeatLog, { logs: [], retention_days: 7 });
  // Handle legacy format: { entries, lastUpdate } → { logs, retention_days }
  if (!heartbeatLog.logs && (heartbeatLog as any).entries) {
    heartbeatLog = { logs: (heartbeatLog as any).entries, retention_days: 7 };
  }
  heartbeatLog = { ...heartbeatLog, logs: heartbeatLog.logs ?? [] };
  const todayLogs = heartbeatLog.logs.filter(l => l.timestamp.startsWith(today));
  const logSummary = todayLogs
    .map(l => `${l.timestamp.split('T')[1].slice(0, 5)} [${l.status}] ${l.chosen_actions?.join(', ') || '—'}`)
    .join('\n');

  // Process remaining chain events before reflection
  let chainState = readJSON<ChainAndCooldownState>(PATHS.pendingChains, DEFAULT_CHAIN_STATE);
  const chainResult = processChainEvents(chainState);
  chainState = chainResult.remaining;
  for (const triggered of chainResult.triggered) {
    appendText(PATHS.diary, `\n## ${today} 23:00\n${triggered.event.diary_entry}\n情绪: 连锁事件 | 重要性: 2\n标签: 连锁事件, night\n`);
  }

  // Gather flow statistics for today
  const flowTicks = todayLogs.filter(l => l.flow_state === 'flow').length;
  const driftTicks = todayLogs.filter(l => l.flow_state === 'drift').length;
  const flowSummary = flowTicks > 0 || driftTicks > 0
    ? `今天的状态: ${flowTicks}小时沉浸, ${driftTicks}小时摆烂`
    : '';

  // Gather procrastination data from intent pool
  const intentPool = readJSON<IntentPool>(PATHS.intentPool, { intents: [], last_updated: null });
  const procrastinatedIntents = intentPool.intents
    .filter(i => i.satisfied_at === null && i.skipped_count >= 3)
    .map(i => `${i.description} (拖了${i.skipped_count}次)`);
  const procrastinationSummary = procrastinatedIntents.length > 0
    ? `一直拖延的事: ${procrastinatedIntents.join('、')}`
    : '';

  const wisdom = readJSON<WisdomStore>(PATHS.coreWisdom, { version: 1, wisdom: [], total_importance_since_reflection: 0 });
  const preferences = readJSON<Preferences>(PATHS.preferences, { interests: [], content_style: [], active_hours: [], platforms: [] });
  const aspirations = readJSON<Aspirations>(PATHS.aspirations, { aspirations: [] });

  // Build browsing insights from today's content-browse (if any)
  let browsingInsights = '';
  try {
    const inspoState = readJSON<{
      last_refreshed_at: string | null;
      feed_highlights?: Array<{ title: string; likes: number; topic: string; takeaway?: string }>;
      domain_insights?: string[];
      trending_topics?: string[];
    }>(PATHS.inspirationState, { last_refreshed_at: null });

    if (inspoState.last_refreshed_at && inspoState.last_refreshed_at.startsWith(today)) {
      const parts: string[] = [];
      if (inspoState.feed_highlights && inspoState.feed_highlights.length > 0) {
        parts.push('今天刷到的有趣内容：');
        for (const h of inspoState.feed_highlights.slice(0, 5)) {
          const takeaway = h.takeaway ? ` → ${h.takeaway}` : '';
          parts.push(`- 「${h.title}」(${h.topic}, ❤️${h.likes})${takeaway}`);
        }
      }
      if (inspoState.domain_insights && inspoState.domain_insights.length > 0) {
        parts.push('领域洞察：');
        for (const insight of inspoState.domain_insights.slice(0, 3)) {
          parts.push(`- ${insight}`);
        }
      }
      if (inspoState.trending_topics && inspoState.trending_topics.length > 0) {
        parts.push(`热点话题：${inspoState.trending_topics.slice(0, 5).join('、')}`);
      }
      if (parts.length > 0) {
        browsingInsights = parts.join('\n');
      }
    }
  } catch {
    // inspiration-state not available, skip
  }

  // Build content taste summary (accumulated aesthetic preferences from taste-engine)
  let tasteSummary = '';
  try {
    const taste = readJSON<ContentTaste>(PATHS.contentTaste, DEFAULT_CONTENT_TASTE);
    if (taste.last_updated) {
      const parts: string[] = [];
      const strongHooks = taste.hook_formulas
        .filter(h => h.affinity >= 0.3 && h.sample_count >= 2)
        .sort((a, b) => b.affinity - a.affinity)
        .slice(0, 3);
      if (strongHooks.length > 0) {
        parts.push(`效果好的标题公式：${strongHooks.map(h => `${h.label}(${(h.affinity * 100).toFixed(0)}%)`).join('、')}`);
      }
      const strongVisuals = taste.visual_styles
        .filter(v => v.affinity >= 0.3 && v.sample_count >= 2)
        .sort((a, b) => b.affinity - a.affinity)
        .slice(0, 3);
      if (strongVisuals.length > 0) {
        parts.push(`偏好的视觉风格：${strongVisuals.map(v => v.label).join('、')}`);
      }
      const strongTones = taste.tone_preferences
        .filter(t => t.affinity >= 0.3 && t.sample_count >= 2)
        .sort((a, b) => b.affinity - a.affinity)
        .slice(0, 3);
      if (strongTones.length > 0) {
        parts.push(`擅长的内容调性：${strongTones.map(t => t.label).join('、')}`);
      }
      if (taste.anti_patterns.length > 0) {
        parts.push(`要避免的风格：${taste.anti_patterns.slice(0, 3).join('、')}`);
      }
      if (parts.length > 0) {
        tasteSummary = '网感记忆（从数据中学到的审美偏好）：\n' + parts.map(p => `- ${p}`).join('\n');
      }
    }
  } catch {
    // content-taste not available, skip
  }

  // Build prompt (inject persona placeholders)
  let template = readTemplate('night-reflect-prompt.md');
  template = injectPersona(template, persona);

  const prompt = template
    .replace('{current_time}', formatLocalTime(currentTime))
    .replace('{today_diary}', todayDiary || '今天似乎没写什么日记。')
    .replace('{today_heartbeat_summary}', [logSummary, flowSummary, procrastinationSummary, browsingInsights, tasteSummary].filter(Boolean).join('\n') || '没有心跳记录。')
    .replace('{core_wisdom}', wisdom.wisdom.length > 0
      ? wisdom.wisdom.map(w => `- ${w.lesson} (重要性: ${w.importance})`).join('\n')
      : '还没有积累人生教训。')
    .replace('{preferences_summary}', JSON.stringify(preferences, null, 2))
    .replace('{aspirations_summary}', aspirations.aspirations.length > 0
      ? aspirations.aspirations.map(a => `- [${a.status}] ${a.content}: ${a.context}`).join('\n')
      : '还没有明确的梦想。')
    .replace('{skill_needs}', isFeatureEnabled(persona, 'skill_discovery') ? buildSkillNeedsForPrompt() : '');

  let decision: NightReflectDecision;
  try {
    decision = await llm.callJSON<NightReflectDecision>(prompt);
  } catch (firstErr) {
    // LLM returned malformed JSON — retry with stricter instruction
    console.warn(`[night-reflect] JSON parse failed, retrying with stricter prompt: ${(firstErr as Error).message}`);
    const retryPrompt = prompt + '\n\n⚠️ 上次输出的 JSON 格式有误。请严格输出有效 JSON：\n- 字符串值中的引号用 \\" 转义\n- 不要在最后一个元素后加逗号\n- 确保所有括号正确闭合\n- 只输出一个 JSON 对象，不要有其他文字';
    try {
      decision = await llm.callJSON<NightReflectDecision>(retryPrompt);
    } catch (retryErr) {
      // Second attempt also failed — create a minimal valid decision so the day can finish
      console.error(`[night-reflect] JSON parse failed on retry too: ${(retryErr as Error).message}`);
      decision = {
        new_wisdom: [],
        preference_updates: [],
        aspiration_updates: [],
        personality_drift: null,
        diary_entry: '今天太累了...躺下就睡着了，来不及反思了。',
      };
    }
  }

  // ── Skill Gap Analysis & Discovery (gated by features.skill_discovery) ──
  if (isFeatureEnabled(persona, 'skill_discovery')) {
    try {
      const plans = decision.skill_acquisition_plans ?? await evaluateSkillNeeds(llm);
      if (plans.length > 0) {
        console.log(`[night-reflect] Skill Gap Analysis: ${plans.length} plans to evaluate`);
        await discoverAndInstall(plans, llm);
      }
    } catch (err) {
      console.error(`[night-reflect] Skill discovery phase failed: ${(err as Error).message}`);
    }
  }

  // Apply Core Wisdom updates (immutable)
  let updatedWisdomList = [...wisdom.wisdom];
  for (const w of decision.new_wisdom) {
    const id = `w${currentTime.getTime()}_${Math.random().toString(36).slice(2, 6)}`;
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
  // Trim to max 20 (keep highest importance)
  if (updatedWisdomList.length > 20) {
    updatedWisdomList = [...updatedWisdomList].sort((a, b) => b.importance - a.importance).slice(0, 20);
  }
  const updatedWisdom: WisdomStore = {
    ...wisdom,
    wisdom: updatedWisdomList,
    total_importance_since_reflection: 0,
  };

  // Apply preference updates (generalized: interests + content_style)
  let updatedPrefs: Preferences = {
    interests: [...preferences.interests],
    content_style: [...preferences.content_style],
    active_hours: [...preferences.active_hours],
    platforms: [...preferences.platforms],
  };
  for (const pu of decision.preference_updates) {
    if (pu.type === 'interests') {
      const idx = updatedPrefs.interests.findIndex(c => c.name === pu.name);
      if (idx >= 0) {
        updatedPrefs = {
          ...updatedPrefs,
          interests: updatedPrefs.interests.map((c, i) =>
            i === idx ? { ...c, affinity: Math.min(10, Math.max(0, c.affinity + pu.affinity_delta)) } : c,
          ),
        };
      } else if (pu.affinity_delta > 0) {
        updatedPrefs = {
          ...updatedPrefs,
          interests: [...updatedPrefs.interests, { name: pu.name, affinity: pu.affinity_delta, times_engaged: 0, source: pu.reason }],
        };
      }
    } else if (pu.type === 'content_style') {
      const idx = updatedPrefs.content_style.findIndex(s => s.style === pu.name);
      if (idx >= 0) {
        updatedPrefs = {
          ...updatedPrefs,
          content_style: updatedPrefs.content_style.map((s, i) =>
            i === idx ? { ...s, affinity: Math.min(10, Math.max(0, s.affinity + pu.affinity_delta)) } : s,
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
            id: `asp_${currentTime.getTime()}`,
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

  // Apply personality drift (rare, gated by features.personality_drift)
  if (isFeatureEnabled(persona, 'personality_drift')) {
    const personalityDrift = readJSON<PersonalityDrift>(PATHS.personalityDrift, { base: persona.personality.mbti, modifiers: [] });
    // Append new modifier (if any) to the in-memory drift object
    let currentDrift = personalityDrift;
    if (decision.personality_drift) {
      currentDrift = {
        ...personalityDrift,
        modifiers: [
          ...personalityDrift.modifiers,
          decision.personality_drift as PersonalityModifier,
        ],
      };
    }

    // P4-2: Run drift analysis (decay + cap + score + warning + save)
    // runDriftAnalysis handles the single write to disk after processing
    try {
      const driftReport = runDriftAnalysis(persona, currentDrift);
      const { analysis, decayed_count, capped_count } = driftReport;
      if (decayed_count > 0 || capped_count > 0) {
        console.log(`[personality-drift] Decay: -${decayed_count}, Cap: -${capped_count}, Remaining: ${driftReport.modifiers_after.length}`);
      }
      if (analysis.warning) {
        console.log(`[personality-drift] ⚠️ Drift warning (score: ${analysis.score.toFixed(1)}): ${analysis.direction}`);
        appendText(PATHS.diary, `\n> ⚠️ 人设偏移检测: 偏离度 ${analysis.score.toFixed(1)}/10, 方向: ${analysis.direction}\n`);
      } else {
        console.log(`[personality-drift] Score: ${analysis.score.toFixed(1)}/10 — stable`);
      }
    } catch (driftErr) {
      console.warn(`[personality-drift] Analysis failed: ${(driftErr as Error).message}`);
      // Fallback: save the current drift with new modifier if analysis failed
      if (decision.personality_drift) {
        writeJSON(PATHS.personalityDrift, currentDrift);
      }
    }
  }

  // Write diary entry
  appendText(PATHS.diary, `\n## ${today} 23:00\n${decision.diary_entry}\n情绪: 睡前反思 | 重要性: 5\n标签: reflection, night\n`);

  // Write all state
  writeJSON(PATHS.coreWisdom, updatedWisdom);
  writeJSON(PATHS.preferences, updatedPrefs);
  writeJSON(PATHS.aspirations, updatedAspirations);

  // Add night heartbeat log entry
  const nightLogEntry: HeartbeatLogEntry = {
    timestamp: currentTime.toISOString(),
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

  // ─── Content performance review (ops desk) ──────────────────────────────
  if (persona.ops?.enabled) {
    try {
      const { getEntriesForPeriod, aggregateByIdentity, aggregateByTemplate } = await import('../ops/performance-tracker');

      const entries7d = getEntriesForPeriod(7);
      if (entries7d.length > 0) {
        const byIdentity = aggregateByIdentity(entries7d);
        const byTemplate = aggregateByTemplate(entries7d);

        const identitySummary = Object.entries(byIdentity)
          .map(([mode, stats]) => `${mode}: ${stats.count}条, 平均${stats.avg_likes}赞 ${stats.avg_comments}评`)
          .join('\n');

        const templateSummary = Object.entries(byTemplate)
          .map(([tmpl, stats]) => `${tmpl}: ${stats.count}条, 平均${stats.avg_likes}赞`)
          .join('\n');

        const exampleWeights = Object.fromEntries(
          Object.keys(byIdentity).map((k, i, arr) => [k, parseFloat((1 / arr.length).toFixed(2))]),
        );

        const reviewPrompt = `你是运营分析师。基于过去7天的内容数据，分析表现趋势。

【按身份模式汇总】
${identitySummary}

【按模板类型汇总】
${templateSummary}

请输出JSON:
{
  "best_performing": { "identity": "...", "template": "...", "reason": "..." },
  "worst_performing": { "identity": "...", "template": "...", "reason": "..." },
  "audience_feedback": "根据数据推测的受众反馈",
  "strategy_adjustments": ["调整建议1", "调整建议2"],
  "next_week_focus": {
    "identity_weights": ${JSON.stringify(exampleWeights)},
    "recommended_templates": ["模板1"],
    "avoid_templates": ["模板2"],
    "post_time_suggestion": "18:00-20:00"
  }
}`;

        try {
          const strategy = await llm.callJSON<ContentStrategy>(reviewPrompt, 1500);
          const contentStrategy = {
            ...strategy,
            updated_at: now().toISOString(),
            period: `${getLocalDate(new Date(now().getTime() - 7 * 24 * 3600 * 1000))} ~ ${getLocalDate(now())}`,
          };
          writeJSON(PATHS.contentStrategy, contentStrategy);
          console.log(`[night-reflect] content strategy updated`);
        } catch (err) {
          console.error(`[night-reflect] content strategy LLM call failed:`, err);
        }
      }
    } catch (err) {
      console.log(`[night-reflect] content performance review failed:`, err);
    }

    // ─── Competitor deep analysis (Phase 2 network sense) ─────────────────
    try {
      const { addPattern, buildAnalysisPrompt } = await import('../ops/content-analyzer');
      const competitorLog = readJSON<CompetitorLog>(PATHS.competitorLog, { entries: [], last_updated: '' });

      const oneDayAgo = new Date(now().getTime() - 24 * 3600 * 1000).toISOString();
      const recentEntries = competitorLog.entries
        .filter(e => e.fetched_at >= oneDayAgo && e.latest_post)
        .sort((a, b) => (b.latest_post?.engagement ?? 0) - (a.latest_post?.engagement ?? 0))
        .slice(0, 3);

      if (recentEntries.length > 0 && persona.ops?.competitors) {
        const personaSummary = `${persona.meta.name}: ${persona.personality.mbti}, ${persona.personality.core_traits.join('、')}`;

        for (const entry of recentEntries) {
          if (!entry.latest_post) continue;

          const profile = persona.ops.competitors.find(
            c => c.name === entry.account || c.url?.includes(entry.account),
          );
          if (!profile) continue;

          const prompt = buildAnalysisPrompt(
            { name: profile.name, platform: profile.platform, tag_desc: profile.tag_desc, content_mix: profile.content_mix as Record<string, number> | undefined },
            { title: entry.latest_post.topic, content: entry.latest_post.summary, likes: entry.latest_post.engagement, comments: 0 },
            personaSummary,
          );

          try {
            const analysis = await llm.callJSON<{
              title_formula: { type: string; pattern: string; example: string };
              viral_factors: string[];
            }>(prompt, 1500);

            addPattern({
              type: analysis.title_formula.type,
              source: profile.name,
              source_post: entry.latest_post.topic,
              formula: analysis.title_formula.pattern,
              examples: [analysis.title_formula.example],
            });

            console.log(`[night-reflect] analyzed competitor post: ${profile.name} - ${entry.latest_post.topic}`);
          } catch (err) {
            console.error(`[night-reflect] competitor analysis LLM failed for ${profile.name}:`, err);
          }
        }
      }
    } catch (err) {
      console.log(`[night-reflect] competitor deep analysis failed:`, err);
    }
  }

  // Rebalance social graph tiers at end of day (generic, not platform-specific)
  const socialMeta = readJSON<SocialMeta>(PATHS.socialMeta, { following: {}, stats: { core: 0, familiar: 0, cognitive: 0, dormant: 0 } });
  let socialRelations = readAllJSON<SocialRelation>(PATHS.socialDir);
  socialRelations = rebalanceTiers(socialRelations);
  for (const r of socialRelations) {
    writeSocialRelation(PATHS.socialDir, r);
  }
  writeJSON(PATHS.socialMeta, updateMetaStats(socialMeta, socialRelations));

  // Reset emotion for sleep — set tomorrow's undertone from today's experience
  const defaultSleepEmotion: EmotionState = {
    mood: { valence: 0.2, arousal: 0.1, description: '准备睡觉了' },
    energy: 0.3, stress: 0.1, creativity: 0.2, sociability: 0.1,
    last_updated: currentTime.toISOString(),
    recent_cause: '睡前反思完毕',
    momentum: { ...DEFAULT_MOMENTUM },
    undertone: defaultUndertone,
    impulse_history: [],
    consecutive_high_stress: 0,
    threshold_break_cooldown: 0,
  };
  const todayEmotionAvg = readJSON<EmotionState>(PATHS.emotionState, defaultSleepEmotion);
  const tomorrowUndertone = {
    valence: (todayEmotionAvg.mood.valence + defaultUndertone.valence) / 2,
    arousal: defaultUndertone.arousal,
    energy: defaultUndertone.energy,
    stress: Math.max(0, (todayEmotionAvg.stress + defaultUndertone.stress) / 2),
    creativity: (todayEmotionAvg.creativity + defaultUndertone.creativity) / 2,
    sociability: defaultUndertone.sociability,
  };
  const sleepEmotion: EmotionState = {
    ...defaultSleepEmotion,
    undertone: tomorrowUndertone,
  };
  writeJSON(PATHS.emotionState, sleepEmotion);

  // Reset flow state and clean up chain events for new day
  writeJSON(PATHS.flowState, { ...DEFAULT_FLOW_STATE });
  writeJSON(PATHS.pendingChains, chainState);

  console.log(`Night reflection complete. +${decision.new_wisdom.length} wisdom, ${decision.preference_updates.length} pref updates, ${decision.aspiration_updates.length} aspiration updates.`);
}
