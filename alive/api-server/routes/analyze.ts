import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import { loadSkillEnvVars } from '../../scripts/utils/file-utils';
import { spawnCli } from '../lib/cli-runner';
import { cachedCliRun } from '../lib/llm-cache';

loadSkillEnvVars('alive');

const router = Router();

// Analyze results are basically immutable — the post URL points to a fixed
// piece of content. Cache for 24h; force refresh only if user explicitly
// requests it via ?refresh=1.
const ANALYZE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function keyForUrl(url: string): string {
  const h = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  return `analyze:${h}`;
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const url = req.body?.url;
    if (typeof url !== 'string' || !url.startsWith('http')) {
      res.status(400).json({ error: 'url must be a valid http(s) URL' });
      return;
    }

    const result = await cachedCliRun({
      key: keyForUrl(url),
      ttlMs: ANALYZE_TTL_MS,
      forceRefresh: req.query.refresh === '1' || req.body?.refresh === true,
      staleWhileRevalidate: false, // per-URL analysis: we can wait
      run: () => spawnCli('analyze', [url]),
    });
    res.json(result);
  } catch (err) {
    console.error('[analyze POST /]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
