/**
 * viral-detector.test.ts
 * Unit tests for viral-detector.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setBasePaths, resetBasePaths } from '../scripts/utils/file-utils';
import { saveEntries, saveQueue } from '../scripts/ops/viral-kb-store';
import { detectViral, TrendLikeItem } from '../scripts/ops/viral-detector';
import { ViralEntry, DissectQueueItem } from '../scripts/utils/types';

// ─── Sandbox setup ────────────────────────────────────────────────────────────

let sandboxDir: string;

beforeEach(() => {
  sandboxDir = fs.mkdtempSync(path.join('/tmp', 'viral-detector-test-'));
  setBasePaths(sandboxDir, sandboxDir);
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(sandboxDir, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<TrendLikeItem> = {}): TrendLikeItem {
  return {
    source_id: 'src-001',
    platform: 'xhs',
    title: 'Viral title',
    description: 'Viral description',
    likes: 9999,
    comments: 500,
    shares: 300,
    source_type: 'trending_feed',
    ...overrides,
  };
}

/** Build the md5 id that detectViral generates internally */
import * as crypto from 'crypto';
function buildId(platform: string, sourceId: string): string {
  return crypto.createHash('md5').update(`${platform}:${sourceId}`).digest('hex');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('detectViral', () => {
  it('returns [] for empty input', () => {
    expect(detectViral([], sandboxDir, 5000)).toEqual([]);
  });

  it('filters items below or at threshold', () => {
    const items: TrendLikeItem[] = [
      makeItem({ source_id: 'a', likes: 5000 }),  // exactly at threshold → excluded
      makeItem({ source_id: 'b', likes: 4999 }),  // below → excluded
    ];
    expect(detectViral(items, sandboxDir, 5000)).toHaveLength(0);
  });

  it('includes items above threshold', () => {
    const items = [makeItem({ source_id: 'a', likes: 5001 })];
    const result = detectViral(items, sandboxDir, 5000);
    expect(result).toHaveLength(1);
    expect(result[0].source_id).toBe('a');
  });

  it('deduplicates items already in the KB entries store', () => {
    const sourceId = 'already-in-kb';
    const platform = 'xhs';
    const id = buildId(platform, sourceId);

    const existingEntry = {
      id,
      platform,
      source_id: sourceId,
    } as unknown as ViralEntry;

    saveEntries(sandboxDir, [existingEntry]);

    const items = [makeItem({ source_id: sourceId, platform, likes: 9999 })];
    expect(detectViral(items, sandboxDir, 5000)).toHaveLength(0);
  });

  it('deduplicates items already in the dissect queue', () => {
    const sourceId = 'already-in-queue';
    const platform = 'douyin';
    const id = buildId(platform, sourceId);

    const queueItem: DissectQueueItem = {
      id,
      platform: 'douyin',
      source_id: sourceId,
      source_type: 'search',
      title: 'Some title',
      description: 'Desc',
      likes: 12000,
      comments: 100,
      shares: 50,
      queued_at: new Date().toISOString(),
    };

    saveQueue(sandboxDir, [queueItem]);

    const items = [makeItem({ source_id: sourceId, platform, likes: 9999 })];
    expect(detectViral(items, sandboxDir, 5000)).toHaveLength(0);
  });

  it('deduplicates within the same batch', () => {
    const items = [
      makeItem({ source_id: 'dup', likes: 9999 }),
      makeItem({ source_id: 'dup', likes: 10000 }),
    ];
    expect(detectViral(items, sandboxDir, 5000)).toHaveLength(1);
  });

  it('preserves identity_mode when present', () => {
    const items = [makeItem({ source_id: 'x', likes: 6000, identity_mode: 'esports' })];
    const result = detectViral(items, sandboxDir, 5000);
    expect(result[0].identity_mode).toBe('esports');
  });

  it('omits identity_mode when not present', () => {
    const items = [makeItem({ source_id: 'x', likes: 6000 })];
    const result = detectViral(items, sandboxDir, 5000);
    expect(result[0].identity_mode).toBeUndefined();
  });

  it('threshold=0: items with likes=0 are excluded (strictly greater than threshold)', () => {
    const items = [
      makeItem({ source_id: 'zero-likes', likes: 0 }),
    ];
    expect(detectViral(items, sandboxDir, 0)).toHaveLength(0);
  });

  it('threshold=0: items with likes=1 are included (strictly greater than 0)', () => {
    const items = [
      makeItem({ source_id: 'one-like', likes: 1 }),
    ];
    const result = detectViral(items, sandboxDir, 0);
    expect(result).toHaveLength(1);
    expect(result[0].source_id).toBe('one-like');
  });

  it('returns correct fields on a valid candidate', () => {
    const item = makeItem({
      source_id: 'full-test',
      platform: 'douyin',
      likes: 7500,
      comments: 200,
      shares: 100,
      source_type: 'competitor',
      title: 'My viral post',
      description: 'Desc here',
    });
    const result = detectViral([item], sandboxDir, 5000);
    expect(result).toHaveLength(1);
    const qItem = result[0];
    expect(qItem.platform).toBe('douyin');
    expect(qItem.source_id).toBe('full-test');
    expect(qItem.source_type).toBe('competitor');
    expect(qItem.likes).toBe(7500);
    expect(typeof qItem.id).toBe('string');
    expect(typeof qItem.queued_at).toBe('string');
  });
});
