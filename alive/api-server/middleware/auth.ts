import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const apiKey = process.env.OPS_API_KEY;
  if (!apiKey) {
    // Dev mode: no key configured — warn loudly but allow
    console.warn('[alive-api] WARNING: OPS_API_KEY is not set. All requests are allowed (dev mode only).');
    next();
    return;
  }
  const provided = req.headers['x-api-key'];
  if (typeof provided !== 'string') {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(apiKey);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }
  } catch {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }
  next();
}
