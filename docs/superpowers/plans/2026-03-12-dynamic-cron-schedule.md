# Dynamic Cron Schedule Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After morning planning, Minase dynamically updates her OpenClaw cron jobs so wake/sleep times and heartbeat hours match each day's LLM-generated schedule.

**Architecture:** A new `cron-sync.ts` module wraps `openclaw cron list --json` and `openclaw cron edit <id> --cron <expr>` via `child_process.execFileSync`. The morning plan calls `syncCronSchedule()` after writing `cron-schedule.json`. The heartbeat entry point also reads `cron-schedule.json` to guard against out-of-range execution (fallback for when Gateway is offline). The installer's `registerCronJobs()` gains retry/diagnostic logic and records job IDs for later editing.

**Tech Stack:** TypeScript (ES2022/CommonJS), vitest for tests, OpenClaw CLI (`openclaw cron` subcommands).

---

## File Structure

| File | Role | Action |
|------|------|--------|
| `skill/scripts/cron-sync.ts` | Wraps `openclaw cron` CLI for list/edit operations | **Create** |
| `skill/scripts/heartbeat-gate.ts` | Schedule-aware hour gating logic | **Create** |
| `skill/scripts/morning-plan.ts` | Calls `syncCronSchedule()` after generating cron config | **Modify** (lines 183-229) |
| `skill/scripts/heartbeat-tick.ts` | Reads `cron-schedule.json` as soft gate for execution | **Modify** (lines 422-466) |
| `bin/cli.js` | Improve cron registration with diagnostics and `--json` validation | **Modify** (lines 75-109) |
| `tests/cron-sync.test.ts` | Unit tests for the new cron-sync module | **Create** |
| `tests/heartbeat-tick-gate.test.ts` | Unit tests for the schedule-aware gating logic | **Create** |

---

## Chunk 1: Core cron-sync module

### Task 1: Create `cron-sync.ts` — list jobs by name

**Files:**
- Create: `skill/scripts/cron-sync.ts`
- Test: `tests/cron-sync.test.ts`

- [ ] **Step 1: Write failing test for `findCronJobByName`**

```typescript
// tests/cron-sync.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as child_process from 'child_process';
import { findCronJobByName } from '../skill/scripts/cron-sync';

vi.mock('child_process');
const mockedCp = vi.mocked(child_process);

beforeEach(() => { vi.clearAllMocks(); });

describe('cron-sync', () => {
  describe('findCronJobByName', () => {
    it('should return job object when name matches', () => {
      const jobs = [
        { id: 'abc123', name: 'minase:tick', cron: '0 8-22 * * *', enabled: true },
        { id: 'def456', name: 'minase:morning', cron: '0 7 * * *', enabled: true },
      ];
      mockedCp.execFileSync.mockReturnValue(JSON.stringify(jobs));

      const result = findCronJobByName('minase:tick');
      expect(result).toEqual({ id: 'abc123', name: 'minase:tick', cron: '0 8-22 * * *', enabled: true });
    });

    it('should return null when no job matches', () => {
      mockedCp.execFileSync.mockReturnValue('[]');
      const result = findCronJobByName('nonexistent');
      expect(result).toBeNull();
    });

    it('should return null when openclaw command fails', () => {
      mockedCp.execFileSync.mockImplementation(() => { throw new Error('gateway down'); });
      const result = findCronJobByName('minase:tick');
      expect(result).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cron-sync.test.ts`
Expected: FAIL — module `cron-sync` does not exist yet.

- [ ] **Step 3: Implement `findCronJobByName`**

```typescript
// skill/scripts/cron-sync.ts
import { execFileSync } from 'child_process';

export interface CronJob {
  id: string;
  name: string;
  cron: string;
  enabled: boolean;
}

/**
 * List all OpenClaw cron jobs and find one by name.
 * Returns null if Gateway is offline or no match found.
 */
export function findCronJobByName(name: string): CronJob | null {
  try {
    const raw = execFileSync('openclaw', ['cron', 'list', '--json'], {
      timeout: 10_000,
      encoding: 'utf8',
    });
    const jobs: CronJob[] = JSON.parse(raw);
    return jobs.find(j => j.name === name) ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cron-sync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skill/scripts/cron-sync.ts tests/cron-sync.test.ts
git commit -m "feat: add cron-sync module with findCronJobByName"
```

