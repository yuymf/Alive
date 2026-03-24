# E2E Lifecycle Testing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a full 24-hour lifecycle simulation runner + quality judge that evaluates MizuSan's image generation, emotion dynamics, and memory quality.

**Architecture:** Modify core utility modules (time-utils, file-utils) to support test-time injection, add mock layers to external bridges (Instagram, XHS, cron), then build the E2E runner that orchestrates a simulated day. A quality judge evaluates output using real LLM/Gemini API calls.

**Tech Stack:** TypeScript, vitest, AIHubMix Gemini API (real), OpenAI-compatible LLM API (real)

**Spec:** `docs/superpowers/specs/2026-03-13-e2e-lifecycle-testing-design.md`

---

## Chunk 1: Core Infrastructure (time-utils, file-utils, mocks)

### Task 1: Add `now()` + time override to time-utils.ts

**Files:**
- Modify: `skill/scripts/time-utils.ts`
- Test: `tests/time-utils.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/time-utils.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { now, setTimeOverride, clearTimeOverride, getLocalHour, getLocalDate } from '../skill/scripts/time-utils';

describe('time-utils override', () => {
  afterEach(() => clearTimeOverride());

  it('now() returns current time when no override set', () => {
    const before = Date.now();
    const result = now();
    const after = Date.now();
    expect(result.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.getTime()).toBeLessThanOrEqual(after);
  });

  it('now() returns overridden time when set', () => {
    const fixed = new Date('2026-06-15T10:30:00+08:00');
    setTimeOverride(fixed);
    const result = now();
    expect(result.getTime()).toBe(fixed.getTime());
  });

  it('now() returns a copy, not a reference to override', () => {
    const fixed = new Date('2026-06-15T10:30:00+08:00');
    setTimeOverride(fixed);
    const a = now();
    const b = now();
    expect(a).not.toBe(b);
    expect(a.getTime()).toBe(b.getTime());
  });

  it('getLocalHour uses now() as default', () => {
    setTimeOverride(new Date('2026-06-15T14:00:00+08:00'));
    expect(getLocalHour()).toBe(14);
  });

  it('getLocalDate uses now() as default', () => {
    setTimeOverride(new Date('2026-06-15T14:00:00+08:00'));
    expect(getLocalDate()).toBe('2026-06-15');
  });

  it('clearTimeOverride restores real time', () => {
    setTimeOverride(new Date('2000-01-01T00:00:00Z'));
    clearTimeOverride();
    const result = now();
    expect(result.getFullYear()).toBeGreaterThan(2024);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/time-utils.test.ts`
Expected: FAIL — `now` is not exported from time-utils

- [ ] **Step 3: Implement now(), setTimeOverride(), clearTimeOverride()**

Replace entire `skill/scripts/time-utils.ts` with:

```typescript
// skill/scripts/time-utils.ts
// Consistent local-time utilities.
// All time-based logic uses system local time (no hardcoded timezone).

let _timeOverride: Date | null = null;

/** Override the global clock for testing. */
export function setTimeOverride(date: Date): void {
  _timeOverride = date;
}

/** Clear the time override, restoring real system time. */
export function clearTimeOverride(): void {
  _timeOverride = null;
}

/** Use instead of `new Date()` everywhere. Returns a fresh copy each call. */
export function now(): Date {
  return _timeOverride ? new Date(_timeOverride.getTime()) : new Date();
}

/**
 * Get today's date as YYYY-MM-DD in local timezone.
 * Unlike toISOString().split('T')[0] which returns UTC date,
 * this returns the local date — correct near midnight.
 */
export function getLocalDate(d: Date = now()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Get current hour (0-23) in local timezone.
 */
export function getLocalHour(d: Date = now()): number {
  return d.getHours();
}

/**
 * Get weekday as 1=Mon..7=Sun (ISO convention).
 */
export function getLocalWeekday(d: Date = now()): number {
  return d.getDay() === 0 ? 7 : d.getDay();
}

/**
 * Format date+time for display, e.g. "2026/3/12 14:30:00".
 * Uses system locale and local timezone.
 */
export function formatLocalTime(d: Date = now()): string {
  return d.toLocaleString('zh-CN');
}

/**
 * Get local time as HH:MM string.
 */
export function getLocalTimeHHMM(d: Date = now()): string {
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${min}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/time-utils.test.ts`
Expected: PASS — all 6 tests pass

- [ ] **Step 5: Run all existing tests to check for regressions**

Run: `npx vitest run`
Expected: All existing tests still pass (parameter names changed from `now` to `d` but signatures are compatible)

- [ ] **Step 6: Commit**

```bash
git add skill/scripts/time-utils.ts tests/time-utils.test.ts
git commit -m "feat: add now() time override to time-utils for E2E testing"
```

---

### Task 2: Migrate all `new Date()` calls to `now()`

**Files:**
- Modify: `skill/scripts/heartbeat-tick.ts:44,172,679,724`
- Modify: `skill/scripts/morning-plan.ts:23,61,75,113,168,173,181`
- Modify: `skill/scripts/night-reflect.ts:22,34`
- Modify: `skill/scripts/post-pipeline.ts:16,58`
- Modify: `skill/scripts/emotion-engine.ts:79,289,400`
- Modify: `skill/scripts/intent-engine.ts:143,200,226,365`
- Modify: `skill/scripts/confidence-engine.ts:52`
- Modify: `skill/scripts/vitality-engine.ts:53,109`
- Modify: `skill/scripts/flow-engine.ts:45,74`
- Modify: `skill/scripts/llm-client.ts:12`
- Modify: `skill/scripts/post-instagram.ts:67`

