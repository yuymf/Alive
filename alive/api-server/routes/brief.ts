import { Router, Request, Response } from 'express';
import { loadSkillEnvVars } from '../../scripts/utils/file-utils';
import { spawnCli } from '../lib/cli-runner';

loadSkillEnvVars('alive');

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    const output = await spawnCli('brief');
    res.json({ output });
  } catch (err) {
    console.error('[brief GET /]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
