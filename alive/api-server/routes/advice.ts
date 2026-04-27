import { Router, Request, Response } from 'express';
import { loadSkillEnvVars } from '../../scripts/utils/file-utils';
import { spawnCli } from '../lib/cli-runner';
import { cachedCliRun } from '../lib/llm-cache';

loadSkillEnvVars('alive');

const router = Router();

const ADVICE_TTL_MS = 60 * 60 * 1000; // 1 hour

router.get('/', async (req: Request, res: Response) => {
  try {
    const result = await cachedCliRun({
      key: 'advice',
      ttlMs: ADVICE_TTL_MS,
      forceRefresh: req.query.refresh === '1',
      staleWhileRevalidate: true,
      run: () => spawnCli('advice'),
    });
    res.json(result);
  } catch (err) {
    console.error('[advice GET /]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
