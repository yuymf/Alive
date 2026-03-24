// alive/sub-skills/send-message/scripts/index.ts
// Proactive messaging sub-skill — sends natural in-character messages
//
// Generalized from skill/scripts/heartbeat-outreach.ts
// Replaces hardcoded file paths and LLM imports with SubSkillContext.

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { SubSkillContext, SubSkillResult, EmotionState } from '../../../scripts/router/sub-skill-sdk';
import { createResult } from '../../../scripts/router/sub-skill-sdk';

// ── Configuration ────────────────────────────────────────────────

/** Max proactive messages per calendar day */
const MAX_DAILY_OUTREACH = 2;

/** Minimum hours between two proactive messages */
const COOLDOWN_HOURS = 4;

/** Hours where proactive messages are allowed (inclusive) */
const ACTIVE_HOURS = { start: 10, end: 21 };

/** Minimum sociability threshold to consider sending */
const MIN_SOCIABILITY = 0.35;

/** Minimum valence — don't message when very upset */
const MIN_VALENCE = -0.2;

// ── State Type ───────────────────────────────────────────────────

export interface OutreachState {
  date: string;
  count: number;
  last_sent_at: string | null;
  last_message: string | null;
}

export const DEFAULT_OUTREACH: OutreachState = {
  date: '',
  count: 0,
  last_sent_at: null,
  last_message: null,
};

// ── Gate Checks ──────────────────────────────────────────────────

export interface OutreachGateInput {
  hour: number;
  emotion: EmotionState;
  outreachState: OutreachState;
  todayStr: string;
  currentTimeISO: string;
}

export interface OutreachGateResult {
  allowed: boolean;
  reason: string;
}

/**
 * Check all gate conditions for proactive messaging.
 */
export function checkOutreachGate(input: OutreachGateInput): OutreachGateResult {
  const { hour, emotion, outreachState, todayStr, currentTimeISO } = input;

  // Time window
  if (hour < ACTIVE_HOURS.start || hour > ACTIVE_HOURS.end) {
    return { allowed: false, reason: `quiet-hours (${hour}h, active ${ACTIVE_HOURS.start}-${ACTIVE_HOURS.end})` };
  }

  // Daily limit
  const dailyCount = outreachState.date === todayStr ? outreachState.count : 0;
  if (dailyCount >= MAX_DAILY_OUTREACH) {
    return { allowed: false, reason: `daily-limit (${dailyCount}/${MAX_DAILY_OUTREACH})` };
  }

  // Cooldown
  if (outreachState.last_sent_at) {
    const elapsedMs = new Date(currentTimeISO).getTime() - new Date(outreachState.last_sent_at).getTime();
    const elapsedHours = elapsedMs / (1000 * 60 * 60);
    if (elapsedHours < COOLDOWN_HOURS) {
      return { allowed: false, reason: `cooldown (${elapsedHours.toFixed(1)}h < ${COOLDOWN_HOURS}h)` };
    }
  }

  // Emotion gates
  if (emotion.sociability < MIN_SOCIABILITY) {
    return { allowed: false, reason: `low-sociability (${emotion.sociability.toFixed(2)} < ${MIN_SOCIABILITY})` };
  }
  if (emotion.mood.valence < MIN_VALENCE) {
    return { allowed: false, reason: `low-valence (${emotion.mood.valence.toFixed(2)} < ${MIN_VALENCE})` };
  }

  return { allowed: true, reason: 'ok' };
}

// ── Template Loader ──────────────────────────────────────────────

function loadTemplate(templateName: string): string {
  const templateDir = path.join(__dirname, '..', 'templates');
  const templatePath = path.join(templateDir, templateName);
  if (fs.existsSync(templatePath)) return fs.readFileSync(templatePath, 'utf8');
  throw new Error(`Template not found: ${templateName}`);
}

// ── Send via OpenClaw CLI ────────────────────────────────────────

/**
 * Send a text message via OpenClaw CLI.
 * Returns true on success, false on failure (never throws).
 */
export function sendMessageViaOpenClaw(message: string): boolean {
  try {
    execFileSync('openclaw', ['message', 'send', '--message', message], {
      timeout: 15_000,
      encoding: 'utf8',
    });
    return true;
  } catch (err) {
    console.error(`[send-message] openclaw message send failed: ${(err as Error).message}`);
    return false;
  }
}

