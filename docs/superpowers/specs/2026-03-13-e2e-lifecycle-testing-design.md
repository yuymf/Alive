# E2E Lifecycle Testing & Quality Optimization — Design Spec

**Date:** 2026-03-13
**Status:** Approved (Rev 2 — post spec review)
**Scope:** Full 24-hour lifecycle simulation with quality assessment and semi-automatic optimization loop

## Problem Statement

MizuSan has been running for ~1 day with the following symptoms:
- Emotion state stuck at "平静" — mood.description never changes despite numeric shifts
- Photo roll empty — 0 photos generated despite heartbeat choosing "real" photo actions
- 0 Instagram posts — post-pipeline never completed successfully
- `post-impulse.json` not written to disk (heartbeat reads default but never persists)
- Inner monologue and diary entries are repetitive

The system needs an end-to-end test that simulates a complete 24-hour lifecycle, evaluates output quality across 3 dimensions, and supports a semi-automatic fix-and-rerun loop.

## Architecture Overview

```
npm run e2e
     |
     v
+-------------------+     +-------------------+
| E2E Lifecycle     |---->| Quality Judge     |
| Runner            |     | (LLM + Gemini)    |
| (24h simulation)  |     +-------------------+
+-------------------+              |
     |                             v
     v                   quality-report.json
tests/e2e-output/                  |
  lifecycle-log.json               v
  state-snapshots/        Human reviews report
  images/                 + human-readable summary
  final-state/                     |
                                   v
                          Fix code -> Re-run e2e
```

Two directories are used:
- **`tests/e2e-sandbox/`** — working directory during simulation (state files, photo roll). Cleaned at start of each run.
- **`tests/e2e-output/`** — final collected artifacts copied from sandbox after simulation completes. Persisted across runs for comparison.

## Part 1: E2E Lifecycle Runner

**File:** `tests/e2e-lifecycle.ts`

### Sandbox Environment

The runner creates an isolated environment to avoid polluting real memory state:

- Temporary memory directory: `tests/e2e-sandbox/memory/minase/`
- Skill base directory: real `skill/` directory (read-only — templates and assets)
- All state files initialized with installer defaults (see Appendix A)
- Reference images: real paths from `skill/assets/references/`
- Real API keys loaded from `~/.openclaw/openclaw.json`
- Instagram bridge mocked (returns fake data for ALL commands)
- XiaoHongShu bridge mocked (returns empty data)
- OpenClaw cron sync mocked (returns success, no-op)

### Time Control — Global `now()` Function

**Problem:** Raw `new Date()` calls appear in ~25 locations across the codebase (heartbeat-tick.ts, morning-plan.ts, night-reflect.ts, emotion-engine.ts, intent-engine.ts, confidence-engine.ts, vitality-engine.ts, flow-engine.ts, post-pipeline.ts, llm-client.ts). A time override in `time-utils.ts` alone would not cover internal timestamps like `last_updated`, `born_at`, `satisfied_at`, etc.

**Solution:** Add a global `now()` function to `time-utils.ts` that all modules use instead of `new Date()`:

```typescript
// time-utils.ts
let _timeOverride: Date | null = null;

export function setTimeOverride(date: Date): void {
  _timeOverride = date;
}

export function clearTimeOverride(): void {
  _timeOverride = null;
}

/** Use this instead of `new Date()` everywhere. */
export function now(): Date {
  return _timeOverride ? new Date(_timeOverride.getTime()) : new Date();
}

// All existing functions use now() as default:
export function getLocalHour(date: Date = now()): number { ... }
export function getLocalDate(date: Date = now()): string { ... }
// etc.
```

**Migration:** All `new Date()` calls across the codebase are replaced with `now()` imported from `time-utils.ts`. This is a mechanical search-and-replace affecting ~25 call sites. The `now()` function returns a fresh copy each time (not a reference to the override), so mutations are safe.

**Files requiring `new Date()` → `now()` migration:**
- `heartbeat-tick.ts` (3 sites)
- `morning-plan.ts` (2 sites)
- `night-reflect.ts` (1 site)
- `post-pipeline.ts` (1 site)
- `emotion-engine.ts` (3 sites)
- `intent-engine.ts` (4 sites)
- `confidence-engine.ts` (1 site)
- `vitality-engine.ts` (2 sites)
- `flow-engine.ts` (2 sites)
- `llm-client.ts` (1 site — debug timestamp, cosmetic only)
- `post-instagram.ts` (1 site)

