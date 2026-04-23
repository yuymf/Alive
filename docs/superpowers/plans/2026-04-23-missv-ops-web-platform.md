# MissV Ops Web Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a web-based ops dashboard that exposes all MissV Ops functionality (queue review, trends, competitors, viral KB, brief generation) as a browser UI, deployed as two independent components: an Express API server inside the Alive repo and a standalone Vite + React frontend repo.

**Architecture:** The Alive repo gains `alive/api-server/` — an Express.js server that directly imports existing `alive/scripts/ops/` TypeScript modules and reads/writes `~/.openclaw/workspace/memory/` JSON files. The `missv-ops-web` repo is a pure Vite + React SPA that talks to this API over HTTPS using a shared `X-API-Key` token. LLM-heavy operations (`/brief`, `/idea`, `/analyze`, `/advice`) are handled by spawning `dist-alive/scripts/ops/ops-command-handler.js` as a child process.

**Tech Stack:** Express 4, tsx, cors (API server) · Vite 5, React 18, TypeScript, Tailwind CSS 3, TanStack Query v5, axios, React Router v6, lucide-react, react-hot-toast (frontend)

---

## Scope note

This plan covers two independent subsystems. They are sequenced so the API server is built first (Tasks 1–2), then the frontend is scaffolded and connected (Task 3), then features are added module by module (Tasks 4–11). Each task produces working, testable software.

---

## File map

### Alive repo additions (`alive/api-server/`)

| File | Responsibility |
|------|---------------|
| `alive/api-server/package.json` | Standalone deps: express, cors, dotenv, tsx |
| `alive/api-server/tsconfig.json` | TS config extending root, includes only api-server |
| `alive/api-server/server.ts` | Express app factory + server entry point |
| `alive/api-server/middleware/auth.ts` | `X-API-Key` validation middleware |
| `alive/api-server/routes/status.ts` | `GET /status` — queue counts + persona name |
| `alive/api-server/routes/queue.ts` | All `/queue/*` endpoints |
| `alive/api-server/routes/trends.ts` | `GET /trends` |
| `alive/api-server/routes/brief.ts` | `GET /brief` (spawns CLI) |
| `alive/api-server/routes/competitors.ts` | `/competitors` CRUD + override merge |
| `alive/api-server/routes/viral-kb.ts` | `GET /viral-kb` + `GET /viral-kb/formulas` |
| `alive/api-server/routes/analyze.ts` | `POST /analyze` (spawns CLI) |
| `alive/api-server/routes/advice.ts` | `GET /advice` (spawns CLI) |
| `alive/api-server/lib/cli-runner.ts` | Shared `spawnCli(command, args)` → Promise<string> |
| `alive/api-server/lib/competitors-override.ts` | Read/write/merge `competitors-override.json` |

### missv-ops-web repo (new, standalone)

| File | Responsibility |
|------|---------------|
| `src/api/client.ts` | axios instance with baseURL + X-API-Key interceptor |
| `src/api/endpoints.ts` | All API call functions (typed) |
| `src/types/api.ts` | Shared response type definitions |
| `src/components/layout/TopNav.tsx` | Top tab navigation bar |
| `src/components/layout/Layout.tsx` | Page shell wrapping TopNav + content |
| `src/components/shared/TagBadge.tsx` | Coloured pill tag |
| `src/components/shared/VelocityBar.tsx` | Speed score progress bar |
| `src/components/shared/FreshnessBanner.tsx` | Cache age warning banner |
| `src/components/shared/LlmLoadingState.tsx` | Spinner + "30–120s" message |
| `src/components/shared/ErrorBanner.tsx` | API error display |
| `src/pages/Brief.tsx` | Today's brief page |
| `src/pages/Queue.tsx` | Queue page — list + detail panel |
| `src/components/queue/QueueList.tsx` | Left column list |
| `src/components/queue/QueueItem.tsx` | Single row in queue list |
| `src/components/queue/QueueDetail.tsx` | Right panel detail + inline edit |
| `src/pages/Trends.tsx` | Trends page |
| `src/pages/Competitors.tsx` | Competitors page |
| `src/components/competitors/CompetitorList.tsx` | Left column |
| `src/components/competitors/CompetitorCard.tsx` | Single row card |
| `src/components/competitors/CompetitorDetail.tsx` | Right panel |
| `src/components/competitors/CompetitorForm.tsx` | Add/edit drawer form |
| `src/pages/ViralKB.tsx` | Viral KB page |
| `src/components/viral-kb/EntryList.tsx` | Left column list |
| `src/components/viral-kb/EntryDetail.tsx` | 6-dimension breakdown grid |
| `src/components/viral-kb/FormulaList.tsx` | Universal formula card grid |
| `src/pages/Advice.tsx` | Persona advice page |
| `src/hooks/useQueue.ts` | TanStack Query hooks for queue |
| `src/hooks/useTrends.ts` | TanStack Query hooks for trends |
| `src/hooks/useCompetitors.ts` | TanStack Query hooks for competitors |
| `src/hooks/useViralKB.ts` | TanStack Query hooks for viral KB |
| `src/main.tsx` | App entry + QueryClientProvider + Router |

---

## Task 1: API Server scaffold + auth + /status

**Files:**
- Create: `alive/api-server/package.json`
- Create: `alive/api-server/tsconfig.json`
- Create: `alive/api-server/middleware/auth.ts`
- Create: `alive/api-server/server.ts`
- Create: `alive/api-server/routes/status.ts`

- [ ] **Step 1: Create `alive/api-server/package.json`**

```json
{
  "name": "alive-api-server",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "tsx watch server.ts",
    "start": "tsx server.ts",
    "build": "tsc -p tsconfig.json",
    "start:prod": "node dist/server.js"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/node": "^20.0.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.5"
  }
}
```

- [ ] **Step 2: Install api-server deps**

```bash
cd alive/api-server && npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Create `alive/api-server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "baseUrl": ".",
    "paths": {
      "@alive/*": ["../scripts/*"]
    }
  },
  "include": ["./**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create `alive/api-server/middleware/auth.ts`**

```typescript
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
```

- [ ] **Step 5: Create `alive/api-server/routes/status.ts`**

```typescript
import { Router, Request, Response } from 'express';
import { loadSkillEnvVars } from '../../scripts/utils/file-utils';
import { loadQueue } from '../../scripts/ops/review-queue';
import { loadPersona } from '../../scripts/persona/persona-loader';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    loadSkillEnvVars('alive');
    const [queue, persona] = await Promise.all([
      loadQueue(),
      Promise.resolve(loadPersona()),
    ]);
    const items = queue.items;
    res.json({
      persona_name: persona.meta?.name ?? 'unknown',
      persona_id: persona.meta?.id ?? 'unknown',
      queue: {
        total: items.length,
        pending: items.filter(i => i.status === 'pending').length,
        approved: items.filter(i => i.status === 'approved').length,
        published: items.filter(i => i.status === 'published').length,
        discarded: items.filter(i => i.status === 'discarded').length,
        expired: items.filter(i => i.status === 'expired').length,
      },
      ok: true,
    });
  } catch (err) {
    res.status(500).json({ error: String(err), ok: false });
  }
});

export default router;
```

- [ ] **Step 6: Create `alive/api-server/server.ts`**

```typescript
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
```

- [ ] **Step 7: Start the server and test /status**

```bash
cd alive/api-server
OPS_API_KEY=test123 ALIVE_PERSONA=miss-v npm run dev
```

In another terminal:
```bash
curl -H "X-API-Key: test123" http://localhost:3001/api/status
```

Expected output (shape):
```json
{"persona_name":"V姐","persona_id":"miss-v","queue":{"total":0,"pending":0,...},"ok":true}
```

- [ ] **Step 8: Commit**

```bash
cd /path/to/Alive
git add alive/api-server/
git commit -m "feat: add alive/api-server scaffold with auth middleware and /status endpoint"
```

---

## Task 2: Queue endpoints

**Files:**
- Create: `alive/api-server/lib/cli-runner.ts`
- Create: `alive/api-server/routes/queue.ts`
- Modify: `alive/api-server/server.ts`

- [ ] **Step 1: Create `alive/api-server/lib/cli-runner.ts`**

```typescript
import { spawn } from 'child_process';
import * as path from 'path';

const CLI_PATH = path.resolve(__dirname, '../../..', 'dist-alive/scripts/ops/ops-command-handler.js');
const TIMEOUT_MS = 360_000;

export function spawnCli(command: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    const child = spawn('node', [CLI_PATH, command, ...args], {
      env,
      timeout: TIMEOUT_MS,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(stdout.trim());
    });

    child.on('error', reject);
  });
}
```

- [ ] **Step 2: Create `alive/api-server/routes/queue.ts`**

```typescript
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

const router = Router();

// GET /queue — full queue
router.get('/', async (_req: Request, res: Response) => {
  try {
    loadSkillEnvVars('alive');
    const queue = await loadQueue();
    res.json(queue);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /queue/idea — generate new topics via CLI
router.post('/idea', async (req: Request, res: Response) => {
  try {
    loadSkillEnvVars('alive');
    const direction: string | undefined = req.body?.direction;
    const args = direction ? [direction] : [];
    const output = await spawnCli('idea', args);
    res.json({ output });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /queue/review — batch review via CLI
router.post('/review', async (req: Request, res: Response) => {
  try {
    loadSkillEnvVars('alive');
    const sub: string | undefined = req.body?.sub; // 'approve-all' | 'discard-low' | undefined
    const args = sub ? [sub] : [];
    const output = await spawnCli('review', args);
    res.json({ output });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /queue/:id/approve
router.post('/:id/approve', async (req: Request, res: Response) => {
  try {
    loadSkillEnvVars('alive');
    const item = await markApproved(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Item not found or invalid status transition' });
      return;
    }
    await addReviewFeedback(req.params.id, {
      decision: 'approved',
      source: 'dashboard',
      reason_summary: req.body?.reason ?? '运营确认',
    });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /queue/:id/discard
router.post('/:id/discard', async (req: Request, res: Response) => {
  try {
    loadSkillEnvVars('alive');
    const item = await markDiscarded(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Item not found or invalid status transition' });
      return;
    }
    await addReviewFeedback(req.params.id, {
      decision: 'discarded',
      source: 'dashboard',
      reason_summary: req.body?.reason ?? '运营否决',
    });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT /queue/:id — update topic/content fields
router.put('/:id', async (req: Request, res: Response) => {
  try {
    loadSkillEnvVars('alive');
    const { content, instruction, field } = req.body as {
      content: Partial<QueueItemContent>;
      instruction: string;
      field: string;
    };
    if (!content || !instruction || !field) {
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
    res.status(500).json({ error: String(err) });
  }
});

export default router;
```

- [ ] **Step 3: Mount queue router in server.ts**

Replace the router section in `alive/api-server/server.ts`:

```typescript
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { authMiddleware } from './middleware/auth';
import statusRouter from './routes/status';
import queueRouter from './routes/queue';

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

app.use(cors({ origin: process.env.CORS_ORIGIN ?? '*' }));
app.use(express.json());
app.use(authMiddleware);

app.use('/api/status', statusRouter);
app.use('/api/queue', queueRouter);

app.listen(PORT, () => {
  console.log(`[alive-api] listening on port ${PORT}`);
});

export default app;
```

- [ ] **Step 4: Build dist-alive to ensure CLI exists**

```bash
cd /path/to/Alive
npm run build
```

Expected: `dist-alive/scripts/ops/ops-command-handler.js` exists.

- [ ] **Step 5: Test queue endpoints**

```bash
# Start server
cd alive/api-server
OPS_API_KEY=test123 ALIVE_PERSONA=miss-v npm run dev

# Test GET /queue
curl -H "X-API-Key: test123" http://localhost:3001/api/queue

# Test approve (use a real pending item id from the queue)
curl -X POST -H "X-API-Key: test123" -H "Content-Type: application/json" \
  -d '{"reason":"test approve"}' \
  http://localhost:3001/api/queue/ITEM_ID/approve
```

Expected: GET returns `{"items":[...],"last_updated":"..."}`. POST returns updated item.

- [ ] **Step 6: Commit**

```bash
git add alive/api-server/lib/cli-runner.ts alive/api-server/routes/queue.ts alive/api-server/server.ts
git commit -m "feat: add queue CRUD endpoints to api-server"
```

---

## Task 3: Trends + Brief + Advice endpoints

**Files:**
- Create: `alive/api-server/routes/trends.ts`
- Create: `alive/api-server/routes/brief.ts`
- Create: `alive/api-server/routes/advice.ts`
- Modify: `alive/api-server/server.ts`

- [ ] **Step 1: Create `alive/api-server/routes/trends.ts`**

```typescript
import { Router, Request, Response } from 'express';
import { loadSkillEnvVars } from '../../scripts/utils/file-utils';
import { loadPersona } from '../../scripts/persona/persona-loader';
import { readCachedTrendsWithMeta, buildPersonaIdentities } from '../../scripts/ops/trend-analyzer';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    loadSkillEnvVars('alive');
    const persona = loadPersona();
    const identities = buildPersonaIdentities(persona);
    const meta = readCachedTrendsWithMeta(identities);
    res.json(meta);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
```

- [ ] **Step 2: Create `alive/api-server/routes/brief.ts`**

```typescript
import { Router, Request, Response } from 'express';
import { loadSkillEnvVars } from '../../scripts/utils/file-utils';
import { spawnCli } from '../lib/cli-runner';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    loadSkillEnvVars('alive');
    const output = await spawnCli('brief');
    res.json({ output });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
```

- [ ] **Step 3: Create `alive/api-server/routes/advice.ts`**

```typescript
import { Router, Request, Response } from 'express';
import { loadSkillEnvVars } from '../../scripts/utils/file-utils';
import { spawnCli } from '../lib/cli-runner';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    loadSkillEnvVars('alive');
    const output = await spawnCli('advice');
    res.json({ output });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
```

- [ ] **Step 4: Mount new routers in server.ts**

```typescript
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { authMiddleware } from './middleware/auth';
import statusRouter from './routes/status';
import queueRouter from './routes/queue';
import trendsRouter from './routes/trends';
import briefRouter from './routes/brief';
import adviceRouter from './routes/advice';

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

app.use(cors({ origin: process.env.CORS_ORIGIN ?? '*' }));
app.use(express.json());
app.use(authMiddleware);

app.use('/api/status', statusRouter);
app.use('/api/queue', queueRouter);
app.use('/api/trends', trendsRouter);
app.use('/api/brief', briefRouter);
app.use('/api/advice', adviceRouter);

app.listen(PORT, () => {
  console.log(`[alive-api] listening on port ${PORT}`);
});

export default app;
```

- [ ] **Step 5: Test**

```bash
curl -H "X-API-Key: test123" http://localhost:3001/api/trends
# Expected: {"computed_at":"...","results":[...],"signal_pool":[...]}

curl -H "X-API-Key: test123" http://localhost:3001/api/brief
# Expected: {"output":"📋 今日简报..."} — may take 30-120s
```

- [ ] **Step 6: Commit**

```bash
git add alive/api-server/routes/trends.ts alive/api-server/routes/brief.ts alive/api-server/routes/advice.ts alive/api-server/server.ts
git commit -m "feat: add trends, brief, advice endpoints"
```

---

## Task 4: Competitors + Viral KB endpoints

**Files:**
- Create: `alive/api-server/lib/competitors-override.ts`
- Create: `alive/api-server/routes/competitors.ts`
- Create: `alive/api-server/routes/viral-kb.ts`
- Create: `alive/api-server/routes/analyze.ts`
- Modify: `alive/api-server/server.ts`

- [ ] **Step 1: Create `alive/api-server/lib/competitors-override.ts`**

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { CompetitorProfile } from '../../scripts/utils/types';

export interface CompetitorOverrideEntry extends Omit<CompetitorProfile, 'name' | 'platform'> {
  name: string;
  platform: CompetitorProfile['platform'];
  _deleted?: boolean;
  _added_at?: string;
  _updated_at?: string;
}

export interface CompetitorOverrideFile {
  entries: CompetitorOverrideEntry[];
  last_updated: string;
}

const EMPTY: CompetitorOverrideFile = { entries: [], last_updated: '' };

function getOverridePath(): string {
  const home = process.env.HOME!;
  const persona = process.env.ALIVE_PERSONA ?? 'default';
  const base = path.join(home, '.openclaw', 'workspace', 'memory', persona);
  return path.join(base, 'competitors-override.json');
}

export function readOverride(): CompetitorOverrideFile {
  const p = getOverridePath();
  if (!fs.existsSync(p)) return EMPTY;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as CompetitorOverrideFile;
  } catch {
    return EMPTY;
  }
}

