// Proactive voice call — invite the owner into Alive's own call page.

import * as fs from 'fs';
import * as path from 'path';
import type { SubSkillContext, SubSkillResult, EmotionState } from '../../../scripts/router/sub-skill-sdk';
import { createResult } from '../../../scripts/router/sub-skill-sdk';
import { defaultTalkToFenggeUrl, deliverCall } from '../../../scripts/host/outbox';
import { now, getLocalHour, getLocalDate, getLocalTimeHHMM } from '../../../scripts/utils/time-utils';

const MAX_DAILY_CALLS = 1;
const COOLDOWN_HOURS = 8;
const ACTIVE_HOURS = { start: 11, end: 21 };
const MIN_SOCIABILITY = 0.45;
const MIN_ENERGY = 0.35;

export interface CallState {
  date: string;
  count: number;
  last_sent_at: string | null;
}

export const DEFAULT_CALL_STATE: CallState = {
  date: '',
  count: 0,
  last_sent_at: null,
};

export interface CallGateInput {
  hour: number;
  emotion: EmotionState;
  callState: CallState;
  todayStr: string;
  currentTimeISO: string;
}

export interface CallGateResult {
  allowed: boolean;
  reason: string;
}

export { defaultTalkToFenggeUrl };

export function checkCallGate(input: CallGateInput): CallGateResult {
  const { hour, emotion, callState, todayStr, currentTimeISO } = input;

  if (hour < ACTIVE_HOURS.start || hour > ACTIVE_HOURS.end) {
    return { allowed: false, reason: `quiet-hours (${hour}h, active ${ACTIVE_HOURS.start}-${ACTIVE_HOURS.end})` };
  }

  const dailyCount = callState.date === todayStr ? callState.count : 0;
  if (dailyCount >= MAX_DAILY_CALLS) {
    return { allowed: false, reason: `daily-limit (${dailyCount}/${MAX_DAILY_CALLS})` };
  }

  if (callState.last_sent_at) {
    const elapsedHours = (new Date(currentTimeISO).getTime() - new Date(callState.last_sent_at).getTime()) / 3_600_000;
    if (elapsedHours < COOLDOWN_HOURS) {
      return { allowed: false, reason: `cooldown (${elapsedHours.toFixed(1)}h < ${COOLDOWN_HOURS}h)` };
    }
  }

  if (emotion.sociability < MIN_SOCIABILITY) {
    return { allowed: false, reason: `low-sociability (${emotion.sociability.toFixed(2)} < ${MIN_SOCIABILITY})` };
  }
  if (emotion.energy < MIN_ENERGY) {
    return { allowed: false, reason: `low-energy (${emotion.energy.toFixed(2)} < ${MIN_ENERGY})` };
  }

  return { allowed: true, reason: 'ok' };
}

function loadTemplate(name: string): string {
  const file = path.join(__dirname, '..', 'templates', name);
  return fs.readFileSync(file, 'utf8');
}

interface CallInviteOutput {
  should_call: boolean;
  invitation: string;
  reason: string;
}

export function inviteOwnerCall(text: string, joinUrl = defaultTalkToFenggeUrl()): boolean {
  return deliverCall(text, joinUrl);
}

export const actions = {
  async 'call-owner'(ctx: SubSkillContext): Promise<SubSkillResult> {
    const { persona, emotion, intent, memory, llm } = ctx;
    const current = now();
    const hour = getLocalHour(current);
    const todayStr = getLocalDate(current);
    const currentTimeISO = current.toISOString();
    const timeStr = getLocalTimeHHMM(current);
    const joinUrl = defaultTalkToFenggeUrl();

    const callState = memory.readJSON<CallState>('voice-call-state', DEFAULT_CALL_STATE);
    const gate = checkCallGate({ hour, emotion, callState, todayStr, currentTimeISO });
    if (!gate.allowed) {
      return createResult(`想打电话但${gate.reason}`, { vitality_cost: 0 });
    }

    let llmResult: CallInviteOutput;
    try {
      const template = loadTemplate('call-invite-prompt.md');
      const emotionSummary = `${emotion.mood.description} (v:${emotion.mood.valence.toFixed(1)} e:${emotion.energy.toFixed(1)} soc:${emotion.sociability.toFixed(1)})`;
      const prompt = template
        .replace('{action_description}', intent.description)
        .replace('{inner_monologue}', intent.description)
        .replace('{emotion_summary}', emotionSummary)
        .replace('{voice_directive}', persona.voice?.style ?? '')
        .replace('{recent_diary}', memory.readDiary(3).slice(-800))
        .replace('{hour}', String(hour))
        .replace(/\{persona\.meta\.name\}/g, persona.meta.name);
      llmResult = await llm.callJSON<CallInviteOutput>(prompt, 250);
    } catch (err) {
      return createResult(`想打电话但组织不好开场：${(err as Error).message}`, { vitality_cost: 4 });
    }

    if (!llmResult.should_call || !llmResult.invitation?.trim()) {
      return createResult(`想了想还是不打了——${llmResult.reason || '没必要'}`, { vitality_cost: 2 });
    }

    const invitation = llmResult.invitation.trim();
    const sent = inviteOwnerCall(invitation, joinUrl);
    memory.writeJSON('voice-call-state', {
      date: todayStr,
      count: (callState.date === todayStr ? callState.count : 0) + 1,
      last_sent_at: currentTimeISO,
    } satisfies CallState);

    if (sent) {
      memory.appendDiary(
        `\n## ${todayStr} ${timeStr}\n想给主人打电话：「${invitation.slice(0, 60)}」\n接通去：${joinUrl}\n情绪: ${emotion.mood.description} | 重要性: 4\n标签: voice-call, 社交\n`,
      );
    }

    return createResult(
      sent ? `给主人发起通话：「${invitation.slice(0, 60)}」→ ${joinUrl}` : '想打电话但邀请没写出去',
      {
        vitality_cost: 10,
        emotion_deltas: sent
          ? [{ sociability: 0.1, valence: 0.06 }]
          : [{ stress: 0.03, valence: -0.03 }],
      },
    );
  },
};
