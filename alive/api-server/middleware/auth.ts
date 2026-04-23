import { Request, Response, NextFunction } from 'express';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const apiKey = process.env.OPS_API_KEY;
  if (!apiKey) {
    // No key configured → open access (dev mode)
    next();
    return;
  }
  const provided = req.headers['x-api-key'];
  if (provided !== apiKey) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }
  next();
}