Each file needs:
1. Add `import { now } from './time-utils';` (or add `now` to existing import)
2. Replace `new Date()` with `now()`
3. Replace `Date.now()` with `now().getTime()`

- [ ] **Step 1: Migrate heartbeat-tick.ts**

At line 44, add `now` to the existing import:
```typescript
import { getLocalDate, getLocalHour, getLocalWeekday, formatLocalTime, getLocalTimeHHMM, now } from './time-utils';
```

Then replace:
- Line 172: `const now = new Date();` → `const currentTime = now();` (rename local var to avoid shadowing import). Update all references in `regularTick()` from `now` to `currentTime`.
- Line 249: `socialRelations = decayAllRelations(socialRelations, now);` → `..., currentTime);`
- Line 250: `const dormancyResult = processDormancy(socialRelations, now);` → `..., currentTime);`
- Line 262: `reactivateRelation(r, now.toISOString())` → `..., currentTime.toISOString())`
- Line 265: `generateSocialIntents(socialRelations, socialMeta, now)` → `..., currentTime)`
- Line 305: `writeFlowTickState(now,` → `writeFlowTickState(currentTime,`
- Line 332: `writeFlowTickState(now,` → `writeFlowTickState(currentTime,`
- Line 418: `[randomResult.event.description]: now.toISOString(),` → `...: currentTime.toISOString(),`
- Line 608: `writeFlowTickState(now,` → `writeFlowTickState(currentTime,`
- Line 679: `const now = new Date();` → `const currentTime = now();`, rename `now` → `currentTime` in `main()` function
- Line 724: `timestamp: new Date().toISOString()` → `timestamp: now().toISOString()`

- [ ] **Step 2: Migrate morning-plan.ts**

At line 23, add `now` to import:
```typescript
import { getLocalDate, getLocalWeekday, formatLocalTime, getLocalTimeHHMM, now } from './time-utils';
```

- Line 61: `const now = new Date();` → `const currentTime = now();`, rename all `now` → `currentTime` in function
- Line 75: `new Date(now.getTime() - 86400000)` → `new Date(currentTime.getTime() - 86400000)`
- Line 113: `follower_synced_at: new Date().toISOString()` → `follower_synced_at: now().toISOString()`
- Line 168: `id: \`seed_${Date.now()}_${i}\`` → `` id: `seed_${currentTime.getTime()}_${i}` ``
- Line 173: `born_at: now.toISOString()` → `born_at: currentTime.toISOString()`
- Line 181: `last_updated: now.toISOString()` → `last_updated: currentTime.toISOString()`

- [ ] **Step 3: Migrate night-reflect.ts**

At line 22, add `now` to import:
```typescript
import { getLocalDate, formatLocalTime, now } from './time-utils';
```

- Line 34: `const now = new Date();` → `const currentTime = now();`, rename in function

- [ ] **Step 4: Migrate post-pipeline.ts**

At line 16, add `now` to import:
```typescript
import { getLocalDate, getLocalTimeHHMM, now } from './time-utils';
```

- Line 58: `const now = new Date();` → `const currentTime = now();` in `writeDiary()` function, rename references

- [ ] **Step 5: Migrate emotion-engine.ts**

Add `import { now } from './time-utils';` at top.

- Line 79: `last_updated: new Date().toISOString()` → `last_updated: now().toISOString()`
- Line 289: `timestamp: new Date().toISOString()` → `timestamp: now().toISOString()`
- Line 400: `timestamp: new Date().toISOString()` → `timestamp: now().toISOString()`

- [ ] **Step 6: Migrate intent-engine.ts**

Add `import { now } from './time-utils';` at top.

- Line 143: `born_at: new Date().toISOString()` → `born_at: now().toISOString()`
- Line 200: `satisfied_at: new Date().toISOString()` → `satisfied_at: now().toISOString()`
- Line 226: `born_at: new Date().toISOString()` → `born_at: now().toISOString()`
- Line 365: `last_attempted: new Date().toISOString()` → `last_attempted: now().toISOString()`

- [ ] **Step 7: Migrate remaining files**

**confidence-engine.ts:** Add `import { now } from './time-utils';`, line 52: `new Date().toISOString()` → `now().toISOString()`

**vitality-engine.ts:** Add `import { now } from './time-utils';`, lines 53,109: `new Date().toISOString()` → `now().toISOString()`

**flow-engine.ts:** Add `import { now } from './time-utils';`, lines 45,74: `new Date().toISOString()` → `now().toISOString()`

**llm-client.ts:** Add `import { now } from './time-utils';`, line 12: `new Date().toISOString()` → `now().toISOString()`

**post-instagram.ts:** Add `import { now } from './time-utils';`, line 67: `const now = new Date().toISOString();` → `const nowStr = now().toISOString();` (rename local var)

- [ ] **Step 8: Run all existing tests**

Run: `npx vitest run`
Expected: All existing tests pass — `now()` returns same as `new Date()` when no override is set

- [ ] **Step 9: Commit**

```bash
git add skill/scripts/heartbeat-tick.ts skill/scripts/morning-plan.ts \
  skill/scripts/night-reflect.ts skill/scripts/post-pipeline.ts \
  skill/scripts/emotion-engine.ts skill/scripts/intent-engine.ts \
  skill/scripts/confidence-engine.ts skill/scripts/vitality-engine.ts \
  skill/scripts/flow-engine.ts skill/scripts/llm-client.ts \
  skill/scripts/post-instagram.ts
git commit -m "refactor: migrate all new Date() calls to now() from time-utils"
```

