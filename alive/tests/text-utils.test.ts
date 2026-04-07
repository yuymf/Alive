// alive/tests/text-utils.test.ts
import { describe, it, expect } from 'vitest';
import { extractKeywords, keywordsOverlap } from '../scripts/utils/text-utils';

describe('extractKeywords', () => {
  it('extracts English words ≥3 chars, excludes stop words', () => {
    const result = extractKeywords('The quick brown fox jumps over the lazy dog');
    expect(result).toEqual(['quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog']);
  });

  it('extracts Chinese characters as individual tokens', () => {
    const result = extractKeywords('在社交场合保持真诚');
    expect(result.length).toBeGreaterThan(0);
    expect(result.some(w => /[\u4e00-\u9fff]/.test(w))).toBe(true);
  });

  it('returns empty array for empty string', () => {
    expect(extractKeywords('')).toEqual([]);
  });

  it('strips punctuation and special characters', () => {
    const result = extractKeywords('hello-world! foo_bar (test)');
    expect(result).toContain('hello');
    expect(result).toContain('world');
    expect(result).toContain('foo');
    expect(result).toContain('bar');
    expect(result).toContain('test');
  });

  it('lowercases all tokens', () => {
    const result = extractKeywords('Hello WORLD Test');
    expect(result).toEqual(['hello', 'world', 'test']);
  });
});

describe('keywordsOverlap', () => {
  it('returns true when overlap ≥50% of shorter set', () => {
    const a = ['quick', 'brown', 'fox', 'jumps'];
    const b = ['quick', 'brown', 'dog'];
    expect(keywordsOverlap(a, b)).toBe(true);
  });

  it('returns false when overlap <50%', () => {
    const a = ['quick', 'brown', 'fox', 'jumps'];
    const b = ['lazy', 'dog', 'cat', 'quick'];
    expect(keywordsOverlap(a, b)).toBe(false);
  });

  it('returns false when either set is empty', () => {
    expect(keywordsOverlap([], ['foo', 'bar'])).toBe(false);
    expect(keywordsOverlap(['foo'], [])).toBe(false);
  });

  it('handles identical sets', () => {
    const a = ['hello', 'world'];
    expect(keywordsOverlap(a, a)).toBe(true);
  });
});
