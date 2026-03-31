import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setBasePaths, resetBasePaths } from '../../scripts/utils/file-utils';
import { setTimeOverride } from '../../scripts/utils/time-utils';
import { buildContentPrompt, selectIdentityMode } from '../../scripts/ops/topic-generator';
import { FilteredTrend } from '../../scripts/ops/trend-analyzer';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const tmpDir = path.join(os.tmpdir(), 'alive-topic-test-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
  setTimeOverride(new Date('2026-03-30T09:00:00Z'));
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('selectIdentityMode', () => {
  it('returns the identity_mode from filtered trend', () => {
    const trend: FilteredTrend = {
      platform: 'douyin', keyword: '#电竞女孩', current_volume: 500,
      avg_7d: 100, velocity_score: 5.0, rank: 1,
      hook_angle: '从赛车手视角切入', identity_mode: 'racer',
    };
    expect(selectIdentityMode(trend)).toBe('racer');
  });
});

describe('buildContentPrompt', () => {
  it('includes trend keyword and hook angle', () => {
    const trend: FilteredTrend = {
      platform: 'douyin', keyword: '#电竞女孩', current_volume: 500,
      avg_7d: 100, velocity_score: 5.0, rank: 1,
      hook_angle: '用赛车手视角反向解读电竞', identity_mode: 'esports',
    };
    const prompt = buildContentPrompt(trend, 'V姐，21岁电竞解说', 'xhs', '图文为主，克制有力');
    expect(prompt).toContain('#电竞女孩');
    expect(prompt).toContain('用赛车手视角反向解读电竞');
    expect(prompt).toContain('xhs');
  });

  it('appends extraContext when provided', () => {
    const trend: FilteredTrend = {
      platform: 'douyin', keyword: '#赛车', current_volume: 300,
      avg_7d: 100, velocity_score: 3.0, rank: 2,
      hook_angle: '速度与激情', identity_mode: 'racer',
    };
    const prompt = buildContentPrompt(trend, 'V姐', 'douyin', '视频脚本', '参考钩子公式：公式A / 公式B');
    expect(prompt).toContain('参考钩子公式：公式A / 公式B');
  });

  it('returns base prompt only when extraContext is undefined', () => {
    const trend: FilteredTrend = {
      platform: 'xhs', keyword: '#日常', current_volume: 200,
      avg_7d: 100, velocity_score: 2.0, rank: 3,
      hook_angle: '真实日常切入', identity_mode: 'daily',
    };
    const withExtra = buildContentPrompt(trend, 'V姐', 'xhs', '图文', '额外信息');
    const withoutExtra = buildContentPrompt(trend, 'V姐', 'xhs', '图文');
    expect(withExtra).toBe(`${withoutExtra}\n额外信息`);
  });
});