Note: `Date.now()` calls (numeric timestamps) should also be replaced with `now().getTime()`.

### Path Injection

**Problem:** `file-utils.ts` exports `PATHS` with `as const`. CommonJS modules cache exported values, so reassigning `PATHS` via `export let` would not propagate to already-imported references. Mutating the object in-place contradicts the immutability principle.

**Solution:** Use a property-based approach — `PATHS` stays as a const object, but its values are computed from getter functions that check the override:

```typescript
// file-utils.ts

let _memoryBaseOverride: string | null = null;
let _skillBaseOverride: string | null = null;

function getMemoryBase(): string {
  return _memoryBaseOverride ?? path.join(process.env.HOME!, '.openclaw', 'workspace', 'memory', 'minase');
}

function getSkillBase(): string {
  return _skillBaseOverride ?? path.join(process.env.HOME!, '.openclaw', 'skills', 'minase');
}

export function setBasePaths(memoryBase: string, skillBase: string): void {
  _memoryBaseOverride = memoryBase;
  _skillBaseOverride = skillBase;
}

export function resetBasePaths(): void {
  _memoryBaseOverride = null;
  _skillBaseOverride = null;
}

// PATHS becomes a Proxy or a getter-based object:
export const PATHS = {
  get emotionState() { return path.join(getMemoryBase(), 'emotion-state.json'); },
  get intentPool() { return path.join(getMemoryBase(), 'intent-pool.json'); },
  get references() { return path.join(getSkillBase(), 'assets', 'references'); },
  // ... all other paths as getters
} as const;
```

This preserves `as const` compatibility (each getter returns a string), existing code using `PATHS.emotionState` continues to work, and the override propagates immediately to all consumers since getters are re-evaluated on each access.

**Note on `readTemplate()`:** This function uses `__dirname` directly, not `PATHS` or `SKILL_BASE`. Templates are read-only code assets, not runtime state, so they resolve to the real skill directory even in sandbox mode. This is correct behavior and does not need overriding.

### Function Accessibility

**Problem:** `regularTick()` in `heartbeat-tick.ts` is not exported. The `main()` function has first-wake detection logic (`cronSchedule.date !== todayStr`) and `isActiveHeartbeatHour()` gating that would interfere with controlled simulation.

**Solution:** Export `regularTick()` as a named export. Also export `runMorningPlan` and `runNightReflect` are already exported from their own modules. The E2E runner calls these functions directly, bypassing `main()`'s routing logic entirely:

```typescript
// heartbeat-tick.ts — add export
export async function regularTick(): Promise<void> { ... }
```

The E2E runner manages its own routing:
```typescript
for (const hour of [7, 8, 9, ..., 22, 23]) {
  setTimeOverride(makeDate(today, hour));
  if (hour === 7) await runMorningPlan();
  else if (hour === 23) await runNightReflect();
  else await regularTick();
  captureSnapshot(hour);
}
```

### Post-Pipeline Inline Execution

**Problem:** `heartbeat-tick.ts` spawns `post-pipeline.ts` as a detached child process with `stdio: 'ignore'`. In E2E mode, we need to capture its output and errors.

**Solution:** When `E2E_INLINE_PIPELINE=1`, replace the spawn with a direct `await runPipeline()` call:

```typescript
// In heartbeat-tick.ts regularTick(), the spawn block:
if (process.env.E2E_INLINE_PIPELINE === '1') {
  const { runPipeline } = await import('./post-pipeline');
  console.log(`[REAL ACTION] Running post-pipeline inline for: ${action.action}`);
  await runPipeline();
} else {
  const child = spawn('node', [scriptPath], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
}
```

### Forced Pipeline Trigger

**Problem:** Whether the LLM chooses `type: "real", skill: "post-pipeline"` depends on post impulse >= 70 AND LLM decision AND vitality > 30. None of these are guaranteed in a single run, making "at least one post attempt" non-deterministic.

**Solution:** The E2E runner seeds the post-impulse state with `value: 75` (above threshold) before the first regular tick. It also ensures vitality starts at 80 (above the 30 gate). If no pipeline run occurs by hour 14, the runner forces one by directly calling `runPipeline()`.

