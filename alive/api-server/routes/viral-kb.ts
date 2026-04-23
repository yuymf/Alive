import { Router, Request, Response } from 'express';
import { loadSkillEnvVars, PATHS } from '../../scripts/utils/file-utils';
import { queryAll, loadFormulas, getStats, auditEntries, requeueEntriesForRepair } from '../../scripts/ops/viral-kb-store';
import * as path from 'path';

loadSkillEnvVars('alive');

const router = Router();

function getKbBasePath(): string {
  // PATHS.stateDir = {memoryBase}/state
  // kbDir(basePath) = {memoryBase}/state/viral-kb
  return path.dirname(PATHS.emotionState); // equivalent to PATHS.stateDir
}

// GET /viral-kb?sort=likes&limit=100&hook_type=...&identity_mode=...
router.get('/', (_req: Request, res: Response) => {
  try {
    const { sort, limit, hook_type, identity_mode } = _req.query as Record<string, string | undefined>;
    const basePath = getKbBasePath();
    const entries = queryAll(basePath, {
      sort: (sort === 'date' ? 'date' : 'likes') as 'likes' | 'date',
      limit: limit ? (isNaN(Number(limit)) ? 200 : Math.min(Number(limit), 500)) : 200,
    }).filter(e => {
      if (hook_type && e.dissection.hook_type !== hook_type) return false;
      if (identity_mode && e.dissection.identity_mode !== identity_mode) return false;
      return true;
    });
    const stats = getStats(basePath);
    res.json({ entries, stats });
  } catch (err) {
    console.error('[viral-kb GET /]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /viral-kb/formulas
router.get('/formulas', (_req: Request, res: Response) => {
  try {
    const formulas = loadFormulas(getKbBasePath());
    res.json({ formulas });
  } catch (err) {
    console.error('[viral-kb GET /formulas]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /viral-kb/stats — KB statistics (aggregates)
router.get('/stats', (_req: Request, res: Response) => {
  try {
    const stats = getStats(getKbBasePath());
    res.json(stats);
  } catch (err) {
    console.error('[viral-kb GET /stats]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /viral-kb/audit — KB audit report (READ-ONLY, no side effects)
router.get('/audit', (_req: Request, res: Response) => {
  try {
    const report = auditEntries(getKbBasePath());
    res.json(report);
  } catch (err) {
    console.error('[viral-kb GET /audit]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /viral-kb/repair — requeue hollow entries for re-dissection
router.post('/repair', (req: Request, res: Response) => {
  try {
    const limitRaw = req.body?.limit;
    const limit = typeof limitRaw === 'number' && limitRaw > 0 ? Math.min(limitRaw, 100) : undefined;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'dashboard-triggered repair';
    const result = requeueEntriesForRepair(getKbBasePath(), { limit, reason });
    res.json(result);
  } catch (err) {
    console.error('[viral-kb POST /repair]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