---

### Task 2: Add `editCronExpression` to cron-sync

**Files:**
- Modify: `skill/scripts/cron-sync.ts`
- Test: `tests/cron-sync.test.ts`

- [ ] **Step 1: Write failing test for `editCronExpression`**

Append to `tests/cron-sync.test.ts`:

```typescript
import { editCronExpression } from '../skill/scripts/cron-sync';

describe('editCronExpression', () => {
  it('should call openclaw cron edit with correct args', () => {
    mockedCp.execFileSync.mockReturnValue('');
    const result = editCronExpression('abc123', '0 10,12,14,17,20 * * *');
    expect(result).toBe(true);
    expect(mockedCp.execFileSync).toHaveBeenCalledWith(
      'openclaw',
      ['cron', 'edit', 'abc123', '--cron', '0 10,12,14,17,20 * * *', '--exact'],
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it('should return false when edit command fails', () => {
    mockedCp.execFileSync.mockImplementation(() => { throw new Error('gateway down'); });
    const result = editCronExpression('abc123', '0 10-20 * * *');
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cron-sync.test.ts`
Expected: FAIL — `editCronExpression` not exported.

- [ ] **Step 3: Implement `editCronExpression`**

Add to `skill/scripts/cron-sync.ts`:

```typescript
/**
 * Edit a cron job's expression by job ID.
 * Uses --exact to disable staggering (heartbeat timing is intentional).
 * Returns true on success, false on failure.
 */
export function editCronExpression(jobId: string, cronExpr: string): boolean {
  try {
    execFileSync('openclaw', ['cron', 'edit', jobId, '--cron', cronExpr, '--exact'], {
      timeout: 10_000,
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cron-sync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skill/scripts/cron-sync.ts tests/cron-sync.test.ts
git commit -m "feat: add editCronExpression to cron-sync"
```

---

### Task 3: Add `buildCronExpression` helper

**Files:**
- Modify: `skill/scripts/cron-sync.ts`
- Test: `tests/cron-sync.test.ts`

- [ ] **Step 1: Write failing tests for `buildCronExpression`**

Append to `tests/cron-sync.test.ts`:

```typescript
import { buildCronExpression } from '../skill/scripts/cron-sync';
import type { CronSchedule } from '../skill/scripts/types';

describe('buildCronExpression', () => {
  it('should build comma-separated hour expression from heartbeats', () => {
    const schedule: CronSchedule = {
      date: '2026-03-12',
      heartbeats: [
        { time: '09:00', type: 'morning' },
        { time: '10:00', type: 'regular' },
        { time: '12:00', type: 'regular' },
        { time: '14:00', type: 'regular' },
        { time: '17:00', type: 'regular' },
        { time: '20:00', type: 'regular' },
        { time: '23:00', type: 'night' },
      ],
    };
    const result = buildCronExpression(schedule);
    expect(result).toEqual({
      morning: '0 9 * * *',
      tick: '0 10,12,14,17,20 * * *',
      night: '0 23 * * *',
    });
  });

  it('should return null for tick when no regular heartbeats exist', () => {
    const schedule: CronSchedule = {
      date: '2026-03-12',
      heartbeats: [
        { time: '07:00', type: 'morning' },
        { time: '23:00', type: 'night' },
      ],
    };
    const result = buildCronExpression(schedule);
    expect(result.tick).toBeNull();
    expect(result.morning).toBe('0 7 * * *');
    expect(result.night).toBe('0 23 * * *');
  });

  it('should use default expressions when schedule has no heartbeats', () => {
    const schedule: CronSchedule = { date: '2026-03-12', heartbeats: [] };
    const result = buildCronExpression(schedule);
    expect(result).toEqual({
      morning: '0 7 * * *',
      tick: '0 8-22 * * *',
      night: '0 23 * * *',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cron-sync.test.ts`