export function writeOverride(file: CompetitorOverrideFile): void {
  const p = getOverridePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const updated = { ...file, last_updated: new Date().toISOString() };
  // Write .bak first
  if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak');
  fs.writeFileSync(p, JSON.stringify(updated, null, 2), 'utf8');
}

/** Merge persona.yaml base profiles with override entries.
 * Override wins on name+platform key. _deleted entries are excluded. */
export function mergeCompetitors(
  base: readonly CompetitorProfile[],
  override: CompetitorOverrideFile,
): CompetitorProfile[] {
  const map = new Map<string, CompetitorProfile>();
  for (const c of base) {
    map.set(`${c.name}::${c.platform}`, c);
  }
  for (const e of override.entries) {
    const key = `${e.name}::${e.platform}`;
    if (e._deleted) {
      map.delete(key);
    } else {
      const { _deleted: _d, _added_at: _a, _updated_at: _u, ...profile } = e;
      map.set(key, profile as CompetitorProfile);
    }
  }
  return [...map.values()];
}

export function upsertOverride(entry: CompetitorOverrideEntry): CompetitorOverrideFile {
  const file = readOverride();
  const key = `${entry.name}::${entry.platform}`;
  const existing = file.entries.findIndex(e => `${e.name}::${e.platform}` === key);
  const ts = new Date().toISOString();
  const updated = { ...entry, _updated_at: ts };
  const newEntries = existing === -1
    ? [...file.entries, { ...updated, _added_at: ts }]
    : [
        ...file.entries.slice(0, existing),
        updated,
        ...file.entries.slice(existing + 1),
      ];
  return { ...file, entries: newEntries };
}

export function deleteOverride(name: string, platform: string): CompetitorOverrideFile {
  const file = readOverride();
  const key = `${name}::${platform}`;
  const existing = file.entries.findIndex(e => `${e.name}::${e.platform}` === key);
  const deletionEntry: CompetitorOverrideEntry = {
    name,
    platform: platform as CompetitorProfile['platform'],
    tag: '',
    tag_desc: '',
    reference_type: 'secondary',
    _deleted: true,
    _updated_at: new Date().toISOString(),
  };
  const newEntries = existing === -1
    ? [...file.entries, deletionEntry]
    : [
        ...file.entries.slice(0, existing),
        deletionEntry,
        ...file.entries.slice(existing + 1),
      ];
  return { ...file, entries: newEntries };
}
```

- [ ] **Step 2: Create `alive/api-server/routes/competitors.ts`**

```typescript
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

const router = Router();

