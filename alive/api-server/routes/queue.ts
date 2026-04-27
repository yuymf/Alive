import { Router, Request, Response } from 'express';
import { loadSkillEnvVars, PATHS, readJSON, writeJSON } from '../../scripts/utils/file-utils';
import {
  loadQueue,
  getItem,
  markApproved,
  markDiscarded,
  markPublished,
  markPerformanceTracked,
  addReviewFeedback,
  updateItemContent,
} from '../../scripts/ops/review-queue';
import { refreshMetricsForQueueItem, appendSnapshot } from '../../scripts/ops/performance-tracker';
import type { QueueItemContent, AnalysisLog, ContentAnalysis } from '../../scripts/utils/types';
import { spawnCli } from '../lib/cli-runner';
import { cachedCliRun } from '../lib/llm-cache';

// Load env vars once at module init
loadSkillEnvVars('alive');

const router = Router();

// GET /queue — full queue
router.get('/', async (_req: Request, res: Response) => {
  try {
    const queue = await loadQueue();
    res.json(queue);
  } catch (err) {
    console.error('[queue GET /]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /queue/idea — generate new topics via CLI
// Cached briefly so a user double-clicking "生成新选题" doesn't fire two
// 2-minute LLM runs. `?refresh=1` or `{ refresh: true }` forces a re-run.
router.post('/idea', async (req: Request, res: Response) => {
  try {
    const direction: string | undefined = typeof req.body?.direction === 'string' ? req.body.direction : undefined;
    const args = direction ? [direction] : [];
    const cacheKey = direction ? `idea:${direction.slice(0, 48)}` : 'idea:default';
    const result = await cachedCliRun({
      key: cacheKey,
      ttlMs: 15 * 60 * 1000, // 15 minutes — idea is semi-fresh
      forceRefresh: req.query.refresh === '1' || req.body?.refresh === true,
      staleWhileRevalidate: false,
      run: () => spawnCli('idea', args),
    });
    res.json(result);
  } catch (err) {
    console.error('[queue POST /idea]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /queue/review — batch review via CLI
router.post('/review', async (req: Request, res: Response) => {
  try {
    const sub = req.body?.sub;
    const validSubs = ['approve-all', 'discard-low'];
    const args = typeof sub === 'string' && validSubs.includes(sub) ? [sub] : [];
    const output = await spawnCli('review', args);
    res.json({ output });
  } catch (err) {
    console.error('[queue POST /review]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /queue/:id/approve
router.post('/:id/approve', async (req: Request, res: Response) => {
  try {
    const item = await markApproved(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Item not found or invalid status transition' });
      return;
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '运营确认';
    await addReviewFeedback(req.params.id, {
      decision: 'approved',
      source: 'dashboard',
      reason_summary: reason,
    });
    res.json(item);
  } catch (err) {
    console.error('[queue POST /:id/approve]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /queue/:id/discard
router.post('/:id/discard', async (req: Request, res: Response) => {
  try {
    const item = await markDiscarded(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Item not found or invalid status transition' });
      return;
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '运营否决';
    await addReviewFeedback(req.params.id, {
      decision: 'discarded',
      source: 'dashboard',
      reason_summary: reason,
    });
    res.json(item);
  } catch (err) {
    console.error('[queue POST /:id/discard]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /queue/:id — update topic/content fields
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { content, instruction, field } = req.body as {
      content: Partial<QueueItemContent>;
      instruction: string;
      field: string;
    };
    if (!content || typeof instruction !== 'string' || typeof field !== 'string') {
      res.status(400).json({ error: 'content, instruction and field are required' });
      return;
    }
    const item = await updateItemContent(req.params.id, content, { instruction, field });
    if (!item) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    res.json(item);
  } catch (err) {
    console.error('[queue PUT /:id]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /queue/:id/publish — mark as published with platform+url
router.post('/:id/publish', async (req: Request, res: Response) => {
  try {
    const platform = req.body?.platform;
    const url = req.body?.url;
    const publishedAt = typeof req.body?.publishedAt === 'string' ? req.body.publishedAt : undefined;

    if (platform !== 'xhs' && platform !== 'douyin') {
      res.status(400).json({ error: 'platform must be "xhs" or "douyin"' });
      return;
    }
    if (typeof url !== 'string' || !url.startsWith('http')) {
      res.status(400).json({ error: 'url must be a valid http(s) URL' });
      return;
    }

    const item = await markPublished(req.params.id, { platform, url, publishedAt });
    if (!item) {
      res.status(404).json({ error: 'Item not found or not in a publishable state' });
      return;
    }
    res.json(item);
  } catch (err) {
    console.error('[queue POST /:id/publish]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /queue/:id/refresh-metrics — fetch live metrics and append snapshot
router.post('/:id/refresh-metrics', async (req: Request, res: Response) => {
  try {
    const result = await refreshMetricsForQueueItem(req.params.id);
    if (!result.ok && result.refreshed.length === 0) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (err) {
    console.error('[queue POST /:id/refresh-metrics]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Dev-only: mock-publish ─────────────────────────────────────────────────
//
// POST /queue/:id/mock-publish
//
// Simulates the full publish+metrics+analysis pipeline for a queue item so
// operators can exercise the downstream health-check / strategy / analytics
// chain without real XHS/Douyin URLs.
//
// Gated: only available when DEV_MODE=1 or NODE_ENV !== 'production'.
// Creates:
//   1. published_urls with mock:// scheme
//   2. A synthetic performance-tracker snapshot (likes/comments/saves/views)
//   3. A synthetic content-analysis entry (engagement_score + pattern_analysis)
//   4. Marks performance_tracked = true
//
// This flips hasAnyPublished → true, which in turn converts the three
// "pending-publish" health items into real ok/warn/missing states.

const MOCK_PUBLISH_ENABLED =
  process.env.DEV_MODE === '1' || process.env.NODE_ENV !== 'production';

router.post('/:id/mock-publish', async (req: Request, res: Response) => {
  if (!MOCK_PUBLISH_ENABLED) {
    res.status(403).json({ error: 'mock-publish is disabled in production' });
    return;
  }

  try {
    const item = await getItem(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    if (item.status === 'discarded' || item.status === 'expired') {
      res.status(400).json({ error: `Cannot mock-publish an item with status "${item.status}"` });
      return;
    }

    const platforms: ('xhs' | 'douyin')[] =
      Array.isArray(req.body?.platforms) ? req.body.platforms : ['xhs'];
    const ts = new Date().toISOString();

    // 1. Mark published with mock URLs
    let published = item;
    for (const platform of platforms) {
      const mockUrl = `https://mock.dev.alive/${platform}/${item.id}`;
      const result = await markPublished(item.id, { platform, url: mockUrl, publishedAt: ts });
      if (result) published = result;
    }

    // 2. Seed synthetic performance snapshot per platform
    const templateType = item.template_spec?.content_type ?? 'unknown';
    for (const platform of platforms) {
      const mockUrl = `https://mock.dev.alive/${platform}/${item.id}`;
      const tagsUsed: string[] = platform === 'xhs'
        ? (item.content?.xhs?.tags ?? [])
        : (item.content?.douyin?.key_captions ?? []);

      const syntheticMetrics = {
        views: randomBetween(800, 5000),
        likes: randomBetween(50, 500),
        comments: randomBetween(10, 80),
        saves: randomBetween(20, 200),
        shares: randomBetween(5, 40),
      };

      appendSnapshot({
        item_id: item.id,
        identity_mode: item.identity_mode,
        template_type: templateType,
        topic: item.topic,
        platform,
        url: mockUrl,
        published_at: ts,
        tags_used: tagsUsed,
      }, syntheticMetrics);
    }

    // 3. Seed synthetic content-analysis entry
    const analysisLog = readJSON<AnalysisLog>(PATHS.analysisLog, { entries: [], last_updated: '' });
    const syntheticAnalysis: ContentAnalysis = {
      item_id: item.id,
      analyzed_at: ts,
      performance_tier: 'normal',
      engagement_score: randomBetween(40, 75),
      platform: platforms[0],
      identity_mode: item.identity_mode,
      template_type: templateType,
      hook_angle: item.trend_hook ?? undefined,
      topic_tags: item.content?.xhs?.tags?.slice(0, 3),
      pattern_analysis: {
        hook_effectiveness: randomBetween(5, 8),
        emotional_resonance: randomBetween(5, 8),
        trending_alignment: randomBetween(4, 7),
        visual_impact: randomBetween(5, 8),
        call_to_action: randomBetween(4, 7),
        key_success_factors: ['合成数据 — 仅供开发测试'],
        improvement_areas: ['无 — 合成数据'],
      },
      extracted_patterns: [],
      persona_alignment: {
        score: randomBetween(6, 9),
        identity_mode_match: true,
        tone_consistency: 'on_brand',
        specific_notes: '合成数据 — mock-publish 生成',
      },
    };
    const updatedAnalysis: AnalysisLog = {
      entries: [...analysisLog.entries, syntheticAnalysis],
      last_updated: ts,
    };
    writeJSON(PATHS.analysisLog, updatedAnalysis);

    // 4. Mark performance-tracked
    await markPerformanceTracked(item.id);

    res.json({
      ok: true,
      mock: true,
      item_id: item.id,
      platforms,
      message: `模拟发布成功 — ${platforms.join('+')} · 已注入合成表现+分析数据`,
    });
  } catch (err) {
    console.error('[queue POST /:id/mock-publish]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Pseudo-random integer in [min, max]. */
function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export default router;