Expected: FAIL — `buildCronExpression` not exported.

- [ ] **Step 3: Implement `buildCronExpression`**

Add to `skill/scripts/cron-sync.ts`:

```typescript
import type { CronSchedule } from './types';

export interface CronExpressions {
  morning: string;
  tick: string | null;
  night: string;
}

const DEFAULT_EXPRESSIONS: CronExpressions = {
  morning: '0 7 * * *',
  tick: '0 8-22 * * *',
  night: '0 23 * * *',
};

/**
 * Convert a CronSchedule (heartbeat list) into cron expressions for each job.
 * Morning/night get single-hour expressions. Tick gets comma-separated regular hours.
 * Returns defaults when schedule is empty.
 */
export function buildCronExpression(schedule: CronSchedule): CronExpressions {
  if (schedule.heartbeats.length === 0) {
    return { ...DEFAULT_EXPRESSIONS };
  }

  const morning = schedule.heartbeats.find(h => h.type === 'morning');
  const night = schedule.heartbeats.find(h => h.type === 'night');
  const regulars = schedule.heartbeats.filter(h => h.type === 'regular');

  const morningHour = morning ? parseInt(morning.time.split(':')[0], 10) : 7;
  const nightHour = night ? parseInt(night.time.split(':')[0], 10) : 23;

  const regularHours = regulars
    .map(h => parseInt(h.time.split(':')[0], 10))
    .sort((a, b) => a - b);

  const tickExpr = regularHours.length > 0
    ? `0 ${regularHours.join(',')} * * *`
    : null;

  return {
    morning: `0 ${morningHour} * * *`,
    tick: tickExpr,
    night: `0 ${nightHour} * * *`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cron-sync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skill/scripts/cron-sync.ts tests/cron-sync.test.ts
git commit -m "feat: add buildCronExpression to derive cron exprs from schedule"
```

---

### Task 4: Add `syncCronSchedule` orchestrator

**Files:**
- Modify: `skill/scripts/cron-sync.ts`
- Test: `tests/cron-sync.test.ts`

- [ ] **Step 1: Write failing tests for `syncCronSchedule`**

Append to `tests/cron-sync.test.ts`:

