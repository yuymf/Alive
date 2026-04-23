import { Router, Request, Response } from 'express';
import { loadSkillEnvVars, PATHS } from '../../scripts/utils/file-utils';
import { queryAll, loadFormulas, getStats } from '../../scripts/ops/viral-kb-store';
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

export default router;