---

### Task 3: Convert file-utils PATHS to getter-based with setBasePaths()

**Files:**
- Modify: `skill/scripts/file-utils.ts`
- Test: `tests/file-utils-paths.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/file-utils-paths.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { PATHS, setBasePaths, resetBasePaths, readJSON, writeJSON } from '../skill/scripts/file-utils';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('file-utils path override', () => {
  afterEach(() => resetBasePaths());

  it('PATHS uses default paths when no override set', () => {
    const home = process.env.HOME!;
    expect(PATHS.emotionState).toBe(path.join(home, '.openclaw', 'workspace', 'memory', 'minase', 'emotion-state.json'));
  });

  it('PATHS uses overridden memory base after setBasePaths', () => {
    setBasePaths('/tmp/test-memory', '/tmp/test-skill');
    expect(PATHS.emotionState).toBe('/tmp/test-memory/emotion-state.json');
    expect(PATHS.diary).toBe('/tmp/test-memory/diary.md');
  });

  it('PATHS uses overridden skill base for skill paths', () => {
    setBasePaths('/tmp/test-memory', '/tmp/test-skill');
    expect(PATHS.references).toBe('/tmp/test-skill/assets/references');
    expect(PATHS.cronSchedule).toBe('/tmp/test-skill/cron-schedule.json');
  });

  it('resetBasePaths restores defaults', () => {
    setBasePaths('/tmp/a', '/tmp/b');
    resetBasePaths();
    expect(PATHS.emotionState).toContain('.openclaw');
  });

  it('readJSON and writeJSON work with overridden paths', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minase-test-'));
    setBasePaths(tmpDir, tmpDir);

    writeJSON(PATHS.emotionState, { test: true });
    const result = readJSON<{ test: boolean }>(PATHS.emotionState, { test: false });
    expect(result.test).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/file-utils-paths.test.ts`
Expected: FAIL — `setBasePaths` not exported

- [ ] **Step 3: Implement getter-based PATHS**

Replace the PATHS section in `skill/scripts/file-utils.ts` (lines 1-43) with:

```typescript
// skill/scripts/file-utils.ts
// Safe file I/O with backup and fallback (Spec §13)

import * as fs from 'fs';
import * as path from 'path';

let _memoryBaseOverride: string | null = null;
let _skillBaseOverride: string | null = null;

function getMemoryBase(): string {
  return _memoryBaseOverride ?? path.join(process.env.HOME!, '.openclaw', 'workspace', 'memory', 'minase');
}

function getSkillBase(): string {
  return _skillBaseOverride ?? path.join(process.env.HOME!, '.openclaw', 'skills', 'minase');
}

/** Override base paths for testing (sandbox isolation). */
export function setBasePaths(memoryBase: string, skillBase: string): void {
  _memoryBaseOverride = memoryBase;
  _skillBaseOverride = skillBase;
}

/** Clear base path overrides, restoring defaults. */
export function resetBasePaths(): void {
  _memoryBaseOverride = null;
  _skillBaseOverride = null;
}

// Keep MEMORY_BASE and SKILL_BASE as getters for backward compat
export const MEMORY_BASE = undefined as unknown as string;
export const SKILL_BASE = undefined as unknown as string;

// Redefine as getters on module.exports for CJS
Object.defineProperty(exports, 'MEMORY_BASE', { get: getMemoryBase });
Object.defineProperty(exports, 'SKILL_BASE', { get: getSkillBase });

export const PATHS = {
  get emotionState() { return path.join(getMemoryBase(), 'emotion-state.json'); },
  get intentPool() { return path.join(getMemoryBase(), 'intent-pool.json'); },
  get scheduleToday() { return path.join(getMemoryBase(), 'schedule-today.json'); },
  get eventQueue() { return path.join(getMemoryBase(), 'event-queue.json'); },
  get preferences() { return path.join(getMemoryBase(), 'preferences.json'); },
  get aspirations() { return path.join(getMemoryBase(), 'aspirations.json'); },
  get personalityDrift() { return path.join(getMemoryBase(), 'personality-drift.json'); },
  get heartbeatLog() { return path.join(getMemoryBase(), 'heartbeat-log.json'); },
  get diary() { return path.join(getMemoryBase(), 'diary.md'); },
  get coreWisdom() { return path.join(getMemoryBase(), 'core-wisdom.json'); },
  get world() { return path.join(getMemoryBase(), 'world.md'); },
  get socialMeta() { return path.join(getMemoryBase(), 'relations', 'social', 'meta.json'); },
  get socialInstagramDir() { return path.join(getMemoryBase(), 'relations', 'social', 'instagram'); },
  get cronSchedule() { return path.join(getSkillBase(), 'cron-schedule.json'); },
  get inspiration() { return path.join(getMemoryBase(), 'inspiration.json'); },
  get postHistory() { return path.join(getMemoryBase(), 'post-history.json'); },
  get vitalityState() { return path.join(getMemoryBase(), 'vitality-state.json'); },
  get confidenceState() { return path.join(getMemoryBase(), 'confidence-state.json'); },
  get photoRoll() { return path.join(getMemoryBase(), 'photo-roll'); },
  get referenceImage() { return path.join(getSkillBase(), 'assets', 'minase-reference.png'); },
  get postImpulse() { return path.join(getMemoryBase(), 'post-impulse.json'); },
  get inspirationRefs() { return path.join(getMemoryBase(), 'inspiration-refs'); },
  get references() { return path.join(getSkillBase(), 'assets', 'references'); },
  get flowState() { return path.join(getMemoryBase(), 'flow-state.json'); },
  get pendingChains() { return path.join(getMemoryBase(), 'pending-chains.json'); },
};
```

