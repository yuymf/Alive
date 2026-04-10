import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setBasePaths, resetBasePaths } from '../scripts/utils/file-utils';
import type { CompetitorAnalysisStore, TopicClusterAnalysis, ViralEntry } from '../scripts/utils/types';

let sandboxDir: string;

beforeEach(() => {
  sandboxDir = fs.mkdtempSync(path.join('/tmp', 'topic-gen-test-'));
  setBasePaths(sandboxDir, sandboxDir);
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(sandboxDir, { recursive: true, force: true });
});

const {
  buildClusterContext,
  buildContentPrompt,
  buildRegeneratePrompt,
  buildViralContext,
} = await import('../scripts/ops/topic-generator');

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

// ─── Feature 1: Title length constraint tests ──────────────────────────────

describe('标题字数约束 11-20字', () => {
  const dummyTrend = {
    keyword: '测试热点',
    platform: 'xhs',
    velocity_score: 3.5,
    hook_angle: '切入角度',
    identity_mode: 'daily' as const,
    relevance_score: 8,
    source: 'trending_feed' as const,
  };

  it('XHS prompt 包含 11-20字 而非旧值', () => {
    const prompt = buildContentPrompt(dummyTrend, '测试人设', 'xhs', '图文为主');
    expect(prompt).toContain('11-20字');
    expect(prompt).not.toContain('20字以内');
  });

  it('Douyin prompt 包含 11-20字 而非旧值', () => {
    const prompt = buildContentPrompt(dummyTrend, '测试人设', 'douyin', '视频脚本');
    expect(prompt).toContain('11-20字');
    expect(prompt).not.toContain('15字以内');
  });
});

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

// ─── Feature 2: buildViralContext with audience_response ──────────────────────

describe('buildViralContext with audience_response', () => {
  function makeViralEntry(overrides: Partial<ViralEntry> = {}): ViralEntry {
    return {
      id: 'v-001',
      platform: 'xhs',
      source_id: 'src-001',
      source_type: 'competitor',
      persona_id: 'test',
      title: 'Test viral',
      description: 'Desc',
      likes: 10000,
      comments: 500,
      shares: 300,
      collected_at: new Date().toISOString(),
      dissection: {
        hook_type: '数字冲击',
        content_type: '种草类',
        identity_mode: 'esports',
        emotion_arc: '焦虑→解脱',
        interaction_design: '评论区问答',
        visual_style: '简约',
        cta_type: '关注',
        summary: '数字引发共鸣',
      },
      dissection_status: 'done',
      kb_tier: 'track',
      promoted_to_template: false,
      times_referenced: 0,
      ...overrides,
    };
  }

  it('有 desire_signals 时输出「受众渴望」行', () => {
    const entry = makeViralEntry({
      dissection: {
        hook_type: '反问式',
        content_type: '种草类',
        identity_mode: 'esports',
        emotion_arc: '好奇→满足',
        interaction_design: '讨论',
        visual_style: '清新',
        cta_type: '收藏',
        summary: '种草引讨论',
        audience_response: {
          top_keywords: ['好用'],
          emotional_triggers: ['心动'],
          desire_signals: ['求教程', '想要同款'],
        },
      },
    });
    const result = buildViralContext([entry], 'xhs');
    expect(result).toContain('受众渴望');
    expect(result).toContain('求教程');
    expect(result).toContain('想要同款');
  });

  it('无 audience_response 时不输出「受众渴望」行', () => {
    const entry = makeViralEntry(); // no audience_response
    const result = buildViralContext([entry], 'xhs');
    expect(result).not.toContain('受众渴望');
  });
});
