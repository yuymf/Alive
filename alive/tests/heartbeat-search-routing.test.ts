import { describe, it, expect } from 'vitest';

/**
 * Lightweight test verifying the regex routing logic used in heartbeat-tick.ts.
 * We test the pattern match in isolation — the full heartbeat is too heavyweight to unit test.
 */
describe('heartbeat search routing regex', () => {
  const isSearchIntent = (skill: string) =>
    /search|搜|查|学习|研究|了解/.test(skill.toLowerCase());

  it('should match "search-pipeline"', () => {
    expect(isSearchIntent('search-pipeline')).toBe(true);
  });

  it('should match Chinese search keywords', () => {
    expect(isSearchIntent('搜索技巧')).toBe(true);
    expect(isSearchIntent('查资料')).toBe(true);
    expect(isSearchIntent('学习化妆')).toBe(true);
    expect(isSearchIntent('研究构图')).toBe(true);
    expect(isSearchIntent('了解趋势')).toBe(true);
  });

  it('should NOT match post-related skills', () => {
    expect(isSearchIntent('post-pipeline')).toBe(false);
    expect(isSearchIntent('auto-photo')).toBe(false);
    expect(isSearchIntent('发帖')).toBe(false);
    expect(isSearchIntent('拍照')).toBe(false);
  });
});