// GET /competitors
router.get('/', async (_req: Request, res: Response) => {
  try {
    loadSkillEnvVars('alive');
    const persona = loadPersona();
    const base = persona.ops?.competitors ?? [];
    const override = readOverride();
    const merged = mergeCompetitors(base, override);
    const { updates, computed_at } = readCachedCompetitorsWithMeta();
    // Annotate merged profiles with live tracking data
    const result = merged.map(profile => ({
      ...profile,
      tracking: updates.find(u => u.account === profile.name && u.platform === profile.platform) ?? null,
    }));
    res.json({ competitors: result, computed_at });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /competitors — add
router.post('/', async (req: Request, res: Response) => {
  try {
    loadSkillEnvVars('alive');
    const entry = req.body as CompetitorOverrideEntry;
    if (!entry.name || !entry.platform) {
      res.status(400).json({ error: 'name and platform are required' });
      return;
    }
    const updated = upsertOverride(entry);
    writeOverride(updated);
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT /competitors/:id — id = encodeURIComponent("name::platform")
router.put('/:id', async (req: Request, res: Response) => {
  try {
    loadSkillEnvVars('alive');
    const [name, platform] = decodeURIComponent(req.params.id).split('::');
    if (!name || !platform) {
      res.status(400).json({ error: 'id must be name::platform' });
      return;
    }
    const entry: CompetitorOverrideEntry = { ...req.body, name, platform };
    const updated = upsertOverride(entry);
    writeOverride(updated);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /competitors/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    loadSkillEnvVars('alive');
    const [name, platform] = decodeURIComponent(req.params.id).split('::');
    if (!name || !platform) {
      res.status(400).json({ error: 'id must be name::platform' });
      return;
    }
    const updated = deleteOverride(name, platform);
    writeOverride(updated);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /competitors/analyze —爆款拆解 via CLI
router.post('/analyze', async (req: Request, res: Response) => {
  try {
    loadSkillEnvVars('alive');
    const { url } = req.body as { url: string };
    if (!url) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    const output = await spawnCli('analyze', [url]);
    res.json({ output });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
```

- [ ] **Step 3: Create `alive/api-server/routes/viral-kb.ts`**

```typescript
import { Router, Request, Response } from 'express';
import { loadSkillEnvVars, PATHS } from '../../scripts/utils/file-utils';
import { queryAll, loadFormulas, getStats } from '../../scripts/ops/viral-kb-store';
import * as path from 'path';

const router = Router();

function getBasePath(): string {
  return path.dirname(PATHS.emotionState);
}

// GET /viral-kb?sort=likes&limit=100&hook_type=反差钩子&identity_mode=电竞
router.get('/', (_req: Request, res: Response) => {
  try {
    loadSkillEnvVars('alive');
    const { sort, limit, hook_type, identity_mode } = _req.query as Record<string, string>;
    const basePath = getBasePath();
    const entries = queryAll(basePath, {
      sort: (sort as 'likes' | 'date') ?? 'likes',
      limit: limit ? Number(limit) : 200,
    }).filter(e => {
      if (hook_type && e.dissection.hook_type !== hook_type) return false;
      if (identity_mode && e.dissection.identity_mode !== identity_mode) return false;
      return true;
    });
    const stats = getStats(basePath);
    res.json({ entries, stats });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /viral-kb/formulas
router.get('/formulas', (_req: Request, res: Response) => {
  try {
    loadSkillEnvVars('alive');
    const formulas = loadFormulas(getBasePath());
    res.json({ formulas });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
```

- [ ] **Step 4: Create `alive/api-server/routes/analyze.ts`**

```typescript
import { Router, Request, Response } from 'express';
import { loadSkillEnvVars } from '../../scripts/utils/file-utils';
import { spawnCli } from '../lib/cli-runner';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  try {
    loadSkillEnvVars('alive');
    const { url } = req.body as { url: string };
    if (!url) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    const output = await spawnCli('analyze', [url]);
    res.json({ output });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
```

- [ ] **Step 5: Mount all remaining routers in server.ts**

```typescript
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { authMiddleware } from './middleware/auth';
import statusRouter from './routes/status';
import queueRouter from './routes/queue';
import trendsRouter from './routes/trends';
import briefRouter from './routes/brief';
import adviceRouter from './routes/advice';
import competitorsRouter from './routes/competitors';
import viralKbRouter from './routes/viral-kb';
import analyzeRouter from './routes/analyze';

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

app.use(cors({ origin: process.env.CORS_ORIGIN ?? '*' }));
app.use(express.json());
app.use(authMiddleware);

app.use('/api/status', statusRouter);
app.use('/api/queue', queueRouter);
app.use('/api/trends', trendsRouter);
app.use('/api/brief', briefRouter);
app.use('/api/advice', adviceRouter);
app.use('/api/competitors', competitorsRouter);
app.use('/api/viral-kb', viralKbRouter);
app.use('/api/analyze', analyzeRouter);

app.listen(PORT, () => {
  console.log(`[alive-api] listening on port ${PORT}`);
});

export default app;
```

- [ ] **Step 6: Test**

```bash
curl -H "X-API-Key: test123" http://localhost:3001/api/competitors
# Expected: {"competitors":[...],"computed_at":"..."}

curl -H "X-API-Key: test123" http://localhost:3001/api/viral-kb
# Expected: {"entries":[...],"stats":{"total":...}}

curl -H "X-API-Key: test123" http://localhost:3001/api/viral-kb/formulas
# Expected: {"formulas":[...]}
```

- [ ] **Step 7: Commit**

```bash
git add alive/api-server/lib/competitors-override.ts alive/api-server/routes/competitors.ts alive/api-server/routes/viral-kb.ts alive/api-server/routes/analyze.ts alive/api-server/server.ts
git commit -m "feat: add competitors CRUD, viral-kb, and analyze endpoints"
```

---

## Task 5: Frontend scaffold — missv-ops-web repo

**Files:** All in a new directory `missv-ops-web/` (separate repo, scaffold with Vite)

- [ ] **Step 1: Scaffold Vite + React project**

Run this from wherever you keep repos (NOT inside the Alive repo):

```bash
npm create vite@latest missv-ops-web -- --template react-ts
cd missv-ops-web
npm install
npm install @tanstack/react-query axios react-router-dom react-hot-toast lucide-react
npm install -D tailwindcss @tailwindcss/vite
```

- [ ] **Step 2: Configure Tailwind**

Replace `src/index.css` with:

```css
@import "tailwindcss";
```

Update `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
});
```

- [ ] **Step 3: Create `.env.example` and `.env`**

`.env.example`:
```
VITE_API_BASE_URL=https://alive-api.example.com
VITE_API_KEY=your-secret-token-here
```

`.env` (local dev, git-ignored):
```
VITE_API_BASE_URL=http://localhost:3001
VITE_API_KEY=test123
```

Add to `.gitignore`:
```
.env
```

- [ ] **Step 4: Create `src/api/client.ts`**

```typescript
import axios from 'axios';

const baseURL = import.meta.env.VITE_API_BASE_URL as string;
const apiKey = import.meta.env.VITE_API_KEY as string;

export const apiClient = axios.create({ baseURL });

apiClient.interceptors.request.use(config => {
  config.headers['X-API-Key'] = apiKey;
  return config;
});

apiClient.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401) {
      console.error('[api] 401 Unauthorized — check VITE_API_KEY');
    }
    return Promise.reject(error as Error);
  },
);
```

- [ ] **Step 5: Create `src/types/api.ts`**

```typescript
// Mirror of types from alive/scripts/utils/types.ts — keep in sync manually

export type QueueItemStatus = 'pending' | 'approved' | 'published' | 'discarded' | 'editing' | 'expired';

export interface QueueItemContent {
  xhs: {
    title: string;
    body: string;
    tags: string[];
    cover_images: string[];
    opening_hook?: string;
    script?: string;
    bgm_suggestion?: string;
    key_captions?: string[];
  };
  douyin: {
    script: string;
    bgm_suggestion: string;
    key_captions: string[];
    cover_images: string[];
    total_duration: string;
    pacing: { tempo: string; description: string };
  };
}

export interface QueueItemCompetitorBenchmark {
  name: string;
  platform: string;
  content_mix_relevant: string;
  audience: string;
  interaction_style: string;
}

export interface QueueItem {
  id: string;
  status: QueueItemStatus;
  topic: string;
  trend_hook: string;
  identity_mode: string;
  created_at: string;
  updated_at: string;
  content: QueueItemContent;
  edit_history: { timestamp: string; instruction: string; field: string }[];
  competitor_benchmarks?: QueueItemCompetitorBenchmark[];
  published_at?: string;
  image_prompts?: string[];
  review_feedback?: {
    decision: 'approved' | 'discarded' | 'edit_requested';
    created_at: string;
    reason_summary: string;
  }[];
}

export interface ReviewQueue {
  items: QueueItem[];
  last_updated: string;
}

export interface FilteredTrend {
  keyword: string;
  platform: string;
  velocity_score: number;
  priority_score: number;
  source_bucket?: string;
  hook_angle: string;
  identity_mode: string;
}

export interface CachedTrendsRead {
  computed_at: string;
  results: FilteredTrend[];
  signal_pool?: { bucket: string; top: { keyword: string; platform: string; v: string; p: string }[] }[];
}

export interface CompetitorProfile {
  name: string;
  platform: string;
  url?: string;
  tag: string;
  tag_desc: string;
  group?: string;
  content_mix?: Record<string, number>;
  audience?: string;
  interaction_style?: string;
  reference_type: 'primary' | 'secondary';
  takeaways?: string[];
  avoid?: string[];
}

export interface CompetitorTracking {
  account: string;
  platform: string;
  latest_post: { topic: string; engagement: number } | null;
  recent_posts: { topic: string; engagement: number; posted_at?: string }[];
  days_since_last_post: number;
  fetched_at: string;
}

export interface CompetitorWithTracking extends CompetitorProfile {
  tracking: CompetitorTracking | null;
}

export interface ViralEntryDissection {
  hook_type: string;
  content_type: string;
  identity_mode: string | null;
  emotion_arc: string;
  interaction_design: string;
  visual_style: string;
  cta_type: string;
  summary: string;
}

export interface ViralEntry {
  id: string;
  platform: string;
  title: string;
  description: string;
  likes: number;
  comments: number;
  collected_at: string;
  dissection: ViralEntryDissection;
  dissection_status: 'done' | 'failed';
  kb_tier: 'track' | 'universal';
}

export interface UniversalFormula {
  id: string;
  platform: string;
  content_type: string;
  hook_type: string;
  formula_summary: string;
  occurrence_count: number;
  created_at: string;
  example_titles?: string[];
  structural_template?: string;
  confidence?: number;
}

export interface StatusResponse {
  persona_name: string;
  persona_id: string;
  queue: {
    total: number;
    pending: number;
    approved: number;
    published: number;
    discarded: number;
    expired: number;
  };
  ok: boolean;
}
```

- [ ] **Step 6: Create `src/api/endpoints.ts`**

```typescript
import { apiClient } from './client';
import {
  ReviewQueue, QueueItem, QueueItemContent, CachedTrendsRead,
  CompetitorWithTracking, CompetitorProfile, ViralEntry,
  UniversalFormula, StatusResponse,
} from '../types/api';

export const api = {
  getStatus: () =>
    apiClient.get<StatusResponse>('/api/status').then(r => r.data),

  getQueue: () =>
    apiClient.get<ReviewQueue>('/api/queue').then(r => r.data),

  approveItem: (id: string, reason?: string) =>
    apiClient.post<QueueItem>(`/api/queue/${id}/approve`, { reason }).then(r => r.data),

  discardItem: (id: string, reason?: string) =>
    apiClient.post<QueueItem>(`/api/queue/${id}/discard`, { reason }).then(r => r.data),

  updateItemContent: (id: string, content: Partial<QueueItemContent>, instruction: string, field: string) =>
    apiClient.put<QueueItem>(`/api/queue/${id}`, { content, instruction, field }).then(r => r.data),

  generateIdea: (direction?: string) =>
    apiClient.post<{ output: string }>('/api/queue/idea', { direction }).then(r => r.data),

  batchReview: (sub?: 'approve-all' | 'discard-low') =>
    apiClient.post<{ output: string }>('/api/queue/review', { sub }).then(r => r.data),

  getTrends: () =>
    apiClient.get<CachedTrendsRead>('/api/trends').then(r => r.data),

  getBrief: () =>
    apiClient.get<{ output: string }>('/api/brief').then(r => r.data),

  getAdvice: () =>
    apiClient.get<{ output: string }>('/api/advice').then(r => r.data),

  getCompetitors: () =>
    apiClient.get<{ competitors: CompetitorWithTracking[]; computed_at: string }>('/api/competitors').then(r => r.data),

  addCompetitor: (profile: Partial<CompetitorProfile> & { name: string; platform: string }) =>
    apiClient.post<{ ok: boolean }>('/api/competitors', profile).then(r => r.data),

  updateCompetitor: (name: string, platform: string, profile: Partial<CompetitorProfile>) =>
    apiClient.put<{ ok: boolean }>(`/api/competitors/${encodeURIComponent(`${name}::${platform}`)}`, profile).then(r => r.data),

  deleteCompetitor: (name: string, platform: string) =>
    apiClient.delete<{ ok: boolean }>(`/api/competitors/${encodeURIComponent(`${name}::${platform}`)}`).then(r => r.data),

  analyzeUrl: (url: string) =>
    apiClient.post<{ output: string }>('/api/analyze', { url }).then(r => r.data),

  getViralKB: (params?: { sort?: 'likes' | 'date'; limit?: number; hook_type?: string; identity_mode?: string }) =>
    apiClient.get<{ entries: ViralEntry[]; stats: { total: number } }>('/api/viral-kb', { params }).then(r => r.data),

  getFormulas: () =>
    apiClient.get<{ formulas: UniversalFormula[] }>('/api/viral-kb/formulas').then(r => r.data),
};
```

- [ ] **Step 7: Create shared components**

`src/components/shared/TagBadge.tsx`:
```tsx
interface Props {
  label: string;
  color?: 'red' | 'green' | 'purple' | 'orange' | 'blue' | 'gray';
}

const colorMap: Record<string, string> = {
  red:    'bg-red-900/30 text-red-400 border border-red-800/40',
  green:  'bg-emerald-900/30 text-emerald-400 border border-emerald-800/40',
  purple: 'bg-purple-900/30 text-purple-400 border border-purple-800/40',
  orange: 'bg-amber-900/30 text-amber-400 border border-amber-800/40',
  blue:   'bg-blue-900/30 text-blue-400 border border-blue-800/40',
  gray:   'bg-white/5 text-gray-400 border border-white/10',
};

export function TagBadge({ label, color = 'gray' }: Props) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colorMap[color]}`}>
      {label}
    </span>
  );
}
```

`src/components/shared/VelocityBar.tsx`:
```tsx
interface Props { score: number }

export function VelocityBar({ score }: Props) {
  const pct = Math.min((score / 3) * 100, 100);
  const color = score >= 2 ? 'bg-red-500' : score >= 1.5 ? 'bg-amber-500' : 'bg-blue-500';
  return (
    <div className="flex items-center gap-2">
      <div className="w-12 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-xs tabular-nums ${score >= 2 ? 'text-red-400' : score >= 1.5 ? 'text-amber-400' : 'text-blue-400'}`}>
        {score.toFixed(1)}x
      </span>
    </div>
  );
}
```

`src/components/shared/FreshnessBanner.tsx`:
```tsx
interface Props { computedAt: string | undefined; label: string }

export function FreshnessBanner({ computedAt, label }: Props) {
  if (!computedAt) return null;
  const mins = Math.floor((Date.now() - new Date(computedAt).getTime()) / 60000);
  if (mins < 30) return null;
  return (
    <div className="text-xs text-amber-400 bg-amber-900/20 border border-amber-800/30 rounded px-3 py-1.5">
      ⚠️ {label}缓存已 {mins} 分钟未更新
    </div>
  );
}
```

`src/components/shared/LlmLoadingState.tsx`:
```tsx
export function LlmLoadingState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-4 text-gray-400">
      <div className="w-8 h-8 border-2 border-white/20 border-t-red-500 rounded-full animate-spin" />
      <p className="text-sm">AI 正在处理，需要 30–120 秒，请稍候…</p>
    </div>
  );
}
```

`src/components/shared/ErrorBanner.tsx`:
```tsx
interface Props { message: string }
export function ErrorBanner({ message }: Props) {
  return (
    <div className="text-sm text-red-400 bg-red-900/20 border border-red-800/30 rounded px-3 py-2">
      ⚠️ {message}
    </div>
  );
}
```

- [ ] **Step 8: Create TopNav + Layout**

`src/components/layout/TopNav.tsx`:
```tsx
import { NavLink } from 'react-router-dom';

const tabs = [
  { to: '/',            label: '📋 简报' },
  { to: '/queue',       label: '💡 选题' },
  { to: '/trends',      label: '🔥 热点' },
  { to: '/competitors', label: '👥 竞品' },
  { to: '/viral-kb',    label: '🏆 爆款库' },
  { to: '/advice',      label: '🎯 建议' },
];

export function TopNav() {
  return (
    <nav className="bg-[#111128] border-b border-white/8 flex items-center px-4 sticky top-0 z-10">
      <span className="text-[#e94560] font-bold text-sm pr-4 py-2.5">MissV Ops</span>
      {tabs.map(({ to, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className={({ isActive }) =>
            `text-xs px-3 py-3 border-b-2 transition-colors ${
              isActive
                ? 'text-white border-[#e94560]'
                : 'text-gray-400 border-transparent hover:text-white'
            }`
          }
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
```

`src/components/layout/Layout.tsx`:
```tsx
import { TopNav } from './TopNav';

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#0d0d1a] text-white">
      <TopNav />
      <main className="p-0">{children}</main>
    </div>
  );
}
```

- [ ] **Step 9: Wire up main.tsx and App.tsx**

`src/main.tsx`:
```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import App from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 3, staleTime: 30_000 },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <App />
        <Toaster position="bottom-right" toastOptions={{ style: { background: '#1a1a2e', color: '#fff', border: '1px solid rgba(255,255,255,0.1)' } }} />
      </HashRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
```

`src/App.tsx`:
```tsx
import { Routes, Route } from 'react-router-dom';
import { Layout } from './components/layout/Layout';
import { Brief } from './pages/Brief';
import { Queue } from './pages/Queue';
import { Trends } from './pages/Trends';
import { Competitors } from './pages/Competitors';
import { ViralKB } from './pages/ViralKB';
import { Advice } from './pages/Advice';

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/"            element={<Brief />} />
        <Route path="/queue"       element={<Queue />} />
        <Route path="/trends"      element={<Trends />} />
        <Route path="/competitors" element={<Competitors />} />
        <Route path="/viral-kb"    element={<ViralKB />} />
        <Route path="/advice"      element={<Advice />} />
      </Routes>
    </Layout>
  );
}
```

- [ ] **Step 10: Create stub pages to verify routing**

Create each of the 6 pages as stubs — use this pattern for all:

`src/pages/Brief.tsx`:
```tsx
export function Brief() {
  return <div className="p-6 text-gray-400">📋 Brief — coming soon</div>;
}
```

Repeat for `Queue.tsx`, `Trends.tsx`, `Competitors.tsx`, `ViralKB.tsx`, `Advice.tsx` with their respective labels.

- [ ] **Step 11: Run dev server and verify routing**

```bash
npm run dev
```

Open http://localhost:5173 in browser. Expected:
- Dark background (`#0d0d1a`)
- Top nav with 6 tabs, all clickable
- Each tab shows its stub text
- No console errors

- [ ] **Step 12: Verify API connection**

Add this temporary test in `Brief.tsx`:

```tsx
import { useEffect } from 'react';
import { api } from '../api/endpoints';

export function Brief() {
  useEffect(() => {
    api.getStatus().then(s => console.log('[status]', s)).catch(console.error);
  }, []);
  return <div className="p-6 text-gray-400">📋 Brief — connecting to API…</div>;
}
```

Check browser console. Expected: `[status] {persona_name: "V姐", ok: true, ...}`.

Remove the test code after verifying.

- [ ] **Step 13: Init git repo and commit**

```bash
cd missv-ops-web
git init
echo "node_modules\ndist\n.env" > .gitignore
git add .
git commit -m "feat: scaffold missv-ops-web with Vite + React + Tailwind + routing + API client"
```

---

## Task 6: Queue page

**Files:**
- Create: `src/hooks/useQueue.ts`
- Create: `src/components/queue/QueueList.tsx`
- Create: `src/components/queue/QueueItem.tsx`
- Create: `src/components/queue/QueueDetail.tsx`
- Modify: `src/pages/Queue.tsx`

- [ ] **Step 1: Create `src/hooks/useQueue.ts`**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { api } from '../api/endpoints';
import { QueueItemContent } from '../types/api';

export function useQueue() {
  return useQuery({
    queryKey: ['queue'],
    queryFn: () => api.getQueue(),
    refetchInterval: 30_000,
  });
}

export function useApproveItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => api.approveItem(id, reason),
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: ['queue'] });
      const prev = qc.getQueryData(['queue']);
      qc.setQueryData(['queue'], (old: any) => ({
        ...old,
        items: old.items.map((i: any) => i.id === id ? { ...i, status: 'approved' } : i),
      }));
      return { prev };
    },
    onError: (_err, _v, ctx) => {
      qc.setQueryData(['queue'], ctx?.prev);
      toast.error('通过失败，已回滚');
    },
    onSuccess: () => {
      toast.success('已通过 ✓');
      qc.invalidateQueries({ queryKey: ['queue'] });
    },
  });
}

export function useDiscardItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => api.discardItem(id, reason),
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: ['queue'] });
      const prev = qc.getQueryData(['queue']);
      qc.setQueryData(['queue'], (old: any) => ({
        ...old,
        items: old.items.map((i: any) => i.id === id ? { ...i, status: 'discarded' } : i),
      }));
      return { prev };
    },
    onError: (_err, _v, ctx) => {
      qc.setQueryData(['queue'], ctx?.prev);
      toast.error('弃置失败，已回滚');
    },
    onSuccess: () => {
      toast.success('已弃置');
      qc.invalidateQueries({ queryKey: ['queue'] });
    },
  });
}