Keep all functions below (readJSON, writeJSON, etc.) unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/file-utils-paths.test.ts`
Expected: PASS

- [ ] **Step 5: Run all existing tests**

Run: `npx vitest run`
Expected: All pass — getter-based PATHS is transparent to consumers

- [ ] **Step 6: Commit**

```bash
git add skill/scripts/file-utils.ts tests/file-utils-paths.test.ts
git commit -m "feat: add getter-based PATHS with setBasePaths() for sandbox isolation"
```

---

### Task 4: Add mock modes to Instagram bridge, XHS bridge, cron sync

**Files:**
- Modify: `skill/scripts/instagram-bridge-client.ts:15`
- Modify: `skill/scripts/xhs-bridge-client.ts:134`
- Modify: `skill/scripts/cron-sync.ts:127`

- [ ] **Step 1: Add Instagram bridge mock**

In `skill/scripts/instagram-bridge-client.ts`, add mock function at top (after imports, before `callInstagramBridge`):

```typescript
function mockInstagramResponse(command: string): unknown {
  switch (command) {
    case 'upload_photo':
      return { media_pk: `mock_${Date.now()}`, media_code: 'mock_code' };
    case 'upload_album':
      return { media_pk: `mock_album_${Date.now()}`, media_code: 'mock_album_code' };
    case 'get_media_insights':
      return {
        likes: 15 + Math.floor(Math.random() * 30),
        comments: 2 + Math.floor(Math.random() * 5),
        reach: 200 + Math.floor(Math.random() * 300),
      };
    case 'hashtag_top':
      return {
        posts: [
          { caption: 'Amazing cosplay! #cosplay #anime', likes: 500, thumbnail_url: '' },
          { caption: 'Daily OOTD #fashion #daily', likes: 300, thumbnail_url: '' },
        ],
      };
    case 'get_user_info':
      return { follower_count: 150, following_count: 200, media_count: 10 };
    default:
      console.log(`[MOCK] Unhandled Instagram command: ${command}`);
      return {};
  }
}
```

Then add early return at start of `callInstagramBridge`:
```typescript
export function callInstagramBridge(command: string, args: Record<string, string>): Promise<unknown> {
  if (process.env.E2E_MOCK_INSTAGRAM === '1') {
    return Promise.resolve(mockInstagramResponse(command));
  }
  // ... existing implementation
```

- [ ] **Step 2: Add XHS bridge mock**

In `skill/scripts/xhs-bridge-client.ts`, modify `isXhsAvailable` (line 134):

```typescript
export async function isXhsAvailable(): Promise<boolean> {
  if (process.env.E2E_MOCK_XHS === '1') return false;
  try {
    await callXhsCli('check-login');
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 3: Add cron sync mock**

In `skill/scripts/cron-sync.ts`, add early return at start of `syncCronSchedule` (line 127):

```typescript
export function syncCronSchedule(schedule: CronSchedule): SyncResult {
  if (process.env.E2E_MOCK_CRON === '1') {
    return { synced: true, details: { morning: 'synced', tick: 'synced', night: 'synced' } };
  }
  const expressions = buildCronExpression(schedule);
  // ... rest unchanged
```

- [ ] **Step 4: Run all existing tests**

Run: `npx vitest run`
Expected: All pass — mock is only activated by env var

- [ ] **Step 5: Commit**

```bash
git add skill/scripts/instagram-bridge-client.ts skill/scripts/xhs-bridge-client.ts skill/scripts/cron-sync.ts
git commit -m "feat: add E2E mock modes to Instagram, XHS, and cron bridges"
```

---

### Task 5: Export regularTick() + add inline pipeline mode

**Files:**
- Modify: `skill/scripts/heartbeat-tick.ts:171,521-541`

- [ ] **Step 1: Export regularTick()**

Change line 171 from:
```typescript
async function regularTick(): Promise<void> {
```
to:
```typescript
export async function regularTick(): Promise<void> {
```

- [ ] **Step 2: Add inline pipeline mode**

Replace the spawn block (lines 522-536) with:

```typescript
      if (action.skill === 'post-pipeline' || action.skill === 'auto-photo') {
        if (!vitalityConstraints.canPost) {
          console.log(`[REAL ACTION] Skipped post-pipeline — vitality too low (${Math.round(vitality.vitality)})`);
          actionResults.push(`[skipped:low-vitality] ${action.action}`);
          continue;
        }
        vitality = applyActionCost(vitality, 'post-pipeline');
        if (process.env.E2E_INLINE_PIPELINE === '1') {
          try {
            const { runPipeline } = await import('./post-pipeline');
            console.log(`[REAL ACTION] Running post-pipeline inline for: ${action.action}`);
            await runPipeline();
          } catch (pipeErr) {
            console.error(`[REAL ACTION] Inline post-pipeline failed: ${(pipeErr as Error).message}`);
          }
        } else {
          const scriptPath = require.resolve('./post-pipeline');
          const child = spawn('node', [scriptPath], {
            detached: true,
            stdio: 'ignore',
            env: process.env,
          });
          child.unref();
          console.log(`[REAL ACTION] Spawned post-pipeline (pid: ${child.pid}) for: ${action.action}`);
        }
```

- [ ] **Step 3: Run existing tests + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add skill/scripts/heartbeat-tick.ts
git commit -m "feat: export regularTick() and add inline pipeline mode for E2E"
```

---

### Task 6: Add e2e script to package.json + update .gitignore

**Files:**
- Modify: `package.json:9-14`
- Modify: `.gitignore`

- [ ] **Step 1: Add e2e script**

Add to `package.json` scripts:
```json
"e2e": "vitest run tests/e2e-lifecycle.test.ts --timeout 600000"
```

- [ ] **Step 2: Add e2e-sandbox and e2e-output to .gitignore**

Append to `.gitignore`:
```
tests/e2e-sandbox/
tests/e2e-output/
```

- [ ] **Step 3: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: add e2e script and ignore sandbox/output dirs"
```

---

## Chunk 2: E2E Lifecycle Runner

### Task 7: Build the E2E lifecycle runner

**Files:**
- Create: `tests/e2e-lifecycle.test.ts`

This is the main E2E test file. It is a single vitest `describe` block that:
1. Sets up a sandbox environment
2. Runs a simulated 24-hour lifecycle (hours 7-23)
3. Captures state snapshots after each step
4. Runs the quality judge on the output
5. Writes reports to `tests/e2e-output/`

- [ ] **Step 1: Create sandbox setup + teardown helpers**

Create `tests/e2e-lifecycle.test.ts` with the sandbox initialization code. The sandbox init creates `tests/e2e-sandbox/memory/minase/` and writes all default state files from Appendix A of the spec.

Key details:
- Load real API keys from `~/.openclaw/openclaw.json` via `JSON.parse(fs.readFileSync(...))`
- Set env vars: `E2E_MOCK_INSTAGRAM=1`, `E2E_MOCK_XHS=1`, `E2E_MOCK_CRON=1`, `E2E_INLINE_PIPELINE=1`
- Call `setBasePaths(sandboxMemory, realSkillDir)` pointing to sandbox for memory but real `skill/` for templates/assets
- Set `post-impulse.json` with `value: 75` (above 70 threshold)
- Set `vitality-state.json` with `vitality: 80` (above 30 gate)
- afterAll: call `resetBasePaths()`, `clearTimeOverride()`, restore env vars

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setTimeOverride, clearTimeOverride, now } from '../skill/scripts/time-utils';
import { setBasePaths, resetBasePaths, PATHS, readJSON, writeJSON } from '../skill/scripts/file-utils';
import { runMorningPlan } from '../skill/scripts/morning-plan';
import { regularTick } from '../skill/scripts/heartbeat-tick';
import { runNightReflect } from '../skill/scripts/night-reflect';
import {
  DEFAULT_MOMENTUM, DEFAULT_UNDERTONE,
  DEFAULT_FLOW_STATE, DEFAULT_CHAIN_STATE,
  DEFAULT_POST_IMPULSE,
} from '../skill/scripts/types';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SANDBOX_DIR = path.join(PROJECT_ROOT, 'tests', 'e2e-sandbox');
const SANDBOX_MEMORY = path.join(SANDBOX_DIR, 'memory', 'minase');
const SKILL_DIR = path.join(PROJECT_ROOT, 'skill');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'tests', 'e2e-output');

// ... (full implementation — see step 2 onwards)
```

- [ ] **Step 2: Implement sandbox initialization function**

```typescript
function initSandbox(): void {
  // Clean up any previous run
  if (fs.existsSync(SANDBOX_DIR)) fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
  if (fs.existsSync(OUTPUT_DIR)) fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });

  // Create directory structure
  for (const dir of [
    SANDBOX_MEMORY,
    path.join(SANDBOX_MEMORY, 'photo-roll'),
    path.join(SANDBOX_MEMORY, 'relations', 'social', 'instagram'),
    path.join(SANDBOX_MEMORY, 'inspiration-refs'),
    OUTPUT_DIR,
    path.join(OUTPUT_DIR, 'state-snapshots'),
    path.join(OUTPUT_DIR, 'images'),
    path.join(OUTPUT_DIR, 'final-state'),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write default state files (from spec Appendix A)
  const defaults: Record<string, unknown> = {
    'emotion-state.json': {
      mood: { valence: 0.3, arousal: 0.5, description: '刚醒来' },
      energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
      last_updated: null, recent_cause: '初始化',
      momentum: { ...DEFAULT_MOMENTUM },
      undertone: { ...DEFAULT_UNDERTONE },
      impulse_history: [],
      consecutive_high_stress: 0,
      threshold_break_cooldown: 0,
    },
    'intent-pool.json': { intents: [], last_updated: null },
    'schedule-today.json': { date: null, rigid: [], flexible: [], generated_by: null },
    'event-queue.json': { events: [], max_size: 50 },
    'heartbeat-log.json': { logs: [], retention_days: 7 },
    'core-wisdom.json': { version: 1, wisdom: [], total_importance_since_reflection: 0 },
    'preferences.json': { cos_characters: [], content_style: [], active_hours: [], social_platforms: [] },
    'aspirations.json': { aspirations: [] },
    'personality-drift.json': { base: 'ESTP', modifiers: [] },
    'post-history.json': { posts: [] },
    'vitality-state.json': { vitality: 80, consecutive_low_days: 0, last_updated: null, last_recovery_date: null },
    'confidence-state.json': { confidence: 1.0, last_updated: null, streak: 0 },
    'post-impulse.json': { ...DEFAULT_POST_IMPULSE, value: 75 },
    'inspiration.json': {
      instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: 0 },
      acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: 0 },
      visual_trends: { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: 0 },
      self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: 0 },
      xiaohongshu_trends: { feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [], saved_inspirations: [], updated_at: 0 },
    },
    'flow-state.json': { ...DEFAULT_FLOW_STATE },
    'pending-chains.json': { ...DEFAULT_CHAIN_STATE },
  };

  for (const [file, data] of Object.entries(defaults)) {
    fs.writeFileSync(path.join(SANDBOX_MEMORY, file), JSON.stringify(data, null, 2));
  }

  // Text files
  fs.writeFileSync(path.join(SANDBOX_MEMORY, 'diary.md'), '# 水瀬の日記\n');
  fs.writeFileSync(path.join(SANDBOX_MEMORY, 'world.md'), '# 世界観察\n\n_水瀬在浏览网络时学到的事情。_\n');

  // Social meta
  fs.mkdirSync(path.join(SANDBOX_MEMORY, 'relations', 'social'), { recursive: true });
  fs.writeFileSync(
    path.join(SANDBOX_MEMORY, 'relations', 'social', 'meta.json'),
    JSON.stringify({ instagram_following: [], xiaohongshu_following: [], stats: { core: 0, familiar: 0, cognitive: 0, dormant: 0 } }, null, 2),
  );
}
```

- [ ] **Step 3: Implement console capture utility**

```typescript
interface CapturedLogs {
  logs: string[];
  restore: () => void;
}

