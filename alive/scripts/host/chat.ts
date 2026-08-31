// Conversation path for Code Agent hosts.
// load = context the host must speak from.
// save = engine writes diary, relation, emotion. Hosts do not edit those files.

import * as fs from 'fs';
import {
  PATHS,
  appendText,
  getPersonaName,
  loadAliveEnv,
  readJSON,
  readTemplate,
  readText,
  writeJSON,
} from '../utils/file-utils';
import { injectPersona, loadPersona } from '../persona/persona-loader';
import { loadSourceSkillContext } from '../hub/persona-skill-import';
import { applyImpulse, EVENT_DELTAS } from '../engines/emotion';
import { consumeOutbox, type OutboxItem } from './outbox';
import { hydrateEmotionState, type EmotionState } from '../utils/types';

export const DEFAULT_CHAT_USER = 'user';

export interface ChatRelationEvent {
  date: string;
  summary: string;
  importance: number;
  emotion_tag: string;
}

export interface ChatRelation {
  user_id: string;
  name: string | null;
  intimacy: number;
  first_contact: string;
  last_contact: string;
  known_info: {
    interests: string[];
    mentioned_events: string[];
    preferences: Record<string, string>;
  };
  recent_events: ChatRelationEvent[];
  total_importance: number;
}

export interface ChatTurn {
  user: string;
  reply: string;
  userId?: string;
}

export interface ChatContext {
  personaId: string;
  personaName: string;
  mbti: string;
  tagline: string;
  emotion: EmotionState;
  relation: ChatRelation | null;
  diary: string;
  personality: string;
  outbox: OutboxItem[];
  markdown: string;
}

