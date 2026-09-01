import { callLLM } from '../utils/llm-client';
import { buildVoiceSystemPrompt } from './persona-prompt';
import { saveChatTurn } from '../host/chat';

export async function runVoiceTurn(userText: string): Promise<{ reply: string }> {
  const user = userText.trim();
  if (!user) return { reply: '嗯？' };
  const system = buildVoiceSystemPrompt();
  const result = await callLLM(`${system}\n\n对方刚说：${user}\n\n用电话口气回一句到三句。`, 'voice-turn', {
    system,
    temperature: 0.8,
  });
  const reply = (result.content || '在呢。').trim();
  try {
    saveChatTurn({ user, reply });
  } catch {
    // chat save needs memory; voice still answers
  }
  return { reply };
}
