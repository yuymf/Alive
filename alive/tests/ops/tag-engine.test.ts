// alive/tests/ops/tag-engine.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setBasePaths, resetBasePaths, PATHS, writeJSON } from '../../scripts/utils/file-utils';
import type { TagVocabulary, TagEntry } from '../../scripts/utils/types';

// ─── Sandbox paths ────────────────────────────────────────────────────────────
const TEST_DIR = path.join(__dirname, '__tag_engine_sandbox__');
const MEMORY_DIR = path.join(TEST_DIR, 'memory');
const SKILL_DIR = path.join(TEST_DIR, 'skill');

// ─── Platform client mocks ────────────────────────────────────────────────────
const mockSearchXhsNotes = vi.fn();
const mockSearchDouyinVideos = vi.fn();

vi.mock('../../sub-skills/platform/xhs-bridge/scripts/xhs-client', () => ({
  searchXhsNotes: mockSearchXhsNotes,
}));

vi.mock('../../sub-skills/platform/douyin-bridge/scripts/douyin-client', () => ({
  searchDouyinVideos: mockSearchDouyinVideos,
}));

// ─── Sandbox lifecycle ────────────────────────────────────────────────────────
beforeEach(() => {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.mkdirSync(SKILL_DIR, { recursive: true });
  setBasePaths(MEMORY_DIR, SKILL_DIR);
  vi.clearAllMocks();
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ─── Types smoke test ─────────────────────────────────────────────────────────
describe('TagVocabulary types', () => {
  it('can construct a TagVocabulary value', () => {
    const vocab: TagVocabulary = {
      version: 1,
      last_updated: new Date().toISOString(),
      active: [],
      dormant: [],
    };
    expect(vocab.version).toBe(1);
    expect(vocab.active).toEqual([]);
  });

  it('can construct a TagEntry with competitor source', () => {
    const entry: TagEntry = {
      tag: '#电竞女生',
      platform: 'xhs',
      score: 25,
      sources: [{ type: 'competitor', account: 'test_account', platform: 'xhs' }],
      first_seen: new Date().toISOString(),
      last_hit: new Date().toISOString(),
      hit_count: 1,
      peak_score: 25,
    };
    expect(entry.tag).toBe('#电竞女生');
    expect(entry.sources[0].type).toBe('competitor');
  });

  it('can construct a TagEntry with keyword_search source', () => {
    const entry: TagEntry = {
      tag: '#赛车手日常',
      platform: 'douyin',
      score: 15,
      sources: [{ type: 'keyword_search', keyword: '赛车', platform: 'douyin' }],
      first_seen: new Date().toISOString(),
      last_hit: new Date().toISOString(),
      hit_count: 1,
      peak_score: 15,
    };
    expect(entry.sources[0].type).toBe('keyword_search');
  });
});
