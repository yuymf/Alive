import { describe, it, expect, vi } from 'vitest';
import { parseSlashCommand, buildNluPrompt, extractIntentFromNluResponse } from '../../sub-skills/ops-desk/scripts/message-parser';

describe('parseSlashCommand', () => {
  it('parses /post with no args', () => {
    const result = parseSlashCommand('/post');
    expect(result).toEqual({ command: 'post', args: [] });
  });

  it('parses /post 1', () => {
    const result = parseSlashCommand('/post 1');
    expect(result).toEqual({ command: 'post', args: ['1'] });
  });

  it('parses /trends', () => {
    const result = parseSlashCommand('/trends');
    expect(result).toEqual({ command: 'trends', args: [] });
  });

  it('parses /idea with direction', () => {
    const result = parseSlashCommand('/idea 赛车训练');
    expect(result).toEqual({ command: 'idea', args: ['赛车训练'] });
  });

  it('returns null for non-slash input', () => {
    expect(parseSlashCommand('发出去')).toBeNull();
    expect(parseSlashCommand('你好')).toBeNull();
  });
});

describe('buildNluPrompt', () => {
  it('includes user message and active item id', () => {
    const prompt = buildNluPrompt('标题改得更有攻击性', 'q_123');
    expect(prompt).toContain('标题改得更有攻击性');
    expect(prompt).toContain('q_123');
  });
});

describe('extractIntentFromNluResponse', () => {
  it('parses approve intent', () => {
    const raw = '{"action":"approve","item_id":"q_1"}';
    const result = extractIntentFromNluResponse(raw, 'q_1');
    expect(result.action).toBe('approve');
  });

  it('parses edit intent with instruction', () => {
    const raw = '{"action":"edit","field":"title","instruction":"更有攻击性"}';
    const result = extractIntentFromNluResponse(raw, 'q_1');
    expect(result.action).toBe('edit');
    expect(result.instruction).toBe('更有攻击性');
  });

  it('returns unknown on invalid JSON', () => {
    const result = extractIntentFromNluResponse('not json', 'q_1');
    expect(result.action).toBe('unknown');
    expect(result.raw).toBe('not json');
  });
});
