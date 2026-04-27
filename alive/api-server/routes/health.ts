import { Router, Request, Response } from 'express';
import { loadSkillEnvVars } from '../../scripts/utils/file-utils';
import { runHealthCheck, formatHealthReport } from '../../scripts/ops/health-check';
import { fetchCronStatus } from '../lib/cron-status';

loadSkillEnvVars('alive');

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    const report = await runHealthCheck();
    const formatted = formatHealthReport(report);
    const cron = fetchCronStatus();
    res.json({ report, formatted, cron });
  } catch (err) {
    console.error('[health GET /]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
