// alive/sub-skills/voice-tts/scripts/index.ts
// Voice TTS sub-skill — synthesize and send voice messages.
//
// Routed by intent: 社交 (priority 5), 表达 (priority 5).
// Competes with send-message (社交: 6, 表达: 4):
//   - 社交 → send-message wins (文字优先)
//   - 表达 → voice-tts wins (语音更有感染力)
//
// Flow: gate check → LLM generate → voice enrichment → TTS → send via openclaw → diary

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { SubSkillContext, SubSkillResult, EmotionState } from '../../../scripts/utils/types';
import { createResult } from '../../../scripts/router/sub-skill-sdk';
import { now, getLocalHour, getLocalDate, getLocalTimeHHMM } from '../../../scripts/utils/time-utils';
import { synthesize } from './tts-provider';
import { enrichForVoice } from './voice-enricher';
import { saveAudio, pruneOldAudio } from './audio-store';

// ── Configuration ────────────────────────────────────────────────

/** Max voice messages per calendar day */
const MAX_DAILY_VOICE = 3;

/** Minimum hours between two voice messages */
const COOLDOWN_HOURS = 3;

/** Hours where voice messages are allowed (inclusive) */
const ACTIVE_HOURS = { start: 9, end: 22 };

/** Minimum sociability threshold to consider sending voice */
const MIN_SOCIABILITY = 0.30;

/** Minimum energy — don't record when exhausted */
const MIN_ENERGY = 0.25;

// ── State Type ───────────────────────────────────────────────────

export interface VoiceState {
  date: string;
  count: number;
  last_sent_at: string | null;
}

export const DEFAULT_VOICE_STATE: VoiceState = {
  date: '',
  count: 0,
  last_sent_at: null,
};

// ── Gate Checks ──────────────────────────────────────────────────

export interface VoiceGateInput {
  hour: number;
  emotion: EmotionState;
  voiceState: VoiceState;
  todayStr: string;
  currentTimeISO: string;
}

export interface VoiceGateResult {
  allowed: boolean;
  reason: string;
}

/**
 * Check all gate conditions for sending a voice message.
 */
export function checkVoiceGate(input: VoiceGateInput): VoiceGateResult {
  const { hour, emotion, voiceState, todayStr, currentTimeISO } = input;

  // Time window
  if (hour < ACTIVE_HOURS.start || hour > ACTIVE_HOURS.end) {
    return { allowed: false, reason: `quiet-hours (${hour}h, active ${ACTIVE_HOURS.start}-${ACTIVE_HOURS.end})` };
  }

  // Daily limit
  const dailyCount = voiceState.date === todayStr ? voiceState.count : 0;
  if (dailyCount >= MAX_DAILY_VOICE) {
    return { allowed: false, reason: `daily-limit (${dailyCount}/${MAX_DAILY_VOICE})` };
  }

  // Cooldown
  if (voiceState.last_sent_at) {
    const elapsedMs = new Date(currentTimeISO).getTime() - new Date(voiceState.last_sent_at).getTime();
    const elapsedHours = elapsedMs / (1000 * 60 * 60);
    if (elapsedHours < COOLDOWN_HOURS) {
      return { allowed: false, reason: `cooldown (${elapsedHours.toFixed(1)}h < ${COOLDOWN_HOURS}h)` };
    }
  }

  // Emotion gates
  if (emotion.sociability < MIN_SOCIABILITY) {
    return { allowed: false, reason: `low-sociability (${emotion.sociability.toFixed(2)} < ${MIN_SOCIABILITY})` };
  }
  if (emotion.energy < MIN_ENERGY) {
    return { allowed: false, reason: `low-energy (${emotion.energy.toFixed(2)} < ${MIN_ENERGY})` };
  }

  return { allowed: true, reason: 'ok' };
}

// ── Template Loader ──────────────────────────────────────────────

function loadTemplate(templateName: string): string {
  const templateDir = path.join(__dirname, '..', 'templates');
  const templatePath = path.join(templateDir, templateName);
  if (fs.existsSync(templatePath)) return fs.readFileSync(templatePath, 'utf8');
  throw new Error(`[voice-tts] Template not found: ${templateName}`);
}

// ── Send via OpenClaw CLI ────────────────────────────────────────

/**
 * Send a voice file via OpenClaw CLI using --media.
 * Returns true on success, false on failure (never throws).
 */
export function sendVoiceViaOpenClaw(
  audioPath: string,
  channel?: string,
  target?: string,
  caption?: string,
): boolean {
  try {
    const args = ['message', 'send', '--media', audioPath];
    if (channel) args.push('--channel', channel);
    if (target) args.push('--target', target);
    if (caption) args.push('--message', caption);
    execFileSync('openclaw', args, { timeout: 30_000, encoding: 'utf8' });
    return true;
  } catch (err) {
    console.error(`[voice-tts] openclaw voice send failed: ${(err as Error).message}`);
    return false;
  }
}

// ── LLM Message Generation ──────────────────────────────────────

