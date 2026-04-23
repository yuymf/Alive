import { Router, Request, Response } from 'express';
import { loadSkillEnvVars } from '../../scripts/utils/file-utils';
import { loadQueue } from '../../scripts/ops/review-queue';
import { loadPersona } from '../../scripts/persona/persona-loader';

// Load env vars once at module init (side-effects process.env)
loadSkillEnvVars('alive');

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    const queue = await loadQueue();
    const persona = loadPersona(); // sync
    const items = queue.items ?? [];

    // Count by status in one pass
    const counts: Record<string, number> = {
      total: items.length,
      pending: 0,
      approved: 0,
      published: 0,
      discarded: 0,
      expired: 0,
    };
    for (const item of items) {
      if (item.status in counts) counts[item.status]++;
    }

    res.json({
      persona_name: persona.meta?.name ?? 'unknown',
      persona_id: persona.meta?.id ?? 'unknown',
      queue: counts,
      ok: true,
    });
  } catch (err) {
    console.error('[status] Error:', err);
    res.status(500).json({ error: 'Internal server error', ok: false });
  }
});

export default router;