// ── LLM Message Generation ──────────────────────────────────────

interface ProactiveMessageOutput {
  should_send: boolean;
  message: string;
  reason: string;
}

// ── Actions ──────────────────────────────────────────────────────

export const actions = {
  /**
   * Attempt proactive outreach: gate check → LLM generation → send → state update.
   * Safe to call on every heartbeat tick — gate logic ensures proper throttling.
   */
  async 'send-message'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const { persona, emotion, intent, memory, llm } = ctx;
    const now = new Date();
    const hour = now.getHours();
    const todayStr = now.toISOString().slice(0, 10);
    const currentTimeISO = now.toISOString();
    const timeStr = now.toTimeString().slice(0, 5);

    // 1. Read state
    const outreachState = memory.readJSON<OutreachState>('outreach-state', DEFAULT_OUTREACH);

    // 2. Gate check
    const gate = checkOutreachGate({
      hour,
      emotion,
      outreachState,
      todayStr,
      currentTimeISO,
    });

    if (!gate.allowed) {
      console.log(`[send-message] Gate blocked: ${gate.reason}`);
      return createResult(
        `想发消息但${gate.reason}`,
        { vitality_cost: 0 },
      );
    }

    // 3. LLM: should we send? what to say?
    let llmResult: ProactiveMessageOutput;
    try {
      const template = loadTemplate('outreach-message-prompt.md');
      const emotionSummary = `${emotion.mood.description} (v:${emotion.mood.valence.toFixed(1)} a:${emotion.mood.arousal.toFixed(1)} e:${emotion.energy.toFixed(1)} soc:${emotion.sociability.toFixed(1)})`;
      const recentDiary = memory.readDiary(3);
      const voiceStyle = persona.voice?.style ?? '';

      const prompt = template
        .replace('{action_description}', intent.description)
        .replace('{inner_monologue}', intent.description)
        .replace('{emotion_summary}', emotionSummary)
        .replace('{voice_directive}', voiceStyle)
        .replace('{recent_diary}', recentDiary.slice(-1000))
        .replace('{hour}', String(hour))
        .replace(/\{persona\.meta\.name\}/g, persona.meta.name);

      llmResult = await llm.callJSON<ProactiveMessageOutput>(prompt, 300);
    } catch (err) {
      console.error(`[send-message] LLM generation failed: ${(err as Error).message}`);
      return createResult(
        `想发消息但不知道说什么`,
        { vitality_cost: 5, emotion_deltas: [{ stress: 0.02 }] },
      );
    }

    if (!llmResult.should_send) {
      console.log(`[send-message] LLM decided not to send: ${llmResult.reason}`);
      return createResult(
        `想了想还是算了——${llmResult.reason}`,
        { vitality_cost: 2 },
      );
    }

    // 4. Send
    const sent = sendMessageViaOpenClaw(llmResult.message);

    // 5. Update state
    const updatedState: OutreachState = {
      date: todayStr,
      count: (outreachState.date === todayStr ? outreachState.count : 0) + 1,
      last_sent_at: currentTimeISO,
      last_message: llmResult.message,
    };
    memory.writeJSON('outreach-state', updatedState);

    // 6. Diary entry
    if (sent) {
      memory.appendDiary(
        `\n## ${todayStr} ${timeStr}\n主动给朋友发了消息：「${llmResult.message.slice(0, 60)}」\n情绪: ${emotion.mood.description} | 重要性: 3\n标签: outreach, 社交\n`,
      );
      console.log(`[send-message] Sent: ${llmResult.message.slice(0, 80)}`);
    } else {
      memory.appendDiary(
        `\n## ${todayStr} ${timeStr}\n想发消息但是没发出去...\n情绪: ${emotion.mood.description} | 重要性: 2\n标签: outreach-fail\n`,
      );
    }

    return createResult(
      sent
        ? `给朋友发了消息：「${llmResult.message.slice(0, 60)}」`
        : `想发消息但是发送失败了`,
      {
        vitality_cost: 5,
        emotion_deltas: sent
          ? [{ sociability: 0.08, valence: 0.05 }]
          : [{ stress: 0.03, valence: -0.03 }],
      },
    );
  },
};