```typescript
import { syncCronSchedule } from '../skill/scripts/cron-sync';

describe('syncCronSchedule', () => {
  it('should find each job by name and edit its cron expression', () => {
    const schedule: CronSchedule = {
      date: '2026-03-12',
      heartbeats: [
        { time: '09:00', type: 'morning' },
        { time: '10:00', type: 'regular' },
        { time: '14:00', type: 'regular' },
        { time: '22:00', type: 'night' },
      ],
    };

    // Mock: list returns all three jobs, edit succeeds
    mockedCp.execFileSync
      .mockImplementation((cmd, args) => {
        const argsArr = args as string[];
        if (argsArr[1] === 'list') {
          return JSON.stringify([
            { id: 'id-m', name: 'minase:morning', cron: '0 7 * * *', enabled: true },
            { id: 'id-t', name: 'minase:tick', cron: '0 8-22 * * *', enabled: true },
            { id: 'id-n', name: 'minase:night', cron: '0 23 * * *', enabled: true },
          ]);
        }
        return '';
      });

    const result = syncCronSchedule(schedule);
    expect(result.synced).toBe(true);
    expect(result.details.morning).toBe('synced');
    expect(result.details.tick).toBe('synced');
    expect(result.details.night).toBe('synced');
  });

  it('should report skipped when Gateway is offline', () => {
    mockedCp.execFileSync.mockImplementation(() => { throw new Error('gateway down'); });
    const schedule: CronSchedule = {
      date: '2026-03-12',
      heartbeats: [
        { time: '07:00', type: 'morning' },
        { time: '08:00', type: 'regular' },
        { time: '23:00', type: 'night' },
      ],
    };
    const result = syncCronSchedule(schedule);
    expect(result.synced).toBe(false);
    expect(result.details.morning).toBe('job_not_found');
    expect(result.details.tick).toBe('job_not_found');
    expect(result.details.night).toBe('job_not_found');
  });

  it('should skip edit when expressions already match', () => {
    mockedCp.execFileSync
      .mockImplementation((cmd, args) => {
        const argsArr = args as string[];
        if (argsArr[1] === 'list') {
          return JSON.stringify([
            { id: 'id-m', name: 'minase:morning', cron: '0 7 * * *', enabled: true },
            { id: 'id-t', name: 'minase:tick', cron: '0 8 * * *', enabled: true },
            { id: 'id-n', name: 'minase:night', cron: '0 23 * * *', enabled: true },
          ]);
        }
        return '';
      });

    const schedule: CronSchedule = {
      date: '2026-03-12',
      heartbeats: [
        { time: '07:00', type: 'morning' },
        { time: '08:00', type: 'regular' },
        { time: '23:00', type: 'night' },
      ],
    };
    const result = syncCronSchedule(schedule);
    expect(result.synced).toBe(true);
    // Should only call list once (no redundant calls), plus zero edits (all match)
    const editCalls = mockedCp.execFileSync.mock.calls.filter(
      c => (c[1] as string[])[1] === 'edit'
    );
    expect(editCalls).toHaveLength(0);
  });

  it('should list jobs only once (not per job)', () => {
    mockedCp.execFileSync
      .mockImplementation((cmd, args) => {
        const argsArr = args as string[];
        if (argsArr[1] === 'list') {
          return JSON.stringify([
            { id: 'id-m', name: 'minase:morning', cron: '0 7 * * *', enabled: true },
            { id: 'id-t', name: 'minase:tick', cron: '0 8-22 * * *', enabled: true },
            { id: 'id-n', name: 'minase:night', cron: '0 23 * * *', enabled: true },
          ]);
        }
        return '';
      });
    const schedule: CronSchedule = {
      date: '2026-03-12',
      heartbeats: [
        { time: '09:00', type: 'morning' },
        { time: '10:00', type: 'regular' },
        { time: '22:00', type: 'night' },
      ],
    };
    syncCronSchedule(schedule);
    const listCalls = mockedCp.execFileSync.mock.calls.filter(
      c => (c[1] as string[])[1] === 'list'
    );
    expect(listCalls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cron-sync.test.ts`
Expected: FAIL — `syncCronSchedule` not exported.

- [ ] **Step 3: Implement `syncCronSchedule`**

Add to `skill/scripts/cron-sync.ts`:

```typescript
type SyncStatus = 'synced' | 'edit_failed' | 'job_not_found' | 'no_regulars';

export interface SyncResult {
  synced: boolean;
  details: {
    morning: SyncStatus;
    tick: SyncStatus;
    night: SyncStatus;
  };
}

const JOB_NAMES = {
  morning: 'minase:morning',
  tick: 'minase:tick',
  night: 'minase:night',
} as const;

/**
 * List all OpenClaw cron jobs (single CLI call).
 * Returns empty array if Gateway is offline.
 */
function listAllCronJobs(): CronJob[] {
  try {
    const raw = execFileSync('openclaw', ['cron', 'list', '--json'], {
      timeout: 10_000,
      encoding: 'utf8',
    });
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Sync CronSchedule to OpenClaw cron system.
 * Lists all jobs once, then edits each matching job's cron expression.
 * Non-fatal: returns status per job so caller can log gracefully.
 */
export function syncCronSchedule(schedule: CronSchedule): SyncResult {
  const expressions = buildCronExpression(schedule);
  const allJobs = listAllCronJobs();

  const syncOne = (jobName: string, expr: string | null): SyncStatus => {
    if (expr === null) return 'no_regulars';
    const job = allJobs.find(j => j.name === jobName) ?? null;
    if (!job) return 'job_not_found';
    if (job.cron === expr) return 'synced'; // Already correct, skip edit
    return editCronExpression(job.id, expr) ? 'synced' : 'edit_failed';
  };

  const details = {
    morning: syncOne(JOB_NAMES.morning, expressions.morning),
    tick: syncOne(JOB_NAMES.tick, expressions.tick),
    night: syncOne(JOB_NAMES.night, expressions.night),
  };

  const synced = Object.values(details).every(s => s === 'synced' || s === 'no_regulars');

  return { synced, details };
}
```

