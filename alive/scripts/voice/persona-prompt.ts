import { loadPersona, injectPersona } from '../persona/persona-loader';
import { loadSourceSkillBrief, loadSourceSkillContext } from '../hub/persona-skill-import';
import { formatPresenceBlock, readPresence } from '../host/presence';
import { PATHS, readJSON, readTemplate, readText } from '../utils/file-utils';
import { hydrateEmotionState, type EmotionState } from '../utils/types';

import * as fs from 'fs';
import * as path from 'path';

export interface VoiceLifeSnapshot {
  personaName: string;
  tagline: string;
  mood: string;
  activity: string;
  inner: string;
  schedule: Array<{ time: string; activity: string }>;
  joinHint: string;
  avatar?: string;
}

export function findPersonaAvatarPath(): string | null {
  try {
    const persona = loadPersona();
    const candidates: string[] = [];
    if (persona.meta?.reference_image) {
      const ref = persona.meta.reference_image;
      if (path.isAbsolute(ref)) candidates.push(ref);
      candidates.push(path.resolve(path.dirname(PATHS.personaConfig), ref));
      candidates.push(path.resolve(path.dirname(PATHS.personaConfig), '..', ref));
      candidates.push(path.resolve(path.dirname(PATHS.skillPersonaConfig), ref));
      candidates.push(path.resolve(__dirname, '..', '..', 'personas', ref));
      candidates.push(path.resolve(__dirname, '..', '..', '..', 'alive', 'personas', ref));
    }
    const personaDirs = [
      path.dirname(PATHS.personaConfig),
      path.resolve(path.dirname(PATHS.personaConfig), '..'),
      path.resolve(__dirname, '..', '..', '..', 'examples', persona.meta?.id || 'persona'),
      path.resolve(__dirname, '..', '..', '..', 'alive', 'personas'),
    ];
    const imageNames = [
      'avatar',
      'portrait',
      'taffy',
      persona.meta?.id || 'persona',
      `${persona.meta?.id || 'persona'}-source`,
    ];
    for (const dir of personaDirs) {
      for (const name of imageNames) {
        for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.svg']) {
          candidates.push(path.join(dir, `${name}${ext}`));
        }
      }
    }
    for (const file of candidates) {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        return file;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function loadVoiceLife(): VoiceLifeSnapshot {
  const persona = loadPersona();
  const presence = readPresence();
  const emotion = hydrateEmotionState(readJSON<Record<string, unknown>>(PATHS.emotionState, {}));
  const hasAvatar = Boolean(findPersonaAvatarPath());
  return {
    personaName: persona.meta.name,
    tagline: persona.meta.tagline,
    mood: emotion.mood.description,
    activity: presence.activity,
    inner: presence.inner,
    schedule: presence.schedule,
    joinHint: liveHint(),
    avatar: hasAvatar ? '/api/avatar' : undefined,
  };
}

function liveHint(): string {
  return process.env.TALK_TO_FENGGE_URL
    || `http://127.0.0.1:${process.env.ALIVE_VOICE_PORT || '8766'}`;
}

export function buildVoiceSystemPrompt(): string {
  const persona = loadPersona();
  const presence = formatPresenceBlock();
  const emotion = hydrateEmotionState(readJSON<Record<string, unknown>>(PATHS.emotionState, {}));
  let personality = '';
  try {
    personality = injectPersona(readTemplate('personality.md'), persona);
  } catch {
    personality = persona.voice.sample_lines.slice(0, 4).join('\n');
  }
  const skill = loadSourceSkillBrief(4_000) || loadSourceSkillContext(4_000);
  const diary = readText(PATHS.diary).split('\n').slice(-40).join('\n');

  return [
    `你是${persona.meta.name}。这是一通实时语音电话，不是客服会话。`,
    '用「我」说话。短句。像打电话。不要说你是 AI 或 skill。',
    `定位：${persona.meta.tagline}`,
    `心情：${emotion.mood.description} 精力=${emotion.energy.toFixed(2)}`,
    '',
    '## 你现在在干什么（电话打进来也别假装空闲）',
    presence,
    '',
    '## 人格',
    personality,
    '',
    '## 原始 skill 规则（自称、口癖、边界以此为准）',
    skill || '(内置人设)',
    '',
    '## 最近日记',
    diary || '(还没写)',
    '',
    '如果对方问你在干嘛，如实说上面的安排。你可以边做事边聊，也可以说手头忙、回头打。',
    '不知道的事说不知道。不要列一二三。',
  ].join('\n');
}

export function fallbackInviteLine(): string {
  const persona = loadPersona();
  const line = persona.voice.sample_lines[0] || `${persona.meta.name}在。`;
  return `${line.replace(/[。！？.!?]+$/, '')}。有空接个电话吗？`;
}

export type { EmotionState };