### Console Capture

The E2E runner captures all `console.log` and `console.error` output by temporarily replacing them:

```typescript
const logs: string[] = [];
const origLog = console.log;
const origErr = console.error;
console.log = (...args) => { logs.push(`[LOG] ${args.join(' ')}`); origLog(...args); };
console.error = (...args) => { logs.push(`[ERR] ${args.join(' ')}`); origErr(...args); };
// ... run tick ...
// ... restore originals ...
```

### Output Artifacts

| File | Contents |
|------|----------|
| `tests/e2e-output/lifecycle-log.json` | Array of `{ hour, module, logs: string[], duration_ms }` |
| `tests/e2e-output/state-snapshots/hour-XX.json` | Full state dump (all JSON files) after each step |
| `tests/e2e-output/images/` | All generated photos (copied from sandbox photo-roll) |
| `tests/e2e-output/final-state/` | Complete final memory state (all JSON + diary.md) |
| `tests/e2e-output/quality-report.json` | Quality Judge structured output |
| `tests/e2e-output/quality-summary.md` | Human-readable summary with pass/fail and issues |

### Error Handling

- **LLM API transient failure:** The existing retry logic in `llm-client.ts` (retry once after 10s) handles this. If both attempts fail, the tick is skipped (logged in heartbeat-log) and simulation continues to the next hour.
- **Image generation failure:** All shots failing is a valid outcome — the runner records it and continues. The Quality Judge will flag "0 images generated" as a failure.
- **Sandbox already exists:** Runner deletes `tests/e2e-sandbox/` at the start of each run (`rm -rf`).
- **Mid-simulation crash:** Partial output is preserved in `tests/e2e-output/`. The `lifecycle-log.json` records which hours completed. The Quality Judge skips dimensions that lack data (e.g., no images → image consistency auto-fails with diagnostic).

## Part 2: Mock Layer

### Instagram Bridge Mock

`instagram-bridge-client.ts` checks `E2E_MOCK_INSTAGRAM=1` and handles ALL commands:

