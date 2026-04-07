// alive/tests/wisdom-dedup.test.ts
// Tests for core-wisdom keyword dedup in night-reflect
import { describe, it, expect } from 'vitest';
import { deduplicateWisdom } from '../scripts/lifecycle/night-reflect';
import type { WisdomEntry } from '../scripts/utils/types';

function makeWisdom(overrides: Partial<WisdomEntry> & { lesson: string }): WisdomEntry {
  return {
    id: `w${Date.now()}_test`,
    lesson: overrides.lesson,
    source: 'night-reflect',
    date: '2026-04-07',
    importance: 5,
    tags: [],
    ...overrides,
  };
}

describe('deduplicateWisdom', () => {
  it('adds new wisdom when no overlap with existing', () => {
    const existing = [makeWisdom({ id: 'w1', lesson: '创作需要灵感和耐心' })];
    const incoming = [{ lesson: '社交场合保持真诚最重要', importance: 7, tags: ['social'] }];
    const result = deduplicateWisdom(existing, incoming, '2026-04-07');
    expect(result).toHaveLength(2);
    expect(result[1].lesson).toBe('社交场合保持真诚最重要');
  });

  it('merges when keywords overlap ≥50%, keeps higher importance lesson', () => {
    const existing = [makeWisdom({
      id: 'w1',
      lesson: 'creative work needs patience and inspiration always',
      importance: 6,
      tags: ['creativity'],
      date: '2026-04-01',
    })];
    const incoming = [{
      lesson: 'creative inspiration requires patience and persistence',
      importance: 8,
      tags: ['growth'],
    }];
    const result = deduplicateWisdom(existing, incoming, '2026-04-07');
    expect(result).toHaveLength(1);
    expect(result[0].lesson).toBe('creative inspiration requires patience and persistence');
    expect(result[0].id).toBe('w1');
    expect(result[0].date).toBe('2026-04-07');
    expect(result[0].tags).toEqual(expect.arrayContaining(['creativity', 'growth']));
    expect(result[0].importance).toBe(8);
  });

  it('merges but keeps existing lesson when existing importance is higher', () => {
    const existing = [makeWisdom({
      id: 'w1',
      lesson: 'creative work needs patience and inspiration always',
      importance: 9,
      tags: ['creativity'],
      date: '2026-04-01',
    })];
    const incoming = [{
      lesson: 'creative inspiration requires patience and persistence',
      importance: 5,
      tags: ['growth'],
    }];
    const result = deduplicateWisdom(existing, incoming, '2026-04-07');
    expect(result).toHaveLength(1);
    expect(result[0].lesson).toBe('creative work needs patience and inspiration always');
    expect(result[0].importance).toBe(9);
    expect(result[0].date).toBe('2026-04-07');
  });

  it('handles multiple incoming where one matches and one does not', () => {
    const existing = [makeWisdom({
      id: 'w1',
      lesson: 'creative work needs patience and inspiration always',
      importance: 6,
      tags: ['creativity'],
    })];
    const incoming = [
      { lesson: 'creative inspiration requires patience and persistence', importance: 8, tags: ['growth'] },
      { lesson: '人际关系需要信任和时间', importance: 7, tags: ['social'] },
    ];
    const result = deduplicateWisdom(existing, incoming, '2026-04-07');
    expect(result).toHaveLength(2);
  });

  it('greedy: matches first hit only when multiple could match', () => {
    const existing = [
      makeWisdom({ id: 'w1', lesson: 'patience creativity inspiration art', importance: 5 }),
      makeWisdom({ id: 'w2', lesson: 'patience creativity discipline focus', importance: 5 }),
    ];
    const incoming = [{ lesson: 'patience creativity growth mindset', importance: 7, tags: [] }];
    const result = deduplicateWisdom(existing, incoming, '2026-04-07');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('w1');
    expect(result[0].importance).toBe(7);
  });

  it('handles empty existing list', () => {
    const incoming = [{ lesson: 'new wisdom entry', importance: 5, tags: ['test'] }];
    const result = deduplicateWisdom([], incoming, '2026-04-07');
    expect(result).toHaveLength(1);
  });

  it('handles empty incoming list', () => {
    const existing = [makeWisdom({ lesson: 'existing wisdom' })];
    const result = deduplicateWisdom(existing, [], '2026-04-07');
    expect(result).toHaveLength(1);
  });

  it('handles undefined tags gracefully', () => {
    const existing = [makeWisdom({ id: 'w1', lesson: 'patience creativity work art', importance: 5 })];
    const incoming = [{ lesson: 'patience creativity growth', importance: 7, tags: undefined as unknown as string[] }];
    const result = deduplicateWisdom(existing, incoming, '2026-04-07');
    expect(result).toHaveLength(1);
    expect(Array.isArray(result[0].tags)).toBe(true);
  });
});
