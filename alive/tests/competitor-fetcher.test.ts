/**
 * competitor-fetcher.test.ts
 * Unit + integration tests for Layer 1 data collection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setBasePaths, resetBasePaths, PATHS, readJSON } from '../scripts/utils/file-utils';
import type { CompetitorPost, CompetitorPostsStore } from '../scripts/utils/types';

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../sub-skills/platform/xhs-bridge/scripts/xhs-client', () => ({
  getUserNotes: vi.fn(),
}));

// ─── Lazy imports (after mocks are set up) ────────────────────────────────────

const { execFileSync } = await import('child_process');
const { getUserNotes } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
const {
  buildAccountKey,
  mergeAndDedupPosts,
  pruneOldPosts,
  fetchCompetitorPosts,
  loadCompetitorPosts,
} = await import('../scripts/ops/competitor-fetcher');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePost(
  overrides: Partial<CompetitorPost> & Pick<CompetitorPost, 'post_id'>
): CompetitorPost {
  return {
    account_name: '@test',
    platform: 'xhs',
    title: '测试标题',
    engagement: 100,
    fetched_at: new Date().toISOString(),
    ...overrides,
  };
}

// ─── buildAccountKey ─────────────────────────────────────────────────────────

describe('buildAccountKey', () => {
  it('joins name and platform with colon', () => {
    expect(buildAccountKey('@test_user', 'xhs')).toBe('@test_user:xhs');
  });

  it('works for douyin platform', () => {
    expect(buildAccountKey('some_account', 'douyin')).toBe('some_account:douyin');
  });

  it('preserves special characters in name', () => {
    expect(buildAccountKey('@user:with:colons', 'xhs')).toBe('@user:with:colons:xhs');
  });
});

// ─── mergeAndDedupPosts ──────────────────────────────────────────────────────

describe('mergeAndDedupPosts', () => {
  it('returns all posts when no duplicates', () => {
    const existing = [makePost({ post_id: 'p1', engagement: 100 })];
    const incoming = [makePost({ post_id: 'p2', engagement: 200 })];
    const result = mergeAndDedupPosts(existing, incoming, 10);
    expect(result).toHaveLength(2);
  });

  it('deduplicates by post_id — incoming wins on conflict', () => {
    const existing = [makePost({ post_id: 'p1', title: '旧标题', engagement: 50 })];
    const incoming = [makePost({ post_id: 'p1', title: '新标题', engagement: 500 })];
    const result = mergeAndDedupPosts(existing, incoming, 10);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('新标题');
    expect(result[0].engagement).toBe(500);
  });

  it('sorts by engagement descending', () => {
    const existing = [makePost({ post_id: 'p1', engagement: 100 })];
    const incoming = [
      makePost({ post_id: 'p2', engagement: 500 }),
      makePost({ post_id: 'p3', engagement: 50 }),
    ];
    const result = mergeAndDedupPosts(existing, incoming, 10);
    expect(result[0].engagement).toBe(500);
    expect(result[1].engagement).toBe(100);
    expect(result[2].engagement).toBe(50);
  });

  it('caps at maxPosts', () => {
    const existing = [
      makePost({ post_id: 'p1', engagement: 10 }),
      makePost({ post_id: 'p2', engagement: 20 }),
    ];
    const incoming = [
      makePost({ post_id: 'p3', engagement: 30 }),
      makePost({ post_id: 'p4', engagement: 40 }),
      makePost({ post_id: 'p5', engagement: 50 }),
    ];
    const result = mergeAndDedupPosts(existing, incoming, 3);
    expect(result).toHaveLength(3);
    // Top 3 by engagement: 50, 40, 30
    expect(result[0].engagement).toBe(50);
    expect(result[1].engagement).toBe(40);
    expect(result[2].engagement).toBe(30);
  });

  it('returns empty array for empty inputs', () => {
    const result = mergeAndDedupPosts([], [], 10);
    expect(result).toEqual([]);
  });

  it('does not mutate existing array', () => {
    const existing = [makePost({ post_id: 'p1', engagement: 100 })];
    const original = [...existing];
    mergeAndDedupPosts(existing, [makePost({ post_id: 'p1', title: 'NEW', engagement: 999 })], 10);
    expect(existing[0].title).toBe(original[0].title);
  });
});

// ─── pruneOldPosts ────────────────────────────────────────────────────────────

describe('pruneOldPosts', () => {
  const refDate = new Date('2026-04-02T12:00:00Z');

  it('removes posts older than retentionDays using posted_at', () => {
    const posts = [
      makePost({ post_id: 'old', posted_at: '2026-02-01T00:00:00Z', fetched_at: '2026-04-02T00:00:00Z' }),
      makePost({ post_id: 'recent', posted_at: '2026-03-20T00:00:00Z', fetched_at: '2026-04-02T00:00:00Z' }),
    ];
    const result = pruneOldPosts(posts, refDate, 30);
    expect(result).toHaveLength(1);
    expect(result[0].post_id).toBe('recent');
  });

  it('uses fetched_at when posted_at is absent', () => {
    const posts = [
      makePost({ post_id: 'old_fetch', fetched_at: '2026-02-01T00:00:00Z' }),
      makePost({ post_id: 'new_fetch', fetched_at: '2026-04-01T00:00:00Z' }),
    ];
    const result = pruneOldPosts(posts, refDate, 30);
    expect(result).toHaveLength(1);
    expect(result[0].post_id).toBe('new_fetch');
  });

  it('keeps all posts when within retention window', () => {
    const posts = [
      makePost({ post_id: 'p1', posted_at: '2026-03-20T00:00:00Z', fetched_at: '2026-03-20T00:00:00Z' }),
      makePost({ post_id: 'p2', posted_at: '2026-04-01T00:00:00Z', fetched_at: '2026-04-01T00:00:00Z' }),
    ];
    const result = pruneOldPosts(posts, refDate, 30);
    expect(result).toHaveLength(2);
  });

  it('returns empty array when all posts are expired', () => {
    const posts = [
      makePost({ post_id: 'p1', fetched_at: '2025-01-01T00:00:00Z' }),
    ];
    const result = pruneOldPosts(posts, refDate, 30);
    expect(result).toHaveLength(0);
  });

  it('uses default retentionDays of 30 when omitted', () => {
    const recentDate = new Date('2026-04-02T12:00:00Z');
    const posts = [
      makePost({ post_id: 'ok', fetched_at: '2026-03-15T00:00:00Z' }),
      makePost({ post_id: 'old', fetched_at: '2026-02-01T00:00:00Z' }),
    ];
    const result = pruneOldPosts(posts, recentDate);
    expect(result).toHaveLength(1);
    expect(result[0].post_id).toBe('ok');
  });
});

// ─── fetchCompetitorPosts (integration) ──────────────────────────────────────

describe('fetchCompetitorPosts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-fetcher-test-'));
    setBasePaths(tmpDir, tmpDir);
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetBasePaths();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fetches XHS posts and writes to competitor-posts.json', async () => {
    const mockNotes = [
      { id: 'note_1', title: '测试帖子1', likes: 1000, xsec_token: '', description: '', user: '@test', tags: [] },
      { id: 'note_2', title: '测试帖子2', likes: 500, xsec_token: '', description: '', user: '@test', tags: [] },
    ];
    vi.mocked(getUserNotes).mockResolvedValue(mockNotes);

    const result = await fetchCompetitorPosts(
      { xhs: ['@test_account'], douyin: [] },
      [],
      tmpDir
    );

    expect(result.success).toContain('@test_account:xhs');
    expect(result.failed).toHaveLength(0);

    const store = readJSON<CompetitorPostsStore>(PATHS.competitorPosts, { version: 1, last_fetched: '', accounts: {} });
    expect(store.version).toBe(1);
    expect(store.accounts['@test_account:xhs']).toBeDefined();
    expect(store.accounts['@test_account:xhs']).toHaveLength(2);
  });

  it('fetches Douyin posts via execFileSync', async () => {
    const mockOutput = JSON.stringify({
      videos: [
        { id: 'video_1', title: '抖音视频1', like_count: 50000, upload_date: '2026-04-01T00:00:00Z' },
        { id: 'video_2', title: '抖音视频2', like_count: 30000, upload_date: '2026-04-01T00:00:00Z' },
      ],
    });
    vi.mocked(execFileSync).mockReturnValue(mockOutput);

    const result = await fetchCompetitorPosts(
      { xhs: [], douyin: ['douyin_user_123'] },
      [],
      tmpDir
    );

    expect(result.success).toContain('douyin_user_123:douyin');
    expect(result.failed).toHaveLength(0);

    const store = readJSON<CompetitorPostsStore>(PATHS.competitorPosts, { version: 1, last_fetched: '', accounts: {} });
    expect(store.accounts['douyin_user_123:douyin']).toBeDefined();
    expect(store.accounts['douyin_user_123:douyin']).toHaveLength(2);
  });

  it('tracks failed accounts when XHS fetch throws', async () => {
    vi.mocked(getUserNotes).mockRejectedValue(new Error('XHS unavailable'));

    const result = await fetchCompetitorPosts(
      { xhs: ['@fail_account'], douyin: [] },
      [],
      tmpDir
    );

    expect(result.failed).toContain('@fail_account:xhs');
    expect(result.success).toHaveLength(0);
  });

  it('tracks failed accounts when Douyin execFileSync throws', async () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('yt-dlp failed'); });

    const result = await fetchCompetitorPosts(
      { xhs: [], douyin: ['bad_account'] },
      [],
      tmpDir
    );

    expect(result.failed).toContain('bad_account:douyin');
    expect(result.success).toHaveLength(0);
  });

  it('one failure does not block other accounts', async () => {
    vi.mocked(getUserNotes).mockRejectedValue(new Error('XHS down'));

    const mockOutput = JSON.stringify({
      videos: [
        { id: 'v1', title: '视频1', like_count: 10000 },
      ],
    });
    vi.mocked(execFileSync).mockReturnValue(mockOutput);

    const result = await fetchCompetitorPosts(
      { xhs: ['@broken_xhs'], douyin: ['ok_douyin'] },
      [],
      tmpDir
    );

    expect(result.failed).toContain('@broken_xhs:xhs');
    expect(result.success).toContain('ok_douyin:douyin');
  });

  it('retains previous data for failed accounts', async () => {
    // Pre-populate store with existing data for an account
    const existingStore: CompetitorPostsStore = {
      version: 1,
      last_fetched: '2026-04-01T00:00:00Z',
      accounts: {
        '@saved_account:xhs': [
          makePost({ post_id: 'existing_1', account_name: '@saved_account', platform: 'xhs', engagement: 999 }),
        ],
      },
    };
    const { writeJSON } = await import('../scripts/utils/file-utils');
    writeJSON(PATHS.competitorPosts, existingStore);

    // This account fails
    vi.mocked(getUserNotes).mockRejectedValue(new Error('network error'));

    await fetchCompetitorPosts({ xhs: ['@saved_account'], douyin: [] }, [], tmpDir);

    const store = readJSON<CompetitorPostsStore>(PATHS.competitorPosts, { version: 1, last_fetched: '', accounts: {} });
    // Previous data should still be present
    expect(store.accounts['@saved_account:xhs']).toBeDefined();
    expect(store.accounts['@saved_account:xhs'][0].post_id).toBe('existing_1');
  });

  it('writes version 1 and last_fetched timestamp', async () => {
    vi.mocked(getUserNotes).mockResolvedValue([]);

    await fetchCompetitorPosts({ xhs: ['@any'], douyin: [] }, [], tmpDir);

    const store = readJSON<CompetitorPostsStore>(PATHS.competitorPosts, { version: 1, last_fetched: '', accounts: {} });
    expect(store.version).toBe(1);
    expect(store.last_fetched).toBeTruthy();
    expect(new Date(store.last_fetched).getTime()).not.toBeNaN();
  });
});

// ─── loadCompetitorPosts ─────────────────────────────────────────────────────

describe('loadCompetitorPosts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-load-test-'));
    setBasePaths(tmpDir, tmpDir);
  });

  afterEach(() => {
    resetBasePaths();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns default empty store when file does not exist', () => {
    const store = loadCompetitorPosts();
    expect(store.version).toBe(1);
    expect(store.last_fetched).toBe('');
    expect(store.accounts).toEqual({});
  });

  it('returns stored data when file exists', async () => {
    const { writeJSON } = await import('../scripts/utils/file-utils');
    const saved: CompetitorPostsStore = {
      version: 1,
      last_fetched: '2026-04-01T00:00:00Z',
      accounts: {
        '@user:xhs': [makePost({ post_id: 'p1', account_name: '@user', platform: 'xhs' })],
      },
    };
    writeJSON(PATHS.competitorPosts, saved);

    const loaded = loadCompetitorPosts();
    expect(loaded.last_fetched).toBe('2026-04-01T00:00:00Z');
    expect(loaded.accounts['@user:xhs']).toHaveLength(1);
  });
});