export function useUpdateItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, content, instruction, field }: {
      id: string;
      content: Partial<QueueItemContent>;
      instruction: string;
      field: string;
    }) => api.updateItemContent(id, content, instruction, field),
    onSuccess: () => {
      toast.success('已保存');
      qc.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: () => toast.error('保存失败'),
  });
}

export function useGenerateIdea() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (direction?: string) => api.generateIdea(direction),
    onSuccess: ({ output }) => {
      toast.success('选题已生成');
      console.log('[idea]', output);
      qc.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: () => toast.error('生成失败'),
  });
}

export function useBatchReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sub?: 'approve-all' | 'discard-low') => api.batchReview(sub),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue'] });
      toast.success('批量操作完成');
    },
    onError: () => toast.error('批量操作失败'),
  });
}
```

- [ ] **Step 2: Create `src/components/queue/QueueItem.tsx`**

```tsx
import { QueueItem as QItem } from '../../types/api';
import { TagBadge } from '../shared/TagBadge';

interface Props {
  item: QItem;
  isSelected: boolean;
  onClick: () => void;
}

const identityColor: Record<string, 'red' | 'blue' | 'orange' | 'purple' | 'green'> = {
  esports: 'red', racer: 'orange', singer: 'blue', daily: 'green',
};

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m前`;
  return `${Math.floor(mins / 60)}h前`;
}

export function QueueItem({ item, isSelected, onClick }: Props) {
  const isPending = item.status === 'pending';
  return (
    <div
      onClick={onClick}
      className={`px-3.5 py-3 cursor-pointer border-l-2 transition-colors ${
        isSelected
          ? 'bg-red-950/30 border-[#e94560]'
          : isPending
          ? 'border-transparent hover:bg-white/3'
          : 'border-transparent opacity-50 hover:opacity-70'
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        {isPending
          ? <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-400 border border-amber-800/40">待审核</span>
          : <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-gray-500 border border-white/10">{item.status}</span>
        }
        <TagBadge label={item.identity_mode} color={identityColor[item.identity_mode] ?? 'gray'} />
      </div>
      <p className="text-xs text-white/90 leading-snug mb-1 line-clamp-2">{item.topic}</p>
      <p className="text-[10px] text-gray-500 truncate">{item.trend_hook} · {timeAgo(item.created_at)}</p>
    </div>
  );
}
```

- [ ] **Step 3: Create `src/components/queue/QueueList.tsx`**

```tsx
import { QueueItem as QItem } from '../../types/api';
import { QueueItem } from './QueueItem';

