import { Router, Request, Response } from 'express';
import { loadSkillEnvVars } from '../../scripts/utils/file-utils';
import { spawnCli } from '../lib/cli-runner';

loadSkillEnvVars('alive');

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  try {
    const url = req.body?.url;
    if (typeof url !== 'string' || !url.startsWith('http')) {
      res.status(400).json({ error: 'url must be a valid http(s) URL' });
      return;
    }
    const output = await spawnCli('analyze', [url]);
    res.json({ output });
  } catch (err) {
    console.error('[analyze POST /]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
