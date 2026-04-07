// alive/tests/ops-browse.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setBasePaths, resetBasePaths, PATHS } from '../scripts/utils/file-utils';

let sandbox: string;
let memoryDir: string;
let skillDir: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-ops-browse-'));
  memoryDir = path.join(sandbox, 'memory');
  skillDir = path.join(sandbox, 'skill');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  setBasePaths(memoryDir, skillDir);
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(sandbox, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// We test the buildBrowseSummary helper (pure function, no side effects)
import { buildBrowseSummary } from '../scripts/lifecycle/ops-browse';

describe('buildBrowseSummary', () => {
  it('formats browse results into diary entry', () => {
    const results = [
      { platform: 'xhs', items: [
        { title: '电竞女解说崛起', source: 'xhs' },
        { title: '赛车新手入门指南', source: 'xhs' },
      ]},
      { platform: 'bilibili', items: [
        { title: 'KPL春季赛回顾', source: 'bilibili' },
      ]},
    ];
    const summary = buildBrowseSummary(results);
    expect(summary).toContain('xhs');
    expect(summary).toContain('电竞女解说崛起');
    expect(summary).toContain('bilibili');
    expect(summary).toContain('KPL春季赛回顾');
  });

  it('returns empty string for empty results', () => {
    expect(buildBrowseSummary([])).toBe('');
  });

  it('skips platforms with no items', () => {
    const results = [
      { platform: 'xhs', items: [] },
      { platform: 'bilibili', items: [{ title: 'test', source: 'bilibili' }] },
    ];
    const summary = buildBrowseSummary(results);
    expect(summary).not.toContain('xhs');
    expect(summary).toContain('bilibili');
  });
});
