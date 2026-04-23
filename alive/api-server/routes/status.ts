import { Router, Request, Response } from 'express';
import { loadSkillEnvVars } from '../../scripts/utils/file-utils';
import { loadQueue } from '../../scripts/ops/review-queue';
import { loadPersona } from '../../scripts/persona/persona-loader';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    loadSkillEnvVars('alive');
    const [queue, persona] = await Promise.all([
      loadQueue(),
      Promise.resolve(loadPersona()),
    ]);
    const items = queue.items;
    res.json({
      persona_name: persona.meta?.name ?? 'unknown',
      persona_id: persona.meta?.id ?? 'unknown',
      queue: {
        total: items.length,
        pending: items.filter(i => i.status === 'pending').length,
        approved: items.filter(i => i.status === 'approved').length,
        published: items.filter(i => i.status === 'published').length,
        discarded: items.filter(i => i.status === 'discarded').length,
        expired: items.filter(i => i.status === 'expired').length,
      },
      ok: true,
    });
  } catch (err) {
    res.status(500).json({ error: String(err), ok: false });
  }
});

export default router;