function captureConsole(): CapturedLogs {
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(`[LOG] ${args.map(String).join(' ')}`);
    origLog(...args);
  };
  console.error = (...args: unknown[]) => {
    logs.push(`[ERR] ${args.map(String).join(' ')}`);
    origErr(...args);
  };
  return { logs, restore: () => { console.log = origLog; console.error = origErr; } };
}
```

- [ ] **Step 4: Implement state snapshot capture**

```typescript
function captureSnapshot(hour: number): void {
  const snapshot: Record<string, unknown> = {};
  const jsonFiles = fs.readdirSync(SANDBOX_MEMORY).filter(f => f.endsWith('.json'));
  for (const file of jsonFiles) {
    try {
      snapshot[file] = JSON.parse(fs.readFileSync(path.join(SANDBOX_MEMORY, file), 'utf8'));
    } catch { /* skip corrupt */ }
  }
  // Also capture diary
  const diaryPath = path.join(SANDBOX_MEMORY, 'diary.md');
  if (fs.existsSync(diaryPath)) {
    snapshot['diary.md'] = fs.readFileSync(diaryPath, 'utf8');
  }
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'state-snapshots', `hour-${String(hour).padStart(2, '0')}.json`),
    JSON.stringify(snapshot, null, 2),
  );
}
```

- [ ] **Step 5: Implement the main simulation loop**

```typescript
interface TickLog {
  hour: number;
  module: string;
  logs: string[];
  duration_ms: number;
  error?: string;
}

