import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setBasePaths, resetBasePaths } from '../../scripts/utils/file-utils';
import { setTimeOverride } from '../../scripts/utils/time-utils';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  loadContentPatterns,
  saveContentPatterns,
  addPattern,
  incrementPatternUsage,
  getRelevantPatterns,
  buildAnalysisPrompt,
  DEFAULT_CONTENT_PATTERNS,
} from '../../scripts/ops/content-analyzer';

const tmpDir = path.join(os.tmpdir(), 'alive-analyzer-test-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
  setTimeOverride(new Date('2026-04-01T02:00:00Z'));
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadContentPatterns', () => {
  it('returns default when file missing', () => {
    const p = loadContentPatterns();
    expect(p.patterns).toEqual([]);
    expect(p.competitor_insights).toEqual([]);
    expect(p.cover_trends).toEqual([]);
  });
});

describe('addPattern', () => {
  it('adds a new pattern', () => {
    addPattern({
      type: '反问句标题', source: '天云', source_post: 'KPL复盘',
      formula: '以"有人说"开头', examples: ['有人说女生不懂电竞？'],
    });
    const p = loadContentPatterns();
    expect(p.patterns).toHaveLength(1);
    expect(p.patterns[0].type).toBe('反问句标题');
    expect(p.patterns[0].times_used).toBe(0);
    expect(p.patterns[0].success_rate).toBeNull();
  });

  it('keeps max 30 patterns, removes oldest unused first', () => {
    for (let i = 0; i < 32; i++) {
      addPattern({
        type: `pattern-${i}`, source: 'test', source_post: 'post',
        formula: 'formula', examples: [],
      });
    }
    const p = loadContentPatterns();
    expect(p.patterns.length).toBeLessThanOrEqual(30);
  });
});

describe('incrementPatternUsage', () => {
  it('increments times_used for matching pattern', () => {
    addPattern({
      type: '数据降维', source: '希然', source_post: '版本解读',
      formula: '用数字总结', examples: [],
    });
    incrementPatternUsage('数据降维');
    const p = loadContentPatterns();
    expect(p.patterns[0].times_used).toBe(1);
  });
});

describe('getRelevantPatterns', () => {
  it('returns patterns as formatted string', () => {
    addPattern({
      type: '反问句标题', source: '天云', source_post: 'KPL复盘',
      formula: '以"有人说"开头', examples: ['example'],
    });
    const result = getRelevantPatterns();
    expect(result).toContain('反问句标题');
    expect(result).toContain('天云');
  });

  it('returns empty string when no patterns', () => {
    expect(getRelevantPatterns()).toBe('');
  });
});

describe('buildAnalysisPrompt', () => {
  it('includes post content and competitor info', () => {
    const prompt = buildAnalysisPrompt(
      { name: '天云', platform: 'douyin', tag_desc: '电竞解说' },
      { title: 'KPL复盘', content: '正文内容', likes: 120000, comments: 5000 },
      'V姐：ENTJ，三栖身份',
    );
    expect(prompt).toContain('天云');
    expect(prompt).toContain('KPL复盘');
    expect(prompt).toContain('V姐');
    expect(prompt).toContain('title_formula');
  });
});
