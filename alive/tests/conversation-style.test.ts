import { describe, it, expect, beforeAll } from 'vitest';
import type { PersonaConfig } from '../scripts/utils/types';
import {
  buildConversationStyleDescription,
  formatConversationExamples,
  injectPersona,
} from '../scripts/persona/persona-loader';

// === Task 1: Type tests ===
describe('conversation style types', () => {
  it('PersonaConfig accepts conversation_style field', () => {
    const config: PersonaConfig = {
      meta: { name: 'Test', tagline: 'test' },
      personality: { mbti: 'INFP', core_traits: ['kind'] },
      voice: { language: 'zh-CN', style: 'casual', sample_lines: ['hi'] },
      conversation_style: {
        mode: 'topic-driver',
        traits: ['顺着话题展开'],
        anti_patterns: ['不要等指令'],
      },
    };
    expect(config.conversation_style?.mode).toBe('topic-driver');
    expect(config.conversation_style?.traits).toHaveLength(1);
    expect(config.conversation_style?.anti_patterns).toHaveLength(1);
  });

  it('PersonaConfig accepts voice.banned_expressions field', () => {
    const config: PersonaConfig = {
      meta: { name: 'Test', tagline: 'test' },
      personality: { mbti: 'INFP', core_traits: ['kind'] },
      voice: {
        language: 'zh-CN', style: 'casual', sample_lines: ['hi'],
        banned_expressions: ['效劳', '吩咐'],
      },
    };
    expect(config.voice.banned_expressions).toEqual(['效劳', '吩咐']);
  });

  it('PersonaConfig accepts voice.conversation_examples field', () => {
    const config: PersonaConfig = {
      meta: { name: 'Test', tagline: 'test' },
      personality: { mbti: 'INFP', core_traits: ['kind'] },
      voice: {
        language: 'zh-CN', style: 'casual', sample_lines: ['hi'],
        conversation_examples: [
          { context: '打招呼', bad: '效劳', good: '嗨，来了' },
        ],
      },
    };
    expect(config.voice.conversation_examples).toHaveLength(1);
    expect(config.voice.conversation_examples![0].context).toBe('打招呼');
  });

  it('all new fields are optional — minimal config still works', () => {
    const config: PersonaConfig = {
      meta: { name: 'Test', tagline: 'test' },
      personality: { mbti: 'INFP', core_traits: ['kind'] },
      voice: { language: 'zh-CN', style: 'casual', sample_lines: ['hi'] },
    };
    expect(config.conversation_style).toBeUndefined();
    expect(config.voice.banned_expressions).toBeUndefined();
    expect(config.voice.conversation_examples).toBeUndefined();
  });
});

// === Task 2: Helper function tests ===
describe('buildConversationStyleDescription', () => {
  it('returns topic-driver description with traits', () => {
    const result = buildConversationStyleDescription({
      mode: 'topic-driver',
      traits: ['顺着话题展开', '拉到自己擅长的领域'],
    });
    expect(result).toContain('你主导对话');
    expect(result).toContain('对话习惯：');
    expect(result).toContain('- 顺着话题展开');
    expect(result).toContain('- 拉到自己擅长的领域');
  });

  it('returns responsive description', () => {
    const result = buildConversationStyleDescription({
      mode: 'responsive',
      traits: [],
    });
    expect(result).toContain('你认真听');
    expect(result).not.toContain('对话习惯：');
  });

  it('returns balanced description as default', () => {
    const result = buildConversationStyleDescription({
      mode: 'balanced',
      traits: [],
    });
    expect(result).toContain('自然聊天');
  });

  it('includes anti_patterns when provided', () => {
    const result = buildConversationStyleDescription({
      mode: 'topic-driver',
      traits: ['展开话题'],
      anti_patterns: ['不要等指令', '不要问对方要什么'],
    });
    expect(result).toContain('对话禁忌：');
    expect(result).toContain('- 不要等指令');
    expect(result).toContain('- 不要问对方要什么');
  });

  it('falls back to balanced for unknown mode', () => {
    const result = buildConversationStyleDescription({
      mode: 'unknown-mode' as any,
      traits: [],
    });
    expect(result).toContain('自然聊天');
  });
});

describe('formatConversationExamples', () => {
  it('formats examples with context/bad/good', () => {
    const result = formatConversationExamples([
      { context: '打招呼', bad: '效劳', good: '嗨，来了' },
      { context: '问忙什么', bad: '吩咐', good: '忙什么，就那点事' },
    ]);
    expect(result).toContain('**场景：** 打招呼');
    expect(result).toContain('✗ "效劳"');
    expect(result).toContain('✓ "嗨，来了"');
    expect(result).toContain('**场景：** 问忙什么');
  });

  it('returns empty string for empty array', () => {
    const result = formatConversationExamples([]);
    expect(result).toBe('');
  });
});

// === Task 3: injectPersona placeholder tests ===
describe('injectPersona — conversation style placeholders', () => {
  const basePersona: PersonaConfig = {
    meta: { name: 'Test', tagline: 'test' },
    personality: { mbti: 'INFP', core_traits: ['kind'] },
    voice: { language: 'zh-CN', style: 'casual', sample_lines: ['hi'] },
  };

  it('injects conversation_style.description with topic-driver mode', () => {
    const persona: PersonaConfig = {
      ...basePersona,
      conversation_style: {
        mode: 'topic-driver',
        traits: ['展开话题'],
      },
    };
    const result = injectPersona('{persona.conversation_style.description}', persona);
    expect(result).toContain('你主导对话');
    expect(result).toContain('- 展开话题');
  });

  it('injects conversation_style.mode', () => {
    const persona: PersonaConfig = {
      ...basePersona,
      conversation_style: {
        mode: 'responsive',
        traits: [],
      },
    };
    const result = injectPersona('{persona.conversation_style.mode}', persona);
    expect(result).toBe('responsive');
  });

  it('defaults to balanced when conversation_style is not configured', () => {
    const result = injectPersona('{persona.conversation_style.description}', basePersona);
    expect(result).toContain('自然聊天');
  });

  it('defaults conversation_style.mode to balanced when not configured', () => {
    const result = injectPersona('{persona.conversation_style.mode}', basePersona);
    expect(result).toBe('balanced');
  });

  it('injects banned_expressions_formatted', () => {
    const persona: PersonaConfig = {
      ...basePersona,
      voice: {
        ...basePersona.voice,
        banned_expressions: ['效劳', '吩咐'],
      },
    };
    const result = injectPersona('{persona.voice.banned_expressions_formatted}', persona);
    expect(result).toBe('- "效劳"\n- "吩咐"');
  });

  it('injects empty string for banned_expressions when not configured', () => {
    const result = injectPersona('{persona.voice.banned_expressions_formatted}', basePersona);
    expect(result).toBe('');
  });

  it('injects conversation_examples_formatted', () => {
    const persona: PersonaConfig = {
      ...basePersona,
      voice: {
        ...basePersona.voice,
        conversation_examples: [
          { context: '打招呼', bad: '效劳', good: '嗨来了' },
        ],
      },
    };
    const result = injectPersona('{persona.voice.conversation_examples_formatted}', persona);
    expect(result).toContain('**场景：** 打招呼');
    expect(result).toContain('✗ "效劳"');
    expect(result).toContain('✓ "嗨来了"');
  });

  it('injects empty string for conversation_examples when not configured', () => {
    const result = injectPersona('{persona.voice.conversation_examples_formatted}', basePersona);
    expect(result).toBe('');
  });
});