async function runSimulation(): Promise<{ tickLogs: TickLog[]; pipelineRanAtLeastOnce: boolean }> {
  const tickLogs: TickLog[] = [];
  let pipelineRanAtLeastOnce = false;
  const today = '2026-06-15'; // Fixed simulated date (a Sunday for free schedule)
  const hours = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];

  for (const hour of hours) {
    const simDate = new Date(`${today}T${String(hour).padStart(2, '0')}:00:00`);
    setTimeOverride(simDate);

    const capture = captureConsole();
    const start = Date.now();
    let module = '';
    let error: string | undefined;

    try {
      if (hour === 7) {
        module = 'morning-plan';
        await runMorningPlan();
      } else if (hour === 23) {
        module = 'night-reflect';
        await runNightReflect();
      } else {
        module = 'regular-tick';
        await regularTick();
      }
    } catch (err) {
      error = (err as Error).message;
      console.error(`Tick hour ${hour} failed: ${error}`);
    }

    capture.restore();
    const duration = Date.now() - start;

    // Check if pipeline ran
    const pipelineLogs = capture.logs.filter(l => l.includes('post-pipeline') || l.includes('REAL ACTION'));
    if (pipelineLogs.length > 0) pipelineRanAtLeastOnce = true;

    tickLogs.push({ hour, module, logs: capture.logs, duration_ms: duration, error });
    captureSnapshot(hour);

    console.log(`--- Hour ${hour} (${module}) completed in ${duration}ms ${error ? `[ERROR: ${error}]` : ''}`);
  }

  // Forced pipeline trigger at end if none ran
  if (!pipelineRanAtLeastOnce) {
    console.log('--- FORCED PIPELINE TRIGGER (no pipeline ran during simulation)');
    setTimeOverride(new Date(`${today}T14:30:00`));
    const capture = captureConsole();
    const start = Date.now();
    try {
      const { runPipeline } = await import('../skill/scripts/post-pipeline');
      await runPipeline();
      pipelineRanAtLeastOnce = true;
    } catch (err) {
      console.error(`Forced pipeline failed: ${(err as Error).message}`);
    }
    capture.restore();
    tickLogs.push({ hour: 14.5, module: 'forced-pipeline', logs: capture.logs, duration_ms: Date.now() - start });
  }

  return { tickLogs, pipelineRanAtLeastOnce };
}
```

- [ ] **Step 6: Implement output collection**

```typescript
function collectOutput(): void {
  // Copy images from sandbox photo-roll to output
  const photoRoll = path.join(SANDBOX_MEMORY, 'photo-roll');
  if (fs.existsSync(photoRoll)) {
    const dateDirs = fs.readdirSync(photoRoll);
    for (const dateDir of dateDirs) {
      const dirPath = path.join(photoRoll, dateDir);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      for (const file of fs.readdirSync(dirPath)) {
        if (file.endsWith('.png') || file.endsWith('.jpg')) {
          fs.copyFileSync(
            path.join(dirPath, file),
            path.join(OUTPUT_DIR, 'images', file),
          );
        }
      }
    }
  }

  // Copy final state
  const finalDir = path.join(OUTPUT_DIR, 'final-state');
  for (const file of fs.readdirSync(SANDBOX_MEMORY)) {
    const src = path.join(SANDBOX_MEMORY, file);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(finalDir, file));
    }
  }
}
```

- [ ] **Step 7: Wire up the test**

```typescript
describe('E2E Lifecycle', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeAll(() => {
    // Save and set env vars
    savedEnv = {
      E2E_MOCK_INSTAGRAM: process.env.E2E_MOCK_INSTAGRAM,
      E2E_MOCK_XHS: process.env.E2E_MOCK_XHS,
      E2E_MOCK_CRON: process.env.E2E_MOCK_CRON,
      E2E_INLINE_PIPELINE: process.env.E2E_INLINE_PIPELINE,
    };
    process.env.E2E_MOCK_INSTAGRAM = '1';
    process.env.E2E_MOCK_XHS = '1';
    process.env.E2E_MOCK_CRON = '1';
    process.env.E2E_INLINE_PIPELINE = '1';

    // Load API keys from openclaw config
    try {
      const configPath = path.join(process.env.HOME!, '.openclaw', 'openclaw.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const minaseEnv = config?.skills?.entries?.minase?.env ?? {};
      if (minaseEnv.LLM_API_KEY) process.env.LLM_API_KEY = minaseEnv.LLM_API_KEY;
      if (minaseEnv.LLM_API_BASE) process.env.LLM_API_BASE = minaseEnv.LLM_API_BASE;
      if (minaseEnv.LLM_MODEL) process.env.LLM_MODEL = minaseEnv.LLM_MODEL;
      if (minaseEnv.AIHUBMIX_API_KEY) process.env.AIHUBMIX_API_KEY = minaseEnv.AIHUBMIX_API_KEY;
    } catch (err) {
      console.error('Warning: Could not load openclaw config for API keys');
    }

    initSandbox();
    setBasePaths(SANDBOX_MEMORY, SKILL_DIR);
  });

  afterAll(() => {
    resetBasePaths();
    clearTimeOverride();
    // Restore env
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('runs a full 24-hour lifecycle simulation', async () => {
    const startTime = Date.now();
    const { tickLogs, pipelineRanAtLeastOnce } = await runSimulation();
    const totalDuration = Date.now() - startTime;

    // Collect output
    collectOutput();

    // Write lifecycle log
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'lifecycle-log.json'),
      JSON.stringify({ tickLogs, totalDuration, pipelineRanAtLeastOnce }, null, 2),
    );

    // Count generated images
    const imageFiles = fs.readdirSync(path.join(OUTPUT_DIR, 'images'))
      .filter(f => f.endsWith('.png') || f.endsWith('.jpg'));

    // Basic assertions
    expect(tickLogs.length).toBeGreaterThanOrEqual(17); // 17 hours
    expect(tickLogs.filter(t => !t.error).length).toBeGreaterThanOrEqual(15); // at least 15 succeed

    // Check diary was written
    const diary = fs.readFileSync(path.join(OUTPUT_DIR, 'final-state', 'diary.md'), 'utf8');
    expect(diary.length).toBeGreaterThan(100);

    // Check wisdom was produced (by night reflect)
    const wisdom = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'final-state', 'core-wisdom.json'), 'utf8'));
    expect(wisdom.wisdom.length).toBeGreaterThan(0);

    console.log(`\n=== E2E Summary ===`);
    console.log(`Duration: ${totalDuration}ms`);
    console.log(`Ticks: ${tickLogs.length} (${tickLogs.filter(t => !t.error).length} successful)`);
    console.log(`Images: ${imageFiles.length}`);
    console.log(`Diary length: ${diary.length} chars`);
    console.log(`Wisdom entries: ${wisdom.wisdom.length}`);
    console.log(`Pipeline ran: ${pipelineRanAtLeastOnce}`);
  }, 600_000); // 10 minute timeout
});
```

- [ ] **Step 8: Commit**

```bash
git add tests/e2e-lifecycle.test.ts
git commit -m "feat: add E2E lifecycle runner with sandbox, time simulation, forced pipeline"
```

---

## Chunk 3: Quality Judge

### Task 8: Build the quality judge

**Files:**
- Create: `tests/e2e-quality-judge.ts`

This module is imported by the E2E test after simulation completes. It reads output artifacts and produces a quality report.

- [ ] **Step 1: Create the quality judge module**

Create `tests/e2e-quality-judge.ts` with the full implementation. The module exports one function: `runQualityJudge(outputDir: string): Promise<QualityReport>`.

Key implementation details:

**Image consistency:** Read reference images from `skill/assets/references/`, read generated images from `outputDir/images/`. For each generated image, call AIHubMix Gemini API with both reference and generated image, asking for JSON scores. Score twice per image, average. If scores differ by > 3, call a third time.

**Emotion dynamics:** Read all `state-snapshots/hour-XX.json` files. Extract `emotion-state.json` from each. Compute `variation` (stddev of valence/arousal), `description_diversity` (count unique descriptions) programmatically. Call LLM for `event_response` and `dimension_coupling` evaluation.

**Memory quality:** Read `final-state/diary.md`, `final-state/core-wisdom.json`, etc. Send to LLM for evaluation.

The full code is too long for inline listing. The key structure:

```typescript
export interface QualityReport { /* ... from spec */ }

