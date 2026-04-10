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
    // Reset rate limiter between tests to avoid inter-test interference
    const { resetRateLimiterForTests } = await import('../sub-skills/platform/xhs-bridge/scripts/xhs-client');
    resetRateLimiterForTests();
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

  describe('getUserNotes', () => {
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
});