Note: This also replaces the previous `findCronJobByName` usage in `syncCronSchedule` — jobs are listed once via `listAllCronJobs()` and looked up in-memory. `findCronJobByName` remains exported for external use.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cron-sync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skill/scripts/cron-sync.ts tests/cron-sync.test.ts
git commit -m "feat: add syncCronSchedule orchestrator for dynamic cron updates"
```

---

## Chunk 2: Integration into morning plan and heartbeat gating

### Task 5: Call `syncCronSchedule` from morning plan

**Files:**
- Modify: `skill/scripts/morning-plan.ts` (after line 205)

- [ ] **Step 1: Add import and sync call to morning-plan.ts**

At the top of `morning-plan.ts`, add to imports:

```typescript
import { syncCronSchedule } from './cron-sync';
```

After line 205 (`writeJSON(PATHS.cronSchedule, cronSchedule);`), add:

```typescript
  // Sync dynamic cron schedule to OpenClaw (non-fatal)
  const syncResult = syncCronSchedule(cronSchedule);
  if (syncResult.synced) {
    console.log(`Cron sync: OK (morning=${syncResult.details.morning}, tick=${syncResult.details.tick}, night=${syncResult.details.night})`);
  } else {
    console.error(`Cron sync: partial/failed — ${JSON.stringify(syncResult.details)}. Fallback: heartbeat-tick will gate by cron-schedule.json.`);
  }
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add skill/scripts/morning-plan.ts
git commit -m "feat: call syncCronSchedule after morning plan generates cron config"
```

---

### Task 6: Add schedule-aware gating to heartbeat-tick

**Files:**
- Modify: `skill/scripts/heartbeat-tick.ts` (lines 422-466, the `main()` function)
- Test: `tests/heartbeat-tick-gate.test.ts`

The heartbeat entry point currently hard-codes sleep = 0-6, morning = 7, night = 23. We replace this with `cron-schedule.json`-aware logic that acts as a soft gate. If the current hour is not in the heartbeat list, skip. This is the fallback for when dynamic cron sync fails.

- [ ] **Step 1: Write failing test for `isActiveHeartbeatHour`**

```typescript
// tests/heartbeat-tick-gate.test.ts
import { describe, it, expect } from 'vitest';
import { isActiveHeartbeatHour } from '../skill/scripts/heartbeat-gate';
import type { CronSchedule } from '../skill/scripts/types';

