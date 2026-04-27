import { Router, Request, Response } from 'express';
import { loadSkillEnvVars } from '../../scripts/utils/file-utils';
import { spawnCli } from '../lib/cli-runner';
import { cachedCliRun } from '../lib/llm-cache';

loadSkillEnvVars('alive');

const router = Router();

const BRIEF_TTL_MS = 30 * 60 * 1000; // 30 minutes

router.get('/', async (req: Request, res: Response) => {
  try {
    const result = await cachedCliRun({
      key: 'brief',
      ttlMs: BRIEF_TTL_MS,
      forceRefresh: req.query.refresh === '1',
      staleWhileRevalidate: true,
      run: () => spawnCli('brief'),
    });
    res.json(result);
  } catch (err) {
    console.error('[brief GET /]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
