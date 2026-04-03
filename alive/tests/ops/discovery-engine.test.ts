/**
 * discovery-engine.test.ts
 * Tests for the content discovery and account discovery engines.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { setBasePaths, resetBasePaths, PATHS } from '../../scripts/utils/file-utils';
import {
  loadDiscoveryPool,
  saveDiscoveryPool,
  scoreContent,
  processInspirationForDiscovery,
  processInspirationForAccountDiscovery,
  loadCandidateAccounts,
  saveCandidateAccounts,
  buildDiscoveryContext,
  buildCandidateContext,
  approveCandidate,
  dismissCandidate,
  DEFAULT_DISCOVERY_POOL,
} from '../../scripts/ops/discovery-engine';
import { writeJSON } from '../../scripts/utils/file-utils';

const TEST_DIR = path.join(__dirname, '__discovery_test_sandbox__');

function cleanSandbox() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
  setBasePaths(TEST_DIR, path.join(TEST_DIR, '_skills'));
}

beforeEach(() => {
  cleanSandbox();
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('scoreContent', () => {
  it('scores high-engagement content higher', () => {
    const low = scoreContent({ title: 'low', likes: 100, topic: 'test' });
    const high = scoreContent({ title: 'high', likes: 10000, topic: 'test' });
    expect(high).toBeGreaterThan(low);
  });

  it('gives bonus for takeaway', () => {
    const without = scoreContent({ title: 'a', likes: 1000, topic: 'test' });
    const withTakeaway = scoreContent({ title: 'a', likes: 1000, topic: 'test', takeaway: 'good stuff' });
    expect(withTakeaway).toBeGreaterThan(without);
  });
});

describe('processInspirationForDiscovery', () => {
  it('returns 0 when no inspiration state', () => {
    expect(processInspirationForDiscovery()).toBe(0);
  });

  it('adds high-engagement highlights to discovery pool', () => {
    writeJSON(PATHS.inspirationState, {
      last_refreshed_at: new Date().toISOString(),
      feed_highlights: [
        { title: '爆款标题', likes: 5000, topic: '电竞' },
        { title: '普通标题', likes: 100, topic: '日常' },
        { title: '超级爆款', likes: 20000, topic: '音乐' },
      ],
      trending_topics: [],
      domain_insights: [],
      saved_inspirations: [],
    });

    const added = processInspirationForDiscovery();
    expect(added).toBe(2); // only 5000 and 20000 pass threshold

    const pool = loadDiscoveryPool();
    expect(pool.items).toHaveLength(2);
    expect(pool.items[0].title).toBe('超级爆款'); // sorted by score desc
  });

  it('deduplicates on title', () => {
    writeJSON(PATHS.inspirationState, {
      last_refreshed_at: new Date().toISOString(),
      feed_highlights: [
        { title: '爆款标题', likes: 5000, topic: '电竞' },
      ],
      trending_topics: [],
      domain_insights: [],
      saved_inspirations: [],
    });

    processInspirationForDiscovery();
    const pool1 = loadDiscoveryPool();
    const count1 = pool1.items.length;

    const added2 = processInspirationForDiscovery();
    expect(added2).toBe(0); // already exists

    const pool2 = loadDiscoveryPool();
    expect(pool2.items).toHaveLength(count1); // same count
  });
});

describe('processInspirationForAccountDiscovery', () => {
  it('creates candidate when author appears multiple times', () => {
    // Set up discovery pool with repeated author
    saveDiscoveryPool({
      items: [
        { title: 'A', author: 'creator1', source: 'xhs', engagement: 5000, topic: '电竞', score: 80, discovered_at: '' },
        { title: 'B', author: 'creator1', source: 'xhs', engagement: 8000, topic: '音乐', score: 90, discovered_at: '' },
        { title: 'C', author: 'creator2', source: 'douyin', engagement: 3000, topic: '日常', score: 70, discovered_at: '' },
      ],
      last_updated: '',
    });

    // Also set up empty inspiration state
    writeJSON(PATHS.inspirationState, {
      last_refreshed_at: new Date().toISOString(),
      feed_highlights: [],
      trending_topics: [],
      domain_insights: [],
      saved_inspirations: [],
    });

    const newCandidates = processInspirationForAccountDiscovery();
    expect(newCandidates).toBe(1); // only creator1 has >= 2 appearances

    const store = loadCandidateAccounts();
    expect(store.candidates).toHaveLength(1);
    expect(store.candidates[0].name).toBe('creator1');
    expect(store.candidates[0].avg_engagement).toBe(6500);
    expect(store.candidates[0].topics).toContain('电竞');
  });
});

describe('buildDiscoveryContext', () => {
  it('returns empty when pool has no items', () => {
    saveDiscoveryPool({ items: [], last_updated: '' });
    expect(buildDiscoveryContext()).toBe('');
  });

  it('returns formatted context with top items', () => {
    saveDiscoveryPool({
      items: [
        { title: '爆款1', author: '', source: 'xhs', engagement: 10000, topic: '电竞', score: 90, discovered_at: '' },
      ],
      last_updated: '',
    });
    const ctx = buildDiscoveryContext();
    expect(ctx).toContain('爆款发现');
    expect(ctx).toContain('爆款1');
  });
});

describe('buildCandidateContext', () => {
  it('returns empty when no pending candidates', () => {
    saveCandidateAccounts({ candidates: [], last_updated: '' });
    expect(buildCandidateContext()).toBe('');
  });

  it('shows pending candidates', () => {
    const store = {
      candidates: [{
        name: 'testuser', platform: 'xhs',
        appearance_count: 3, avg_engagement: 5000,
        topics: ['电竞', '日常'],
        first_seen: '2026-04-01', last_seen: '2026-04-03',
        status: 'pending' as const,
      }],
      last_updated: '',
    };
    writeJSON(PATHS.candidateAccounts, store);
    const ctx = buildCandidateContext();
    expect(ctx).toContain('候选对标');
    expect(ctx).toContain('testuser');
  });
});

describe('candidate management', () => {
  it('approves and dismisses candidates', () => {
    writeJSON(PATHS.candidateAccounts, {
      candidates: [
        { name: 'a', platform: 'xhs', appearance_count: 3, avg_engagement: 5000, topics: [], first_seen: '', last_seen: '', status: 'pending' },
        { name: 'b', platform: 'douyin', appearance_count: 2, avg_engagement: 3000, topics: [], first_seen: '', last_seen: '', status: 'pending' },
      ],
      last_updated: '',
    });

    expect(approveCandidate('a', 'xhs')).toBe(true);
    expect(dismissCandidate('b', 'douyin')).toBe(true);
    expect(approveCandidate('nonexistent', 'xhs')).toBe(false);

    const store = loadCandidateAccounts();
    expect(store.candidates.find(c => c.name === 'a')!.status).toBe('approved');
    expect(store.candidates.find(c => c.name === 'b')!.status).toBe('dismissed');
  });
});
