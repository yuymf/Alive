import { Router, Request, Response } from 'express';
import { loadSkillEnvVars } from '../../scripts/utils/file-utils';
import { loadPersona } from '../../scripts/persona/persona-loader';
import { readCachedCompetitorsWithMeta } from '../../scripts/ops/competitor-tracker';
import {
  readOverride,
  writeOverride,
  mergeCompetitors,
  upsertOverride,
  deleteOverride,
  CompetitorOverrideEntry,
} from '../lib/competitors-override';
import { spawnCli } from '../lib/cli-runner';

loadSkillEnvVars('alive');

const router = Router();

// GET /competitors
router.get('/', (_req: Request, res: Response) => {
  try {
    const persona = loadPersona();
    const base = persona.ops?.competitors ?? [];
    const override = readOverride();
    const merged = mergeCompetitors(base, override);
    const { updates, computed_at } = readCachedCompetitorsWithMeta();
    const result = merged.map(profile => ({
      ...profile,
      tracking: updates.find(u => u.account === profile.name && u.platform === profile.platform) ?? null,
    }));
    res.json({ competitors: result, computed_at });
  } catch (err) {
    console.error('[competitors GET /]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /competitors — add
router.post('/', (req: Request, res: Response) => {
  try {
    const entry = req.body as CompetitorOverrideEntry;
    if (typeof entry.name !== 'string' || !entry.name || typeof entry.platform !== 'string' || !entry.platform) {
      res.status(400).json({ error: 'name and platform are required strings' });
      return;
    }
    const updated = upsertOverride(entry);
    writeOverride(updated);
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[competitors POST /]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /competitors/:id — id = encodeURIComponent("name::platform")
router.put('/:id', (req: Request, res: Response) => {
  try {
    const decoded = decodeURIComponent(req.params.id);
    const sepIdx = decoded.indexOf('::');
    if (sepIdx === -1) {
      res.status(400).json({ error: 'id must be encodeURIComponent("name::platform")' });
      return;
    }
    const name = decoded.slice(0, sepIdx);
    const platform = decoded.slice(sepIdx + 2);
    if (!name || !platform) {
      res.status(400).json({ error: 'id must be encodeURIComponent("name::platform")' });
      return;
    }
    const entry: CompetitorOverrideEntry = { ...req.body, name, platform };
    const updated = upsertOverride(entry);
    writeOverride(updated);
    res.json({ ok: true });
  } catch (err) {
    console.error('[competitors PUT /:id]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /competitors/:id
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const decoded = decodeURIComponent(req.params.id);
    const sepIdx = decoded.indexOf('::');
    if (sepIdx === -1) {
      res.status(400).json({ error: 'id must be encodeURIComponent("name::platform")' });
      return;
    }
    const name = decoded.slice(0, sepIdx);
    const platform = decoded.slice(sepIdx + 2);
    if (!name || !platform) {
      res.status(400).json({ error: 'id must be encodeURIComponent("name::platform")' });
      return;
    }
    const updated = deleteOverride(name, platform);
    writeOverride(updated);
    res.json({ ok: true });
  } catch (err) {
    console.error('[competitors DELETE /:id]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /competitors/analyze — 爆款拆解
router.post('/analyze', async (req: Request, res: Response) => {
  try {
    const url = req.body?.url;
    if (typeof url !== 'string' || !url.startsWith('http')) {
      res.status(400).json({ error: 'url must be a valid http(s) URL' });
      return;
    }
    const output = await spawnCli('analyze', [url]);
    res.json({ output });
  } catch (err) {
    console.error('[competitors POST /analyze]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