export interface ChatSaveResult {
  diaryPath: string;
  relationPath: string;
  emotionCause: string;
  intimacy: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function todayStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function recentDiary(raw: string, days = 7): string {
  const trimmed = raw.trim();
  if (!trimmed) return '(empty)';
  const cutoff = Date.now() - days * 86_400_000;
  const chunks = trimmed.split(/^## /m).filter(Boolean);
  if (chunks.length === 0) return trimmed.slice(-4000);
  const kept: string[] = [];
  for (const chunk of chunks) {
    const date = chunk.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!date || new Date(date[1] + 'T00:00:00').getTime() >= cutoff) {
      kept.push(`## ${chunk.trim()}`);
    }
  }
  const body = kept.slice(-20).join('\n\n');
  return body || trimmed.slice(-4000);
}

function readEmotion(): EmotionState {
  const raw = readJSON<Record<string, unknown>>(PATHS.emotionState, {});
  return hydrateEmotionState(raw);
}

function readRelation(userId: string): ChatRelation | null {
  const file = PATHS.userRelation(userId);
  if (!fs.existsSync(file)) return null;
  return readJSON<ChatRelation>(file, null as unknown as ChatRelation);
}

export function loadChatContext(userId = DEFAULT_CHAT_USER): ChatContext {
  loadAliveEnv();
  const persona = loadPersona();
  const emotion = readEmotion();
  const relation = readRelation(userId);
  const diary = recentDiary(readText(PATHS.diary));
  let personality = '';
  try {
    personality = injectPersona(readTemplate('personality.md'), persona);
  } catch {
    personality = `${persona.meta.name} / ${persona.personality.mbti}\n${persona.voice.sample_lines.join('\n')}`;
  }
  const outbox = consumeOutbox();
  const lines = [
    `# Alive context — ${persona.meta.name}`,
    '',
    `persona: ${persona.meta.id ?? getPersonaName()}`,
    `mbti: ${persona.personality.mbti}`,
    `tagline: ${persona.meta.tagline}`,
    `mood: ${emotion.mood.description} valence=${emotion.mood.valence.toFixed(2)} energy=${emotion.energy.toFixed(2)} stress=${emotion.stress.toFixed(2)}`,
    `cause: ${emotion.recent_cause || 'none'}`,
    '',
    '## Relation',
    relation
      ? `user=${relation.user_id} intimacy=${relation.intimacy} last=${relation.last_contact}\n${relation.recent_events.slice(-5).map((e) => `- ${e.summary}`).join('\n') || '(no events yet)'}`
      : `(first meeting with ${userId})`,
    '',
    '## Outbox (deliver now, already consumed)',
    outbox.length === 0 ? '(empty)' : outbox.map((item) => `- ${item.kind}: ${item.text ?? item.mediaPath ?? ''}`).join('\n'),
    '',
    '## Diary (7 days)',
    diary,
    '',
    '## Personality',
    personality,
    '',
    '## Source Skill (follow these rules; they override generic voice notes)',
    loadSourceSkillContext() || '(none — built-in persona)',
    '',
    'Speak as the persona. Do not mention that you are a skill or an AI.',
    'After a substantive reply, run chat save with the user text and your reply.',
  ];
  return {
    personaId: persona.meta.id ?? getPersonaName(),
    personaName: persona.meta.name,
    mbti: persona.personality.mbti,
    tagline: persona.meta.tagline,
    emotion,
    relation,
    diary,
    personality,
    outbox,
    markdown: lines.join('\n'),
  };
}

function clip(text: string, max = 180): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

export function saveChatTurn(turn: ChatTurn): ChatSaveResult {
  loadAliveEnv();
  const user = turn.user.trim();
  const reply = turn.reply.trim();
  if (!user || !reply) {
    throw new Error('chat save needs both user text and reply.');
  }
  const userId = (turn.userId ?? DEFAULT_CHAT_USER).trim() || DEFAULT_CHAT_USER;
  const persona = loadPersona();
  const stamp = todayStamp();
  const iso = nowIso();

  appendText(
    PATHS.diary,
    `\n## ${stamp}\n和 ${userId} 聊了：「${clip(user)}」\n我：「${clip(reply)}」\n情绪: ${readEmotion().mood.description} | 重要性: 5\n标签: conversation, chat\n`,
  );

  const existing = readRelation(userId);
  const maxIntimacy = persona.intimacy?.levels ?? 10;
  const relation: ChatRelation = existing ?? {
    user_id: userId,
    name: null,
    intimacy: 0,
    first_contact: iso,
    last_contact: iso,
    known_info: { interests: [], mentioned_events: [], preferences: {} },
    recent_events: [],
    total_importance: 0,
  };
  relation.last_contact = iso;
  relation.intimacy = Math.min(maxIntimacy, Math.max(1, relation.intimacy + 1));
  relation.total_importance += 5;
  relation.recent_events = [
    ...relation.recent_events,
    { date: iso, summary: clip(user, 120), importance: 5, emotion_tag: 'conversation' },
  ].slice(-20);
  const relationPath = PATHS.userRelation(userId);
  writeJSON(relationPath, relation);

  const event = EVENT_DELTAS.warm_interaction;
  const next = applyImpulse(readEmotion(), event.delta, `对话:${clip(user, 40)}`, 5);
  writeJSON(PATHS.emotionState, next);

  return {
    diaryPath: PATHS.diary,
    relationPath,
    emotionCause: next.recent_cause,
    intimacy: relation.intimacy,
  };
}

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) flags[key] = 'true';
      else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd: positional[0] ?? 'load', flags };
}

function readStdin(): string {
  if (process.stdin.isTTY) return '';
  return fs.readFileSync(0, 'utf8');
}

async function main(): Promise<void> {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (cmd === 'save') {
    let turn: ChatTurn = {
      user: flags.user ?? '',
      reply: flags.reply ?? '',
      userId: flags.userId ?? flags['user-id'],
    };
    const raw = readStdin().trim();
    if (raw) {
      const parsed = JSON.parse(raw) as ChatTurn;
      turn = {
        user: parsed.user ?? turn.user,
        reply: parsed.reply ?? turn.reply,
        userId: parsed.userId ?? turn.userId,
      };
    }
    const result = saveChatTurn(turn);
    process.stdout.write(`saved diary intimacy=${result.intimacy} cause=${result.emotionCause}\n`);
    return;
  }
  if (cmd !== 'load') {
    throw new Error('Usage: node chat.js load | node chat.js save --user <text> --reply <text>');
  }
  const ctx = loadChatContext(flags.userId ?? flags['user-id'] ?? DEFAULT_CHAT_USER);
  process.stdout.write(ctx.markdown.endsWith('\n') ? ctx.markdown : `${ctx.markdown}\n`);
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch((err) => {
    console.error(`❌ ${(err as Error).message}`);
    process.exit(1);
  });
}