```typescript
function mockInstagramResponse(command: string, args: Record<string, string>): unknown {
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

### XiaoHongShu Bridge Mock

`xhs-bridge-client.ts` checks `E2E_MOCK_XHS=1`:

```typescript
// In xhs-bridge-client.ts
export function isXhsAvailable(): boolean {
  if (process.env.E2E_MOCK_XHS === '1') return false; // Pretend XHS is not installed
  // ...existing check
}
```

When XHS is "not available," `refreshInspiration()` in `inspiration-collector.ts` already skips XHS collection gracefully.

### Cron Sync Mock

`cron-sync.ts` checks `E2E_MOCK_CRON=1`:

```typescript
export function syncCronSchedule(schedule: CronSchedule): SyncResult {
  if (process.env.E2E_MOCK_CRON === '1') {
    return { synced: true, details: { morning: 'synced', tick: 'synced', night: 'synced' } };
  }
  // ...existing implementation
}
```

### What Uses Real APIs

| Component | Real/Mock | Reason |
|-----------|-----------|--------|
| AIHubMix Gemini (image gen) | **Real** | Need real images for quality assessment |
| LLM API (heartbeat/reflect) | **Real** | Need real LLM output for quality assessment |
| Instagram bridge (ALL commands) | **Mock** | Don't want to actually post or scrape |
| XiaoHongShu bridge | **Mock** (pretend unavailable) | Optional dependency, not needed for E2E |
| OpenClaw cron sync | **Mock** (no-op success) | Don't modify real cron jobs |
| File system (memory state) | **Redirected** to sandbox | Isolation |
| Time | **Overridden** via `now()` | Simulate 24h in minutes |

### API Cost Estimate

Per E2E run:
- **LLM calls:** ~20 calls (1 morning plan + 15 regular ticks with ~1 simulated action each + 1 night reflect + 1 photo intent + 1 post intent) × ~$0.01/call = **~$0.20**
- **Image generation:** ~3-6 images × ~$0.02/image = **~$0.06-0.12**
- **Quality judge:** ~5 Gemini vision calls (image comparison) + ~2 LLM calls (emotion/memory analysis) = **~$0.10**
- **Total per run: ~$0.35-0.45**

## Part 3: Quality Judge

**File:** `tests/e2e-quality-judge.ts`

Runs after the lifecycle simulation. Reads all output artifacts and produces a structured quality report.

### Dimension 1: Image Consistency

**Input:** Reference image(s) from `skill/assets/references/` + all generated images from `tests/e2e-output/images/`

**Method:** For each generated image, call Gemini API with both images and a structured scoring prompt. Ask for JSON output with specific scores.

**Scoring dimensions:**
- `face_similarity` (1-10): Facial features, hairstyle, hair color, body type match with reference
- `style_appropriateness` (1-10): Does it match expected style (daily/cos/travel)?
- `naturalness` (1-10): Does it look like a real photo (not AI-generated)?

**Thresholds:** face_similarity >= 7, style_appropriateness >= 7, naturalness >= 6

**Scoring variance mitigation:** Each image is scored twice (two separate API calls). The final score is the average of the two. If scores differ by > 3 points, a third call breaks the tie. This reduces LLM scoring variance from ~+/-2 to ~+/-1.

**Failure handling:** If zero images were generated, this dimension auto-fails with diagnostic: "Pipeline never triggered or all shots failed. Check lifecycle-log.json for errors."

### Dimension 2: Emotion Dynamics

**Input:** State snapshots from `tests/e2e-output/state-snapshots/`

**Method:** Extract emotion state sequence from all snapshots. Compute some metrics programmatically, use LLM for qualitative assessment.

**Scoring dimensions:**
- `variation` (1-10): Programmatic — compute standard deviation of valence/arousal across snapshots. Map: stddev < 0.05 → score 1-3, 0.05-0.15 → score 4-7, > 0.15 → score 8-10
- `event_response` (1-10): LLM — given the action log and emotion changes, are responses appropriate?
- `description_diversity` (1-10): Programmatic — count unique `mood.description` values. Map: 1-2 unique → score 1-3, 3-5 unique → score 4-7, 6+ unique → score 8-10
- `dimension_coupling` (1-10): LLM — do valence/arousal/energy/stress/creativity/sociability show reasonable correlations?

**Thresholds:** All dimensions >= 7

**Definition of "stuck":** A state is considered "stuck" if the same `mood.description` appears in 5+ consecutive snapshots AND the numeric values (valence, arousal) change by < 0.1 total across those snapshots.

### Dimension 3: Memory Quality

**Input:** Final diary.md, core-wisdom.json, aspirations.json, preferences.json

**Method:** LLM evaluates content quality with a single structured prompt.

**Scoring dimensions:**
- `diary_diversity` (1-10): Are diary entries varied, non-repetitive, with personality?
- `diary_voice` (1-10): Does it sound like an 18-year-old ESTP cosplayer speaking Chinese with Japanese loanwords?
- `wisdom_actionability` (1-10): Are lessons specific and actionable (not generic platitudes)?
- `wisdom_relevance` (1-10): Do lessons relate to actual day's experiences?
- `character_consistency` (1-10): Is the overall character portrayal coherent?

**Thresholds:** All dimensions >= 8 (higher bar because memory is the core differentiator)

**Rationale for threshold difference:** Image consistency (>= 7) and emotion dynamics (>= 7) are constrained by external API quality and engine mechanics respectively. Memory quality (>= 8) is primarily LLM output quality which is more directly controllable via prompt engineering — hence the higher bar.

### Output Schema

```typescript
interface QualityReport {
  timestamp: string;
  e2e_duration_ms: number;
  ticks_completed: number;
  images_generated: number;
  posts_attempted: number;
  api_calls: { llm: number; gemini_image: number; gemini_judge: number };

  image_consistency: {
    scores: Array<{
      file: string;
      face_similarity: number;
      style_appropriateness: number;
      naturalness: number;
    }>;
    average: { face: number; style: number; natural: number };
    pass: boolean;
    issues: string[];
  };

  emotion_dynamics: {
    variation: number;
    event_response: number;
    description_diversity: number;
    dimension_coupling: number;
    unique_descriptions: string[];
    stuck_detected: boolean;
    stuck_description: string | null;
    pass: boolean;
    issues: string[];
  };

