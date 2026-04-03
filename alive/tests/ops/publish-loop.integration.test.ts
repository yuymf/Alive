/**
 * publish-loop.integration.test.ts
 * End-to-end integration test: published queue item → performance snapshot → post analysis → pattern extraction.
 * Uses sandbox paths and mock LLM — no real API calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setBasePaths, resetBasePaths, PATHS, readJSON } from '../../scripts/utils/file-utils';
import { setTimeOverride, clearTimeOverride } from '../../scripts/utils/time-utils';
import { addItem, markPublished, getPublishedItemsWithUrls } from '../../scripts/ops/review-queue';
import { appendSnapshot, loadPerformanceLog } from '../../scripts/ops/performance-tracker';
import { analyzePublishedPosts, findPendingAnalysis, loadAnalysisLog } from '../../scripts/ops/post-analyzer';
import { createMockLLMClient } from '../../scripts/utils/llm-client';
import type { PerformanceLog, AnalysisLog, ContentPatterns } from '../../scripts/utils/types';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const tmpDir = path.join(os.tmpdir(), 'alive-publish-loop-' + Date.now());

const seedContent = {
  xhs: { title: '电竞女孩赛场氛围感', body: '有人说女生不懂电竞。排位赛不说谎。', tags: ['#电竞', '#女性视角'], cover_images: [] as string[] },
  douyin: { script: '开场3秒高燃镜头', bgm_suggestion: '高燃BGM', key_captions: ['BP阶段'], cover_images: [] as string[] },
};

// Mock LLM returns a structured analysis response
const mockAnalysisResponse = JSON.stringify({
  engagement_score: 85,
  performance_tier: 'above_avg',
  pattern_analysis: {
    hook_effectiveness: 8,
    emotional_resonance: 7,
    trending_alignment: 9,
    visual_impact: 7,
    call_to_action: 6,
    key_success_factors: ['赛事热点借势', '女性视角差异化', '专业数据支撑'],
    improvement_areas: ['CTA可以更明确', '封面可以更抓眼球'],
  },
  extracted_patterns: [
    {
      pattern_type: 'hook',
      description: '反刻板印象开场',
      applicable_templates: ['赛场氛围感', '赛场高燃瞬间'],
      confidence: 0.85,
    },
  ],
  persona_alignment: {
    score: 8,
    identity_mode_match: true,
    tone_consistency: 'on_brand',
    specific_notes: '专业+飒爽的调性保持一致',
  },
});

const mockLLM = createMockLLMClient({
  default: mockAnalysisResponse,
});

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
  // Set time to April 1 for seeding, then advance for analysis
  setTimeOverride(new Date('2026-04-01T08:00:00Z'));
});

afterEach(() => {
  clearTimeOverride();
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Publish → Performance → Analysis loop', () => {
  it('flows from published queue item to performance snapshot to post analysis with pattern extraction', async () => {
    // === Phase 1: Seed a published queue item ===
    const item = await addItem({
      topic: '蹭 电竞S16：女性视角赛场氛围感',
      trend_hook: '电竞S16 (douyin, 2.1x)',
      identity_mode: 'esports',
      content: seedContent,
    });

    const published = await markPublished(item.id, {
      platform: 'xhs',
      url: 'https://www.xiaohongshu.com/explore/abc123',
      publishedAt: '2026-04-01T08:00:00Z',
    });
    expect(published?.status).toBe('published');
    expect(published?.published_urls?.xhs).toBeTruthy();

    // Verify getPublishedItemsWithUrls picks it up
    const publishedItems = await getPublishedItemsWithUrls();
    expect(publishedItems).toHaveLength(1);

    // === Phase 2: Simulate performance collection (what ops-performance cron does) ===
    const fakeMetrics = {
      likes: 350,
      comments: 45,
      saves: 120,
      shares: 30,
    };

    appendSnapshot(
      {
        item_id: item.id,
        identity_mode: 'esports',
        template_type: '赛场氛围感',
        topic: item.topic,
        platform: 'xhs',
        url: 'https://www.xiaohongshu.com/explore/abc123',
        published_at: '2026-04-01T08:00:00Z',
        tags_used: ['#电竞', '#女性视角'],
      },
      fakeMetrics,
    );

    const perfLog = loadPerformanceLog();
    expect(perfLog.entries).toHaveLength(1);
    expect(perfLog.entries[0].peak_metrics.likes).toBe(350);

    // === Phase 3: Advance time to T+25h so analysis delay (24h) is satisfied ===
    setTimeOverride(new Date('2026-04-02T09:00:00Z'));

    const analysisLogBefore = loadAnalysisLog();
    const pending = findPendingAnalysis(perfLog, analysisLogBefore, 24);
    expect(pending).toHaveLength(1);

    // === Phase 4: Run post analysis ===
    const analyzedCount = await analyzePublishedPosts(mockLLM, 'V姐 — 电竞解说+歌手+赛车手', 24, 7);
    expect(analyzedCount).toBe(1);

    // Verify analysis was saved
    const analysisLogAfter = loadAnalysisLog();
    expect(analysisLogAfter.entries).toHaveLength(1);
    expect(analysisLogAfter.entries[0].item_id).toBe(item.id);
    expect(analysisLogAfter.entries[0].performance_tier).toBe('above_avg');

    // Verify patterns were extracted
    const patterns = readJSON<ContentPatterns>(PATHS.contentPatterns, { updated_at: '', patterns: [], competitor_insights: [], cover_trends: [] });
    expect(patterns.patterns.length).toBeGreaterThan(0);
    expect(patterns.patterns[0].type).toBe('hook');
    expect(patterns.patterns[0].source).toBe('self');
  });

  it('does not re-analyze already analyzed items', async () => {
    // Seed + publish + snapshot
    const item = await addItem({
      topic: 're-analysis guard',
      trend_hook: 'hook',
      identity_mode: 'daily',
      content: seedContent,
    });
    await markPublished(item.id, {
      platform: 'xhs',
      url: 'https://www.xiaohongshu.com/explore/def',
      publishedAt: '2026-04-01T08:00:00Z',
    });
    appendSnapshot(
      {
        item_id: item.id,
        identity_mode: 'daily',
        template_type: 'unknown',
        topic: item.topic,
        platform: 'xhs',
        url: 'https://www.xiaohongshu.com/explore/def',
        published_at: '2026-04-01T08:00:00Z',
        tags_used: [],
      },
      { likes: 100, comments: 10 },
    );

    setTimeOverride(new Date('2026-04-02T09:00:00Z'));

    // First analysis
    const count1 = await analyzePublishedPosts(mockLLM, 'summary', 24, 7);
    expect(count1).toBe(1);

    // Second analysis should skip (already analyzed)
    const count2 = await analyzePublishedPosts(mockLLM, 'summary', 24, 7);
    expect(count2).toBe(0);

    // Analysis log should still only have 1 entry
    const log = loadAnalysisLog();
    expect(log.entries).toHaveLength(1);
  });

  it('respects delay — does not analyze items published less than delayHours ago', async () => {
    const item = await addItem({
      topic: 'too fresh',
      trend_hook: 'h',
      identity_mode: 'daily',
      content: seedContent,
    });
    await markPublished(item.id, {
      platform: 'xhs',
      url: 'https://www.xiaohongshu.com/explore/fresh',
      publishedAt: '2026-04-01T08:00:00Z',
    });
    appendSnapshot(
      {
        item_id: item.id,
        identity_mode: 'daily',
        template_type: 'unknown',
        topic: item.topic,
        platform: 'xhs',
        url: 'https://www.xiaohongshu.com/explore/fresh',
        published_at: '2026-04-01T08:00:00Z',
        tags_used: [],
      },
      { likes: 50, comments: 5 },
    );

    // Only 12 hours later — should not trigger analysis with 24h delay
    setTimeOverride(new Date('2026-04-01T20:00:00Z'));
    const count = await analyzePublishedPosts(mockLLM, 'summary', 24, 7);
    expect(count).toBe(0);
  });
});
