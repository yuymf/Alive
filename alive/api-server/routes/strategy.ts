import { Router, Request, Response } from 'express';
import { loadSkillEnvVars } from '../../scripts/utils/file-utils';
import { loadStrategy, confirmStrategy, computeStrategy } from '../../scripts/ops/strategy-engine';
import { loadPersona } from '../../scripts/persona/persona-loader';
import { createRealLLMClient } from '../../scripts/utils/llm-client';

loadSkillEnvVars('alive');

const router = Router();

// GET /strategy — read current cached strategy
router.get('/', (_req: Request, res: Response) => {
  try {
    const strategy = loadStrategy();
    res.json({ strategy });
  } catch (err) {
    console.error('[strategy GET /]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /strategy/compute — trigger LLM recompute (1-2 min, in-process)
// Mirrors alive/scripts/lifecycle/ops-strategy.ts invocation pattern.
router.post('/compute', async (_req: Request, res: Response) => {
  try {
    const persona = await loadPersona();
    if (!persona.ops?.enabled) {
      res.status(400).json({ error: 'persona.ops.enabled is false — strategy computation disabled' });
      return;
    }

    const llm = createRealLLMClient('api-strategy-compute');
    const personaSummary = `${persona.meta.name}：${persona.personality?.mbti ?? ''}，${persona.meta.tagline ?? ''}`;

    // Build target mix from ops.content_templates identity_modes
    const targetMix: Record<string, number> = {};
    const templates = persona.ops?.content_templates;
    if (templates && templates.length > 0) {
      const allModes = templates.map(t => t.identity_mode).filter(Boolean) as string[];
      const uniqueModes = [...new Set(allModes)];
      if (uniqueModes.length > 0) {
        const weight = Math.round(100 / uniqueModes.length);
        for (const mode of uniqueModes) {
          targetMix[mode] = weight;
        }
      }
    }

    const success = await computeStrategy(llm, personaSummary, targetMix);
    const strategy = loadStrategy();
    res.json({ ok: success, strategy });
  } catch (err) {
    console.error('[strategy POST /compute]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /strategy/confirm — mark current pending strategy as confirmed
router.post('/confirm', (_req: Request, res: Response) => {
  try {
    const ok = confirmStrategy();
    if (!ok) {
      res.status(404).json({ error: 'No pending strategy to confirm' });
      return;
    }
    const strategy = loadStrategy();
    res.json({ strategy });
  } catch (err) {
    console.error('[strategy POST /confirm]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
