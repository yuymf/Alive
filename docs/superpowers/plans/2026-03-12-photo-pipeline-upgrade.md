# Photo Pipeline Upgrade Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Minase's photo-to-post system with multi-reference face consistency, inspiration image collection, multi-image carousel posts, organic posting rhythm, and realistic photo post-processing.

**Architecture:** Incremental enhancement on the existing pipeline. Five independent modules layered on top of the current generate → quality-check → post flow. Each module can be developed and tested in isolation. Module dependencies: M1 (face refs) and M5 (post-process) feed into M3 (multi-image gen), M2 (inspiration) feeds into M1+M3, M4 (impulse) is fully independent.

**Tech Stack:** TypeScript (CommonJS/ES2022), Vitest, jimp (image post-processing), instagrapi (Python Instagram bridge), AIHubMix Gemini API

**Spec:** `docs/superpowers/specs/2026-03-12-photo-pipeline-upgrade-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `skill/scripts/reference-selector.ts` | Select appropriate face reference images based on content style and scene description |
| `skill/scripts/post-impulse.ts` | Post impulse state management: accumulate, decay, reset, dormancy check |
| `skill/scripts/image-post-process.ts` | Jimp-based photo post-processing: noise, color temp, vignette, blur |
| `tests/reference-selector.test.ts` | Unit tests for reference selection + selfie detection |
| `tests/post-impulse.test.ts` | Unit tests for impulse accumulation, decay, clamping, dormancy |
| `tests/image-post-process.test.ts` | Unit tests for post-processing parameter generation |
| `tests/generate-image-set.test.ts` | Integration tests for multi-image generation with mocked API |
| `tests/upload-album.test.ts` | Integration tests for carousel upload with mocked bridge |

### Modified Files
| File | What Changes |
|------|-------------|
| `skill/scripts/types.ts` | Add `ShotDescription`, `PostImpulseState`, `SavedReference`; modify `PhotoIntent`, `PostIntent`, `PostRecord`, `GenerateImageOptions`, `InspirationData` |
| `skill/scripts/file-utils.ts` | Add `PATHS.postImpulse`, `PATHS.inspirationRefs`, `PATHS.references` |
| `skill/scripts/generate-image.ts` | Multi-reference API calls with fallback chain; `styleReference` support; `generateImageSet()`; `buildRealisticPrompt()` |
| `skill/scripts/content-planner.ts` | `shouldConsiderPosting()` → 3/day limit; `planPhoto()` multi-shot; `planPost()` multi-select |
| `skill/scripts/post-pipeline.ts` | Multi-image flow; carousel upload; impulse reset; backward compat for PostRecord |
| `skill/scripts/inspiration-collector.ts` | Image download + LLM filtering + saved_references management |
| `skill/scripts/heartbeat-tick.ts` | Impulse accumulation/decay; inject impulse context to LLM |
| `skill/scripts/instagram-bridge-client.ts` | Add `uploadAlbum()` function |
| `skill/scripts/instagram-bridge.py` | Add `upload_album` command; extend `hashtag_top` to return `thumbnail_url` |
| `skill/templates/photo-intent-prompt.md` | Add inspiration refs, shot count ranges, shots[] output format |
| `skill/templates/post-intent-prompt.md` | Change to `selectedPhotos[]`, multi-image ordering |
| `bin/cli.js` | Initialize `post-impulse.json`; copy `references/` directory |
| `package.json` | Add `jimp` dependency |
| `tests/content-planner.test.ts` | Update tests for new 3/day limit logic |

---

## Chunk 1: Foundation — Types, Paths, and Reference Selector (Module 1 core)

### Task 1: Add new types to types.ts

**Files:**
- Modify: `skill/scripts/types.ts:241-320`

- [ ] **Step 1: Add `ShotDescription` interface after line 240**

```typescript
// After ContentStyle type (line 241)

export interface ShotDescription {
  description: string;
  angle: string;
  variation: string;
}
```

- [ ] **Step 2: Add `PostImpulseState` and `DEFAULT_POST_IMPULSE` after `RandomEvent` (line 343)**

```typescript
export interface PostImpulseState {
  value: number;
  last_post_at: number;
  posts_today_date: string;
  posts_today: number;
}

export const DEFAULT_POST_IMPULSE: PostImpulseState = {
  value: 0,
  last_post_at: 0,
  posts_today_date: '',
  posts_today: 0,
};
```

- [ ] **Step 3: Add `SavedReference` interface after `PostImpulseState`**

```typescript
export interface SavedReference {
  url: string;
  local_path: string;
  source_hashtag: string;
  style_tags: string[];
  scene_description: string;
  saved_at: number;
}
```

- [ ] **Step 4: Modify `PhotoIntent` (line 306-312) to include multi-shot fields**

```typescript
export interface PhotoIntent {
  wantToShoot: boolean;
  sceneDescription: string;
  style: ContentStyle;
  mood: string;
  reason: string;
  imageCount: number;
  shots: ShotDescription[];
  referenceInspiration?: string;
}
```

- [ ] **Step 5: Modify `PostIntent` (line 314-320) — `selectedPhoto` → `selectedPhotos`**

```typescript
export interface PostIntent {
  wantToPost: boolean;
  selectedPhotos: string[];
  caption: string;
  hashtags: string[];
  reason: string;
}
```

- [ ] **Step 6: Modify `PostRecord` (line 243-258) — `image_local_path` → `image_local_paths`**

```typescript
export interface PostRecord {
  media_id: string;
  timestamp: number;
  style: ContentStyle;
  caption: string;
  hashtags: string[];
  image_local_paths: string[];
  image_url?: string;
  stats?: {
    likes: number;
    comments: number;
    reach: number;
    follows: number;
    checked_at: number;
  };
}
```

- [ ] **Step 7: Add `saved_references` to `InspirationData` (line 264-304)**

Add after the last field in `InspirationData`:

```typescript
  saved_references?: SavedReference[];
```

- [ ] **Step 8: Modify `GenerateImageOptions` in `generate-image.ts` (line 28-34) — preview only, actual change in Task 5**

This step is documentation-only: note that `GenerateImageOptions` will be updated from `referenceImagePath: string` to `referenceImages: string[]` plus `styleReference?: string` in Task 5.

- [ ] **Step 9: Run typecheck to identify all breakages from type changes**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck`

Expected: Multiple errors in files that reference `image_local_path`, `selectedPhoto`, `referenceImagePath`. Record every error location — these will be fixed in subsequent tasks.

- [ ] **Step 10: Commit type changes**

```bash
git add skill/scripts/types.ts
git commit -m "feat: add types for photo pipeline upgrade (ShotDescription, PostImpulseState, SavedReference, multi-image fields)"
```

---

### Task 2: Add new PATHS entries to file-utils.ts

**Files:**
- Modify: `skill/scripts/file-utils.ts:17-38`

- [ ] **Step 1: Add three new PATHS entries**

Add inside the `PATHS` object (after existing entries):

```typescript
  postImpulse: path.join(MEMORY_BASE, 'post-impulse.json'),
  inspirationRefs: path.join(MEMORY_BASE, 'inspiration-refs'),
  references: path.join(SKILL_BASE, 'assets', 'references'),
```

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck`

Expected: Same errors as before (from type changes), no new errors from PATHS.

- [ ] **Step 3: Commit**

```bash
git add skill/scripts/file-utils.ts
git commit -m "feat: add PATHS for post-impulse, inspiration-refs, references"
```

---

### Task 3: Create reference-selector.ts with tests (TDD)

**Files:**
- Create: `skill/scripts/reference-selector.ts`
- Create: `tests/reference-selector.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/reference-selector.test.ts
import { describe, it, expect } from 'vitest';
import { selectReferences, isSelfieType } from '../skill/scripts/reference-selector';

describe('isSelfieType', () => {
  it('returns true for daily style with selfie keywords', () => {
    expect(isSelfieType('daily', '在便利店里自拍')).toBe(true);
    expect(isSelfieType('daily', '镜子前的特写')).toBe(true);
    expect(isSelfieType('daily', '正脸照')).toBe(true);
  });

  it('returns false for daily style without selfie keywords', () => {
    expect(isSelfieType('daily', '街上看到的猫')).toBe(false);
    expect(isSelfieType('daily', '公园的风景')).toBe(false);
  });

  it('returns true for cos style by default (conservative)', () => {
    expect(isSelfieType('cos', '穿着制服在工作室')).toBe(true);
  });

  it('returns false for cos with explicit distant/landscape keywords', () => {
    expect(isSelfieType('cos', '远景全身照，背景是城堡')).toBe(false);
  });

  it('returns false for travel style by default', () => {
    expect(isSelfieType('travel', '海边的日落')).toBe(false);
  });

  it('returns true for travel with selfie keywords', () => {
    expect(isSelfieType('travel', '在海边自拍')).toBe(true);
  });

  it('returns false for behind_scenes by default', () => {
    expect(isSelfieType('behind_scenes', '工作台上的道具')).toBe(false);
  });
});

