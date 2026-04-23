import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { authMiddleware } from './middleware/auth';
import statusRouter from './routes/status';

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

app.use(cors({
  origin: process.env.CORS_ORIGIN ?? '*',
}));
app.use(express.json());
app.use(authMiddleware);

app.use('/api/status', statusRouter);

app.listen(PORT, () => {
  console.log(`[alive-api] listening on port ${PORT}`);
});

export default app;
