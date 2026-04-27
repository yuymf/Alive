import { Router, Request, Response } from 'express';
import * as path from 'path';
import { loadSkillEnvVars, PATHS } from '../../scripts/utils/file-utils';
import { loadQueue } from '../../scripts/ops/review-queue';
import { loadPersona } from '../../scripts/persona/persona-loader';
import { runHealthCheck } from '../../scripts/ops/health-check';
import { loadDiscoveryPool, loadCandidateAccounts } from '../../scripts/ops/discovery-engine';
import { loadKeywordState } from '../../scripts/ops/keyword-tracker';
import { loadContentPatterns } from '../../scripts/ops/content-analyzer';
import { getStats as getViralKBStats } from '../../scripts/ops/viral-kb-store';

loadSkillEnvVars('alive');

const router = Router();

function getKbBasePath(): string {
  // PATHS.stateDir = {memoryBase}/state; kbDir(basePath) = {memoryBase}/state/viral-kb
  return path.dirname(PATHS.emotionState);
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    const queue = await loadQueue();
    const persona = loadPersona();
    const items = queue.items ?? [];

    const queueCounts: Record<string, number> = {
      total: items.length,
      pending: 0, approved: 0, published: 0, discarded: 0, expired: 0,
    };
    for (const item of items) {
      if (item.status in queueCounts) queueCounts[item.status]++;
    }

    // Best-effort: any individual failure should not break the whole payload
    const [healthReport, pool, candidates, keywords, patterns, kbStats] = await Promise.all([
      runHealthCheck().catch(() => null),
      Promise.resolve().then(() => loadDiscoveryPool()).catch(() => ({ items: [] as unknown[] })),
      Promise.resolve().then(() => loadCandidateAccounts()).catch(() => ({ candidates: [] as unknown[] })),
      Promise.resolve().then(() => loadKeywordState()).catch(() => ({ keywords: [] as unknown[] })),
      Promise.resolve().then(() => loadContentPatterns()).catch(() => ({ patterns: [] as unknown[] })),
      Promise.resolve().then(() => getViralKBStats(getKbBasePath())).catch(() => null),
    ]);

    res.json({
      ok: true,
      persona_name: persona.meta?.name ?? 'unknown',
      persona_id: persona.meta?.id ?? 'unknown',
      queue: queueCounts,
      health: healthReport ? {
        ok: healthReport.summary.ok,
        warn: healthReport.summary.warn,
        missing: healthReport.summary.missing,
        pending: healthReport.summary.pending,
      } : null,
      discovery: {
        pool_size: (pool as { items?: unknown[] }).items?.length ?? 0,
        candidate_accounts: (candidates as { candidates?: unknown[] }).candidates?.length ?? 0,
      },
      keywords_total: (keywords as { keywords?: unknown[] }).keywords?.length ?? 0,
      patterns_total: (patterns as { patterns?: unknown[] }).patterns?.length ?? 0,
      viral_kb: kbStats,
    });
  } catch (err) {
    console.error('[status] Error:', err);
    res.status(500).json({ error: 'Internal server error', ok: false });
  }
});

export default router;
