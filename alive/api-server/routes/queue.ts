import { Router, Request, Response } from 'express';
import { loadSkillEnvVars } from '../../scripts/utils/file-utils';
import {
  loadQueue,
  markApproved,
  markDiscarded,
  addReviewFeedback,
  updateItemContent,
} from '../../scripts/ops/review-queue';
import { QueueItemContent } from '../../scripts/utils/types';
import { spawnCli } from '../lib/cli-runner';

// Load env vars once at module init
loadSkillEnvVars('alive');

const router = Router();

// GET /queue — full queue
router.get('/', async (_req: Request, res: Response) => {
  try {
    const queue = await loadQueue();
    res.json(queue);
  } catch (err) {
    console.error('[queue GET /]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /queue/idea — generate new topics via CLI
router.post('/idea', async (req: Request, res: Response) => {
  try {
    const direction: string | undefined = typeof req.body?.direction === 'string' ? req.body.direction : undefined;
    const args = direction ? [direction] : [];
    const output = await spawnCli('idea', args);
    res.json({ output });
  } catch (err) {
    console.error('[queue POST /idea]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /queue/review — batch review via CLI
router.post('/review', async (req: Request, res: Response) => {
  try {
    const sub = req.body?.sub;
    const validSubs = ['approve-all', 'discard-low'];
    const args = typeof sub === 'string' && validSubs.includes(sub) ? [sub] : [];
    const output = await spawnCli('review', args);
    res.json({ output });
  } catch (err) {
    console.error('[queue POST /review]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /queue/:id/approve
router.post('/:id/approve', async (req: Request, res: Response) => {
  try {
    const item = await markApproved(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Item not found or invalid status transition' });
      return;
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '运营确认';
    await addReviewFeedback(req.params.id, {
      decision: 'approved',
      source: 'dashboard',
      reason_summary: reason,
    });
    res.json(item);
  } catch (err) {
    console.error('[queue POST /:id/approve]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /queue/:id/discard
router.post('/:id/discard', async (req: Request, res: Response) => {
  try {
    const item = await markDiscarded(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Item not found or invalid status transition' });
      return;
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '运营否决';
    await addReviewFeedback(req.params.id, {
      decision: 'discarded',
      source: 'dashboard',
      reason_summary: reason,
    });
    res.json(item);
  } catch (err) {
    console.error('[queue POST /:id/discard]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /queue/:id — update topic/content fields
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { content, instruction, field } = req.body as {
      content: Partial<QueueItemContent>;
      instruction: string;
      field: string;
    };
    if (!content || typeof instruction !== 'string' || typeof field !== 'string') {
      res.status(400).json({ error: 'content, instruction and field are required' });
      return;
    }
    const item = await updateItemContent(req.params.id, content, { instruction, field });
    if (!item) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    res.json(item);
  } catch (err) {
    console.error('[queue PUT /:id]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