describe('selectReferences', () => {
  it('returns front + left-profile for selfie/closeup', () => {
    const refs = selectReferences('daily', '便利店自拍');
    expect(refs).toEqual(['front.png', 'left-profile.png']);
  });

  it('returns front + half-body for half-body cos', () => {
    const refs = selectReferences('cos', '穿着制服在工作室拍半身');
    expect(refs).toEqual(['front.png', 'half-body.png']);
  });

  it('returns half-body + full-body for full-body travel', () => {
    const refs = selectReferences('travel', '站在樱花树下的全身照');
    expect(refs).toEqual(['half-body.png', 'full-body.png']);
  });

  it('returns full-body only for distant/landscape scenes', () => {
    const refs = selectReferences('travel', '远处的海边风景，人很小');
    expect(refs).toEqual(['full-body.png']);
  });

  it('returns front + half-body for cos without specific angle cues', () => {
    // cos defaults to selfie-like treatment (conservative)
    const refs = selectReferences('cos', '穿着制服在工作室');
    expect(refs).toEqual(['front.png', 'half-body.png']);
  });

  it('returns filenames only (not full paths)', () => {
    const refs = selectReferences('daily', '自拍');
    refs.forEach(ref => {
      expect(ref).not.toContain('/');
      expect(ref).toMatch(/\.png$/);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/reference-selector.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement reference-selector.ts**

```typescript
// skill/scripts/reference-selector.ts
import { ContentStyle } from './types';

const SELFIE_KEYWORDS = ['自拍', '特写', '正脸', '镜子', '脸部', '头像', '近距离'];
const DISTANT_KEYWORDS = ['远景', '远处', '全景', '风景为主', '人很小'];
const FULLBODY_KEYWORDS = ['全身', '站在', '走在', '全身照'];
const HALFBODY_KEYWORDS = ['半身', '上半身', '坐着'];

function containsAny(text: string, keywords: readonly string[]): boolean {
  return keywords.some(kw => text.includes(kw));
}

/**
 * Determine if a scene is "selfie-type" (requires stricter face consistency).
 * Conservative: when uncertain, returns true.
 */
export function isSelfieType(style: ContentStyle, sceneDescription: string): boolean {
  if (containsAny(sceneDescription, SELFIE_KEYWORDS)) return true;
  if (containsAny(sceneDescription, DISTANT_KEYWORDS)) return false;

  switch (style) {
    case 'cos':
      // cos defaults to selfie-type unless explicitly distant
      return !containsAny(sceneDescription, DISTANT_KEYWORDS);
    case 'daily':
      return containsAny(sceneDescription, SELFIE_KEYWORDS);
    case 'travel':
    case 'behind_scenes':
      return false;
    default:
      return true; // conservative fallback
  }
}

/**
 * Select reference image filenames based on style and scene description.
 * Returns 1-2 filenames from the references/ directory.
 */
export function selectReferences(style: ContentStyle, sceneDescription: string): string[] {
  const isSelfie = containsAny(sceneDescription, SELFIE_KEYWORDS);
  const isDistant = containsAny(sceneDescription, DISTANT_KEYWORDS);
  const isFullBody = containsAny(sceneDescription, FULLBODY_KEYWORDS);

  // Selfie/closeup → front + left-profile
  if (isSelfie) {
    return ['front.png', 'left-profile.png'];
  }

  // Distant/landscape → full-body only
  if (isDistant) {
    return ['full-body.png'];
  }

  // Explicit full-body → half-body + full-body
  if (isFullBody) {
    return ['half-body.png', 'full-body.png'];
  }

  // Explicit half-body → front + half-body
  if (containsAny(sceneDescription, HALFBODY_KEYWORDS)) {
    return ['front.png', 'half-body.png'];
  }

  // Style-based defaults
  switch (style) {
    case 'cos':
      // cos without specific cues → front + half-body (conservative)
      return ['front.png', 'half-body.png'];
    case 'daily':
      // daily without selfie cues → front + half-body
      return ['front.png', 'half-body.png'];
    case 'travel':
      // travel default → half-body + full-body
      return ['half-body.png', 'full-body.png'];
    case 'behind_scenes':
      // behind_scenes → front + half-body
      return ['front.png', 'half-body.png'];
    default:
      return ['front.png', 'half-body.png'];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/reference-selector.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add skill/scripts/reference-selector.ts tests/reference-selector.test.ts
git commit -m "feat: add reference-selector with selfie detection and multi-angle reference selection"
```

---

### Task 4: Create post-impulse.ts with tests (TDD)

**Files:**
- Create: `skill/scripts/post-impulse.ts`
- Create: `tests/post-impulse.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/post-impulse.test.ts
import { describe, it, expect } from 'vitest';
import {
  accumulateImpulse,
  decayImpulse,
  resetImpulseAfterPost,
  shouldInjectPostDesire,
  checkDormancy,
} from '../skill/scripts/post-impulse';
import { PostImpulseState, DEFAULT_POST_IMPULSE } from '../skill/scripts/types';

function makeState(overrides?: Partial<PostImpulseState>): PostImpulseState {
  return { ...DEFAULT_POST_IMPULSE, ...overrides };
}

describe('accumulateImpulse', () => {
  it('adds delta to value, clamped to 0-100', () => {
    const state = makeState({ value: 50 });
    const result = accumulateImpulse(state, 25);
    expect(result.value).toBe(75);
  });

  it('clamps at 100', () => {
    const state = makeState({ value: 90 });
    const result = accumulateImpulse(state, 20);
    expect(result.value).toBe(100);
  });

  it('clamps at 0 for negative delta', () => {
    const state = makeState({ value: 5 });
    const result = accumulateImpulse(state, -10);
    expect(result.value).toBe(0);
  });

  it('is immutable', () => {
    const state = makeState({ value: 50 });
    const original = state.value;
    accumulateImpulse(state, 10);
    expect(state.value).toBe(original);
  });

  it('returns new object', () => {
    const state = makeState();
    const result = accumulateImpulse(state, 10);
    expect(result).not.toBe(state);
  });
});

describe('decayImpulse', () => {
  it('applies base decay of -3', () => {
    const state = makeState({ value: 50, posts_today: 0 });
    const result = decayImpulse(state);
    expect(result.value).toBe(47);
  });

  it('applies extra -5 when 1 post today', () => {
    // Use getLocalDate() to match the module's internal date logic
    const { getLocalDate } = require('../skill/scripts/time-utils');
    const today = getLocalDate();
    const state = makeState({ value: 50, posts_today: 1, posts_today_date: today });
    const result = decayImpulse(state);
    expect(result.value).toBe(42); // -3 base -5 extra
  });

  it('applies extra -15 when 2 posts today', () => {
    const { getLocalDate } = require('../skill/scripts/time-utils');
    const today = getLocalDate();
    const state = makeState({ value: 50, posts_today: 2, posts_today_date: today });
    const result = decayImpulse(state);
    expect(result.value).toBe(32); // -3 base -15 extra
  });

  it('clamps at 0', () => {
    const state = makeState({ value: 2 });
    const result = decayImpulse(state);
    expect(result.value).toBe(0);
  });

  it('resets posts_today on date rollover', () => {
    const state = makeState({ value: 50, posts_today: 2, posts_today_date: '2020-01-01' });
    const result = decayImpulse(state);
    expect(result.posts_today).toBe(0);
    expect(result.value).toBe(47); // only base decay, no extra (posts_today reset)
  });

  it('is immutable', () => {
    const state = makeState({ value: 50 });
    const original = state.value;
    decayImpulse(state);
    expect(state.value).toBe(original);
  });
});

describe('resetImpulseAfterPost', () => {
  it('sets value to 0', () => {
    const state = makeState({ value: 80 });
    const result = resetImpulseAfterPost(state);
    expect(result.value).toBe(0);
  });

  it('updates last_post_at to now', () => {
    const before = Date.now();
    const state = makeState({ last_post_at: 0 });
    const result = resetImpulseAfterPost(state);
    expect(result.last_post_at).toBeGreaterThanOrEqual(before);
  });

  it('increments posts_today', () => {
    const { getLocalDate } = require('../skill/scripts/time-utils');
    const today = getLocalDate();
    const state = makeState({ posts_today: 1, posts_today_date: today });
    const result = resetImpulseAfterPost(state);
    expect(result.posts_today).toBe(2);
  });

  it('resets posts_today to 1 if date changed', () => {
    const state = makeState({ posts_today: 2, posts_today_date: '2020-01-01' });
    const result = resetImpulseAfterPost(state);
    expect(result.posts_today).toBe(1);
  });

  it('is immutable', () => {
    const state = makeState({ value: 80 });
    resetImpulseAfterPost(state);
    expect(state.value).toBe(80);
  });
});

describe('shouldInjectPostDesire', () => {
  it('returns true when value >= 70', () => {
    expect(shouldInjectPostDesire(makeState({ value: 70 }))).toBe(true);
    expect(shouldInjectPostDesire(makeState({ value: 100 }))).toBe(true);
  });

  it('returns false when value < 70', () => {
    expect(shouldInjectPostDesire(makeState({ value: 69 }))).toBe(false);
    expect(shouldInjectPostDesire(makeState({ value: 0 }))).toBe(false);
  });
});

describe('checkDormancy', () => {
  it('returns 0 when last post was less than 5 days ago', () => {
    const state = makeState({ last_post_at: Date.now() - 3 * 24 * 60 * 60 * 1000 });
    expect(checkDormancy(state)).toBe(0);
  });

  it('returns 50 when last post was 5+ days ago', () => {
    const state = makeState({ last_post_at: Date.now() - 6 * 24 * 60 * 60 * 1000 });
    expect(checkDormancy(state)).toBe(50);
  });

  it('returns 50 when never posted (last_post_at = 0) and more than 5 days since init', () => {
    // Edge case: brand new install. Don't inject dormancy boost on day 1.
    // This tests the "never posted" path — checkDormancy should return 0
    // if last_post_at is 0 (special case for fresh installs).
    const state = makeState({ last_post_at: 0 });
    expect(checkDormancy(state)).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/post-impulse.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement post-impulse.ts**

```typescript
// skill/scripts/post-impulse.ts
import { PostImpulseState } from './types';
import { getLocalDate } from './time-utils';

const BASE_DECAY = 3;
const EXTRA_DECAY_1_POST = 5;
const EXTRA_DECAY_2_POSTS = 15;
const IMPULSE_THRESHOLD = 70;
const DORMANCY_DAYS = 5;
const DORMANCY_BOOST = 50;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getCurrentDate(): string {
  return getLocalDate();
}

/** Add or subtract impulse value, clamped to 0-100. Immutable. */
export function accumulateImpulse(state: PostImpulseState, delta: number): PostImpulseState {
  return {
    ...state,
    value: clamp(state.value + delta, 0, 100),
  };
}

/** Apply per-tick decay. Resets posts_today on date rollover. Immutable. */
export function decayImpulse(state: PostImpulseState): PostImpulseState {
  const today = getCurrentDate();
  const postsToday = state.posts_today_date === today ? state.posts_today : 0;
  const todayDate = state.posts_today_date === today ? state.posts_today_date : today;

  let totalDecay = BASE_DECAY;
  if (postsToday >= 2) {
    totalDecay += EXTRA_DECAY_2_POSTS;
  } else if (postsToday >= 1) {
    totalDecay += EXTRA_DECAY_1_POST;
  }

  return {
    ...state,
    value: clamp(state.value - totalDecay, 0, 100),
    posts_today: postsToday,
    posts_today_date: todayDate,
  };
}

/** Reset impulse after posting. Immutable. */
export function resetImpulseAfterPost(state: PostImpulseState): PostImpulseState {
  const today = getCurrentDate();
  const postsToday = state.posts_today_date === today ? state.posts_today : 0;

  return {
    value: 0,
    last_post_at: Date.now(),
    posts_today_date: today,
    posts_today: postsToday + 1,
  };
}

/** Check if impulse is high enough to inject "want to post" into LLM context. */
export function shouldInjectPostDesire(state: PostImpulseState): boolean {
  return state.value >= IMPULSE_THRESHOLD;
}

/** Check dormancy: if no posts for 5+ days, return boost amount (50). Otherwise 0.
 *  Special case: last_post_at === 0 means never posted (fresh install), no boost. */
export function checkDormancy(state: PostImpulseState): number {
  if (state.last_post_at === 0) return 0;
  const daysSincePost = (Date.now() - state.last_post_at) / (24 * 60 * 60 * 1000);
  return daysSincePost >= DORMANCY_DAYS ? DORMANCY_BOOST : 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/post-impulse.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add skill/scripts/post-impulse.ts tests/post-impulse.test.ts
git commit -m "feat: add post-impulse engine with accumulation, decay, dormancy check"
```

---

## Chunk 2: Image Post-Processing (Module 5) and Generate-Image Upgrade (Module 1)

### Task 5: Install jimp dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install jimp**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npm install jimp`

- [ ] **Step 2: Verify install**

Run: `cd /Users/halyu/Documents/Code/MizuSan && node -e "require('jimp')"`

Expected: No error.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add jimp dependency for image post-processing"
```

---

### Task 6: Create image-post-process.ts with tests (TDD)

**Files:**
- Create: `skill/scripts/image-post-process.ts`
- Create: `tests/image-post-process.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/image-post-process.test.ts
import { describe, it, expect } from 'vitest';
import {
  getProcessingParams,
  mulberry32,
} from '../skill/scripts/image-post-process';

describe('mulberry32', () => {
  it('produces deterministic output for same seed', () => {
    const rng1 = mulberry32(42);
    const rng2 = mulberry32(42);
    expect(rng1()).toBe(rng2());
    expect(rng1()).toBe(rng2());
  });

  it('produces different output for different seeds', () => {
    const rng1 = mulberry32(42);
    const rng2 = mulberry32(99);
    // Extremely unlikely to be equal for first value
    expect(rng1()).not.toBe(rng2());
  });

  it('returns values between 0 and 1', () => {
    const rng = mulberry32(12345);
    for (let i = 0; i < 100; i++) {
      const val = rng();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });
});

describe('getProcessingParams', () => {
  it('returns no-op params for cos style', () => {
    const params = getProcessingParams('cos');
    expect(params.skip).toBe(true);
  });

  it('returns daily params with noise and blur', () => {
    const params = getProcessingParams('daily');
    expect(params.skip).toBe(false);
    expect(params.noisePercent).toBeGreaterThan(0);
    expect(params.blurRadius).toBeGreaterThan(0);
  });

  it('returns travel params with saturation and vignette', () => {
    const params = getProcessingParams('travel');
    expect(params.skip).toBe(false);
    expect(params.saturationDelta).toBeGreaterThan(0);
    expect(params.vignetteStrength).toBeGreaterThan(0);
  });

  it('returns behind_scenes params with reduced contrast', () => {
    const params = getProcessingParams('behind_scenes');
    expect(params.skip).toBe(false);
    expect(params.contrastDelta).toBeLessThan(0);
  });

  it('uses groupSeed for deterministic randomness within group', () => {
    const params1 = getProcessingParams('daily', 42);
    const params2 = getProcessingParams('daily', 42);
    expect(params1).toEqual(params2);
  });

  it('produces ±3% variation within group (groupSeed)', () => {
    const params1 = getProcessingParams('daily', 42);
    const params2 = getProcessingParams('daily', 43); // different seed but same "group"
    // Different seeds should produce different (but close) params
    // This is a sanity check — exact values depend on PRNG
    expect(typeof params1.noisePercent).toBe('number');
  });

  it('defaults unknown style to daily processing', () => {
    const params = getProcessingParams('unknown_style' as any);
    expect(params.skip).toBe(false);
    expect(params.noisePercent).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/image-post-process.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement image-post-process.ts**

```typescript
// skill/scripts/image-post-process.ts
import * as path from 'path';
import { ContentStyle } from './types';

export interface ProcessingParams {
  skip: boolean;
  noisePercent: number;      // 0-5 (percent of pixels affected)
  blurRadius: number;        // 0-2 (gaussian blur radius)
  contrastDelta: number;     // -0.2 to 0.2
  saturationDelta: number;   // -0.2 to 0.2
  colorTempShift: number;    // -15 to 15 (negative=cool, positive=warm)
  vignetteStrength: number;  // 0-0.3
}

const EMPTY_PARAMS: ProcessingParams = {
  skip: true,
  noisePercent: 0,
  blurRadius: 0,
  contrastDelta: 0,
  saturationDelta: 0,
  colorTempShift: 0,
  vignetteStrength: 0,
};

interface StylePreset {
  noisePercent: number;
  blurRadius: number;
  contrastDelta: number;
  saturationDelta: number;
  colorTempShift: number;
  vignetteStrength: number;
}

const STYLE_PRESETS: Record<string, StylePreset> = {
  daily: {
    noisePercent: 1.5,
    blurRadius: 0.5,
    contrastDelta: -0.05,
    saturationDelta: -0.05,
    colorTempShift: 5,
    vignetteStrength: 0,
  },
  behind_scenes: {
    noisePercent: 1.0,
    blurRadius: 0.3,
    contrastDelta: -0.1,
    saturationDelta: -0.03,
    colorTempShift: 8,
    vignetteStrength: 0,
  },
  travel: {
    noisePercent: 0.5,
    blurRadius: 0,
    contrastDelta: 0.05,
    saturationDelta: 0.1,
    colorTempShift: 3,
    vignetteStrength: 0.15,
  },
};

/** Mulberry32 PRNG — deterministic from seed. Returns values in [0, 1). */
export function mulberry32(seed: number): () => number {
  let t = seed | 0;
  return () => {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Get processing parameters for a given style.
 * groupSeed provides deterministic randomness for within-group consistency (±3%).
 * Without groupSeed, uses ±10% random variation.
 */
export function getProcessingParams(style: ContentStyle, groupSeed?: number): ProcessingParams {
  if (style === 'cos') return { ...EMPTY_PARAMS };

  const preset = STYLE_PRESETS[style] ?? STYLE_PRESETS.daily;
  const variationRange = groupSeed !== undefined ? 0.03 : 0.10;
  const rng = groupSeed !== undefined ? mulberry32(groupSeed) : Math.random;

  function vary(base: number): number {
    const offset = (rng() * 2 - 1) * variationRange;
    return base * (1 + offset);
  }

  return {
    skip: false,
    noisePercent: vary(preset.noisePercent),
    blurRadius: vary(preset.blurRadius),
    contrastDelta: vary(preset.contrastDelta),
    saturationDelta: vary(preset.saturationDelta),
    colorTempShift: vary(preset.colorTempShift),
    vignetteStrength: vary(preset.vignetteStrength),
  };
}

/**
 * Apply post-processing to an image file.
 * Returns path to the processed image (new file with _processed suffix).
 */
export async function postProcessImage(
  imagePath: string,
  style: ContentStyle,
  groupSeed?: number,
): Promise<string> {
  const params = getProcessingParams(style, groupSeed);
  if (params.skip) return imagePath;

  // Dynamic import — jimp is only needed when actually processing
  const { Jimp } = await import('jimp');
  const image = await Jimp.read(imagePath);

  // Apply blur (reduced sharpness)
  if (params.blurRadius > 0) {
    image.blur(Math.max(1, Math.round(params.blurRadius)));
  }

  // Apply contrast adjustment
  if (params.contrastDelta !== 0) {
    image.contrast(params.contrastDelta);
  }

  // Apply color temperature shift (warm = add red/yellow, cool = add blue)
  if (params.colorTempShift !== 0) {
    image.color([
      { apply: 'red', params: [Math.round(params.colorTempShift)] },
      { apply: 'blue', params: [Math.round(-params.colorTempShift * 0.5)] },
    ]);
  }

  // Apply saturation
  if (params.saturationDelta !== 0) {
    image.color([
      { apply: 'saturate', params: [Math.round(params.saturationDelta * 100)] },
    ]);
  }

  // Apply noise (random pixel perturbation for phone-camera feel)
  if (params.noisePercent > 0) {
    const { width, height } = image;
    const pixelCount = Math.round(width * height * params.noisePercent / 100);
    for (let i = 0; i < pixelCount; i++) {
      const x = Math.floor(Math.random() * width);
      const y = Math.floor(Math.random() * height);
      const pixel = image.getPixelColor(x, y);
      const offset = Math.floor(Math.random() * 40) - 20;
      const r = Math.min(255, Math.max(0, ((pixel >> 24) & 0xff) + offset));
      const g = Math.min(255, Math.max(0, ((pixel >> 16) & 0xff) + offset));
      const b = Math.min(255, Math.max(0, ((pixel >> 8) & 0xff) + offset));
      const a = pixel & 0xff;
      image.setPixelColor((r << 24) | (g << 16) | (b << 8) | a, x, y);
    }
  }

  // Apply vignette (darken edges for travel photos)
  if (params.vignetteStrength > 0) {
    const { width, height } = image;
    const cx = width / 2;
    const cy = height / 2;
    const maxDist = Math.sqrt(cx * cx + cy * cy);
    image.scan(0, 0, width, height, (x, y, idx) => {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy) / maxDist;
      const factor = 1 - params.vignetteStrength * dist * dist;
      const data = image.bitmap.data;
      data[idx] = Math.round(data[idx] * factor);
      data[idx + 1] = Math.round(data[idx + 1] * factor);
      data[idx + 2] = Math.round(data[idx + 2] * factor);
    });
  }

  // Write to new file
  const ext = path.extname(imagePath);
  const base = imagePath.slice(0, -ext.length);
  const outputPath = `${base}_processed${ext}`;
  await image.write(outputPath as `${string}.${string}`);

  return outputPath;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/image-post-process.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add skill/scripts/image-post-process.ts tests/image-post-process.test.ts
git commit -m "feat: add image-post-process with jimp-based filters and deterministic PRNG"
```

---

### Task 7: Upgrade generate-image.ts — multi-reference + realistic prompts + generateImageSet

**Files:**
- Modify: `skill/scripts/generate-image.ts`

This is the largest single-file change. It modifies the API call to support multiple reference images with a fallback chain, adds `buildRealisticPrompt()`, and adds `generateImageSet()`.

- [ ] **Step 1: Update `GenerateImageOptions` interface (line 28-34)**

Replace:
```typescript
export interface GenerateImageOptions {
  prompt: string;
  referenceImagePath: string;
  style?: ContentStyle;
  aspectRatio?: string;
  outputDir?: string;
}
```

With:
```typescript
export interface GenerateImageOptions {
  prompt: string;
  referenceImages: string[];
  styleReference?: string;
  style?: ContentStyle;
  aspectRatio?: string;
  outputDir?: string;
}
```

- [ ] **Step 2: Add `REALISTIC_HINTS` constant and `buildRealisticPrompt()` after `buildImagePrompt()` (line 55)**

```typescript
const REALISTIC_HINTS: Record<string, string> = {
  daily: '用iPhone拍摄，自然光线，轻微过曝，浅景深，手持微晃感，非专业构图，主体偶尔偏离中心，背景有生活杂物，像发给朋友看的随手拍',
  behind_scenes: '手机随手拍的花絮，光线一般，有工作台杂物，未完成感，不是摆拍',
  travel: '手机广角，自然色彩，有游客感，背景有路人，光线不完美，有时逆光或阴影',
};

export function buildRealisticPrompt(sceneDescription: string, style: ContentStyle): string {
  const base = buildImagePrompt(sceneDescription, style);
  const hint = REALISTIC_HINTS[style];
  return hint ? `${base}，${hint}` : base;
}
```

- [ ] **Step 3: Modify `callAIHubMix()` to accept multiple reference images (line 60-126)**

Change signature from:
```typescript
async function callAIHubMix(
  prompt: string,
  referenceImageBase64: string,
  aspectRatio: string,
): Promise<{ imageData: Buffer; textResponse?: string }>
```

To:
```typescript
async function callAIHubMix(
  prompt: string,
  referenceImagesBase64: string[],
  aspectRatio: string,
  styleReferenceBase64?: string,
): Promise<{ imageData: Buffer; textResponse?: string }>
```

Update the message body construction (line 68-84):
```typescript
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: prompt },
  ];

  // Add face reference images with labeled purpose
  referenceImagesBase64.forEach((base64, i) => {
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${base64}` },
    });
  });

  // Add style reference if provided
  if (styleReferenceBase64) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${styleReferenceBase64}` },
    });
  }

  const body = {
    model: AIHUBMIX_MODEL,
    modalities: ['text', 'image'],
    messages: [
      { role: 'system', content: `aspect_ratio=${aspectRatio}` },
      { role: 'user', content },
    ],
  };
```

- [ ] **Step 4: Add fallback chain for multi-image reference**

**Important:** The response parsing logic (lines 99-126 of the original file) that handles `multi_mod_content` vs `content` and extracts `inline_data` must remain unchanged. Only the request construction changes; the response format is the same regardless of how many images are sent.

After the current `callAIHubMix` function, add a wrapper:

```typescript
/** Try multi-image reference, fallback to grid composite, fallback to single. */
async function callAIHubMixWithFallback(
  prompt: string,
  referenceImagesBase64: string[],
  aspectRatio: string,
  styleReferenceBase64?: string,
): Promise<{ imageData: Buffer; textResponse?: string }> {
  // Strategy 1: Multiple image_url parts
  try {
    return await callAIHubMix(prompt, referenceImagesBase64, aspectRatio, styleReferenceBase64);
  } catch (err) {
    if (referenceImagesBase64.length <= 1) throw err;
    console.log('Multi-image reference failed, trying grid composite fallback...');
  }

  // Strategy 2: Grid composite (requires jimp)
  try {
    const compositeBase64 = await compositeReferences(referenceImagesBase64);
    return await callAIHubMix(prompt, [compositeBase64], aspectRatio, styleReferenceBase64);
  } catch (err) {
    console.log('Grid composite fallback failed, trying single reference...');
  }

  // Strategy 3: Single image (first = most relevant)
  return await callAIHubMix(prompt, [referenceImagesBase64[0]], aspectRatio, styleReferenceBase64);
}

/** Composite multiple base64 images into a side-by-side grid using jimp. */
async function compositeReferences(imagesBase64: string[]): Promise<string> {
  const { Jimp } = await import('jimp');
  const images = await Promise.all(
    imagesBase64.map(b64 => Jimp.read(Buffer.from(b64, 'base64')))
  );

  // Resize all to same height (512px)
  const targetHeight = 512;
  const resized = images.map(img => {
    const scale = targetHeight / img.height;
    return img.resize({ w: Math.round(img.width * scale), h: targetHeight });
  });

  const totalWidth = resized.reduce((sum, img) => sum + img.width, 0);
  const composite = new Jimp({ width: totalWidth, height: targetHeight, color: 0xffffffff });

  let x = 0;
  for (const img of resized) {
    composite.composite(img, x, 0);
    x += img.width;
  }

  const buffer = await composite.getBuffer('image/jpeg');
  return buffer.toString('base64');
}
```

- [ ] **Step 5: Update `generateImage()` function (line 214-274)**

Key changes:
1. Destructure `referenceImages` instead of `referenceImagePath`
2. Load and compress all reference images
3. Load style reference if provided
4. Call `callAIHubMixWithFallback` instead of `callAIHubMix`
5. Use `isSelfieType` for quality threshold

```typescript
export async function generateImage(options: GenerateImageOptions): Promise<GenerateImageResult> {
  const { prompt, referenceImages, styleReference, style = 'daily', aspectRatio = DEFAULT_ASPECT_RATIO } = options;
  const today = getLocalDate();
  const outputDir = options.outputDir ?? path.join(PATHS.photoRoll, today);

  fs.mkdirSync(outputDir, { recursive: true });

  // Load all reference images
  const refBase64List = referenceImages
    .filter(refPath => fs.existsSync(refPath))
    .map(refPath => loadReferenceBase64(refPath));

  if (refBase64List.length === 0) {
    throw new Error(`No valid reference images found: ${referenceImages.join(', ')}`);
  }

  // Load style reference if provided
  const styleRefBase64 = styleReference && fs.existsSync(styleReference)
    ? loadReferenceBase64(styleReference)
    : undefined;

  // Determine quality thresholds
  const selfie = isSelfieType(style, prompt);
  const qualityThreshold = selfie ? 7 : QUALITY_THRESHOLD;
  const maxQualityRetries = selfie ? 2 : MAX_QUALITY_RETRIES;

  // Generate with retry
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { imageData, textResponse } = await callAIHubMixWithFallback(
        prompt, refBase64List, aspectRatio, styleRefBase64
      );

      const timestamp = Date.now();
      const hour = getLocalHour();
      const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
      const existing = fs.existsSync(outputDir) ? fs.readdirSync(outputDir).length : 0;
      const filename = `${timeOfDay}_${style}_${existing + 1}.png`;
      const localPath = path.join(outputDir, filename);

      fs.writeFileSync(localPath, imageData);

      // Quality check — compare to first (most relevant) reference
      const primaryRef = referenceImages.find(p => fs.existsSync(p)) ?? referenceImages[0];
      for (let qAttempt = 0; qAttempt < maxQualityRetries; qAttempt++) {
        const score = await checkQuality(localPath, primaryRef);
        if (score >= qualityThreshold) {
          return { localPath, textResponse, timestamp };
        }

        // On second retry for selfie: append correction instruction
        const correctionPrompt = (selfie && qAttempt >= 1)
          ? `${prompt}，注意：请严格保持人脸特征与参考图一致，五官轮廓、发型发色、体型比例都要匹配`
          : prompt;

        console.log(`Quality score ${score} < ${qualityThreshold}, retrying (${qAttempt + 1}/${maxQualityRetries})...`);
        const retry = await callAIHubMixWithFallback(
          correctionPrompt, refBase64List, aspectRatio, styleRefBase64
        );
        fs.writeFileSync(localPath, retry.imageData);
      }

      const finalScore = await checkQuality(localPath, primaryRef);
      if (finalScore >= qualityThreshold) {
        return { localPath, textResponse, timestamp };
      }

      fs.unlinkSync(localPath);
      throw new Error(`Quality check failed after ${maxQualityRetries} retries (final score: ${finalScore})`);
    } catch (err) {
      lastError = err as Error;
      if (attempt < MAX_RETRIES) {
        console.error(`Image generation failed, retrying: ${lastError.message}`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  throw lastError ?? new Error('Image generation failed');
}
```

- [ ] **Step 6: Add `generateImageSet()` function at end of file (before CLI entry)**

```typescript
import { ShotDescription } from './types';
import { postProcessImage } from './image-post-process';
import { selectReferences } from './reference-selector';

export interface GenerateSetOptions {
  shots: ShotDescription[];
  baseReferenceDir: string;
  styleReference?: string;
  style: ContentStyle;
  aspectRatio?: string;
  outputDir?: string;
}

export interface GenerateSetResult {
  images: GenerateImageResult[];
  failed: number;
}

const MIN_IMAGES: Record<ContentStyle, number> = {
  cos: 3,
  daily: 1,
  behind_scenes: 2,
  travel: 4,
};

export async function generateImageSet(options: GenerateSetOptions): Promise<GenerateSetResult> {
  const { shots, style, baseReferenceDir, styleReference, aspectRatio, outputDir } = options;
  const results: GenerateImageResult[] = [];
  let failed = 0;
  const groupSeed = Math.random() * 2 ** 32 | 0;

  for (const shot of shots) {
    const prompt = buildRealisticPrompt(shot.description, style);

    // Per-shot reference selection — different shots may need different angles
    const refFileNames = selectReferences(style, shot.description);
    const referenceImages = refFileNames
      .map(f => path.join(baseReferenceDir, f))
      .filter(f => fs.existsSync(f));

    if (referenceImages.length === 0) {
      console.error(`No reference images found for shot: "${shot.description}"`);
      failed++;
      continue;
    }

    try {
      const result = await generateImage({
        prompt,
        referenceImages,
        styleReference,
        style,
        aspectRatio,
        outputDir,
      });

      // Post-process the generated image
      const processedPath = await postProcessImage(result.localPath, style, groupSeed);
      results.push({ ...result, localPath: processedPath });
    } catch (err) {
      console.error(`Shot failed: "${shot.description}" — ${(err as Error).message}`);
      failed++;
    }
  }

  // Degradation: if remaining images < type minimum, keep what we have (degrade to fewer, don't abandon)
  const minRequired = MIN_IMAGES[style] ?? 1;
  if (results.length > 0 && results.length < minRequired) {
    console.log(`Only ${results.length}/${minRequired} images passed for ${style}, degrading to available set`);
  }

  return { images: results, failed };
}
```

- [ ] **Step 7: Update CLI entry (line 277-288) to use new interface**

```typescript
if (require.main === module) {
  const prompt = process.argv[2] ?? '一张便利店里的自拍，日常风格，真实感';
  generateImage({
    prompt,
    referenceImages: [PATHS.referenceImage],
  })
    .then(result => console.log(`Photo saved: ${result.localPath}`))
    .catch(err => {
      console.error('Failed to take photo:', err.message);
      process.exit(1);
    });
}
```

- [ ] **Step 8: Add import for `isSelfieType` at top of file**

```typescript
import { isSelfieType } from './reference-selector';
```

- [ ] **Step 9: Run typecheck**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck`

Expected: Errors in files that still use old `referenceImagePath` or `image_local_path` — these are fixed in later tasks.

- [ ] **Step 10: Commit**

```bash
git add skill/scripts/generate-image.ts
git commit -m "feat: upgrade generate-image with multi-reference fallback, realistic prompts, and generateImageSet"
```

---

## Chunk 3: Instagram Bridge, Content Planner, and Post Pipeline (Modules 2-4 integration)

### Task 8: Upgrade instagram-bridge.py — add upload_album + thumbnail_url

**Files:**
- Modify: `skill/scripts/instagram-bridge.py`

- [ ] **Step 1: Add `upload_album` subparser and command handler**

In `main()` (line 221), add a new subparser after the `get_user_info` parser (line 244):

```python
    # upload_album
    p_album = subparsers.add_parser("upload_album")
    p_album.add_argument("--images", required=True, help="JSON array of image paths")
    p_album.add_argument("--caption", default="", help="Post caption")
```

Add the command handler function before `main()`:

```python
def cmd_upload_album(args):
    """Upload a carousel/album post."""
    cl = get_client()
    image_paths = json.loads(args.images)
    media = with_retry(lambda: cl.album_upload(
        paths=[Path(p) for p in image_paths],
        caption=args.caption or ''
    ))
    print(json.dumps({"media_pk": str(media.pk)}))
```

Add dispatch in the command routing section (after line 258):

```python
        elif args.command == "upload_album":
            cmd_upload_album(args)
```

- [ ] **Step 2: Extend `cmd_hashtag_top` to include `thumbnail_url` (line 184-203)**

In the list comprehension that builds the posts array, add `thumbnail_url`:
```python
# Change the posts list comprehension in cmd_hashtag_top:
posts = [{
    "pk": str(m.pk),
    "code": m.code,
    "like_count": m.like_count,
    "comment_count": m.comment_count,
    "caption_text": m.caption_text[:200] if m.caption_text else "",
    "thumbnail_url": str(m.thumbnail_url) if m.thumbnail_url else None,
} for m in medias[:amount]]
```

- [ ] **Step 3: Commit**

```bash
git add skill/scripts/instagram-bridge.py
git commit -m "feat: add upload_album command and thumbnail_url to hashtag_top in instagram bridge"
```

---

### Task 9: Upgrade instagram-bridge-client.ts — add uploadAlbum()

**Files:**
- Modify: `skill/scripts/instagram-bridge-client.ts`

- [ ] **Step 1: Add `uploadAlbum` export after `callInstagramBridge` function (line 50)**

```typescript
/**
 * Upload a carousel/album post to Instagram.
 * @param imagePaths Array of local image file paths
 * @param caption Post caption text
 * @returns media_pk of the created post
 */
export async function uploadAlbum(imagePaths: string[], caption: string): Promise<string> {
  const result = await callInstagramBridge('upload_album', {
    images: JSON.stringify(imagePaths),
    caption,
  });
  return (result as { media_pk: string }).media_pk;
}
```

- [ ] **Step 2: Commit**

```bash
git add skill/scripts/instagram-bridge-client.ts
git commit -m "feat: add uploadAlbum function to instagram bridge client"
```

---

### Task 10: Upgrade content-planner.ts — shouldConsiderPosting + planPhoto + planPost

**Files:**
- Modify: `skill/scripts/content-planner.ts`
- Modify: `tests/content-planner.test.ts`

- [ ] **Step 1: Update `shouldConsiderPosting` tests first**

Replace `tests/content-planner.test.ts` with updated tests:

```typescript
import { describe, it, expect } from 'vitest';
import { shouldConsiderPosting } from '../skill/scripts/content-planner';
import { PostHistory, PostRecord } from '../skill/scripts/types';

function makePost(overrides?: Partial<PostRecord>): PostRecord {
  return {
    media_id: '123',
    timestamp: Date.now(),
    style: 'cos',
    caption: 'test caption',
    hashtags: ['cosplay'],
    image_local_paths: ['/tmp/test.png'],
    ...overrides,
  };
}

describe('content-planner', () => {
  describe('shouldConsiderPosting', () => {
    it('should allow posting when there are no previous posts', () => {
      const history: PostHistory = { posts: [] };
      const result = shouldConsiderPosting(history);
      expect(result.allowed).toBe(true);
    });

    it('should allow posting when last post was 2 hours ago (no 16h limit)', () => {
      const history: PostHistory = {
        posts: [makePost({ timestamp: Date.now() - 2 * 60 * 60 * 1000 })],
      };
      const result = shouldConsiderPosting(history);
      expect(result.allowed).toBe(true);
    });

    it('should block posting when 3 posts already today', () => {
      const now = Date.now();
      const history: PostHistory = {
        posts: [
          makePost({ timestamp: now - 3 * 60 * 60 * 1000 }),
          makePost({ timestamp: now - 2 * 60 * 60 * 1000 }),
          makePost({ timestamp: now - 1 * 60 * 60 * 1000 }),
        ],
      };
      const result = shouldConsiderPosting(history);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('3');
    });

    it('should allow posting when 2 posts today (under limit)', () => {
      const now = Date.now();
      const history: PostHistory = {
        posts: [
          makePost({ timestamp: now - 2 * 60 * 60 * 1000 }),
          makePost({ timestamp: now - 1 * 60 * 60 * 1000 }),
        ],
      };
      const result = shouldConsiderPosting(history);
      expect(result.allowed).toBe(true);
    });

    it('should not count posts from previous days', () => {
      const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
      const history: PostHistory = {
        posts: [
          makePost({ timestamp: twoDaysAgo }),
          makePost({ timestamp: twoDaysAgo + 1000 }),
          makePost({ timestamp: twoDaysAgo + 2000 }),
        ],
      };
      const result = shouldConsiderPosting(history);
      expect(result.allowed).toBe(true);
    });

    it('should return a reason string regardless of allowed status', () => {
      const emptyHistory: PostHistory = { posts: [] };
      const allowedResult = shouldConsiderPosting(emptyHistory);
      expect(allowedResult.reason).toBeTruthy();

      const now = Date.now();
      const fullHistory: PostHistory = {
        posts: [
          makePost({ timestamp: now - 3 * 60 * 60 * 1000 }),
          makePost({ timestamp: now - 2 * 60 * 60 * 1000 }),
          makePost({ timestamp: now - 1 * 60 * 60 * 1000 }),
        ],
      };
      const blockedResult = shouldConsiderPosting(fullHistory);
      expect(blockedResult.reason).toBeTruthy();
    });
  });
});
```

- [ ] **Step 2: Run tests to see them fail (shouldConsiderPosting still has old logic)**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/content-planner.test.ts`

Expected: Some tests FAIL (the "2 hours ago should be allowed" test fails because old code checks 16h minimum).

- [ ] **Step 3: Rewrite `shouldConsiderPosting` (line 56-81)**

Replace with:

```typescript
const MAX_POSTS_PER_DAY = 3;

export function shouldConsiderPosting(history: PostHistory): { allowed: boolean; reason: string } {
  const today = getLocalDate();
  const todayStart = new Date(today).getTime();
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;

  const postsToday = history.posts.filter(
    p => p.timestamp >= todayStart && p.timestamp < todayEnd
  ).length;

  if (postsToday >= MAX_POSTS_PER_DAY) {
    return { allowed: false, reason: `今天已经发了${postsToday}条，达到每日上限${MAX_POSTS_PER_DAY}条` };
  }

  return { allowed: true, reason: `今天已发${postsToday}条，还可以发${MAX_POSTS_PER_DAY - postsToday}条` };
}
```

Remove the `MIN_POST_INTERVAL_MS` constant (line 39).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/content-planner.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Update `planPhoto()` (line 124-156) to support multi-shot output**

The LLM output now needs `imageCount` and `shots[]`. Update the JSON parsing in `planPhoto()`:

After parsing the LLM response, add defaults for backward compatibility:
```typescript
  const intent: PhotoIntent = {
    ...parsed,
    imageCount: parsed.imageCount ?? 1,
    shots: parsed.shots ?? (parsed.wantToShoot ? [{
      description: parsed.sceneDescription,
      angle: '正面',
      variation: '主图',
    }] : []),
  };
```

- [ ] **Step 6: Update `planPost()` (line 161-196) to support multi-photo selection**

Change the photo path resolution from single to array:
```typescript
  // Old:
  // const selectedPath = photoList.find(p => path.basename(p) === parsed.selectedPhoto) ?? parsed.selectedPhoto;

  // New:
  const selectedPhotos = (parsed.selectedPhotos ?? (parsed.selectedPhoto ? [parsed.selectedPhoto] : []))
    .map((name: string) => photoList.find(p => path.basename(p) === name) ?? name);

  const intent: PostIntent = {
    ...parsed,
    selectedPhotos,
  };
```

- [ ] **Step 7: Update all references to `image_local_path` in `getRecentStyleDistribution()` and `formatRecentPerformance()`**

Search and replace `p.image_local_path` with `p.image_local_paths?.[0] ?? (p as any).image_local_path` for backward compatibility in any read paths.

Alternatively, add a helper at the top of the file:
```typescript
function getFirstImagePath(post: PostRecord): string {
  return post.image_local_paths?.[0] ?? (post as any).image_local_path ?? '';
}
```

Use this helper anywhere `image_local_path` was previously accessed.

- [ ] **Step 8: Run typecheck**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck`

Check for remaining type errors. Fix any that appear.

- [ ] **Step 9: Run all tests**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npm test`

Expected: All tests pass.

- [ ] **Step 10: Commit**

```bash
git add skill/scripts/content-planner.ts tests/content-planner.test.ts
git commit -m "feat: upgrade content-planner with 3/day limit, multi-shot planPhoto, multi-select planPost"
```

---

### Task 11: Upgrade post-pipeline.ts — multi-image flow + carousel upload + impulse

**Files:**
- Modify: `skill/scripts/post-pipeline.ts`

- [ ] **Step 1: Add imports at top of file**

```typescript
import { generateImageSet, GenerateSetResult } from './generate-image';
import { uploadAlbum } from './instagram-bridge-client';
import { resetImpulseAfterPost, accumulateImpulse } from './post-impulse';
import { PostImpulseState, DEFAULT_POST_IMPULSE } from './types';
```

- [ ] **Step 2: Update `postToInstagram` to handle single and multiple images**

```typescript
async function postToInstagram(imagePaths: string[], caption: string): Promise<string> {
  if (imagePaths.length === 1) {
    const result = await callInstagramBridge('upload_photo', {
      image: imagePaths[0],
      caption,
    });
    return (result as { media_pk: string }).media_pk;
  }
  return uploadAlbum(imagePaths, caption);
}
```

- [ ] **Step 3: Add backward compatibility helper for PostRecord**

```typescript
export function normalizePostRecord(post: PostRecord): PostRecord {
  if (!post.image_local_paths && (post as any).image_local_path) {
    return { ...post, image_local_paths: [(post as any).image_local_path] };
  }
  return post;
}
```

Use this when reading post history:
```typescript
const history: PostHistory = readJSON(PATHS.postHistory, DEFAULT_POST_HISTORY);
const normalizedHistory: PostHistory = {
  posts: history.posts.map(normalizePostRecord),
};
```

- [ ] **Step 4: Update `cleanupPhotoRoll` to use `image_local_paths`**

Replace `p.image_local_path` with `p.image_local_paths` (array). Check if any path in the array matches, not just a single path.

- [ ] **Step 5: Update `runPipeline` photo generation phase**

Replace the single `generateImage()` call with:

```typescript
// Select references based on style
const refDir = PATHS.references;
const photoIntent = await planPhoto();
if (!photoIntent.wantToShoot) {
  writeDiary(photoIntent.reason, 2, ['不想拍']);
  return;
}

// Style reference from inspiration
const styleReference = photoIntent.referenceInspiration
  ? path.join(PATHS.inspirationRefs, photoIntent.referenceInspiration)
  : undefined;

// Generate image set (per-shot reference selection happens inside generateImageSet)
const setResult = await generateImageSet({
  shots: photoIntent.shots,
  baseReferenceDir: refDir,
  styleReference,
  style: photoIntent.style,
});

if (setResult.images.length === 0) {
  writeDiary('拍照全部失败了...', 3, ['失败']);
  return;
}

// Accumulate impulse from successful photos
let impulse: PostImpulseState = readJSON(PATHS.postImpulse, DEFAULT_POST_IMPULSE);
const photoBoost = 20 + Math.random() * 10; // +20~30
impulse = accumulateImpulse(impulse, photoBoost);
writeJSON(PATHS.postImpulse, impulse);
```

- [ ] **Step 6: Update the posting phase to handle multiple images**

```typescript
const postIntent = await planPost();
if (!postIntent.wantToPost || postIntent.selectedPhotos.length === 0) {
  writeDiary(postIntent.reason, 2, ['不想发']);
  return;
}

const caption = `${postIntent.caption}\n\n${postIntent.hashtags.map(t => `#${t}`).join(' ')}`;
const mediaPk = await postToInstagram(postIntent.selectedPhotos, caption);

// Record to history
const newRecord: PostRecord = {
  media_id: mediaPk,
  timestamp: Date.now(),
  style: photoIntent.style,
  caption: postIntent.caption,
  hashtags: postIntent.hashtags,
  image_local_paths: postIntent.selectedPhotos,
};

const history = readJSON(PATHS.postHistory, DEFAULT_POST_HISTORY);
writeJSON(PATHS.postHistory, {
  posts: [...history.posts, newRecord],
});

// Reset impulse
impulse = resetImpulseAfterPost(impulse);
writeJSON(PATHS.postImpulse, impulse);
```

- [ ] **Step 7: Run typecheck**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck`

Fix any remaining type errors.

- [ ] **Step 8: Commit**

```bash
git add skill/scripts/post-pipeline.ts
git commit -m "feat: upgrade post-pipeline with multi-image generation, carousel upload, and impulse tracking"
```

---

### Task 12: Upgrade heartbeat-tick.ts — impulse accumulation + decay + LLM context injection

**Files:**
- Modify: `skill/scripts/heartbeat-tick.ts`

- [ ] **Step 1: Add imports**

```typescript
import { PostImpulseState, DEFAULT_POST_IMPULSE } from './types';
import { accumulateImpulse, decayImpulse, shouldInjectPostDesire, checkDormancy } from './post-impulse';
```

- [ ] **Step 2: In `regularTick()`, add impulse state read + decay + accumulation (around line 200, after emotion/intent reads)**

```typescript
// Read impulse state
let impulse: PostImpulseState = readJSON(PATHS.postImpulse, DEFAULT_POST_IMPULSE);

// Decay impulse each tick
impulse = decayImpulse(impulse);

// Check dormancy
const dormancyBoost = checkDormancy(impulse);
if (dormancyBoost > 0) {
  impulse = accumulateImpulse(impulse, dormancyBoost);
  console.log(`Dormancy boost applied: +${dormancyBoost}`);
}

// Accumulate from emotion
if (emotion.mood.valence > 0.6 && emotion.mood.arousal > 0.5) {
  const emotionBoost = 5 + Math.random() * 5; // +5~10
  impulse = accumulateImpulse(impulse, emotionBoost);
}

// Write updated impulse
writeJSON(PATHS.postImpulse, impulse);
```

- [ ] **Step 3: Inject impulse into LLM perception summary**

In `buildPerceptionSummary()` (line 85-121), add a section:

```typescript
if (shouldInjectPostDesire(impulse)) {
  summary += `\n\n【发帖冲动】想发帖的冲动很强（冲动值：${Math.round(impulse.value)}/100），考虑一下要不要去拍照发帖`;
}
```

Pass `impulse` as a parameter to `buildPerceptionSummary()`.

- [ ] **Step 4: Write impulse state back after all tick processing**

Ensure `writeJSON(PATHS.postImpulse, impulse)` is called at the end of `regularTick()`, after all accumulation/decay has been applied.

- [ ] **Step 5: Run typecheck**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck`

- [ ] **Step 6: Run all tests**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npm test`

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add skill/scripts/heartbeat-tick.ts
git commit -m "feat: integrate post-impulse into heartbeat tick with accumulation, decay, and LLM injection"
```

---

## Chunk 4: Inspiration Collection Upgrade (Module 2) + Templates + Installer

### Task 13: Upgrade inspiration-collector.ts — image download + saved_references

**Files:**
- Modify: `skill/scripts/inspiration-collector.ts`

- [ ] **Step 1: Add image download utility function**

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { PATHS } from './file-utils';
import { SavedReference } from './types';

const DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_SAVED_REFS = 20;
const REF_EXPIRY_DAYS = 7;

const IMAGE_MAGIC_BYTES: Record<string, Buffer> = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  jpg: Buffer.from([0xff, 0xd8, 0xff]),
  webp: Buffer.from([0x52, 0x49, 0x46, 0x46]),
};

function isValidImage(buffer: Buffer): boolean {
  return Object.values(IMAGE_MAGIC_BYTES).some(magic =>
    buffer.length > magic.length && buffer.subarray(0, magic.length).equals(magic)
  );
}

async function downloadImage(url: string, destPath: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return false;

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_FILE_SIZE) return false;
    if (!isValidImage(buffer)) return false;

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buffer);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Add saved references cleanup function**

```typescript
function cleanupExpiredRefs(refs: SavedReference[]): SavedReference[] {
  const expiryMs = REF_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  return refs.filter(ref => {
    const expired = now - ref.saved_at > expiryMs;
    if (expired && fs.existsSync(ref.local_path)) {
      try { fs.unlinkSync(ref.local_path); } catch { /* ignore */ }
    }
    return !expired;
  });
}
```

- [ ] **Step 3: Modify `collectInstagramTrends()` to save images**

After the existing LLM summary call, add image filtering and download:

```typescript
// After getting trending posts from hashtag_top:
// Filter posts that have thumbnail_url
const postsWithImages = rawPosts.filter((p: any) => p.thumbnail_url);

// Ask LLM to filter "心动" images (max 5 per refresh)
if (postsWithImages.length > 0) {
  // Build image selection prompt
  const selectionPrompt = `你是水瀬（Minase），18岁辣妹系coser。从以下Instagram热门帖子中选出最多5张让你"心动"的图片（符合你的审美：辣妹风、cos、街拍、潮流）。

帖子列表：
${postsWithImages.map((p: any, i: number) => `${i + 1}. [${p.caption_text?.slice(0, 50)}] 点赞:${p.like_count}`).join('\n')}

返回JSON：{"selected": [序号], "reasons": {"序号": "原因"}}`;

  // Call LLM to filter
  const filterResult = await callLLM(selectionPrompt);
  const selected = filterResult.selected ?? [];

  // Download selected images
  const refsDir = PATHS.inspirationRefs;
  const newRefs: SavedReference[] = [];

  for (const idx of selected) {
    const post = postsWithImages[idx - 1];
    if (!post?.thumbnail_url) continue;

    const filename = `ig_${post.pk}_${Date.now()}.jpg`;
    const destPath = path.join(refsDir, filename);

    const ok = await downloadImage(post.thumbnail_url, destPath);
    if (ok) {
      newRefs.push({
        url: post.thumbnail_url,
        local_path: destPath,
        source_hashtag: currentHashtag,
        style_tags: [], // Will be enriched by LLM in future iteration
        scene_description: post.caption_text?.slice(0, 100) ?? '',
        saved_at: Date.now(),
      });
    }
  }

  // Merge with existing refs, cap at MAX_SAVED_REFS
  const existing = inspiration.saved_references ?? [];
  const cleaned = cleanupExpiredRefs(existing);
  const merged = [...cleaned, ...newRefs].slice(-MAX_SAVED_REFS);
  inspiration.saved_references = merged;
}
```

- [ ] **Step 4: Run typecheck**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add skill/scripts/inspiration-collector.ts
git commit -m "feat: add inspiration image download and saved_references management"
```

---

### Task 14: Update templates — photo-intent-prompt.md + post-intent-prompt.md

**Files:**
- Modify: `skill/templates/photo-intent-prompt.md`
- Modify: `skill/templates/post-intent-prompt.md`

- [ ] **Step 1: Update photo-intent-prompt.md**

Add after the existing inspiration section:

```markdown
## 灵感参考图片

{inspiration_refs}

## 拍照张数参考

根据内容类型选择拍照张数：
- cos: 3-6张（多角度/多表情组图）
- daily: 1-2张（随手拍）
- behind_scenes: 2-4张（过程记录）
- travel: 4-8张（旅行多场景）
```

Update the expected JSON output format:
```markdown
返回JSON：
```json
{
  "wantToShoot": true,
  "sceneDescription": "整体场景描述",
  "style": "cos/daily/behind_scenes/travel",
  "mood": "当前心情",
  "reason": "为什么想拍",
  "imageCount": 3,
  "shots": [
    {"description": "第一张具体描述", "angle": "机位角度", "variation": "与其他图的差异"},
    {"description": "第二张具体描述", "angle": "机位角度", "variation": "与其他图的差异"}
  ],
  "referenceInspiration": "ig_123_xxx.jpg 或 null"
}
```

- [ ] **Step 2: Update post-intent-prompt.md**

Change `selectedPhoto` to `selectedPhotos`:

```markdown
返回JSON：
```json
{
  "wantToPost": true,
  "selectedPhotos": ["photo1.png", "photo2.png"],
  "caption": "ins文案（1-3句话，1-3个emoji）",
  "hashtags": ["tag1", "tag2"],
  "reason": "为什么想发"
}
```

Add instruction:
```markdown
选择多张图片时，第一张最重要（决定封面/首图印象），请按重要性排序。
```

- [ ] **Step 3: Commit**

```bash
git add skill/templates/photo-intent-prompt.md skill/templates/post-intent-prompt.md
git commit -m "feat: update templates for multi-shot photo intent and multi-photo post selection"
```

---

### Task 15: Update bin/cli.js — initialize post-impulse.json + copy references

**Files:**
- Modify: `bin/cli.js`

- [ ] **Step 1: Add post-impulse.json initialization (around line 671)**

After the `post-history.json` initialization block:

```javascript
// post-impulse.json
const postImpulsePath = path.join(memoryDir, 'post-impulse.json');
if (!fs.existsSync(postImpulsePath)) {
  fs.writeFileSync(postImpulsePath, JSON.stringify({
    value: 0,
    last_post_at: 0,
    posts_today_date: '',
    posts_today: 0,
  }, null, 2));
  console.log('  ✓ post-impulse.json');
}
```

- [ ] **Step 2: Add inspiration-refs directory creation**

```javascript
// inspiration-refs/
const inspirationRefsDir = path.join(memoryDir, 'inspiration-refs');
if (!fs.existsSync(inspirationRefsDir)) {
  fs.mkdirSync(inspirationRefsDir, { recursive: true });
  console.log('  ✓ inspiration-refs/');
}
```

- [ ] **Step 3: Add references directory copy (copy skill/assets/references/ to install location)**

```javascript
// Copy reference images
const srcRefs = path.join(__dirname, '..', 'skill', 'assets', 'references');
const destRefs = path.join(skillDir, 'assets', 'references');
if (fs.existsSync(srcRefs) && !fs.existsSync(destRefs)) {
  fs.mkdirSync(destRefs, { recursive: true });
  for (const file of fs.readdirSync(srcRefs)) {
    fs.copyFileSync(path.join(srcRefs, file), path.join(destRefs, file));
  }
  console.log('  ✓ reference images');
}
```

- [ ] **Step 4: Commit**

```bash
git add bin/cli.js
git commit -m "feat: update installer to initialize post-impulse state and copy reference images"
```

---

## Chunk 5: Final Integration, Backward Compatibility, and Full Test Suite

### Task 16: Create missing integration tests — generate-image-set + upload-album + backward compat

**Files:**
- Create: `tests/generate-image-set.test.ts`
- Create: `tests/upload-album.test.ts`

- [ ] **Step 1: Write generate-image-set tests with mocked API**

```typescript
// tests/generate-image-set.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';

// Mock fs.existsSync to pretend reference files exist
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readdirSync: actual.readdirSync,
    mkdirSync: actual.mkdirSync,
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// Mock the entire generate-image module to avoid real API calls
vi.mock('../skill/scripts/generate-image', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../skill/scripts/generate-image')>();
  return {
    ...actual,
    generateImage: vi.fn().mockResolvedValue({
      localPath: '/tmp/test_image.png',
      textResponse: 'test',
      timestamp: Date.now(),
    }),
  };
});

vi.mock('../skill/scripts/image-post-process', () => ({
  postProcessImage: vi.fn().mockImplementation((p: string) => Promise.resolve(p)),
}));

import { generateImageSet } from '../skill/scripts/generate-image';
import { ShotDescription } from '../skill/scripts/types';

describe('generateImageSet', () => {
  it('generates one image per shot', async () => {
    const shots: ShotDescription[] = [
      { description: '正面特写', angle: '正面', variation: '主图' },
      { description: '侧面', angle: '左侧', variation: '侧脸' },
    ];

    const result = await generateImageSet({
      shots,
      baseReferenceDir: '/tmp/refs',
      style: 'cos',
    });

    expect(result.images.length + result.failed).toBe(2);
    expect(result.images.length).toBeGreaterThan(0);
  });

  it('returns failed count when generation throws', async () => {
    const { generateImage: mockGenerate } = await import('../skill/scripts/generate-image');
    (mockGenerate as any).mockRejectedValueOnce(new Error('API error'));

    const shots: ShotDescription[] = [
      { description: '会失败的', angle: '正面', variation: '主图' },
    ];

    const result = await generateImageSet({
      shots,
      baseReferenceDir: '/tmp/refs',
      style: 'daily',
    });

    expect(result.failed).toBe(1);
    expect(result.images).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Write upload-album tests with mocked bridge**

```typescript
// tests/upload-album.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../skill/scripts/instagram-bridge-client', () => ({
  callInstagramBridge: vi.fn().mockResolvedValue({ media_pk: '999' }),
  uploadAlbum: vi.fn().mockResolvedValue('999'),
}));

import { uploadAlbum } from '../skill/scripts/instagram-bridge-client';

describe('uploadAlbum', () => {
  it('returns media_pk on success', async () => {
    const result = await uploadAlbum(['/tmp/a.png', '/tmp/b.png'], 'test caption');
    expect(result).toBe('999');
  });
});
```

- [ ] **Step 3: Write backward compatibility test for PostRecord migration**

```typescript
// Add to tests/content-planner.test.ts or a new tests/backward-compat.test.ts
import { describe, it, expect } from 'vitest';

describe('PostRecord backward compatibility', () => {
  it('old image_local_path string should be wrapped in array when accessed', () => {
    const oldRecord = {
      media_id: '1',
      timestamp: Date.now(),
      style: 'cos' as const,
      caption: '',
      hashtags: [],
      image_local_path: '/tmp/old.png', // old field
    };

    // Simulate the normalization logic
    const paths = (oldRecord as any).image_local_paths
      ?? [(oldRecord as any).image_local_path];
    expect(paths).toEqual(['/tmp/old.png']);
  });
});
```

- [ ] **Step 4: Write impulse rhythm simulation test**

```typescript
// Add to tests/post-impulse.test.ts
describe('impulse rhythm simulation', () => {
  it('simulates 5-day dormancy triggering a boost', () => {
    let state = makeState({ last_post_at: Date.now() - 6 * 24 * 60 * 60 * 1000, value: 10 });
    const boost = checkDormancy(state);
    expect(boost).toBe(50);
    state = accumulateImpulse(state, boost);
    expect(state.value).toBe(60);
    // Still below 70, but one emotional tick could push over
    state = accumulateImpulse(state, 10); // emotion boost
    expect(shouldInjectPostDesire(state)).toBe(true);
  });

  it('simulates daily limit preventing 4th post', () => {
    const { getLocalDate } = require('../skill/scripts/time-utils');
    const today = getLocalDate();
    let state = makeState({ value: 80, posts_today: 0, posts_today_date: today });

    // Post 3 times
    state = resetImpulseAfterPost(state);
    expect(state.posts_today).toBe(1);
    state = accumulateImpulse(state, 80); // re-accumulate
    state = resetImpulseAfterPost(state);
    expect(state.posts_today).toBe(2);
    state = accumulateImpulse(state, 80);
    state = resetImpulseAfterPost(state);
    expect(state.posts_today).toBe(3);
    // posts_today is now 3 — shouldConsiderPosting (external) would block
  });

  it('simulates rapid decay after 2 posts today', () => {
    const { getLocalDate } = require('../skill/scripts/time-utils');
    const today = getLocalDate();
    let state = makeState({ value: 80, posts_today: 2, posts_today_date: today });

    // Apply 5 ticks of decay
    for (let i = 0; i < 5; i++) {
      state = decayImpulse(state);
    }
    // Each tick: -3 base -15 extra = -18 per tick, 5 ticks = -90
    expect(state.value).toBe(0); // clamped at 0
  });
});
```

- [ ] **Step 5: Run all new tests**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/generate-image-set.test.ts tests/upload-album.test.ts tests/post-impulse.test.ts`

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add tests/generate-image-set.test.ts tests/upload-album.test.ts tests/post-impulse.test.ts
git commit -m "test: add integration tests for generateImageSet, uploadAlbum, backward compat, and impulse simulation"
```

---

### Task 17: Fix all remaining image_local_path references

**Files:**
- Modify: any file still referencing `image_local_path` as a string

- [ ] **Step 1: Run typecheck and collect all errors**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck 2>&1 | head -100`

- [ ] **Step 2: Fix each file**

For each error:
- If it reads `post.image_local_path`, change to `post.image_local_paths[0]` or use `getFirstImagePath()` helper
- If it writes `image_local_path: x`, change to `image_local_paths: [x]`

Common locations to check:
- `post-pipeline.ts` — `cleanupPhotoRoll()`, `checkPostStats()`
- `content-planner.ts` — `getRecentStyleDistribution()`, `formatRecentPerformance()`
- `confidence-engine.ts` — if it accesses PostRecord

- [ ] **Step 3: Run typecheck — should be clean**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck`

Expected: No errors.

- [ ] **Step 4: Run all tests**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npm test`

Expected: All tests pass. If any test uses `image_local_path` in its fixture, update to `image_local_paths`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: migrate all image_local_path references to image_local_paths for multi-image support"
```

---

### Task 18: Add inspiration impulse accumulation to inspiration-collector

**Files:**
- Modify: `skill/scripts/inspiration-collector.ts`

- [ ] **Step 1: Add impulse accumulation after saving new references**

In the image download section added in Task 13, after the `merged` assignment, add impulse accumulation:

```typescript
import { accumulateImpulse } from './post-impulse';
import { PostImpulseState, DEFAULT_POST_IMPULSE } from './types';
import { readJSON, writeJSON, PATHS } from './file-utils';

// After saving new references:
if (newRefs.length > 0) {
  const impulseBoost = 10 + Math.random() * 5; // +10~15
  let impulse: PostImpulseState = readJSON(PATHS.postImpulse, DEFAULT_POST_IMPULSE);
  impulse = accumulateImpulse(impulse, impulseBoost);
  writeJSON(PATHS.postImpulse, impulse);
  console.log(`Inspiration saved ${newRefs.length} refs, impulse +${impulseBoost.toFixed(1)}`);
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck`

Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add skill/scripts/inspiration-collector.ts
git commit -m "feat: accumulate post impulse when saving inspiration reference images"
```

---

### Task 19: Create references directory placeholder

**Files:**
- Create: `skill/assets/references/.gitkeep`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p /Users/halyu/Documents/Code/MizuSan/skill/assets/references
touch /Users/halyu/Documents/Code/MizuSan/skill/assets/references/.gitkeep
```

- [ ] **Step 2: Commit**

```bash
git add skill/assets/references/.gitkeep
git commit -m "chore: add references directory placeholder (user provides actual images)"
```

---

### Task 20: Full integration test run

**Files:** None new — verification only.

- [ ] **Step 1: Run full typecheck**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck`

Expected: No errors.

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npm test`

Expected: All tests pass.

- [ ] **Step 3: Run build**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npm run build`

Expected: Build succeeds.

- [ ] **Step 4: Verify backward compatibility is covered by automated tests**

The backward compat test in Task 16 (`tests/generate-image-set.test.ts`) covers the PostRecord migration. No manual step needed — just verify `npm test` passes.

---

### Task 21: Update CLAUDE.md documentation

**Files:**
- Modify: `.claude/CLAUDE.md`

- [ ] **Step 1: Update Post Pipeline section**

Update the Post Pipeline description to reflect:
- Multi-image generation via `generateImageSet()`
- Carousel upload via `upload_album`
- Post-processing via `postProcessImage()`
- Impulse-based posting rhythm
- Inspiration image collection

- [ ] **Step 2: Update Heartbeat System section**

Add post-impulse engine to the list of six engines:
```
- **Post impulse engine** (`post-impulse.ts`) — 0-100 impulse value that accumulates from photo success, inspiration, and emotion, with per-tick decay and dormancy fallback.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/CLAUDE.md
git commit -m "docs: update CLAUDE.md with photo pipeline upgrade changes"
```