interface Props {
  items: QItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function QueueList({ items, selectedId, onSelect }: Props) {
  const pending  = items.filter(i => i.status === 'pending');
  const others   = items.filter(i => i.status !== 'pending');

  return (
    <div className="overflow-y-auto h-full">
      {pending.map(item => (
        <QueueItem key={item.id} item={item} isSelected={selectedId === item.id} onClick={() => onSelect(item.id)} />
      ))}
      {others.length > 0 && (
        <>
          <div className="px-3.5 py-1.5 bg-black/30">
            <span className="text-[10px] text-gray-600">— 已处理 —</span>
          </div>
          {others.map(item => (
            <QueueItem key={item.id} item={item} isSelected={selectedId === item.id} onClick={() => onSelect(item.id)} />
          ))}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Create `src/components/queue/QueueDetail.tsx`**

```tsx
import { useState } from 'react';
import { QueueItem, QueueItemContent } from '../../types/api';
import { TagBadge } from '../shared/TagBadge';
import { useApproveItem, useDiscardItem, useUpdateItem } from '../../hooks/useQueue';

interface Props { item: QueueItem }

export function QueueDetail({ item }: Props) {
  const [tab, setTab] = useState<'xhs' | 'douyin'>('xhs');
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(item.content.xhs.title);
  const [editBody,  setEditBody]  = useState(item.content.xhs.body);

  const approve = useApproveItem();
  const discard = useDiscardItem();
  const update  = useUpdateItem();

  const isPending = item.status === 'pending';

  function handleSave() {
    update.mutate({
      id: item.id,
      content: { xhs: { ...item.content.xhs, title: editTitle, body: editBody } },
      instruction: `修改标题为: ${editTitle}`,
      field: 'xhs.title',
    }, { onSuccess: () => setEditing(false) });
  }

  return (
    <div className="overflow-y-auto h-full p-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-sm font-semibold text-white leading-snug mb-2">{item.topic}</h2>
          <div className="flex flex-wrap gap-1.5">
            <TagBadge label={item.identity_mode} color="red" />
            {item.competitor_benchmarks?.slice(0, 1).map(b => (
              <TagBadge key={b.name} label={b.name} color="purple" />
            ))}
          </div>
        </div>
        {isPending && (
          <div className="flex gap-1.5 flex-shrink-0">
            <button
              onClick={() => approve.mutate({ id: item.id })}
              disabled={approve.isPending}
              className="text-xs px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium disabled:opacity-50"
            >✓ 通过</button>
            <button
              onClick={() => setEditing(!editing)}
              className="text-xs px-3 py-1.5 rounded bg-white/8 hover:bg-white/12 text-gray-300 border border-white/10"
            >✏ 改</button>
            <button
              onClick={() => discard.mutate({ id: item.id })}
              disabled={discard.isPending}
              className="text-xs px-3 py-1.5 rounded bg-red-950/40 hover:bg-red-900/40 text-red-400 border border-red-800/30 disabled:opacity-50"
            >✕</button>
          </div>
        )}
      </div>

      {/* Trend hook */}
      <div className="bg-amber-900/10 border border-amber-800/25 rounded-md px-3 py-2 mb-3">
        <p className="text-[10px] text-amber-400 mb-1">🎯 热点钩子</p>
        <p className="text-xs text-gray-300">{item.trend_hook}</p>
      </div>

      {/* Inline edit */}
      {editing && (
        <div className="bg-white/5 border border-white/10 rounded-md p-3 mb-3">
          <p className="text-[10px] text-gray-400 mb-2">编辑标题</p>
          <input
            value={editTitle}
            onChange={e => setEditTitle(e.target.value)}
            className="w-full bg-white/8 border border-white/15 rounded px-2 py-1.5 text-xs text-white mb-2 outline-none focus:border-[#e94560]"
          />
          <p className="text-[10px] text-gray-400 mb-2">编辑正文</p>
          <textarea
            value={editBody}
            onChange={e => setEditBody(e.target.value)}
            rows={4}
            className="w-full bg-white/8 border border-white/15 rounded px-2 py-1.5 text-xs text-white outline-none focus:border-[#e94560] resize-none"
          />
          <div className="flex gap-2 mt-2">
            <button onClick={handleSave} disabled={update.isPending}
              className="text-xs px-3 py-1 rounded bg-[#e94560] text-white disabled:opacity-50">
              保存
            </button>
            <button onClick={() => setEditing(false)} className="text-xs px-3 py-1 rounded bg-white/8 text-gray-300">
              取消
            </button>
          </div>
        </div>
      )}

      {/* Platform tabs */}
      <div className="flex border-b border-white/8 mb-3">
        {(['xhs', 'douyin'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`text-xs px-3 py-2 border-b-2 transition-colors ${tab === t ? 'text-white border-[#e94560]' : 'text-gray-400 border-transparent'}`}>
            {t === 'xhs' ? '小红书图文' : '抖音脚本'}
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === 'xhs' ? (
        <div className="bg-white/4 rounded-md p-3 text-xs space-y-2">
          <p className="text-[10px] text-gray-500">封面文案</p>
          <p className="text-white font-semibold">{item.content.xhs.title}</p>
          <p className="text-[10px] text-gray-500">正文</p>
          <p className="text-gray-300 leading-relaxed">{item.content.xhs.body}</p>
          <p className="text-[10px] text-gray-500 mt-2">{item.content.xhs.tags.map(t => `#${t}`).join(' ')}</p>
        </div>
      ) : (
        <div className="bg-white/4 rounded-md p-3 text-xs space-y-2">
          <p className="text-[10px] text-gray-500">脚本</p>
          <p className="text-gray-300 leading-relaxed">{item.content.douyin.script}</p>
          <p className="text-[10px] text-gray-500">BGM</p>
          <p className="text-gray-300">{item.content.douyin.bgm_suggestion}</p>
          <p className="text-[10px] text-gray-500">时长</p>
          <p className="text-gray-300">{item.content.douyin.total_duration}</p>
        </div>
      )}

      {/* Competitor benchmarks */}
      {item.competitor_benchmarks && item.competitor_benchmarks.length > 0 && (
        <div className="bg-purple-900/10 border border-purple-800/25 rounded-md px-3 py-2 mt-3">
          <p className="text-[10px] text-purple-400 mb-1.5">📊 参考竞品</p>
          {item.competitor_benchmarks.slice(0, 2).map(b => (
            <p key={b.name} className="text-xs text-gray-400">{b.name} · {b.platform}</p>
          ))}
        </div>
      )}

      {/* Image prompts */}
      {item.image_prompts && item.image_prompts.length > 0 && (
        <div className="bg-white/4 rounded-md p-3 mt-3">
          <p className="text-[10px] text-gray-500 mb-1.5">🖼 图片 Prompt</p>
          {item.image_prompts.map((p, i) => (
            <p key={i} className="text-xs text-gray-400 mb-1">{i + 1}. {p}</p>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Implement `src/pages/Queue.tsx`**

```tsx
import { useState } from 'react';
import { useQueue, useGenerateIdea, useBatchReview } from '../hooks/useQueue';
import { QueueList } from '../components/queue/QueueList';
import { QueueDetail } from '../components/queue/QueueDetail';
import { ErrorBanner } from '../components/shared/ErrorBanner';

export function Queue() {
  const { data, isLoading, error } = useQueue();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const generateIdea = useGenerateIdea();
  const batchReview  = useBatchReview();

  const items = data?.items ?? [];
  const pending = items.filter(i => i.status === 'pending').length;
  const published = items.filter(i => i.status === 'published').length;
  const selectedItem = items.find(i => i.id === selectedId) ?? null;

  return (
    <div className="flex flex-col h-[calc(100vh-41px)]">
      {/* Toolbar */}
      <div className="bg-[#111128] border-b border-white/6 px-4 py-2 flex items-center gap-2 flex-shrink-0">
        <span className="text-xs text-gray-400">
          待审核 <strong className="text-amber-400">{pending}</strong>
          <span className="mx-2 text-gray-700">·</span>
          已发布 <strong className="text-emerald-400">{published}</strong>
        </span>
        <div className="flex-1" />
        <button
          onClick={() => generateIdea.mutate(undefined)}
          disabled={generateIdea.isPending}
          className="text-xs px-3 py-1.5 rounded bg-[#e94560] text-white hover:bg-red-500 disabled:opacity-50"
        >
          {generateIdea.isPending ? '生成中…' : '＋ 生成新选题'}
        </button>
        <button
          onClick={() => batchReview.mutate(undefined)}
          disabled={batchReview.isPending}
          className="text-xs px-3 py-1.5 rounded bg-white/6 text-gray-300 border border-white/10 hover:bg-white/10 disabled:opacity-50"
        >
          AI 批量审核
        </button>
        <button
          onClick={() => batchReview.mutate('approve-all')}
          disabled={batchReview.isPending}
          className="text-xs px-3 py-1.5 rounded bg-white/6 text-gray-300 border border-white/10 hover:bg-white/10 disabled:opacity-50"
        >
          全部通过
        </button>
      </div>

      {error && <div className="p-4"><ErrorBanner message={String(error)} /></div>}
      {isLoading && <div className="p-6 text-xs text-gray-500">加载中…</div>}

      {/* List + Detail */}
      <div className="flex flex-1 overflow-hidden">
        <div className="w-72 border-r border-white/8 flex-shrink-0">
          <QueueList items={items} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
        <div className="flex-1">
          {selectedItem
            ? <QueueDetail item={selectedItem} />
            : <div className="flex items-center justify-center h-full text-xs text-gray-600">← 选择一条选题查看详情</div>
          }
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Test in browser**

```bash
npm run dev
```

Navigate to `/#/queue`. Expected:
- Toolbar with counts
- Left panel shows pending items (if any)
- Clicking an item shows right panel with XHS/抖音 tabs, approve/discard buttons
- Approve button triggers optimistic update (status changes immediately)

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useQueue.ts src/components/queue/ src/pages/Queue.tsx
git commit -m "feat: implement Queue page with optimistic approve/discard and inline edit"
```

---

## Task 7: Trends page

**Files:**
- Create: `src/hooks/useTrends.ts`
- Modify: `src/pages/Trends.tsx`

- [ ] **Step 1: Create `src/hooks/useTrends.ts`**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { api } from '../api/endpoints';

export function useTrends() {
  return useQuery({
    queryKey: ['trends'],
    queryFn: () => api.getTrends(),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
}

export function useGenerateIdeaFromTrend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (direction: string) => api.generateIdea(direction),
    onSuccess: () => {
      toast.success('选题已生成，前往选题队列查看');
      qc.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: () => toast.error('生成失败'),
  });
}
```

- [ ] **Step 2: Implement `src/pages/Trends.tsx`**

```tsx
import { useTrends, useGenerateIdeaFromTrend } from '../hooks/useTrends';
import { VelocityBar } from '../components/shared/VelocityBar';
import { FreshnessBanner } from '../components/shared/FreshnessBanner';
import { ErrorBanner } from '../components/shared/ErrorBanner';
import { FilteredTrend } from '../types/api';
import { useQueryClient } from '@tanstack/react-query';

const BUCKET_LABELS: Record<string, string> = {
  '赛道 Tag': '🏷️ 推荐流',
  '热榜':    '📰 热榜',
  '搜索':    '🔍 搜索',
};
const BUCKET_ORDER = ['赛道 Tag', '搜索', '热榜'];

export function Trends() {
  const { data, isLoading, error } = useTrends();
  const qc = useQueryClient();
  const generateIdea = useGenerateIdeaFromTrend();

  const results = data?.results ?? [];
  const signalPool = data?.signal_pool ?? [];

  // Group by source_bucket
  const grouped = new Map<string, FilteredTrend[]>();
  for (const t of results) {
    const b = t.source_bucket ?? '热榜';
    if (!grouped.has(b)) grouped.set(b, []);
    grouped.get(b)!.push(t);
  }

  return (
    <div className="flex flex-col h-[calc(100vh-41px)]">
      {/* Toolbar */}
      <div className="bg-[#111128] border-b border-white/6 px-4 py-2 flex items-center gap-2 flex-shrink-0">
        <span className="text-xs text-gray-400">
          {results.length} 条通过过滤
        </span>
        <div className="flex-1" />
        {data?.computed_at && (
          <span className="text-[10px] text-gray-600">
            {Math.floor((Date.now() - new Date(data.computed_at).getTime()) / 60000)}min 前更新
          </span>
        )}
        <button
          onClick={() => qc.invalidateQueries({ queryKey: ['trends'] })}
          className="text-xs px-3 py-1.5 rounded bg-orange-900/20 text-orange-400 border border-orange-800/30 hover:bg-orange-900/30"
        >
          刷新
        </button>
      </div>

      {error && <div className="p-4"><ErrorBanner message={String(error)} /></div>}

      <div className="flex flex-1 overflow-hidden">
        {/* Main list */}
        <div className="flex-1 overflow-y-auto p-4">
          {isLoading && <p className="text-xs text-gray-500">加载中…</p>}
          {BUCKET_ORDER.map(bucket => {
            const items = grouped.get(bucket);
            if (!items || items.length === 0) return null;
            return (
              <div key={bucket} className="mb-6">
                <h3 className="text-xs text-gray-400 mb-3">
                  {BUCKET_LABELS[bucket] ?? bucket}（{items.length}）
                </h3>
                <div className="space-y-2">
                  {items.map(t => (
                    <div
                      key={t.keyword + t.platform}
                      className="flex items-center gap-3 bg-white/3 hover:bg-white/5 rounded-md px-3 py-2 transition-colors"
                    >
                      <span className="text-sm">{t.velocity_score >= 2 ? '🔥' : '⚡'}</span>
                      <span className="text-xs text-white flex-1 font-medium">{t.keyword}</span>
                      <span className="text-[10px] text-gray-500">{t.platform}</span>
                      <VelocityBar score={t.velocity_score} />
                      <button
                        onClick={() => generateIdea.mutate(t.keyword)}
                        disabled={generateIdea.isPending}
                        className="text-[10px] px-2 py-1 rounded bg-red-950/40 text-red-400 border border-red-800/30 hover:bg-red-950/60 disabled:opacity-50 flex-shrink-0"
                      >
                        出选题
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Signal pool sidebar */}
        {signalPool.length > 0 && (
          <div className="w-48 border-l border-white/8 p-3 overflow-y-auto flex-shrink-0">
            <p className="text-[10px] text-gray-500 mb-3">📋 信号池概览</p>
            {signalPool.map(group => (
              <div key={group.bucket} className="mb-4">
                <p className="text-[10px] text-gray-600 mb-1.5">{BUCKET_LABELS[group.bucket] ?? group.bucket}</p>
                {group.top.map(t => (
                  <p key={t.keyword} className="text-[10px] text-gray-400 leading-relaxed">
                    · {t.keyword} <span className="text-gray-600">{t.v}x</span>
                  </p>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="px-4 pb-2">
        <FreshnessBanner computedAt={data?.computed_at} label="热点数据" />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Test in browser**

Navigate to `/#/trends`. Expected:
- Trends grouped by bucket
- Velocity bar shows colored progress
- 「出选题」button triggers idea generation (spinner while loading)

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useTrends.ts src/pages/Trends.tsx
git commit -m "feat: implement Trends page with bucket grouping and velocity bars"
```

---

## Task 8: Brief + Advice pages

**Files:**
- Modify: `src/pages/Brief.tsx`
- Modify: `src/pages/Advice.tsx`

- [ ] **Step 1: Implement `src/pages/Brief.tsx`**

```tsx
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { LlmLoadingState } from '../components/shared/LlmLoadingState';
import { ErrorBanner } from '../components/shared/ErrorBanner';
import { FreshnessBanner } from '../components/shared/FreshnessBanner';
import { useNavigate } from 'react-router-dom';

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-[#111128] border border-white/6 rounded-lg p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-3xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

export function Brief() {
  const navigate = useNavigate();
  const status = useQuery({ queryKey: ['status'], queryFn: api.getStatus, staleTime: 30_000 });
  const brief = useMutation({ mutationFn: api.getBrief });

  const q = status.data?.queue;

  return (
    <div className="p-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-sm font-semibold text-white">
          📋 今日简报
          {status.data && <span className="text-gray-500 font-normal ml-2">— {status.data.persona_name}</span>}
        </h1>
        <button
          onClick={() => brief.mutate()}
          disabled={brief.isPending}
          className="text-xs px-4 py-2 rounded bg-[#e94560] text-white hover:bg-red-500 disabled:opacity-50"
        >
          {brief.isPending ? '生成中…' : '生成/刷新简报'}
        </button>
      </div>

      {/* Stats */}
      {q && (
        <div className="grid grid-cols-4 gap-3 mb-6">
          <StatCard label="待审核选题" value={q.pending}   color="text-amber-400" />
          <StatCard label="已发布"     value={q.published} color="text-emerald-400" />
          <StatCard label="已弃置"     value={q.discarded} color="text-gray-500" />
          <StatCard label="总条目"     value={q.total}     color="text-gray-300" />
        </div>
      )}

      {/* LLM output */}
      {brief.isPending && <LlmLoadingState />}
      {brief.isError && <ErrorBanner message={String(brief.error)} />}
      {brief.data && (
        <div className="bg-[#111128] border border-white/6 rounded-lg p-5">
          <pre className="text-xs text-gray-300 whitespace-pre-wrap leading-relaxed font-sans">
            {brief.data.output}
          </pre>
          <div className="mt-4 pt-3 border-t border-white/6">
            <button
              onClick={() => navigate('/queue')}
              className="text-xs text-red-400 hover:text-red-300"
            >
              → 前往选题队列审核
            </button>
          </div>
        </div>
      )}

      {!brief.data && !brief.isPending && (
        <div className="bg-[#111128] border border-white/6 rounded-lg p-8 text-center text-gray-600 text-sm">
          点击「生成/刷新简报」获取今日运营摘要
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Implement `src/pages/Advice.tsx`**

```tsx
import { useMutation } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { LlmLoadingState } from '../components/shared/LlmLoadingState';
import { ErrorBanner } from '../components/shared/ErrorBanner';

export function Advice() {
  const advice = useMutation({ mutationFn: api.getAdvice });

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-sm font-semibold text-white">🎯 人设建议</h1>
        <button
          onClick={() => advice.mutate()}
          disabled={advice.isPending}
          className="text-xs px-4 py-2 rounded bg-purple-700 text-white hover:bg-purple-600 disabled:opacity-50"
        >
          {advice.isPending ? '分析中…' : '生成建议'}
        </button>
      </div>

      {advice.isPending && <LlmLoadingState />}
      {advice.isError && <ErrorBanner message={String(advice.error)} />}
      {advice.data && (
        <div className="bg-[#111128] border border-white/6 rounded-lg p-5">
          <pre className="text-xs text-gray-300 whitespace-pre-wrap leading-relaxed font-sans">
            {advice.data.output}
          </pre>
        </div>
      )}

      {!advice.data && !advice.isPending && (
        <div className="bg-[#111128] border border-white/6 rounded-lg p-8 text-center text-gray-600 text-sm">
          点击「生成建议」获取人设对齐分析（需要 30–120 秒）
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Test**

Navigate to `/#/`. Expected: stat cards visible (requires `/status` to work). Click 「生成/刷新简报」— spinner shows, after completion formatted text appears.

Navigate to `/#/advice`. Expected: same pattern with 「生成建议」button.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Brief.tsx src/pages/Advice.tsx
git commit -m "feat: implement Brief and Advice pages"
```

---

## Task 9: Competitors page

**Files:**
- Create: `src/hooks/useCompetitors.ts`
- Create: `src/components/competitors/CompetitorCard.tsx`
- Create: `src/components/competitors/CompetitorList.tsx`
- Create: `src/components/competitors/CompetitorDetail.tsx`
- Create: `src/components/competitors/CompetitorForm.tsx`
- Modify: `src/pages/Competitors.tsx`

- [ ] **Step 1: Create `src/hooks/useCompetitors.ts`**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { api } from '../api/endpoints';
import { CompetitorProfile } from '../types/api';

export function useCompetitors() {
  return useQuery({
    queryKey: ['competitors'],
    queryFn: () => api.getCompetitors(),
    staleTime: 2 * 60_000,
  });
}

export function useAddCompetitor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Partial<CompetitorProfile> & { name: string; platform: string }) => api.addCompetitor(p),
    onSuccess: () => { toast.success('竞品已添加'); qc.invalidateQueries({ queryKey: ['competitors'] }); },
    onError: () => toast.error('添加失败'),
  });
}

export function useUpdateCompetitor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, platform, profile }: { name: string; platform: string; profile: Partial<CompetitorProfile> }) =>
      api.updateCompetitor(name, platform, profile),
    onSuccess: () => { toast.success('已更新'); qc.invalidateQueries({ queryKey: ['competitors'] }); },
    onError: () => toast.error('更新失败'),
  });
}

export function useDeleteCompetitor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, platform }: { name: string; platform: string }) => api.deleteCompetitor(name, platform),
    onSuccess: () => { toast.success('已删除'); qc.invalidateQueries({ queryKey: ['competitors'] }); },
    onError: () => toast.error('删除失败'),
  });
}

export function useAnalyzeUrl() {
  return useMutation({
    mutationFn: (url: string) => api.analyzeUrl(url),
    onError: () => toast.error('拆解失败'),
  });
}
```

- [ ] **Step 2: Create `src/components/competitors/CompetitorCard.tsx`**

```tsx
import { CompetitorWithTracking } from '../../types/api';

interface Props {
  competitor: CompetitorWithTracking;
  isSelected: boolean;
  onClick: () => void;
}

export function CompetitorCard({ competitor: c, isSelected, onClick }: Props) {
  const initial = c.name.charAt(0);
  const failed = c.tracking?.days_since_last_post === -1;

  return (
    <div
      onClick={onClick}
      className={`px-3.5 py-3 cursor-pointer border-l-2 transition-colors ${
        isSelected ? 'bg-purple-950/20 border-[#a64dff]' : 'border-transparent hover:bg-white/3'
      } ${failed ? 'opacity-40' : ''}`}
    >
      <div className="flex items-center gap-2.5 mb-2">
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#e94560] to-[#a64dff] flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
          {initial}
        </div>
        <div className="min-w-0">
          <p className="text-xs text-white font-medium truncate">{c.name}</p>
          <p className="text-[10px] text-gray-500">{c.platform} · {c.tag}</p>
        </div>
      </div>
      {failed
        ? <p className="text-[10px] text-red-500">拉取失败</p>
        : c.tracking?.latest_post
        ? <p className="text-[10px] text-gray-400 truncate">今日: 「{c.tracking.latest_post.topic.slice(0, 20)}」互动 {c.tracking.latest_post.engagement}</p>
        : <p className="text-[10px] text-gray-600">{c.tracking ? `${c.tracking.days_since_last_post}天未更新` : '暂无数据'}</p>
      }
    </div>
  );
}
```

- [ ] **Step 3: Create `src/components/competitors/CompetitorList.tsx`**

```tsx
import { CompetitorWithTracking } from '../../types/api';
import { CompetitorCard } from './CompetitorCard';

interface Props {
  competitors: CompetitorWithTracking[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  filterGroup: string;
  groups: string[];
  onFilterChange: (g: string) => void;
  onAdd: () => void;
}

function makeKey(c: CompetitorWithTracking) { return `${c.name}::${c.platform}`; }

export function CompetitorList({ competitors, selectedKey, onSelect, filterGroup, groups, onFilterChange, onAdd }: Props) {
  const filtered = filterGroup === 'all'
    ? competitors
    : competitors.filter(c => (c.group ?? c.tag) === filterGroup);

  return (
    <div className="flex flex-col h-full">
      {/* Group filter */}
      <div className="px-3 py-2 border-b border-white/6 flex flex-wrap gap-1">
        <button
          onClick={() => onFilterChange('all')}
          className={`text-[10px] px-2 py-1 rounded transition-colors ${filterGroup === 'all' ? 'bg-purple-900/30 text-purple-400 border border-purple-800/40' : 'bg-white/4 text-gray-500 border border-white/8 hover:text-gray-300'}`}
        >
          全部 {competitors.length}
        </button>
        {groups.map(g => (
          <button
            key={g}
            onClick={() => onFilterChange(g)}
            className={`text-[10px] px-2 py-1 rounded transition-colors ${filterGroup === g ? 'bg-purple-900/30 text-purple-400 border border-purple-800/40' : 'bg-white/4 text-gray-500 border border-white/8 hover:text-gray-300'}`}
          >
            {g}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.map(c => (
          <CompetitorCard
            key={makeKey(c)}
            competitor={c}
            isSelected={selectedKey === makeKey(c)}
            onClick={() => onSelect(makeKey(c))}
          />
        ))}
      </div>

      <div className="p-3 border-t border-white/6">
        <button onClick={onAdd} className="w-full text-xs py-2 rounded bg-purple-700 text-white hover:bg-purple-600">
          ＋ 添加竞品
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create `src/components/competitors/CompetitorDetail.tsx`**

```tsx
import { useState } from 'react';
import { CompetitorWithTracking } from '../../types/api';
import { useAnalyzeUrl, useDeleteCompetitor } from '../../hooks/useCompetitors';

interface Props {
  competitor: CompetitorWithTracking;
  onEdit: () => void;
}

export function CompetitorDetail({ competitor: c, onEdit }: Props) {
  const [analyzeUrl, setAnalyzeUrl] = useState('');
  const [showAnalysis, setShowAnalysis] = useState(false);
  const analyze = useAnalyzeUrl();
  const del = useDeleteCompetitor();

  const mix = c.content_mix ?? {};
  const mixEntries = Object.entries(mix).sort((a, b) => b[1] - a[1]);
  const mixColors = ['bg-[#e94560]', 'bg-[#a64dff]', 'bg-[#4db6ff]', 'bg-[#00d4aa]', 'bg-[#f0a500]'];

  return (
    <div className="overflow-y-auto h-full p-4">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#e94560] to-[#a64dff] flex items-center justify-center text-base font-bold text-white">
            {c.name.charAt(0)}
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white">{c.name}</h2>
            {c.url
              ? <a href={c.url} target="_blank" rel="noreferrer" className="text-[10px] text-gray-500 hover:text-gray-300">{c.platform} ↗</a>
              : <p className="text-[10px] text-gray-500">{c.platform}</p>
            }
          </div>
        </div>
        <div className="flex gap-1.5">
          <button onClick={onEdit} className="text-xs px-2.5 py-1 rounded bg-white/6 text-gray-300 border border-white/10 hover:bg-white/10">✏ 编辑</button>
          <button
            onClick={() => { if (confirm(`删除竞品 ${c.name}?`)) del.mutate({ name: c.name, platform: c.platform }); }}
            className="text-xs px-2.5 py-1 rounded bg-red-950/30 text-red-400 border border-red-800/25 hover:bg-red-950/50"
          >删除</button>
        </div>
      </div>

      {/* Content mix bar */}
      {mixEntries.length > 0 && (
        <div className="mb-4">
          <p className="text-[10px] text-gray-500 mb-2">内容混合比例</p>
          <div className="flex rounded overflow-hidden h-4 mb-1.5">
            {mixEntries.map(([label, pct], i) => (
              <div key={label} className={`${mixColors[i % mixColors.length]} flex items-center justify-center`} style={{ width: `${pct}%` }}>
                <span className="text-[8px] text-white truncate px-1">{pct > 10 ? `${label} ${pct}%` : ''}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {mixEntries.map(([label, pct], i) => (
              <span key={label} className="text-[9px] text-gray-400">
                <span className={`inline-block w-2 h-2 rounded-full mr-1 ${mixColors[i % mixColors.length]}`} />
                {label} {pct}%
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Audience + Interaction */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        {c.audience && (
          <div className="bg-white/4 rounded-md p-2.5">
            <p className="text-[10px] text-gray-500 mb-1">受众画像</p>
            <p className="text-xs text-gray-300 leading-relaxed">{c.audience}</p>
          </div>
        )}
        {c.interaction_style && (
          <div className="bg-white/4 rounded-md p-2.5">
            <p className="text-[10px] text-gray-500 mb-1">互动风格</p>
            <p className="text-xs text-gray-300 leading-relaxed">{c.interaction_style}</p>
          </div>
        )}
      </div>

      {/* Takeaways */}
      {c.takeaways && c.takeaways.length > 0 && (
        <div className="bg-emerald-900/10 border border-emerald-800/20 rounded-md p-2.5 mb-3">
          <p className="text-[10px] text-emerald-400 mb-1.5">💡 可学习</p>
          {c.takeaways.map((t, i) => <p key={i} className="text-xs text-gray-300 leading-relaxed">· {t}</p>)}
        </div>
      )}

      {/* Avoid */}
      {c.avoid && c.avoid.length > 0 && (
        <div className="bg-red-900/10 border border-red-800/20 rounded-md p-2.5 mb-3">
          <p className="text-[10px] text-red-400 mb-1.5">⚠️ 避坑</p>
          {c.avoid.map((t, i) => <p key={i} className="text-xs text-gray-300 leading-relaxed">· {t}</p>)}
        </div>
      )}

      {/* Recent posts */}
      {c.tracking?.recent_posts && c.tracking.recent_posts.length > 0 && (
        <div className="mb-4">
          <p className="text-[10px] text-gray-500 mb-2">最近内容</p>
          {c.tracking.recent_posts.slice(0, 3).map((p, i) => (
            <div key={i} className="bg-white/4 rounded-md px-3 py-2 mb-1.5">
              <div className="flex justify-between items-center mb-1">
                <p className="text-xs text-gray-300 truncate flex-1">{p.topic}</p>
                <p className="text-[10px] text-amber-400 ml-2 flex-shrink-0">互动 {p.engagement}</p>
              </div>
              <div className="flex items-center gap-2">
                {p.posted_at && <span className="text-[9px] text-gray-600">{p.posted_at}</span>}
                <button
                  onClick={() => { setAnalyzeUrl(`${c.url ?? c.name}/${p.topic}`); setShowAnalysis(true); }}
                  className="text-[9px] px-1.5 py-0.5 rounded bg-red-950/30 text-red-400 border border-red-800/25 hover:bg-red-950/50"
                >
                  拆解分析
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* URL analyze */}
      <div className="border-t border-white/6 pt-3">
        <p className="text-[10px] text-gray-500 mb-1.5">粘贴帖子 URL 进行爆款拆解</p>
        <div className="flex gap-2">
          <input
            value={analyzeUrl}
            onChange={e => setAnalyzeUrl(e.target.value)}
            placeholder="https://xiaohongshu.com/..."
            className="flex-1 bg-white/6 border border-white/10 rounded px-2 py-1.5 text-xs text-white outline-none focus:border-[#e94560]"
          />
          <button
            onClick={() => { analyze.mutate(analyzeUrl, { onSuccess: () => setShowAnalysis(true) }); }}
            disabled={analyze.isPending || !analyzeUrl}
            className="text-xs px-3 py-1.5 rounded bg-[#e94560] text-white disabled:opacity-50"
          >
            {analyze.isPending ? '…' : '拆解'}
          </button>
        </div>
        {showAnalysis && analyze.data && (
          <div className="mt-2 bg-white/4 rounded-md p-3">
            <pre className="text-xs text-gray-300 whitespace-pre-wrap font-sans">{analyze.data.output}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create `src/components/competitors/CompetitorForm.tsx`**

```tsx
import { useState } from 'react';
import { CompetitorWithTracking } from '../../types/api';
import { useAddCompetitor, useUpdateCompetitor } from '../../hooks/useCompetitors';

interface Props {
  existing?: CompetitorWithTracking;
  onClose: () => void;
}

export function CompetitorForm({ existing, onClose }: Props) {
  const [form, setForm] = useState({
    name: existing?.name ?? '',
    platform: existing?.platform ?? 'xhs',
    url: existing?.url ?? '',
    tag: existing?.tag ?? '',
    group: existing?.group ?? '',
    audience: existing?.audience ?? '',
    interaction_style: existing?.interaction_style ?? '',
    reference_type: existing?.reference_type ?? 'secondary',
    takeaways: existing?.takeaways?.join('\n') ?? '',
    avoid: existing?.avoid?.join('\n') ?? '',
  });

  const add = useAddCompetitor();
  const update = useUpdateCompetitor();
  const isEditing = !!existing;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = {
      ...form,
      takeaways: form.takeaways.split('\n').map(s => s.trim()).filter(Boolean),
      avoid: form.avoid.split('\n').map(s => s.trim()).filter(Boolean),
    } as any;

    if (isEditing) {
      update.mutate({ name: existing.name, platform: existing.platform, profile: payload }, { onSuccess: onClose });
    } else {
      add.mutate(payload, { onSuccess: onClose });
    }
  }

  const field = (label: string, key: keyof typeof form, type: 'text' | 'textarea' = 'text') => (
    <div className="mb-3">
      <label className="text-[10px] text-gray-500 block mb-1">{label}</label>
      {type === 'textarea'
        ? <textarea value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} rows={3}
            className="w-full bg-white/6 border border-white/10 rounded px-2 py-1.5 text-xs text-white outline-none focus:border-[#a64dff] resize-none" />
        : <input value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
            className="w-full bg-white/6 border border-white/10 rounded px-2 py-1.5 text-xs text-white outline-none focus:border-[#a64dff]" />
      }
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex justify-end" onClick={onClose}>
      <div className="bg-[#111128] w-80 h-full overflow-y-auto p-4 border-l border-white/10" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white">{isEditing ? '编辑竞品' : '添加竞品'}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg">×</button>
        </div>
        <form onSubmit={handleSubmit}>
          {field('账号名称 *', 'name')}
          <div className="mb-3">
            <label className="text-[10px] text-gray-500 block mb-1">平台 *</label>
            <select value={form.platform} onChange={e => setForm(f => ({ ...f, platform: e.target.value }))}
              className="w-full bg-white/6 border border-white/10 rounded px-2 py-1.5 text-xs text-white outline-none focus:border-[#a64dff]">
              <option value="xhs">小红书</option>
              <option value="douyin">抖音</option>
              <option value="bilibili">B站</option>
              <option value="weibo">微博</option>
              <option value="instagram">Instagram</option>
            </select>
          </div>
          {field('主页 URL', 'url')}
          {field('Tag（赛道标签）', 'tag')}
          {field('分组', 'group')}
          {field('受众画像', 'audience', 'textarea')}
          {field('互动风格', 'interaction_style', 'textarea')}
          {field('可学习（每行一条）', 'takeaways', 'textarea')}
          {field('避坑（每行一条）', 'avoid', 'textarea')}
          <div className="flex gap-2 mt-4">
            <button type="submit" disabled={add.isPending || update.isPending}
              className="flex-1 py-2 rounded bg-[#a64dff] text-white text-xs hover:bg-purple-500 disabled:opacity-50">
              {isEditing ? '保存' : '添加'}
            </button>
            <button type="button" onClick={onClose} className="flex-1 py-2 rounded bg-white/6 text-gray-300 text-xs">
              取消
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Implement `src/pages/Competitors.tsx`**

```tsx
import { useState, useMemo } from 'react';
import { useCompetitors } from '../hooks/useCompetitors';
import { CompetitorList } from '../components/competitors/CompetitorList';
import { CompetitorDetail } from '../components/competitors/CompetitorDetail';
import { CompetitorForm } from '../components/competitors/CompetitorForm';
import { FreshnessBanner } from '../components/shared/FreshnessBanner';
import { ErrorBanner } from '../components/shared/ErrorBanner';
import { CompetitorWithTracking } from '../types/api';

export function Competitors() {
  const { data, isLoading, error } = useCompetitors();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filterGroup, setFilterGroup] = useState('all');
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<CompetitorWithTracking | undefined>();

  const competitors = data?.competitors ?? [];
  const groups = useMemo(() => [...new Set(competitors.map(c => c.group ?? c.tag).filter(Boolean))], [competitors]);
  const selectedCompetitor = competitors.find(c => `${c.name}::${c.platform}` === selectedKey);

  function openAdd() { setEditTarget(undefined); setShowForm(true); }
  function openEdit() { setEditTarget(selectedCompetitor); setShowForm(true); }

  return (
    <div className="flex flex-col h-[calc(100vh-41px)]">
      {error && <div className="p-4"><ErrorBanner message={String(error)} /></div>}
      {isLoading && <div className="p-4 text-xs text-gray-500">加载中…</div>}

      <div className="flex flex-1 overflow-hidden">
        <div className="w-64 border-r border-white/8 flex-shrink-0">
          <CompetitorList
            competitors={competitors}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
            filterGroup={filterGroup}
            groups={groups}
            onFilterChange={setFilterGroup}
            onAdd={openAdd}
          />
        </div>
        <div className="flex-1">
          {selectedCompetitor
            ? <CompetitorDetail competitor={selectedCompetitor} onEdit={openEdit} />
            : <div className="flex items-center justify-center h-full text-xs text-gray-600">← 选择竞品查看详情</div>
          }
        </div>
      </div>

      <div className="px-4 pb-2">
        <FreshnessBanner computedAt={data?.computed_at} label="竞品数据" />
      </div>

      {showForm && <CompetitorForm existing={editTarget} onClose={() => setShowForm(false)} />}
    </div>
  );
}
```

- [ ] **Step 7: Test**

Navigate to `/#/competitors`. Expected:
- Group filter tags across top
- Competitor cards in left panel
- Right panel shows mix bar + takeaways
- 「＋ 添加竞品」opens drawer form
- Adding a competitor writes to `competitors-override.json`

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useCompetitors.ts src/components/competitors/ src/pages/Competitors.tsx
git commit -m "feat: implement Competitors page with override CRUD and analyze integration"
```

---

## Task 10: Viral KB page

**Files:**
- Create: `src/hooks/useViralKB.ts`
- Create: `src/components/viral-kb/EntryList.tsx`
- Create: `src/components/viral-kb/EntryDetail.tsx`
- Create: `src/components/viral-kb/FormulaList.tsx`
- Modify: `src/pages/ViralKB.tsx`

- [ ] **Step 1: Create `src/hooks/useViralKB.ts`**

```typescript
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/endpoints';

export function useViralKB(params?: { sort?: 'likes' | 'date'; hook_type?: string; identity_mode?: string }) {
  return useQuery({
    queryKey: ['viral-kb', params],
    queryFn: () => api.getViralKB(params),
    staleTime: 10 * 60_000,
  });
}

export function useFormulas() {
  return useQuery({
    queryKey: ['viral-kb-formulas'],
    queryFn: () => api.getFormulas(),
    staleTime: 10 * 60_000,
  });
}
```

- [ ] **Step 2: Create `src/components/viral-kb/EntryList.tsx`**

```tsx
import { ViralEntry } from '../../types/api';
import { TagBadge } from '../shared/TagBadge';

interface Props {
  entries: ViralEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function formatLikes(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`;
  return String(n);
}

export function EntryList({ entries, selectedId, onSelect }: Props) {
  return (
    <div className="overflow-y-auto h-full">
      {entries.map(e => (
        <div
          key={e.id}
          onClick={() => onSelect(e.id)}
          className={`px-3.5 py-3 cursor-pointer border-l-2 transition-colors ${
            selectedId === e.id
              ? 'bg-emerald-950/20 border-[#00d4aa]'
              : 'border-transparent hover:bg-white/3'
          }`}
        >
          <div className="flex items-center justify-between mb-1.5">
            <TagBadge
              label={e.dissection.identity_mode ?? 'universal'}
              color={e.kb_tier === 'track' ? 'red' : 'purple'}
            />
            <span className="text-[10px] text-amber-400 font-medium">❤ {formatLikes(e.likes)}</span>
          </div>
          <p className="text-xs text-white/90 leading-snug mb-1.5 line-clamp-2">{e.title}</p>
          <div className="flex items-center gap-2">
            {e.dissection.hook_type && (
              <TagBadge label={e.dissection.hook_type} color="green" />
            )}
            <span className="text-[9px] text-gray-600">{e.platform}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Create `src/components/viral-kb/EntryDetail.tsx`**

```tsx
import { ViralEntry } from '../../types/api';

interface Props { entry: ViralEntry }

const DIMENSIONS = [
  { key: 'hook_type',          label: '🎣 钩子类型',   color: 'border-red-800/30 bg-red-900/8 text-red-400' },
  { key: 'content_type',       label: '📦 内容类型',   color: 'border-amber-800/30 bg-amber-900/8 text-amber-400' },
  { key: 'identity_mode',      label: '🎭 身份模式',   color: 'border-purple-800/30 bg-purple-900/8 text-purple-400' },
  { key: 'emotion_arc',        label: '💫 情绪弧线',   color: 'border-red-800/20 bg-red-900/6 text-red-400' },
  { key: 'interaction_design', label: '💬 互动设计',   color: 'border-emerald-800/30 bg-emerald-900/8 text-emerald-400' },
  { key: 'visual_style',       label: '🎬 视觉风格',   color: 'border-blue-800/30 bg-blue-900/8 text-blue-400' },
] as const;

function formatLikes(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`;
  return String(n);
}

export function EntryDetail({ entry: e }: Props) {
  return (
    <div className="overflow-y-auto h-full p-4">
      {/* Header */}
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-white leading-snug mb-2">{e.title}</h2>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-amber-400 text-xs font-bold">❤ {formatLikes(e.likes)}</span>
          <span className="text-[10px] text-gray-500">{e.platform} · {new Date(e.collected_at).toLocaleDateString('zh-CN')} 入库</span>
          <span className={`text-[9px] px-1.5 py-0.5 rounded border ${e.kb_tier === 'track' ? 'text-red-400 bg-red-900/20 border-red-800/30' : 'text-purple-400 bg-purple-900/20 border-purple-800/30'}`}>
            {e.kb_tier === 'track' ? '赛道爆款' : '通用爆款'}
          </span>
        </div>
      </div>

      {/* 6D Grid */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        {DIMENSIONS.map(({ key, label, color }) => {
          const value = e.dissection[key];
          if (!value) return null;
          return (
            <div key={key} className={`border rounded-md p-2.5 ${color.split(' ').slice(1).join(' ')}`}>
              <p className={`text-[9px] mb-1 ${color.split(' ')[0].replace('border-', 'text-').replace('/30', '').replace('/20', '')}`}>{label}</p>
              <p className="text-xs text-white font-medium">{value}</p>
            </div>
          );
        })}
      </div>

      {/* Summary */}
      {e.dissection.summary && (
        <div className="bg-white/4 rounded-md p-3">
          <p className="text-[10px] text-gray-500 mb-1.5">AI 拆解摘要</p>
          <p className="text-xs text-gray-300 leading-relaxed">{e.dissection.summary}</p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Create `src/components/viral-kb/FormulaList.tsx`**

```tsx
import { UniversalFormula } from '../../types/api';

interface Props { formulas: UniversalFormula[] }

export function FormulaList({ formulas }: Props) {
  if (formulas.length === 0) {
    return <p className="p-6 text-xs text-gray-600 text-center">暂无通用公式（需要同平台+内容类型+钩子组合出现 ≥3 次才会自动晋升）</p>;
  }
  return (
    <div className="p-4 grid grid-cols-2 gap-3">
      {formulas.map(f => (
        <div key={f.id} className="bg-white/4 border border-white/8 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex gap-1.5 flex-wrap">
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-900/20 text-emerald-400 border border-emerald-800/30">{f.platform}</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/6 text-gray-400 border border-white/10">{f.content_type}</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-900/20 text-amber-400 border border-amber-800/30">{f.hook_type}</span>
            </div>
            <span className="text-[9px] text-gray-600">{f.occurrence_count}次</span>
          </div>
          <p className="text-xs text-white mb-2 leading-snug">{f.formula_summary}</p>
          {f.structural_template && (
            <p className="text-[10px] text-gray-500 font-mono bg-black/20 rounded px-2 py-1">{f.structural_template}</p>
          )}
          {f.example_titles && f.example_titles.length > 0 && (
            <div className="mt-2">
              <p className="text-[9px] text-gray-600 mb-1">案例标题</p>
              {f.example_titles.slice(0, 2).map((t, i) => (
                <p key={i} className="text-[10px] text-gray-400 leading-snug">· {t}</p>
              ))}
            </div>
          )}
          {f.confidence !== undefined && (
            <p className="text-[9px] text-gray-600 mt-2">可信度 {Math.round(f.confidence * 100)}%</p>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Implement `src/pages/ViralKB.tsx`**

```tsx
import { useState } from 'react';
import { useViralKB, useFormulas } from '../hooks/useViralKB';
import { EntryList } from '../components/viral-kb/EntryList';
import { EntryDetail } from '../components/viral-kb/EntryDetail';
import { FormulaList } from '../components/viral-kb/FormulaList';
import { ErrorBanner } from '../components/shared/ErrorBanner';

type SubTab = 'entries' | 'formulas';

export function ViralKB() {
  const [subTab, setSubTab] = useState<SubTab>('entries');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hookFilter, setHookFilter] = useState('');
  const [identityFilter, setIdentityFilter] = useState('');
  const [sort, setSort] = useState<'likes' | 'date'>('likes');

  const { data, isLoading, error } = useViralKB({
    sort,
    hook_type: hookFilter || undefined,
    identity_mode: identityFilter || undefined,
  });
  const formulasQuery = useFormulas();

  const entries = data?.entries ?? [];
  const selectedEntry = entries.find(e => e.id === selectedId) ?? null;

  // Derive unique hook types and identity modes for filter pills
  const hookTypes     = [...new Set(entries.map(e => e.dissection.hook_type).filter(Boolean))].slice(0, 6);
  const identityModes = [...new Set(entries.map(e => e.dissection.identity_mode).filter((v): v is string => !!v))].slice(0, 5);

  return (
    <div className="flex flex-col h-[calc(100vh-41px)]">
      {/* Sub-tabs */}
      <div className="bg-[#111128] border-b border-white/6 flex items-center px-4">
        <button onClick={() => setSubTab('entries')}
          className={`text-xs py-2.5 px-3 border-b-2 transition-colors ${subTab === 'entries' ? 'text-white border-[#00d4aa]' : 'text-gray-400 border-transparent'}`}>
          条目库 {data?.stats?.total ? <span className="text-emerald-400 ml-1">{data.stats.total}</span> : ''}
        </button>
        <button onClick={() => setSubTab('formulas')}
          className={`text-xs py-2.5 px-3 border-b-2 transition-colors ${subTab === 'formulas' ? 'text-white border-[#00d4aa]' : 'text-gray-400 border-transparent'}`}>
          通用公式 {formulasQuery.data?.formulas?.length ? <span className="text-amber-400 ml-1">{formulasQuery.data.formulas.length}</span> : ''}
        </button>

        {subTab === 'entries' && (
          <>
            <div className="flex-1" />
            {/* Hook filter */}
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-600">Hook:</span>
              {hookTypes.map(h => (
                <button key={h} onClick={() => setHookFilter(hookFilter === h ? '' : h)}
                  className={`text-[10px] px-2 py-0.5 rounded transition-colors ${hookFilter === h ? 'bg-emerald-900/30 text-emerald-400 border border-emerald-800/40' : 'bg-white/4 text-gray-500 border border-white/8 hover:text-gray-300'}`}>
                  {h}
                </button>
              ))}
            </div>
            <div className="mx-3 h-4 w-px bg-white/10" />
            {/* Identity filter */}
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-600">身份:</span>
              {identityModes.map(m => (
                <button key={m} onClick={() => setIdentityFilter(identityFilter === m ? '' : m)}
                  className={`text-[10px] px-2 py-0.5 rounded transition-colors ${identityFilter === m ? 'bg-red-900/30 text-red-400 border border-red-800/40' : 'bg-white/4 text-gray-500 border border-white/8 hover:text-gray-300'}`}>
                  {m}
                </button>
              ))}
            </div>
            <div className="mx-3 h-4 w-px bg-white/10" />
            {/* Sort */}
            <button onClick={() => setSort(sort === 'likes' ? 'date' : 'likes')}
              className="text-[10px] px-2 py-0.5 rounded bg-amber-900/20 text-amber-400 border border-amber-800/30">
              {sort === 'likes' ? '点赞↓' : '时间↓'}
            </button>
          </>
        )}
      </div>

      {error && <div className="p-4"><ErrorBanner message={String(error)} /></div>}
      {isLoading && <div className="p-4 text-xs text-gray-500">加载中…</div>}

      {subTab === 'entries' ? (
        <div className="flex flex-1 overflow-hidden">
          <div className="w-64 border-r border-white/8 flex-shrink-0">
            <EntryList entries={entries} selectedId={selectedId} onSelect={setSelectedId} />
          </div>
          <div className="flex-1">
            {selectedEntry
              ? <EntryDetail entry={selectedEntry} />
              : <div className="flex items-center justify-center h-full text-xs text-gray-600">← 选择条目查看 6 维拆解</div>
            }
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <FormulaList formulas={formulasQuery.data?.formulas ?? []} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Test**

Navigate to `/#/viral-kb`. Expected:
- 「条目库」tab: entries in left panel with likes, clicking one shows 6D grid on right
- Hook/identity filter pills dynamically derived from entries
- 「通用公式」tab: formula cards grid, empty state message if none yet

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useViralKB.ts src/components/viral-kb/ src/pages/ViralKB.tsx
git commit -m "feat: implement ViralKB page with 6D entry detail and formula grid"
```

---

## Task 11: Polish — error handling, offline banner, deploy config

**Files:**
- Modify: `src/main.tsx`
- Create: `nginx.conf` (in missv-ops-web root)
- Create: `alive/api-server/.env.example`
- Modify: `alive/api-server/package.json` (add pm2 script)

- [ ] **Step 1: Add global 401 handler in main.tsx**

Add this import and effect inside `main.tsx` before `ReactDOM.createRoot`:

```typescript
// Already in client.ts as interceptor — just ensure toast is available:
// The 401 handling is in apiClient interceptors.
// For a global network-offline banner, add to App.tsx:
```

Add to `src/App.tsx` (inside the function, before Routes):

```tsx
import { useEffect, useState } from 'react';

// Inside App():
const [offline, setOffline] = useState(!navigator.onLine);
useEffect(() => {
  const on  = () => setOffline(false);
  const off = () => setOffline(true);
  window.addEventListener('online', on);
  window.addEventListener('offline', off);
  return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
}, []);
```

And render at the top of the Layout content:

```tsx
{offline && (
  <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-red-900 text-red-200 text-xs px-4 py-2 rounded-full shadow-lg z-50">
    ⚠️ 网络断开，数据可能不是最新
  </div>
)}
```

- [ ] **Step 2: Create `nginx.conf` for Web machine**

```nginx
server {
    listen 80;
    server_name _;
    root /var/www/missv-ops-web/dist;
    index index.html;

    # SPA fallback — all routes → index.html (Hash mode handles client routing)
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Gzip
    gzip on;
    gzip_types text/plain text/css application/javascript application/json;
    gzip_min_length 1024;
}
```

- [ ] **Step 3: Create `alive/api-server/.env.example`**

```
PORT=3001
OPS_API_KEY=change-me-to-a-secure-random-string
ALIVE_PERSONA=miss-v
CORS_ORIGIN=https://your-web-domain.com
```

- [ ] **Step 4: Add pm2 ecosystem file in `alive/api-server/`**

`alive/api-server/ecosystem.config.js`:
```javascript
module.exports = {
  apps: [{
    name: 'alive-api-server',
    script: '../dist-alive/scripts/../../../alive/api-server/server.ts',
    interpreter: 'tsx',
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
    },
    watch: false,
    max_restarts: 10,
    restart_delay: 3000,
  }],
};
```

Note: for production, build with `tsc` and run `node dist/server.js` instead of `tsx`.

- [ ] **Step 5: Verify full end-to-end locally**

```bash
# Terminal 1: API server
cd alive/api-server
OPS_API_KEY=test123 ALIVE_PERSONA=miss-v npm run dev

# Terminal 2: Frontend
cd missv-ops-web
npm run dev
```

Walk through every tab:
- `/` Brief: stats cards visible, 「生成简报」shows spinner then output
- `/queue`: items listed, approve one → optimistically removed from pending
- `/trends`: trends grouped, velocity bars colored
- `/competitors`: profiles listed, right panel shows mix bar
- `/viral-kb`: entries with likes, clicking shows 6D grid
- `/advice`: 「生成建议」works

- [ ] **Step 6: Build frontend and verify**

```bash
cd missv-ops-web
VITE_API_BASE_URL=http://localhost:3001 VITE_API_KEY=test123 npm run build
npx serve dist
```

Open http://localhost:3000. Verify no broken assets, Hash routing works.

- [ ] **Step 7: Final commits**

Alive repo:
```bash
cd /path/to/Alive
git add alive/api-server/.env.example alive/api-server/ecosystem.config.js
git commit -m "chore: add api-server deploy config and .env.example"
```

missv-ops-web repo:
```bash
cd missv-ops-web
git add nginx.conf src/App.tsx
git commit -m "chore: add nginx config and offline banner"
```

---

## Self-Review

**Spec coverage:**
- ✅ Section 1: All ops operations accessible via Web UI
- ✅ Section 2: Dual-repo + dual-machine, Express + Vite, X-API-Key auth
- ✅ Section 3: All files in spec are created
- ✅ Section 4: All 17 API endpoints implemented
- ✅ Section 5.1 Brief: stat cards + LLM output + freshness banner
- ✅ Section 5.2 Queue: left list + right detail, approve/discard/edit, XHS/Douyin tabs, competitor benchmarks
- ✅ Section 5.3 Trends: bucket groups, velocity bars, 出选题 button, signal pool sidebar
- ✅ Section 5.4 Competitors: left list, group filter, right detail with mix bar, add/edit drawer, analyze URL
- ✅ Section 5.5 ViralKB: entry list, 6D grid, formula tab
- ✅ Section 5.6 Advice: LLM output panel
- ✅ Section 6: TanStack Query staleTime per endpoint, optimistic updates on approve/discard
- ✅ Section 7: auth middleware, CORS_ORIGIN env var, .env files git-ignored
- ✅ Section 8: deploy instructions, nginx.conf, pm2 ecosystem file
- ✅ Section 9: LLM loading state, cold-cache handled by freshness banner, 401 interceptor, offline banner
- ✅ Section 10: All tech selected as specified
- ✅ competitors-override.json merge strategy (Section 5.4 updated requirement)

**Placeholder scan:** None found — all steps contain full code.

**Type consistency:**
- `QueueItem.id` used as key throughout — consistent
- `markApproved`/`markDiscarded` called with string `id` — matches `review-queue.ts` signature
- `CompetitorWithTracking` extends `CompetitorProfile` + adds `tracking: CompetitorTracking | null` — consistent with `competitors.ts` route output
- `spawnCli(command, args)` called identically across all CLI routes — consistent
- `upsertOverride` / `deleteOverride` return `CompetitorOverrideFile`, caller does `writeOverride(result)` — consistent
- `competitors/:id` uses `encodeURIComponent("name::platform")` in both frontend `endpoints.ts` and backend `competitors.ts` — consistent