describe('heartbeat-gate', () => {
  const schedule: CronSchedule = {
    date: '2026-03-12',
    heartbeats: [
      { time: '09:00', type: 'morning' },
      { time: '10:00', type: 'regular' },
      { time: '14:00', type: 'regular' },
      { time: '20:00', type: 'regular' },
      { time: '23:00', type: 'night' },
    ],
  };

  it('should return matching heartbeat for an active hour', () => {
    expect(isActiveHeartbeatHour(10, schedule)).toEqual({ time: '10:00', type: 'regular' });
  });

  it('should return matching heartbeat for morning hour', () => {
    expect(isActiveHeartbeatHour(9, schedule)).toEqual({ time: '09:00', type: 'morning' });
  });

  it('should return null for an inactive hour', () => {
    expect(isActiveHeartbeatHour(15, schedule)).toBeNull();
  });

  it('should return null for sleep hours with no schedule', () => {
    const empty: CronSchedule = { date: '2026-03-12', heartbeats: [] };
    expect(isActiveHeartbeatHour(3, empty)).toBeNull();
  });

  it('should fall back to default ranges when schedule has no heartbeats', () => {
    const empty: CronSchedule = { date: '2026-03-12', heartbeats: [] };
    // Default: morning=7, regular=8-22, night=23
    expect(isActiveHeartbeatHour(7, empty)).toEqual({ time: '07:00', type: 'morning' });
    expect(isActiveHeartbeatHour(12, empty)).toEqual({ time: '12:00', type: 'regular' });
    expect(isActiveHeartbeatHour(23, empty)).toEqual({ time: '23:00', type: 'night' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/heartbeat-tick-gate.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `heartbeat-gate.ts`**

```typescript
// skill/scripts/heartbeat-gate.ts
import type { CronSchedule, CronHeartbeat } from './types';

/**
 * Check if the given hour is an active heartbeat hour per the cron schedule.
 * Returns the matching heartbeat entry, or null if this hour should be skipped.
 *
 * When schedule has no heartbeats (empty or stale), falls back to defaults:
 * morning=7, regular=8-22, night=23, sleep=0-6.
 */
export function isActiveHeartbeatHour(hour: number, schedule: CronSchedule): CronHeartbeat | null {
  if (schedule.heartbeats.length > 0) {
    return schedule.heartbeats.find(
      h => parseInt(h.time.split(':')[0], 10) === hour
    ) ?? null;
  }

  // Fallback defaults (matches the static cron registered at install)
  if (hour === 7) return { time: '07:00', type: 'morning' };
  if (hour === 23) return { time: '23:00', type: 'night' };
  if (hour >= 8 && hour <= 22) return { time: `${hour.toString().padStart(2, '0')}:00`, type: 'regular' };
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/heartbeat-tick-gate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skill/scripts/heartbeat-gate.ts tests/heartbeat-tick-gate.test.ts
git commit -m "feat: add heartbeat-gate module for schedule-aware hour gating"
```

---

### Task 7: Integrate gate into heartbeat-tick entry point

**Files:**
- Modify: `skill/scripts/heartbeat-tick.ts` (the `main()` function, lines 422-466)

- [ ] **Step 1: Replace hard-coded routing with schedule-aware gating**

Add import at top of `heartbeat-tick.ts`:

```typescript
import { isActiveHeartbeatHour } from './heartbeat-gate';
```

Also add `CronSchedule` to the existing type import on lines 10-14 (append to the destructured list):

```typescript
import {
  EmotionState, IntentPool, IntentCategory, ScheduleToday, EventQueue,
  HeartbeatLog, HeartbeatLogEntry, ActionOutput, RigidSchedule, WisdomStore,
  SocialRelation, SocialMeta, VitalityState, ConfidenceState, PostHistory,
  CronSchedule,
} from './types';
```

Note: `PATHS` and `readJSON` are already imported at line 15. `runMorningPlan` and `runNightReflect` are already imported at lines 22-23. Only add `isActiveHeartbeatHour` (new import) and `CronSchedule` (merged into existing import).

Replace the entire `main()` function (lines 422-447) with:

```typescript
async function main(): Promise<void> {
  const hour = getCurrentHour();

  // Read today's cron schedule (written by morning plan)
  const cronSchedule = readJSON<CronSchedule>(PATHS.cronSchedule, { date: '', heartbeats: [] });
  const activeHeartbeat = isActiveHeartbeatHour(hour, cronSchedule);

  if (!activeHeartbeat) {
    console.log(`Hour ${hour} is not in today's heartbeat schedule — skipping.`);
    return;
  }

  switch (activeHeartbeat.type) {
    case 'morning':
      console.log('Morning heartbeat — running morning plan');
      await runMorningPlan();
      break;
    case 'night':
      console.log('Night heartbeat — running night reflection');
      await runNightReflect();
      break;
    case 'regular':
      await regularTick();
      break;
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add skill/scripts/heartbeat-tick.ts
git commit -m "feat: replace hard-coded hour routing with cron-schedule.json gate"
```

---

## Chunk 3: Installer fix and final verification

### Task 8: Improve installer cron registration diagnostics

**Files:**
- Modify: `bin/cli.js` (lines 75-109, `registerCronJobs()`)

- [ ] **Step 1: Rewrite `registerCronJobs()` with diagnostic output**

Replace `registerCronJobs()` in `bin/cli.js` (lines 75-109) with:

```javascript
function registerCronJobs() {
  const { execFileSync } = require('child_process');

  // Pre-flight: check if Gateway is reachable by listing jobs
  let existingJobs = [];
  try {
    const raw = execFileSync('openclaw', ['cron', 'list', '--json'], { timeout: 10000, encoding: 'utf8' });
    existingJobs = JSON.parse(raw);
  } catch {
    warn('OpenClaw Gateway is not running — cannot register cron jobs.');
    warn('Start the Gateway first, then re-run: npx minase@latest');
    warn('Or register manually after starting Gateway:');
    warn('  openclaw cron add --name "minase:morning" --cron "0 7 * * *" --tz "Asia/Shanghai" --session isolated --message "[cron:morning] 执行水瀬晨规划。运行: node ~/.openclaw/skills/minase/scripts/morning-plan.js" --timeout 180');
    warn('  openclaw cron add --name "minase:tick" --cron "0 8-22 * * *" --tz "Asia/Shanghai" --session isolated --message "[cron:tick] 执行水瀬心跳。运行: node ~/.openclaw/skills/minase/scripts/heartbeat-tick.js" --timeout 120');
    warn('  openclaw cron add --name "minase:night" --cron "0 23 * * *" --tz "Asia/Shanghai" --session isolated --message "[cron:night] 执行水瀬夜反思。运行: node ~/.openclaw/skills/minase/scripts/night-reflect.js" --timeout 300');
    return;
  }

  // Remove existing jobs first (idempotent re-install)
  const existingNames = ['minase:morning', 'minase:tick', 'minase:night'];
  for (const name of existingNames) {
    const existing = existingJobs.find(j => j.name === name);
    if (existing) {
      try {
        execFileSync('openclaw', ['cron', 'rm', existing.id], { timeout: 10000, stdio: 'ignore' });
      } catch { /* best effort */ }
    }
  }

  const jobs = [
    {
      name: 'minase:morning',
      cron: '0 7 * * *',
      message: '[cron:morning] 执行水瀬晨规划。运行: node ~/.openclaw/skills/minase/scripts/morning-plan.js',
      timeout: 180,
    },
    {
      name: 'minase:tick',
      cron: '0 8-22 * * *',
      message: '[cron:tick] 执行水瀬心跳。运行: node ~/.openclaw/skills/minase/scripts/heartbeat-tick.js',
      timeout: 120,
    },
    {
      name: 'minase:night',
      cron: '0 23 * * *',
      message: '[cron:night] 执行水瀬夜反思。运行: node ~/.openclaw/skills/minase/scripts/night-reflect.js',
      timeout: 300,
    },
  ];

  for (const job of jobs) {
    try {
      const output = execFileSync(
        'openclaw',
        [
          'cron', 'add',
          '--name', job.name,
          '--cron', job.cron,
          '--tz', 'Asia/Shanghai',
          '--session', 'isolated',
          '--message', job.message,
          '--timeout', String(job.timeout),
          '--exact',
          '--json',
        ],
        { timeout: 10000, encoding: 'utf8' }
      );
      ok(`Registered cron: ${job.name} (${job.cron})`);
    } catch (err) {
      warn(`Failed to register cron ${job.name}: ${err.message}`);
    }
  }
}
```

- [ ] **Step 2: Verify installer still parses correctly**

Run: `node -c bin/cli.js`
Expected: No syntax errors.

- [ ] **Step 3: Commit**

```bash
git add bin/cli.js
git commit -m "fix: improve cron registration with Gateway pre-check and idempotent re-install"
```

---

### Task 9: Build, typecheck, and run full test suite

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: Clean build to `dist/`.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: dynamic cron schedule — Minase decides her own daily rhythm"
```