export async function runQualityJudge(outputDir: string): Promise<QualityReport> {
  const report: QualityReport = { /* init with zeros */ };
  report.image_consistency = await judgeImageConsistency(outputDir);
  report.emotion_dynamics = await judgeEmotionDynamics(outputDir);
  report.memory_quality = await judgeMemoryQuality(outputDir);
  report.overall_pass = report.image_consistency.pass && report.emotion_dynamics.pass && report.memory_quality.pass;
  report.diagnosis = buildDiagnosis(report);
  report.suggested_fixes = buildSuggestions(report);
  return report;
}
```

- [ ] **Step 2: Implement image consistency judge**

Uses AIHubMix Gemini API to compare reference vs generated images. Reads images as base64. Sends structured prompt asking for JSON response with face_similarity, style_appropriateness, naturalness scores 1-10.

If 0 images generated, auto-fails with diagnostic.

- [ ] **Step 3: Implement emotion dynamics judge**

Reads all state snapshots. Computes:
- `variation`: stddev of valence across snapshots → maps to 1-10
- `description_diversity`: count unique mood descriptions → maps to 1-10
- `stuck_detected`: same description 5+ consecutive times AND numeric change < 0.1

Calls LLM for:
- `event_response`: given action log + emotion changes, rate appropriateness
- `dimension_coupling`: given all 6 dimensions across time, rate correlation quality

- [ ] **Step 4: Implement memory quality judge**

Reads final diary, wisdom, aspirations, preferences. Sends single LLM prompt asking for diary_diversity, diary_voice, wisdom_actionability, wisdom_relevance, character_consistency scores.

- [ ] **Step 5: Implement human-readable summary writer**

```typescript
export function writeQualitySummary(report: QualityReport, outputDir: string): void {
  const lines: string[] = [];
  lines.push(`# E2E Quality Report — ${report.timestamp}`);
  lines.push('');
  const passCount = [report.image_consistency.pass, report.emotion_dynamics.pass, report.memory_quality.pass].filter(Boolean).length;
  lines.push(`## Overall: ${report.overall_pass ? 'PASS' : 'FAIL'} (${passCount}/3 dimensions passed)`);
  // ... format each dimension
  lines.push('## Suggested Fixes');
  for (const fix of report.suggested_fixes) {
    lines.push(`- ${fix}`);
  }
  fs.writeFileSync(path.join(outputDir, 'quality-summary.md'), lines.join('\n'));
}
```

- [ ] **Step 6: Commit**

```bash
git add tests/e2e-quality-judge.ts
git commit -m "feat: add 3-dimension quality judge (image, emotion, memory)"
```

---

### Task 9: Integrate quality judge into E2E test

**Files:**
- Modify: `tests/e2e-lifecycle.test.ts`

- [ ] **Step 1: Add quality judge call after simulation**

In the E2E test, after `collectOutput()`, add:

```typescript
import { runQualityJudge, writeQualitySummary } from './e2e-quality-judge';

