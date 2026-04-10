/**
 * tag-engine.test.ts
 * Unit tests for tag-engine.ts — including viral KB feedback loop.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setBasePaths, resetBasePaths, PATHS } from '../scripts/utils/file-utils';
import type { TagVocabulary, TagEntry, TagSource, ViralEntry } from '../scripts/utils/types';

const {
  extractHashtags,
  buildInitialEntry,
  boostTagsFromViralEntry,
} = await import('../scripts/ops/tag-engine');

// ─── Sandbox setup ────────────────────────────────────────────────────────────

let sandboxDir: string;

beforeEach(() => {
  sandboxDir = fs.mkdtempSync(path.join('/tmp', 'tag-engine-test-'));
  setBasePaths(sandboxDir, sandboxDir);
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(sandboxDir, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeVocab(active: TagEntry[], dormant: TagEntry[] = []): TagVocabulary {
  return {
    version: 1,
    last_updated: new Date().toISOString(),
    active,
    dormant,
  };
}

function makeTag(tag: string, score = 10, overrides: Partial<TagEntry> = {}): TagEntry {
  const source: TagSource = { type: 'competitor', account: 'test', platform: 'xhs' };
  return {
    tag,
    platform: 'xhs',
    score,
    sources: [source],
    first_seen: new Date().toISOString(),
    last_hit: new Date().toISOString(),
    hit_count: 1,
    peak_score: score,
    ...overrides,
  };
}

function makeViralEntry(overrides: Partial<ViralEntry> = {}): ViralEntry {
  return {
    id: 'viral-001',
    platform: 'xhs',
    source_id: 'src-001',
    source_type: 'competitor',
    persona_id: 'test-persona',
    title: '震惊 #电竞 #游戏 这也太离谱了',
    description: '#赛车 精彩内容',
    likes: 10000,
    comments: 500,
    shares: 300,
    collected_at: new Date().toISOString(),
    dissection: {
      hook_type: '数字冲击',
      content_type: '赛事解读',
      identity_mode: 'esports',
      emotion_arc: '紧张→释放',
      interaction_design: '投票',
      visual_style: '动感',
      cta_type: '评论',
      summary: '赛事引爆互动',
    },
    dissection_status: 'done',
    kb_tier: 'track',
    promoted_to_template: false,
    times_referenced: 0,
    ...overrides,
  };
}

function writeVocab(vocab: TagVocabulary): void {
  fs.writeFileSync(PATHS.tagVocabulary, JSON.stringify(vocab), 'utf8');
}

function readVocab(): TagVocabulary {
  return JSON.parse(fs.readFileSync(PATHS.tagVocabulary, 'utf8')) as TagVocabulary;
}

// ─── extractHashtags tests ──────────────────────────────────────────────────

describe('extractHashtags', () => {
  it('提取多个不重复 hashtags', () => {
    const result = extractHashtags('#电竞 #游戏 内容', '#电竞 #赛车');
    expect(result).toContain('#电竞');
    expect(result).toContain('#游戏');
    expect(result).toContain('#赛车');
    // #电竞 appears in both texts but should be deduped
    expect(result.filter(t => t === '#电竞')).toHaveLength(1);
  });

  it('无 hashtag 返回空数组', () => {
    expect(extractHashtags('no hashtags here')).toEqual([]);
  });
});

// ─── boostTagsFromViralEntry tests ──────────────────────────────────────────

describe('boostTagsFromViralEntry', () => {
  it('提升已有 active tag 的分数', () => {
    const vocab = makeVocab([makeTag('#电竞', 10)]);
    writeVocab(vocab);

    boostTagsFromViralEntry(makeViralEntry());

    const updated = readVocab();
    const tag = updated.active.find(t => t.tag === '#电竞');
    expect(tag).toBeDefined();
    expect(tag!.score).toBe(10 + 25); // original + boost
    expect(tag!.hit_count).toBe(2);
    // Verify source type
    const viralSource = tag!.sources.find(s => s.type === 'viral_kb');
    expect(viralSource).toBeDefined();
    expect((viralSource as { type: 'viral_kb'; entry_id: string }).entry_id).toBe('viral-001');
  });

  it('复活 dormant tag → 移入 active', () => {
    const dormantTag = makeTag('#游戏', 3);
    const vocab = makeVocab([], [dormantTag]);
    writeVocab(vocab);

    boostTagsFromViralEntry(makeViralEntry());

    const updated = readVocab();
    expect(updated.dormant.find(t => t.tag === '#游戏')).toBeUndefined();
    const revived = updated.active.find(t => t.tag === '#游戏');
    expect(revived).toBeDefined();
    expect(revived!.score).toBe(25);
  });

  it('创建全新 tag（含 implicit content_type tag）', () => {
    const vocab = makeVocab([]);
    writeVocab(vocab);

    boostTagsFromViralEntry(makeViralEntry());

    const updated = readVocab();
    // Should have hashtags from title/description + implicit #赛事解读
    const tags = updated.active.map(t => t.tag);
    expect(tags).toContain('#赛事解读'); // from content_type
    expect(tags).toContain('#电竞');     // from title
  });

  it('冷启动（无 vocabulary 文件）静默跳过', () => {
    // No vocab file written — should be a no-op
    expect(() => boostTagsFromViralEntry(makeViralEntry())).not.toThrow();
  });

  it('source 类型为 viral_kb', () => {
    const vocab = makeVocab([]);
    writeVocab(vocab);

    boostTagsFromViralEntry(makeViralEntry());

    const updated = readVocab();
    for (const tag of updated.active) {
      const viralSource = tag.sources.find(s => s.type === 'viral_kb');
      expect(viralSource).toBeDefined();
      expect((viralSource as { type: 'viral_kb'; entry_id: string; platform: string }).platform).toBe('xhs');
    }
  });
});
