import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setBasePaths, resetBasePaths } from '../scripts/utils/file-utils';
import type { CompetitorAnalysisStore, TopicClusterAnalysis } from '../scripts/utils/types';

let sandboxDir: string;

beforeEach(() => {
  sandboxDir = fs.mkdtempSync(path.join('/tmp', 'topic-gen-test-'));
  setBasePaths(sandboxDir, sandboxDir);
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(sandboxDir, { recursive: true, force: true });
});

const { buildClusterContext } = await import('../scripts/ops/topic-generator');

function makeCluster(overrides: Partial<TopicClusterAnalysis> = {}): TopicClusterAnalysis {
  return {
    cluster_name: '电竞解说',
    post_count: 8,
    avg_engagement: 2340,
    representative_titles: ['LCK BP复盘', 'Bo5绝杀时刻'],
    ...overrides,
  };
}

function makeStore(accountKey: string, clusters: TopicClusterAnalysis[], autoCluster = true): CompetitorAnalysisStore {
  return {
    version: 1,
    last_analyzed: new Date().toISOString(),
    insufficient_data: [],
    analyses: {
      [accountKey]: {
        account_name: accountKey.split(':')[0],
        platform: accountKey.split(':')[1] ?? 'xhs',
        analyzed_at: new Date().toISOString(),
        post_count: clusters.reduce((s, c) => s + c.post_count, 0),
        hook_patterns: [],
        cover_formulas: [],
        topic_clusters: clusters,
        engagement_pattern: {
          best_performing_type: '电竞', avg_engagement: 500,
          posting_frequency: '每日1条', peak_days: [],
        },
        key_insight: '洞察',
        auto_cluster: autoCluster,
      },
    },
  };
}

describe('buildClusterContext', () => {
  it('有 auto_cluster 聚类时返回格式化文字块', () => {
    const store = makeStore('@v姐:xhs', [makeCluster()]);
    const result = buildClusterContext('@v姐:xhs', store);
    expect(result).toContain('电竞解说');
    expect(result).toContain('8条');
    expect(result).toContain('2340');
    expect(result).toContain('LCK BP复盘');
  });

  it('auto_cluster=false 时返回空字符串（fallback）', () => {
    const store = makeStore('@v姐:xhs', [makeCluster()], false);
    const result = buildClusterContext('@v姐:xhs', store);
    expect(result).toBe('');
  });

  it('accountKey 不存在时返回空字符串', () => {
    const store = makeStore('@v姐:xhs', [makeCluster()]);
    const result = buildClusterContext('不存在:xhs', store);
    expect(result).toBe('');
  });

  it('topic_clusters 为空数组时返回空字符串', () => {
    const store = makeStore('@v姐:xhs', []);
    const result = buildClusterContext('@v姐:xhs', store);
    expect(result).toBe('');
  });
});