// ... inside the test:
console.log('\n=== Running Quality Judge ===');
const qualityReport = await runQualityJudge(OUTPUT_DIR);

// Write reports
fs.writeFileSync(
  path.join(OUTPUT_DIR, 'quality-report.json'),
  JSON.stringify(qualityReport, null, 2),
);
writeQualitySummary(qualityReport, OUTPUT_DIR);

console.log(`Quality: ${qualityReport.overall_pass ? 'PASS' : 'FAIL'}`);
console.log(`  Image: ${qualityReport.image_consistency.pass ? 'PASS' : 'FAIL'}`);
console.log(`  Emotion: ${qualityReport.emotion_dynamics.pass ? 'PASS' : 'FAIL'}`);
console.log(`  Memory: ${qualityReport.memory_quality.pass ? 'PASS' : 'FAIL'}`);
if (qualityReport.diagnosis) console.log(`  Diagnosis: ${qualityReport.diagnosis}`);
```

- [ ] **Step 2: Run the full E2E**

Run: `npm run e2e`
Expected: Runs to completion (quality thresholds may fail — that's expected and will be addressed in the optimization loop)

- [ ] **Step 3: Commit**

```bash
git add tests/e2e-lifecycle.test.ts
git commit -m "feat: integrate quality judge into E2E lifecycle test"
```

---

## Chunk 4: First Run + Diagnosis

### Task 10: Execute first E2E run and analyze results

- [ ] **Step 1: Run the E2E**

```bash
npm run e2e
```

- [ ] **Step 2: Review quality-summary.md**

```bash
cat tests/e2e-output/quality-summary.md
```

- [ ] **Step 3: Review lifecycle-log.json for errors**

```bash
cat tests/e2e-output/lifecycle-log.json | python3 -m json.tool | head -100
```

- [ ] **Step 4: Analyze and document findings**

Based on the report, identify specific code issues and propose fixes. Present to user for approval before making changes.

- [ ] **Step 5: Commit analysis results**

```bash
git add -f tests/e2e-output/quality-report.json tests/e2e-output/quality-summary.md
git commit -m "test: first E2E run results — baseline quality report"
```
