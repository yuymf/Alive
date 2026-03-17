// tests/json-repair.test.ts
import { repairJSON } from '../skill/scripts/llm-client';

describe('repairJSON', () => {
  it('passes through valid JSON unchanged', () => {
    const valid = '{"key": "value", "num": 42}';
    expect(JSON.parse(repairJSON(valid))).toEqual({ key: 'value', num: 42 });
  });

  it('removes trailing commas before }', () => {
    const input = '{"a": 1, "b": 2,}';
    expect(JSON.parse(repairJSON(input))).toEqual({ a: 1, b: 2 });
  });

  it('removes trailing commas before ]', () => {
    const input = '{"items": [1, 2, 3,]}';
    expect(JSON.parse(repairJSON(input))).toEqual({ items: [1, 2, 3] });
  });

  it('removes nested trailing commas', () => {
    const input = '{"a": {"b": 1,}, "c": [4, 5,],}';
    expect(JSON.parse(repairJSON(input))).toEqual({ a: { b: 1 }, c: [4, 5] });
  });

  it('escapes literal newlines inside string values', () => {
    const input = '{"text": "line1\nline2"}';
    const result = repairJSON(input);
    expect(JSON.parse(result)).toEqual({ text: 'line1\nline2' });
  });

  it('escapes literal tabs inside string values', () => {
    const input = '{"text": "col1\tcol2"}';
    const result = repairJSON(input);
    expect(JSON.parse(result)).toEqual({ text: 'col1\tcol2' });
  });

  it('does not escape newlines outside of strings', () => {
    const input = '{\n  "a": 1,\n  "b": 2\n}';
    expect(JSON.parse(repairJSON(input))).toEqual({ a: 1, b: 2 });
  });

  it('adds missing commas between properties on separate lines', () => {
    const input = '{"a": "hello"\n"b": "world"}';
    const result = repairJSON(input);
    expect(JSON.parse(result)).toEqual({ a: 'hello', b: 'world' });
  });

  it('adds missing commas after numeric values', () => {
    const input = '{"a": 42\n"b": 99}';
    const result = repairJSON(input);
    expect(JSON.parse(result)).toEqual({ a: 42, b: 99 });
  });

  it('adds missing commas after boolean values', () => {
    const input = '{"a": true\n"b": false}';
    const result = repairJSON(input);
    expect(JSON.parse(result)).toEqual({ a: true, b: false });
  });

  it('handles a realistic LLM response with trailing commas and raw newlines', () => {
    const llmOutput = `{
  "wisdom": [
    {"lesson": "创作是一种自我疗愈",},
  ],
  "preferences": {"favorite_time": "morning",},
  "personality_notes": "趋向于更外向",
}`;
    const result = repairJSON(llmOutput);
    const parsed = JSON.parse(result);
    expect(parsed.wisdom[0].lesson).toBe('创作是一种自我疗愈');
    expect(parsed.preferences.favorite_time).toBe('morning');
  });

  it('handles multiple combined issues', () => {
    const ugly = '{"a": 1,\n"b": "hello"\n"c": true,}';
    const result = repairJSON(ugly);
    expect(JSON.parse(result)).toEqual({ a: 1, b: 'hello', c: true });
  });

  it('preserves already-escaped sequences', () => {
    const input = '{"text": "line1\\nline2\\ttab"}';
    const result = repairJSON(input);
    expect(JSON.parse(result)).toEqual({ text: 'line1\nline2\ttab' });
  });
});
