import { Router, Request, Response } from 'express';
import { loadSkillEnvVars } from '../../scripts/utils/file-utils';
import { loadPersona } from '../../scripts/persona/persona-loader';
import { readCachedTrendsWithMeta, buildPersonaIdentities } from '../../scripts/ops/trend-analyzer';

loadSkillEnvVars('alive');

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  try {
    const persona = loadPersona();
    const identities = buildPersonaIdentities(persona);
    const meta = readCachedTrendsWithMeta(identities);
    res.json(meta);
  } catch (err) {
    console.error('[trends GET /]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
