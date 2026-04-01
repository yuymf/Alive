import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setBasePaths, resetBasePaths } from '../../scripts/utils/file-utils';
import { setTimeOverride } from '../../scripts/utils/time-utils';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const tmpDir = path.join(os.tmpdir(), 'alive-post-analyzer-test-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
  setTimeOverride(new Date('2026-04-02T12:00:00Z'));
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('computeEngagementScore', () => {
  it('should compute XHS engagement score with correct weights', async () => {
    const { computeEngagementScore } = await import('../../scripts/ops/post-analyzer');
    const score = computeEngagementScore(
      { likes: 100, comments: 50, saves: 30, views: 10000 },
      'xhs',
    );
    // XHS: likes*1.0 + comments*3.0 + saves*5.0 + shares*4.0
    // = 100 + 150 + 150 + 0 = 400
    expect(score).toBe(400);
  });

  it('should compute Douyin engagement score with views weight', async () => {
    const { computeEngagementScore } = await import('../../scripts/ops/post-analyzer');
    const score = computeEngagementScore(
      { likes: 100, comments: 50, saves: 30, views: 10000, shares: 20 },
      'douyin',
    );
    // Douyin: likes*1.0 + comments*2.0 + saves*3.0 + shares*5.0 + views*0.01
    // = 100 + 100 + 90 + 100 + 100 = 490
    expect(score).toBe(490);
  });
});

describe('classifyTier', () => {
  it('should classify as viral when score > baseline * 2.0', async () => {
    const { classifyTier } = await import('../../scripts/ops/post-analyzer');
    expect(classifyTier(210, 100)).toBe('viral');
  });

  it('should classify as above_avg when score > baseline * 1.3', async () => {
    const { classifyTier } = await import('../../scripts/ops/post-analyzer');
    expect(classifyTier(140, 100)).toBe('above_avg');
  });

  it('should classify as normal when score >= baseline * 0.7', async () => {
    const { classifyTier } = await import('../../scripts/ops/post-analyzer');
    expect(classifyTier(80, 100)).toBe('normal');
  });

  it('should classify as below_avg when score < baseline * 0.7', async () => {
    const { classifyTier } = await import('../../scripts/ops/post-analyzer');
    expect(classifyTier(60, 100)).toBe('below_avg');
  });

  it('should use flat baseline of 50 when no baseline data', async () => {
    const { classifyTier } = await import('../../scripts/ops/post-analyzer');
    expect(classifyTier(110, 0)).toBe('viral'); // 110 > 50 * 2.0
  });
});
