import { Router, Request, Response } from 'express';
import { loadSkillEnvVars, PATHS, readJSON } from '../../scripts/utils/file-utils';
import {
  loadPerformanceLog,
  getEntriesForPeriod,
  aggregateByIdentity,
  aggregateByTemplate,
} from '../../scripts/ops/performance-tracker';
import { loadAnalysisLog } from '../../scripts/ops/post-analyzer';
import { loadContentTaste } from '../../scripts/ops/taste-engine';
import { loadAudiencePerception } from '../../scripts/ops/audience-perception';

loadSkillEnvVars('alive');

const router = Router();

// GET /analytics/performance?days=30 — published post metrics + optional aggregations
router.get('/performance', (req: Request, res: Response) => {
  try {
    const daysParam = req.query.days;
    const days = typeof daysParam === 'string' && !isNaN(Number(daysParam))
      ? Math.min(Math.max(Number(daysParam), 1), 365)
      : null;

    if (days !== null) {
      const entries = getEntriesForPeriod(days);
      const byIdentity = aggregateByIdentity(entries);
      const byTemplate = aggregateByTemplate(entries);
      res.json({ entries, by_identity: byIdentity, by_template: byTemplate, period_days: days });
    } else {
      // Full log if no period specified
      const log = loadPerformanceLog();
      const byIdentity = aggregateByIdentity(log.entries);
      const byTemplate = aggregateByTemplate(log.entries);
      res.json({
        entries: log.entries,
        by_identity: byIdentity,
        by_template: byTemplate,
        last_updated: log.last_updated,
      });
    }
  } catch (err) {
    console.error('[analytics GET /performance]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /analytics/analysis-log — post-publish LLM analysis records
router.get('/analysis-log', (_req: Request, res: Response) => {
  try {
    const log = loadAnalysisLog();
    res.json(log);
  } catch (err) {
    console.error('[analytics GET /analysis-log]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /analytics/taste — 7-dimension content taste preferences
router.get('/taste', (_req: Request, res: Response) => {
  try {
    const taste = loadContentTaste();
    res.json(taste);
  } catch (err) {
    console.error('[analytics GET /taste]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /analytics/perception — audience perception entries
router.get('/perception', (_req: Request, res: Response) => {
  try {
    const store = loadAudiencePerception();
    res.json(store);
  } catch (err) {
    console.error('[analytics GET /perception]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /analytics/tags — tag vocabulary (active / dormant)
router.get('/tags', (_req: Request, res: Response) => {
  try {
    const vocab = readJSON<{ version?: number; last_updated?: string; active: unknown[]; dormant: unknown[] }>(
      PATHS.tagVocabulary,
      { version: 1, last_updated: '', active: [], dormant: [] },
    );
    res.json(vocab);
  } catch (err) {
    console.error('[analytics GET /tags]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
