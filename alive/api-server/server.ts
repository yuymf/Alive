import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { authMiddleware } from './middleware/auth';
import statusRouter from './routes/status';
import queueRouter from './routes/queue';

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

if (!Number.isInteger(PORT) || PORT <= 0) {
  console.error(`[alive-api] Invalid PORT: ${process.env.PORT}`);
  process.exit(1);
}

const corsOrigin = process.env.CORS_ORIGIN;
if (!corsOrigin) {
  console.warn('[alive-api] WARNING: CORS_ORIGIN is not set. Defaulting to same-origin only.');
}

app.use(cors({
  origin: corsOrigin ?? false,
}));
app.use(express.json({ limit: '1mb' }));
app.use(authMiddleware);

app.use('/api/status', statusRouter);
app.use('/api/queue', queueRouter);

// 404 catch-all
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[alive-api] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`[alive-api] listening on port ${PORT}`);
});

server.on('error', (err) => {
  console.error('[alive-api] Failed to start server:', err);
  process.exit(1);
});

export default app;