  memory_quality: {
    diary_diversity: number;
    diary_voice: number;
    wisdom_actionability: number;
    wisdom_relevance: number;
    character_consistency: number;
    diary_entry_count: number;
    wisdom_count: number;
    pass: boolean;
    issues: string[];
  };

  overall_pass: boolean;
  diagnosis: string;
  suggested_fixes: string[];
}
```

### Human-Readable Summary

In addition to `quality-report.json`, the judge writes `quality-summary.md`:

```markdown
# E2E Quality Report — 2026-03-13

## Overall: FAIL (1/3 dimensions passed)

### Image Consistency: FAIL
- 0 images generated
- Diagnosis: Post-pipeline never triggered...

### Emotion Dynamics: FAIL
- Variation: 2/10 (stuck at "平静" for 12/15 ticks)
- ...

### Memory Quality: PASS
- Diary voice: 8/10
- ...

## Suggested Fixes
1. [CRITICAL] Fix emotion description update in applyDelta()...
```

## Part 4: Optimization Loop

### Workflow

1. Run `npm run e2e`
2. Review `tests/e2e-output/quality-summary.md` (human-readable)
3. I analyze the report, diagnose root causes, propose specific code fixes
4. User confirms proposed fixes
5. I implement fixes
6. Re-run `npm run e2e`, compare before/after reports

### Known Issues to Investigate

Based on the current 1-day runtime observation:

1. **Emotion stuck at "平静"**
   - Hypothesis: `decayTowardBaseline()` decays too aggressively, or `mood.description` is not updated when numeric values change via `applyDelta()`
   - Investigation: Check if `applyDelta` updates description field, check decay rates vs. delta magnitudes

2. **Post-pipeline never executes**
   - Hypothesis: `spawn('node', [scriptPath])` with `stdio: 'ignore'` silently fails. Also, post-impulse never reaches 70 threshold because `post-impulse.json` is never written.
   - Investigation: E2E will call `runPipeline()` directly, revealing actual errors. Forced pipeline trigger at hour 14 ensures at least one attempt.

3. **Post-impulse not persisted**
   - Hypothesis: `readJSON(PATHS.postImpulse, DEFAULT_POST_IMPULSE)` returns default each tick, impulse accumulates in memory but `writeJSON(PATHS.postImpulse, impulse)` may not execute if it's after the impulse variable scope. (Verified: heartbeat-tick.ts line 429 writes impulse, but the file may not exist for the first write. Actually `writeJSON` creates directories as needed, so this should work. Further investigation needed.)

4. **Repetitive inner monologue**
   - Hypothesis: LLM prompt template doesn't provide enough context variation between ticks. The perception summary is mostly identical each hour when no events occur.
   - Investigation: Compare prompts across ticks to identify what changes vs. what stays static.

## Part 5: File Changes

### New Files

| File | Purpose |
|------|---------|
| `tests/e2e-lifecycle.ts` | E2E lifecycle runner (24h simulation) |
| `tests/e2e-quality-judge.ts` | Quality assessment with 3-dimension scoring |

### Modified Files

| File | Change | Scope |
|------|--------|-------|
| `skill/scripts/time-utils.ts` | Add `now()`, `setTimeOverride()`, `clearTimeOverride()` | 3 new functions |
| `skill/scripts/file-utils.ts` | Add `setBasePaths()`, `resetBasePaths()`, convert PATHS to getter-based | PATHS refactor + 2 functions |
| `skill/scripts/instagram-bridge-client.ts` | Add `E2E_MOCK_INSTAGRAM` check covering ALL commands | ~20 lines in mock function |
| `skill/scripts/xhs-bridge-client.ts` | Add `E2E_MOCK_XHS` check in `isXhsAvailable()` | 2 lines |
| `skill/scripts/cron-sync.ts` | Add `E2E_MOCK_CRON` check in `syncCronSchedule()` | 3 lines |
| `skill/scripts/heartbeat-tick.ts` | Export `regularTick()`, add `E2E_INLINE_PIPELINE` check | ~10 lines |
| `skill/scripts/heartbeat-tick.ts` | Replace `new Date()` with `now()` | 3 call sites |
| `skill/scripts/morning-plan.ts` | Replace `new Date()` with `now()` | 2 call sites |
| `skill/scripts/night-reflect.ts` | Replace `new Date()` with `now()` | 1 call site |
| `skill/scripts/post-pipeline.ts` | Replace `new Date()` with `now()` | 1 call site |
| `skill/scripts/emotion-engine.ts` | Replace `new Date()` with `now()` | 3 call sites |
| `skill/scripts/intent-engine.ts` | Replace `new Date()` with `now()` | 4 call sites |
| `skill/scripts/confidence-engine.ts` | Replace `new Date()` with `now()` | 1 call site |
| `skill/scripts/vitality-engine.ts` | Replace `new Date()` with `now()` | 2 call sites |
| `skill/scripts/flow-engine.ts` | Replace `new Date()` with `now()` | 2 call sites |
| `skill/scripts/post-instagram.ts` | Replace `new Date()` with `now()` | 1 call site |
| `package.json` | Add `"e2e"` script | 1 line |

### Unchanged Files (Until Quality Judge Diagnoses Issues)

Core logic files are not changed during E2E infrastructure setup. They only change during the optimization loop when the Quality Judge identifies specific issues:
- Engine logic in `emotion-engine.ts`, `intent-engine.ts`, etc.
- Template files in `skill/templates/`
- Installer in `bin/cli.js`

## NPM Script

```json
{
  "scripts": {
    "e2e": "vitest run tests/e2e-lifecycle.ts --timeout 600000"
  }
}
```

Timeout set to 10 minutes. Estimated runtime: 3-5 minutes (17 ticks × ~3s LLM call + 3-6 images × ~20s each + quality judge ~30s).

## Success Criteria

### E2E Infrastructure Working

1. Lifecycle runner completes a full 24h simulation without crashes
2. Quality Judge produces a valid report with scores for all 3 dimensions
3. At least 1 image is generated (forced pipeline trigger ensures this)
4. At least 1 post attempt occurs (forced trigger + mock ensures this)
5. Night reflection produces wisdom and diary entries

### Optimization Loop Successful

1. Image consistency average >= 7 (averaged over 2 judge runs per image)
2. All emotion dynamics scores >= 7
3. All memory quality scores >= 8
4. No "stuck" states detected (same description for 5+ consecutive hours with < 0.1 numeric change)

## Appendix A: Sandbox State Initialization

Files to create in `tests/e2e-sandbox/memory/minase/`:

| File | Default Content |
|------|----------------|
| `emotion-state.json` | ESTP baseline emotion state (from morning-plan defaults) |
| `intent-pool.json` | `{ "intents": [], "last_updated": null }` |
| `schedule-today.json` | `{ "date": null, "rigid": [], "flexible": [], "generated_by": null }` |
| `event-queue.json` | `{ "events": [], "max_size": 50 }` |
| `heartbeat-log.json` | `{ "logs": [], "retention_days": 7 }` |
| `diary.md` | `# 水瀬の日記\n` |
| `core-wisdom.json` | `{ "version": 1, "wisdom": [], "total_importance_since_reflection": 0 }` |
| `world.md` | `# 世界观察\n\n_水瀬在浏览网络时学到的事情。_\n` |
| `preferences.json` | `{ "cos_characters": [], "content_style": [], "active_hours": [], "social_platforms": [] }` |
| `aspirations.json` | `{ "aspirations": [] }` |
| `personality-drift.json` | `{ "base": "ESTP", "modifiers": [] }` |
| `post-history.json` | `{ "posts": [] }` |
| `vitality-state.json` | `{ "vitality": 80, "last_updated": null, ... }` |
| `confidence-state.json` | `{ "confidence": 1.0, "last_updated": null, ... }` |
| `post-impulse.json` | `{ "value": 75, ... }` (seeded above threshold) |
| `inspiration.json` | Minimal structure with empty arrays |
| `flow-state.json` | DEFAULT_FLOW_STATE |
| `pending-chains.json` | DEFAULT_CHAIN_STATE |
| `relations/social/meta.json` | `{ "instagram_following": [], "stats": { ... } }` |

Directories to create:
- `tests/e2e-sandbox/memory/minase/photo-roll/`
- `tests/e2e-sandbox/memory/minase/relations/social/instagram/`
- `tests/e2e-sandbox/memory/minase/inspiration-refs/`
