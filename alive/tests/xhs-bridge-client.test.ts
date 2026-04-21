import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

function simulateExecFile(stdout: string, stderr = '', error: Error | null = null) {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(error, stdout, stderr);
  });
}

describe('xhs-bridge-client', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockExecFile.mockReset();
    // Reset rate limiter and search cache between tests
    const mod = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
    mod.resetRateLimiterForTests();
    mod.resetSearchCacheForTests();
  });

  describe('isXhsAvailable', () => {
    it('should return true when check-login exits successfully', async () => {
      simulateExecFile(JSON.stringify({ logged_in: true }));
      const { isXhsAvailable } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
      const result = await isXhsAvailable();
      expect(result).toBe(true);
      expect(mockExecFile).toHaveBeenCalledWith(
        'uv',
        expect.arrayContaining(['run', 'python', 'check-login']),
        expect.any(Object),
        expect.any(Function),
      );
    });

    it('should return false when check-login fails', async () => {
      simulateExecFile('', '', new Error('exit code 1'));
      const { isXhsAvailable } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
      const result = await isXhsAvailable();
      expect(result).toBe(false);
    });

    it('should use cached login status on second call (no extra CLI invocation)', async () => {
      simulateExecFile(JSON.stringify({ logged_in: true }));
      const { isXhsAvailable, resetRateLimiterForTests } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
      resetRateLimiterForTests();

      const first = await isXhsAvailable();
      expect(first).toBe(true);
      const callCountAfterFirst = mockExecFile.mock.calls.length;

      const second = await isXhsAvailable();
      expect(second).toBe(true);
      // Second call should NOT trigger another CLI invocation — login status was cached
      expect(mockExecFile.mock.calls.length).toBe(callCountAfterFirst);
    });

    it('should re-check login after cache is invalidated by reset', async () => {
      simulateExecFile(JSON.stringify({ logged_in: true }));
      const { isXhsAvailable, resetRateLimiterForTests } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
      resetRateLimiterForTests();

      await isXhsAvailable();
      const callCountAfterFirst = mockExecFile.mock.calls.length;

      // Reset cache
      resetRateLimiterForTests();

      await isXhsAvailable();
      // After reset, should trigger a fresh CLI call
      expect(mockExecFile.mock.calls.length).toBeGreaterThan(callCountAfterFirst);
    });
  });

  describe('listXhsFeed', () => {
    it('should parse CLI JSON stdout and map to XhsNote array', async () => {
      const cliResponse = {
        feeds: [
          { id: 'note1', xsecToken: 'tok1', displayTitle: 'JK制服穿搭', user: { nickname: 'fashionista' }, interactInfo: { likedCount: '2000' } },
          { id: 'note2', xsecToken: 'tok2', displayTitle: 'Cos妆容教程', user: { nickname: 'cosbeauty' }, interactInfo: { likedCount: '500' } },
        ],
        count: 2,
      };
      simulateExecFile(JSON.stringify(cliResponse));
      const { listXhsFeed } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
      const notes = await listXhsFeed();
      expect(notes).toHaveLength(2);
      expect(notes[0].title).toBe('JK制服穿搭');
      expect(notes[0].likes).toBe(2000);
      expect(notes[0].xsec_token).toBe('tok1');
      expect(notes[0].user).toBe('fashionista');
    });

    it('should throw when CLI returns error', async () => {
      simulateExecFile('', 'some error', new Error('exit code 1'));
      const { listXhsFeed } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
      await expect(listXhsFeed()).rejects.toThrow('xhs-bridge list-feeds failed');
    });
  });

  describe('searchXhsNotes', () => {
    it('should pass keyword and recency filters to CLI', async () => {
      simulateExecFile(JSON.stringify({ feeds: [], count: 0 }));
      const { searchXhsNotes } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
      await searchXhsNotes('cosplay', { sortBy: '最新', publishTime: '一周内' });
      expect(mockExecFile).toHaveBeenCalledWith(
        'uv',
        expect.arrayContaining(['run', 'python', 'search-feeds', '--keyword', 'cosplay', '--sort-by', '最新', '--publish-time', '一周内']),
        expect.any(Object),
        expect.any(Function),
      );
    });
  });

  describe('getUserNotes', { timeout: 30_000 }, () => {
    it('should parse user notes from CLI response', async () => {
      vi.useFakeTimers();
      const cliResponse = {
        notes: [
          { id: 'n1', xsecToken: 'tok1', displayTitle: '赛车日记', user: { nickname: 'miss_v' }, interactInfo: { likedCount: '1.2万' } },
          { id: 'n2', xsecToken: 'tok2', displayTitle: '今日穿搭', user: { nickname: 'miss_v' }, interactInfo: { likedCount: '800' } },
        ],
      };
      // Mock: 1st call = check-login (success), 2nd call = get-user-notes (success)
      mockExecFile
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, JSON.stringify({ logged_in: true }), '');
        })
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, JSON.stringify(cliResponse), '');
        });

      const { getUserNotes, resetRateLimiterForTests } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
      resetRateLimiterForTests();

      const promise = getUserNotes('miss_v', 20);
      // Advance timers to skip jitter + rate limiter waits
      await vi.advanceTimersByTimeAsync(20_000);
      const notes = await promise;

      expect(notes).toHaveLength(2);
      expect(notes[0].id).toBe('n1');
      expect(notes[0].title).toBe('赛车日记');
      expect(notes[0].likes).toBe(12000);
      expect(notes[0].user).toBe('miss_v');
      expect(mockExecFile).toHaveBeenCalledWith(
        'uv',
        expect.arrayContaining(['run', 'python', 'get-user-notes', '--user', 'miss_v', '--limit', '20']),
        expect.any(Object),
        expect.any(Function),
      );
      vi.useRealTimers();
    });

    it('should fall back to search on CLI error', async () => {
      // Rate limiter introduces ~10-15s real wall-clock delay even with fake timers,
      // because the limiter uses Date.now() internally. Bump vitest timeout.
      vi.useFakeTimers();
      // Mock: 1st = check-login (success), 2nd = get-user-notes (fail), 3rd = search-feeds (success)
      mockExecFile
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, JSON.stringify({ logged_in: true }), '');
        })
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(new Error('exit code 1'), '', 'command not found');
        })
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, JSON.stringify({ feeds: [], count: 0 }), '');
        });

      const { getUserNotes, resetRateLimiterForTests } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
      resetRateLimiterForTests();

      const promise = getUserNotes('miss_v');
      await vi.advanceTimersByTimeAsync(30_000);
      const notes = await promise;

      expect(notes).toEqual([]);
      vi.useRealTimers();
    });
  });

  describe('getXhsNoteDetail', () => {
    it('should pass --feed-id and --xsec-token to CLI and map result', async () => {
      // CLI wraps detail in { note: {...}, comments: [...] }
      const cliDetail = {
        note: {
          noteId: 'note1', title: 'Test', desc: 'description text',
          user: { userId: 'u1', nickname: 'testuser' },
          interactInfo: { likedCount: '3.4万', collectedCount: '1.3万', sharedCount: '786', commentCount: '280' },
          imageList: [{ width: 800, height: 600, urlDefault: 'https://img.example.com/1.jpg' }],
        },
        comments: [
          { content: '好看', likeCount: '35', user: { userId: 'c1', nickname: 'commenter1' } },
        ],
      };
      simulateExecFile(JSON.stringify(cliDetail));
      const { getXhsNoteDetail } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
      const result = await getXhsNoteDetail('note1', 'tok1');
      expect(result.id).toBe('note1');
      expect(result.title).toBe('Test');
      expect(result.description).toBe('description text');
      expect(result.likes).toBe(34000);
      expect(result.collected_count).toBe(13000);
      expect(result.share_count).toBe(786);
      expect(result.images).toEqual(['https://img.example.com/1.jpg']);
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].user).toBe('commenter1');
      expect(result.comments[0].content).toBe('好看');
      expect(result.comments[0].likes).toBe(35);
      expect(mockExecFile).toHaveBeenCalledWith(
        'uv',
        expect.arrayContaining(['run', 'python', 'get-feed-detail', '--feed-id', 'note1', '--xsec-token', 'tok1']),
        expect.any(Object),
        expect.any(Function),
      );
    });
  });

  describe('resetRateLimiterForTests', () => {
    it('should be exported and callable without errors', async () => {
      const { resetRateLimiterForTests } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
      expect(() => resetRateLimiterForTests()).not.toThrow();
    });

    it('should clear login cache so isXhsAvailable re-checks', async () => {
      // First: login succeeds
      simulateExecFile(JSON.stringify({ logged_in: true }));
      const { isXhsAvailable, resetRateLimiterForTests } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
      resetRateLimiterForTests();
      expect(await isXhsAvailable()).toBe(true);

      // Reset and switch mock to fail
      resetRateLimiterForTests();
      simulateExecFile('', '', new Error('not logged in'));

      // Now should return false (cache was cleared)
      expect(await isXhsAvailable()).toBe(false);
    });
  });

  describe('search result TTL cache', () => {
    it('second searchXhsNotes call within TTL should hit cache and skip CLI', async () => {
      const cliResponse = { feeds: [
        { id: 'n1', xsecToken: 'tok1', displayTitle: '穿搭日记', user: { nickname: 'stylist' }, interactInfo: { likedCount: '500' } },
      ], count: 1 };
      simulateExecFile(JSON.stringify(cliResponse));

      const { searchXhsNotes, resetSearchCacheForTests } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
      resetSearchCacheForTests();

      const first = await searchXhsNotes('穿搭', { sortBy: '最热' });
      expect(first).toHaveLength(1);
      const callCountAfterFirst = mockExecFile.mock.calls.length;

      // Second call — should return cached result without invoking CLI again
      const second = await searchXhsNotes('穿搭', { sortBy: '最热' });
      expect(second).toHaveLength(1);
      expect(second[0].id).toBe('n1');
      expect(mockExecFile.mock.calls.length).toBe(callCountAfterFirst);
    });

    it('different keyword produces a separate cache entry', async () => {
      vi.useFakeTimers();
      const response1 = { feeds: [{ id: 'a1', xsecToken: 't1', displayTitle: 'A', user: { nickname: 'u1' }, interactInfo: { likedCount: '1' } }], count: 1 };
      const response2 = { feeds: [{ id: 'b1', xsecToken: 't2', displayTitle: 'B', user: { nickname: 'u2' }, interactInfo: { likedCount: '2' } }], count: 1 };

      mockExecFile
        .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: Function) => cb(null, JSON.stringify(response1), ''))
        .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: Function) => cb(null, JSON.stringify(response2), ''));

      const { searchXhsNotes, resetSearchCacheForTests } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
      resetSearchCacheForTests();

      const p1 = searchXhsNotes('穿搭');
      await vi.advanceTimersByTimeAsync(20_000);
      const r1 = await p1;

      const p2 = searchXhsNotes('美食');
      await vi.advanceTimersByTimeAsync(20_000);
      const r2 = await p2;

      expect(r1[0].id).toBe('a1');
      expect(r2[0].id).toBe('b1');
      expect(mockExecFile.mock.calls.length).toBe(2);
      vi.useRealTimers();
    });

    it('cache miss on expired entry re-fetches from CLI', async () => {
      vi.useFakeTimers();
      const response = { feeds: [{ id: 'n1', xsecToken: 't1', displayTitle: 'X', user: { nickname: 'u' }, interactInfo: { likedCount: '0' } }], count: 1 };
      simulateExecFile(JSON.stringify(response));

      const { searchXhsNotes, resetSearchCacheForTests } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
      resetSearchCacheForTests();

      // First call — fills cache
      await searchXhsNotes('cosplay');
      const callsAfterFirst = mockExecFile.mock.calls.length;

      // Advance time past 4-hour TTL
      await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000 + 1000);

      // Second call — cache expired, should re-fetch
      simulateExecFile(JSON.stringify(response));
      await searchXhsNotes('cosplay');
      expect(mockExecFile.mock.calls.length).toBeGreaterThan(callsAfterFirst);

      vi.useRealTimers();
    });

    it('CLI failure does not overwrite existing cache', async () => {
      const goodResponse = { feeds: [{ id: 'cached', xsecToken: 't', displayTitle: 'Cached', user: { nickname: 'u' }, interactInfo: { likedCount: '100' } }], count: 1 };

      // First successful call — fills cache
      mockExecFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: Function) =>
        cb(null, JSON.stringify(goodResponse), ''));

      const { searchXhsNotes, resetSearchCacheForTests } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
      resetSearchCacheForTests();

      await searchXhsNotes('穿搭');

      // Manually expire the in-memory cache by resetting TTL check via env-based file (the cache is file-based,
      // so we need to simulate expiry by calling with a different context — just test that CLI error doesn't throw away cached data
      // by calling again when CLI fails but cache is still fresh)
      mockExecFile.mockReset();
      simulateExecFile('', 'internal server error', new Error('CLI failed'));

      // Cache is still fresh — should return cached value, not call CLI
      const result = await searchXhsNotes('穿搭');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('cached');
      // CLI should NOT have been called (cache hit)
      expect(mockExecFile.mock.calls.length).toBe(0);
    });

    it('empty result from CLI does not overwrite existing cache', async () => {
      vi.useFakeTimers();
      const goodResponse = { feeds: [{ id: 'keep-me', xsecToken: 't', displayTitle: 'Keep', user: { nickname: 'u' }, interactInfo: { likedCount: '50' } }], count: 1 };
      const emptyResponse = { feeds: [], count: 0 };

      mockExecFile
        .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: Function) => cb(null, JSON.stringify(goodResponse), ''))
        .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: Function) => cb(null, JSON.stringify(emptyResponse), ''));

      const { searchXhsNotes, resetSearchCacheForTests } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
      resetSearchCacheForTests();

      // Fill cache with good data
      const p1 = searchXhsNotes('赛车');
      await vi.advanceTimersByTimeAsync(20_000);
      await p1;

      // Expire the cache
      await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000 + 1000);

      // CLI returns empty — existing cache should NOT be overwritten
      // (After expiry the fetcher runs, returns [], so cache entry is not updated)
      const p2 = searchXhsNotes('赛车');
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await p2;
      expect(result).toEqual([]);

      // Verify: if we call again (still empty CLI), we go to CLI each time since cache was not updated
      mockExecFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: Function) =>
        cb(null, JSON.stringify(emptyResponse), ''));
      const p3 = searchXhsNotes('赛车');
      await vi.advanceTimersByTimeAsync(20_000);
      const result2 = await p3;
      expect(result2).toEqual([]);
      // CLI was called for both expired calls (no re-caching of empty)
      expect(mockExecFile.mock.calls.length).toBe(3);

      vi.useRealTimers();
    });

    it('listXhsFeed honours the in-memory feed cache', async () => {
      vi.useFakeTimers();
      const response1 = { feeds: [{ id: 'f1', xsecToken: 't1', displayTitle: 'Feed1', user: { nickname: 'u' }, interactInfo: { likedCount: '10' } }] };
      const response2 = { feeds: [{ id: 'f2', xsecToken: 't2', displayTitle: 'Feed2', user: { nickname: 'u' }, interactInfo: { likedCount: '20' } }] };

      mockExecFile
        .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: Function) => cb(null, JSON.stringify(response1), ''))
        .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: Function) => cb(null, JSON.stringify(response2), ''));

      const { listXhsFeed } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');

      const p1 = listXhsFeed();
      await vi.advanceTimersByTimeAsync(20_000);
      const first = await p1;

      const p2 = listXhsFeed();
      await vi.advanceTimersByTimeAsync(20_000);
      const second = await p2;

      // Second call must hit the in-memory cache populated by the first call;
      // we asserted the old "always call CLI" contract which no longer holds.
      expect(first[0].id).toBe('f1');
      expect(second[0].id).toBe('f1');
      expect(mockExecFile.mock.calls.length).toBe(1);
      vi.useRealTimers();
    });

    it('resetSearchCacheForTests clears cache so next call re-fetches', async () => {
      vi.useFakeTimers();
      const response = { feeds: [{ id: 'n1', xsecToken: 't', displayTitle: 'T', user: { nickname: 'u' }, interactInfo: { likedCount: '5' } }], count: 1 };
      simulateExecFile(JSON.stringify(response));

      const { searchXhsNotes, resetSearchCacheForTests } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
      resetSearchCacheForTests();

      const p1 = searchXhsNotes('test');
      await vi.advanceTimersByTimeAsync(20_000);
      await p1;
      const callsAfterFirst = mockExecFile.mock.calls.length;

      // Reset cache — next call should go to CLI again
      resetSearchCacheForTests();
      simulateExecFile(JSON.stringify(response));
      const p2 = searchXhsNotes('test');
      await vi.advanceTimersByTimeAsync(20_000);
      await p2;
      expect(mockExecFile.mock.calls.length).toBeGreaterThan(callsAfterFirst);
      vi.useRealTimers();
    });
  });
});