interface VoiceMessageOutput {
  should_speak: boolean;
  text: string;
  emotion_tone: string;
  reason: string;
}

// ── Actions ──────────────────────────────────────────────────────

export const actions = {
  /**
   * Attempt to generate and send a voice message.
   * Safe to call on every heartbeat tick — gate logic ensures proper throttling.
   */
  async 'send-voice'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const { persona, emotion, intent, memory, llm, config } = ctx;
    const currentTime = now();
    const hour = getLocalHour(currentTime);
    const todayStr = getLocalDate(currentTime);
    const currentTimeISO = currentTime.toISOString();
    const timeStr = getLocalTimeHHMM(currentTime);

    // 0. Prune old audio files (opportunistic cleanup)
    try { pruneOldAudio(); } catch { /* non-critical */ }

    // 1. Read state
    const voiceState = memory.readJSON<VoiceState>('voice-state', DEFAULT_VOICE_STATE);

    // 2. Gate check
    const gate = checkVoiceGate({
      hour,
      emotion,
      voiceState,
      todayStr,
      currentTimeISO,
    });

    if (!gate.allowed) {
      console.log(`[voice-tts] Gate blocked: ${gate.reason}`);
      return createResult(
        `想发语音但${gate.reason}`,
        { vitality_cost: 0 },
      );
    }

    // 3. LLM: what to say?
    let llmResult: VoiceMessageOutput;
    try {
      const template = loadTemplate('voice-message-prompt.md');
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

      llmResult = await llm.callJSON<VoiceMessageOutput>(prompt, 400);
    } catch (err) {
      console.error(`[voice-tts] LLM generation failed: ${(err as Error).message}`);
      return createResult(
        '想发语音但不知道说什么',
        { vitality_cost: 3, emotion_deltas: [{ stress: 0.02 }] },
      );
    }

    if (!llmResult.should_speak) {
      console.log(`[voice-tts] LLM decided not to speak: ${llmResult.reason}`);
      return createResult(
        `想说话但${llmResult.reason}`,
        { vitality_cost: 2 },
      );
    }

    // 4. Characteristic Voice enrichment
    const enriched = enrichForVoice(llmResult.text, {
      emotion,
      persona,
      tone: llmResult.emotion_tone,
    });

    // 5. TTS synthesis
    const provider = (config.tts_provider as string) ?? 'noiz';
    const voiceId = (config.voice_id as string) ?? undefined;
    let audioPath: string;

    try {
      const ttsResult = await synthesize(enriched.text, {
        provider: provider as 'noiz' | 'kokoro',
        voiceId,
        lang: (config.voice_lang as string) ?? persona.voice?.language ?? 'zh',
        speed: (config.voice_speed as number) ?? 1.0,
        emotion: enriched.emotionParams,
      });

      // 6. Save audio
      const saved = saveAudio(ttsResult.audioBuffer, ttsResult.format);
      audioPath = saved.filePath;
      console.log(`[voice-tts] Audio saved: ${saved.fileName} (${saved.sizeBytes} bytes)`);
    } catch (err) {
      console.error(`[voice-tts] TTS synthesis failed: ${(err as Error).message}`);
      return createResult(
        `想发语音但合成失败：${(err as Error).message.slice(0, 50)}`,
        { vitality_cost: 5, emotion_deltas: [{ stress: 0.03 }] },
      );
    }

    // 7. Send via OpenClaw
    const sent = sendVoiceViaOpenClaw(audioPath);

    // 8. Update state
    const updatedState: VoiceState = {
      date: todayStr,
      count: (voiceState.date === todayStr ? voiceState.count : 0) + 1,
      last_sent_at: currentTimeISO,
    };
    memory.writeJSON('voice-state', updatedState);

    // 9. Diary entry
    const textPreview = llmResult.text.slice(0, 60);
    if (sent) {
      memory.appendDiary(
        `\n## ${todayStr} ${timeStr}\n发了条语音消息：「${textPreview}」\n情绪: ${emotion.mood.description} | 重要性: 4\n标签: voice, ${llmResult.emotion_tone}\n`,
      );
      console.log(`[voice-tts] Sent: ${textPreview}`);
    } else {
      memory.appendDiary(
        `\n## ${todayStr} ${timeStr}\n录了语音但没发出去...\n情绪: ${emotion.mood.description} | 重要性: 2\n标签: voice-fail\n`,
      );
    }

    return createResult(
      sent
        ? `发了语音：「${textPreview}」`
        : '语音发送失败',
      {
        vitality_cost: 8,
        emotion_deltas: sent
          ? [{ sociability: 0.1, valence: 0.05, energy: -0.03 }]
          : [{ stress: 0.03 }],
      },
    );
  },
};

export const manifest = {
  name: 'voice-tts',
  display_name: '语音消息',
  version: '0.1.0',
  description: '将角色的话变成语音消息发送——让聊天更像真人朋友',
  intent_bindings: [
    { intent: '社交', action: 'send-voice', priority: 5 },
    { intent: '表达', action: 'send-voice', priority: 5 },
  ],
};
