import { Router, Request, Response } from 'express';
import { loadSkillEnvVars } from '../../scripts/utils/file-utils';
import {
  loadDiscoveryPool,
  loadCandidateAccounts,
  approveCandidate,
  dismissCandidate,
} from '../../scripts/ops/discovery-engine';
import { loadKeywordState } from '../../scripts/ops/keyword-tracker';
import { loadContentPatterns } from '../../scripts/ops/content-analyzer';
import { readViralSearchState } from '../../scripts/ops/viral-search';

loadSkillEnvVars('alive');

const router = Router();

// GET /intel/discovery — discovery pool (high-engagement content items)
router.get('/discovery', (_req: Request, res: Response) => {
  try {
    const pool = loadDiscoveryPool();
    res.json(pool);
  } catch (err) {
    console.error('[intel GET /discovery]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /intel/candidates — candidate competitor accounts
router.get('/candidates', (_req: Request, res: Response) => {
  try {
    const store = loadCandidateAccounts();
    res.json(store);
  } catch (err) {
    console.error('[intel GET /candidates]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /intel/candidates/:key/approve — approve candidate → push to persona.yaml competitors
// :key = encodeURIComponent("name::platform")
router.post('/candidates/:key/approve', (req: Request, res: Response) => {
  try {
    const decoded = decodeURIComponent(req.params.key);
    const sepIdx = decoded.indexOf('::');
    if (sepIdx === -1) {
      res.status(400).json({ error: 'key must be encodeURIComponent("name::platform")' });
      return;
    }
    const name = decoded.slice(0, sepIdx);
    const platform = decoded.slice(sepIdx + 2);
    if (!name || !platform) {
      res.status(400).json({ error: 'name or platform missing' });
      return;
    }
    const ok = approveCandidate(name, platform);
    if (!ok) {
      res.status(404).json({ error: 'Candidate not found or not in pending state' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[intel POST /candidates/:key/approve]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /intel/candidates/:key/dismiss
router.post('/candidates/:key/dismiss', (req: Request, res: Response) => {
  try {
    const decoded = decodeURIComponent(req.params.key);
    const sepIdx = decoded.indexOf('::');
    if (sepIdx === -1) {
      res.status(400).json({ error: 'key must be encodeURIComponent("name::platform")' });
      return;
    }
    const name = decoded.slice(0, sepIdx);
    const platform = decoded.slice(sepIdx + 2);
    if (!name || !platform) {
      res.status(400).json({ error: 'name or platform missing' });
      return;
    }
    const ok = dismissCandidate(name, platform);
    if (!ok) {
      res.status(404).json({ error: 'Candidate not found or not in pending state' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[intel POST /candidates/:key/dismiss]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /intel/keywords — keyword tracker state
router.get('/keywords', (_req: Request, res: Response) => {
  try {
    const state = loadKeywordState();
    res.json(state);
  } catch (err) {
    console.error('[intel GET /keywords]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /intel/patterns — content patterns (for pattern trends UI)
router.get('/patterns', (_req: Request, res: Response) => {
  try {
    const patterns = loadContentPatterns();
    res.json(patterns);
  } catch (err) {
    console.error('[intel GET /patterns]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /intel/radar — viral search / radar state (for "跨平台雷达" panel)
router.get('/radar', (_req: Request, res: Response) => {
  try {
    const state = readViralSearchState();
    res.json(state);
  } catch (err) {
    console.error('[intel GET /radar]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
