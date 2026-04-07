import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as child_process from 'child_process';

vi.mock('child_process');

const { listDouyinUserPosts, searchDouyinVideos } = await import(
  '../../sub-skills/platform/douyin-bridge/scripts/douyin-client'
);

describe('listDouyinUserPosts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses successful result', () => {
    const mockResult = {
      success: true,
      videos: [{
        aweme_id: '123',
        desc: '测试视频',
        create_time: 1700000000,
        author: 'testuser',
        digg_count: 1234,
      }],
    };
    vi.mocked(child_process.execFileSync).mockReturnValue(JSON.stringify(mockResult));
    const result = listDouyinUserPosts('some_sec_uid');
    expect(result.success).toBe(true);
    expect(result.videos).toHaveLength(1);
    expect(result.videos![0].desc).toBe('测试视频');
    expect(result.videos![0].digg_count).toBe(1234);
  });

  it('handles CLI failure gracefully', () => {
    vi.mocked(child_process.execFileSync).mockImplementation(() => {
      throw new Error('uv not found');
    });
    const result = listDouyinUserPosts('some_sec_uid');
    expect(result.success).toBe(false);
    expect(result.error).toContain('uv not found');
  });

  it('returns no posts when videos array is empty', () => {
    vi.mocked(child_process.execFileSync).mockReturnValue(
      JSON.stringify({ success: true, videos: [] }),
    );
    const result = listDouyinUserPosts('some_sec_uid');
    expect(result.success).toBe(true);
    expect(result.videos).toHaveLength(0);
  });
});

describe('searchDouyinVideos', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns video list on success', () => {
    const mockResult = {
      success: true,
      videos: [{
        aweme_id: '456',
        desc: 'keyword结果',
        create_time: 1700000000,
        author: 'u',
        digg_count: 500,
      }],
    };
    vi.mocked(child_process.execFileSync).mockReturnValue(JSON.stringify(mockResult));
    const result = searchDouyinVideos('测试关键词');
    expect(result.success).toBe(true);
    expect(result.videos).toHaveLength(1);
    expect(result.videos![0].desc).toBe('keyword结果');
  });

  it('returns failure on CLI error', () => {
    vi.mocked(child_process.execFileSync).mockReturnValue(
      JSON.stringify({ success: false, error: '搜索无结果' }),
    );
    const result = searchDouyinVideos('不存在的内容');
    expect(result.success).toBe(false);
    expect(result.error).toBe('搜索无结果');
  });

  it('handles exception gracefully', () => {
    vi.mocked(child_process.execFileSync).mockImplementation(() => {
      throw new Error('spawn uv ENOENT');
    });
    const result = searchDouyinVideos('test');
    expect(result.success).toBe(false);
    expect(result.error).toContain('spawn uv ENOENT');
  });
});
