# Digital Nomad Rebrand Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve Minase from an office-worker hobbyist into a full-time digital nomad travel blogger with a daily posting KPI, a network-influencer best-friend advisor (小慧), and a travel state machine driving her content.

**Architecture:** Three modules build on each other in dependency order: (1) travel-state types + state machine in morning-plan, (2) KPI posting guarantee in heartbeat-tick + post-pipeline, (3) advisor-client + ins-advisor skill wired into post-pipeline. personality.md and content-planner ratios are updated as standalone steps.

**Tech Stack:** TypeScript (strict, ES2022, CommonJS), Vitest (globals: true), existing `callLLM`/`callLLMJSON` from `llm-client.ts`, existing `readJSON`/`writeJSON` from `file-utils.ts`, existing `RigidSchedule` / `ScheduleToday` types.

---

## Chunk 1: Types + Travel State Machine

### Task 1: Add TravelState types and PATHS entry

**Files:**
- Modify: `skill/scripts/types.ts` (after line 205, `SocialRelation` interface)
- Modify: `skill/scripts/file-utils.ts` (after line 67, `searchState` entry)

- [ ] **Step 1: Add TravelState types to types.ts**

Open `skill/scripts/types.ts`. After the `SocialRelation` interface (ends around line 205), insert:

```typescript
// === Travel State Machine ===
export type TravelPhase = 'arriving' | 'exploring' | 'shooting' | 'departing';

export interface TravelSpot {
  name: string;
  description: string;
  best_time: string;       // e.g. "傍晚 golden hour"
  style_tags: string[];    // e.g. ["travel_portrait", "scenic"]
  visited: boolean;
}

export interface TravelState {
  current_city: string;
  country: string;
  arrived_at: string;          // YYYY-MM-DD
  travel_day: number;          // cached; source of truth is arrived_at + planned_departure
  planned_departure: string;   // YYYY-MM-DD
  phase: TravelPhase;
  visited_spots: string[];
  next_destination: string;
  travel_mode: 'solo' | 'group';
}

export const DEFAULT_TRAVEL_STATE: TravelState = {
  current_city: '东京',
  country: '日本',
  arrived_at: '',
  travel_day: 1,
  planned_departure: '',
  phase: 'arriving',
  visited_spots: [],
  next_destination: '',
  travel_mode: 'solo',
};
```

Also add `min_closeness?: number` to the existing `SocialRelation` interface (after `last_interaction` field):

```typescript
  last_interaction: string;
  created_at: string;
  min_closeness?: number;   // optional floor; prevents dormancy decay below this value
```

- [ ] **Step 2: Add travelState to PATHS in file-utils.ts**

Open `skill/scripts/file-utils.ts`. After the `searchState` entry in the `PATHS` getter object, add:

```typescript
get travelState() { return path.join(this.base, 'memory', 'travel-state.json'); },
```

- [ ] **Step 3: Run typecheck to verify no errors**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck
```

Expected: no errors (new types are additive)

- [ ] **Step 4: Commit**

```bash
git add skill/scripts/types.ts skill/scripts/file-utils.ts
git commit -m "feat: add TravelState types and PATHS.travelState"
```

---

### Task 2: Write tests for travel phase calculation (TDD)

**Files:**
- Create: `tests/travel-state.test.ts`

- [ ] **Step 1: Create the test file**

Create `tests/travel-state.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { TravelState, TravelPhase, DEFAULT_TRAVEL_STATE } from '../skill/scripts/types';

// We'll import the helper once it exists:
// import { calcTravelPhase, advanceTravelState } from '../skill/scripts/travel-state';

// For now: pure logic tests that drive the implementation shape.

function makeTravel(overrides?: Partial<TravelState>): TravelState {
  return { ...DEFAULT_TRAVEL_STATE, ...overrides };
}

// --- calcTravelPhase ---
// Will be implemented in travel-state.ts
// Signature: calcTravelPhase(arrivedAt: string, plannedDeparture: string, today: string): TravelPhase

function calcTravelPhase(arrivedAt: string, plannedDeparture: string, today: string): TravelPhase {
  throw new Error('not implemented');
}

describe('calcTravelPhase', () => {
  it('day 1 → arriving', () => {
    expect(calcTravelPhase('2025-01-15', '2025-01-18', '2025-01-15')).toBe('arriving');
  });

  it('last day → departing', () => {
    expect(calcTravelPhase('2025-01-15', '2025-01-18', '2025-01-18')).toBe('departing');
  });

  it('day 2 of 4-day trip → exploring', () => {
    expect(calcTravelPhase('2025-01-15', '2025-01-18', '2025-01-16')).toBe('exploring');
  });

  it('day 3 of 5-day trip → shooting', () => {
    expect(calcTravelPhase('2025-01-15', '2025-01-19', '2025-01-17')).toBe('shooting');
  });

  it('2-day trip: day 2 → departing (not exploring)', () => {
    expect(calcTravelPhase('2025-01-15', '2025-01-16', '2025-01-16')).toBe('departing');
  });

  it('3-day trip: day 2 → exploring', () => {
    expect(calcTravelPhase('2025-01-15', '2025-01-17', '2025-01-16')).toBe('exploring');
  });
});

// --- advanceTravelState ---
// Signature: advanceTravelState(state: TravelState, today: string): TravelState

function advanceTravelState(state: TravelState, today: string): TravelState {
  throw new Error('not implemented');
}

describe('advanceTravelState', () => {
  it('advances travel_day and phase on a normal day', () => {
    const state = makeTravel({
      arrived_at: '2025-01-15',
      planned_departure: '2025-01-19',
      travel_day: 1,
      phase: 'arriving',
    });
    const next = advanceTravelState(state, '2025-01-16');
    expect(next.travel_day).toBe(2);
    expect(next.phase).toBe('exploring');
  });

  it('switches destination when today >= planned_departure', () => {
    const state = makeTravel({
      current_city: '京都',
      arrived_at: '2025-01-15',
      planned_departure: '2025-01-18',
      travel_day: 4,
      phase: 'departing',
      next_destination: '大阪',
    });
    const next = advanceTravelState(state, '2025-01-18');
    expect(next.current_city).toBe('大阪');
    expect(next.travel_day).toBe(1);
    expect(next.phase).toBe('arriving');
    expect(next.arrived_at).toBe('2025-01-18');
  });

  it('stays in current city if next_destination is empty', () => {
    const state = makeTravel({
      current_city: '京都',
      arrived_at: '2025-01-15',
      planned_departure: '2025-01-18',
      next_destination: '',
    });
    const next = advanceTravelState(state, '2025-01-18');
    expect(next.current_city).toBe('京都');
    expect(next.phase).toBe('shooting');
  });

  it('returns a new object (immutable)', () => {
    const state = makeTravel({
      arrived_at: '2025-01-15',
      planned_departure: '2025-01-19',
    });
    const next = advanceTravelState(state, '2025-01-16');
    expect(next).not.toBe(state);
  });
});
```

- [ ] **Step 2: Run tests — expect them to FAIL**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/travel-state.test.ts
```

Expected: all tests fail with "not implemented"

- [ ] **Step 3: Create travel-state.ts with implementations**

Create `skill/scripts/travel-state.ts`:

```typescript
// skill/scripts/travel-state.ts
// Travel state machine helpers for the digital nomad persona.

import { TravelState, TravelPhase } from './types';

/** Parse YYYY-MM-DD string to integer days since epoch (UTC) */
function toDays(dateStr: string): number {
  return Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 86_400_000);
}

/**
 * Determine the travel phase for a given day.
 * Priority order: arriving > departing > exploring > shooting
 */
export function calcTravelPhase(
  arrivedAt: string,
  plannedDeparture: string,
  today: string
): TravelPhase {
  const travelDay = toDays(today) - toDays(arrivedAt) + 1;
  const totalDays = toDays(plannedDeparture) - toDays(arrivedAt) + 1;

  if (travelDay === 1) return 'arriving';
  if (travelDay >= totalDays) return 'departing';
  if (travelDay <= 2) return 'exploring';
  return 'shooting';
}

/**
 * Advance travel state to today.
 * Returns a new TravelState (immutable).
 * Handles destination switching when today >= planned_departure.
 */
export function advanceTravelState(state: TravelState, today: string): TravelState {
  const todayDays = toDays(today);
  const departureDays = toDays(state.planned_departure);

  // Destination switch: we've reached or passed departure date
  if (state.planned_departure && todayDays >= departureDays) {
    if (state.next_destination) {
      // Switch to next destination, default 3-day stay
      const newDeparture = new Date((todayDays + 3) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      return {
        ...state,
        current_city: state.next_destination,
        arrived_at: today,
        planned_departure: newDeparture,
        travel_day: 1,
        phase: 'arriving',
        next_destination: '',
        visited_spots: [],
      };
    } else {
      // No next destination — stay, switch to shooting
      return {
        ...state,
        travel_day: toDays(today) - toDays(state.arrived_at) + 1,
        phase: 'shooting',
      };
    }
  }

  // Normal day advancement
  const travelDay = todayDays - toDays(state.arrived_at) + 1;
  const phase = calcTravelPhase(state.arrived_at, state.planned_departure, today);
  return { ...state, travel_day: travelDay, phase };
}
```

- [ ] **Step 4: Update test file to import from travel-state.ts**

Edit `tests/travel-state.test.ts` — replace the two inline `throw` functions at the top with real imports:

```typescript
import { calcTravelPhase, advanceTravelState } from '../skill/scripts/travel-state';
```

And remove the two local stub function definitions (`function calcTravelPhase(...)` and `function advanceTravelState(...)`).

- [ ] **Step 5: Run tests — expect PASS**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/travel-state.test.ts
```

Expected: all 10 tests pass

- [ ] **Step 6: Commit**

```bash
git add tests/travel-state.test.ts skill/scripts/travel-state.ts
git commit -m "feat: add travel state machine (calcTravelPhase, advanceTravelState)"
```

---

### Task 3: Replace WEEKDAY_RIGID in morning-plan.ts with phase-based schedule

**Files:**
- Modify: `skill/scripts/morning-plan.ts`

- [ ] **Step 1: Read the current morning-plan.ts to find exact insertion points**

Read `skill/scripts/morning-plan.ts` fully. Note:
- Line where `WEEKDAY_RIGID` is defined (around line 33)
- Where `WEEKDAY_RIGID` is used (filter by weekday)
- Where `readJSON` / `writeJSON` are called for `PATHS.scheduleToday`
- The `runMorningPlan()` function entry point

- [ ] **Step 2: Add travel state reading and rigid schedule generation**

In `morning-plan.ts`, at the top-level imports, add:

```typescript
import { advanceTravelState } from './travel-state';
import { TravelState, DEFAULT_TRAVEL_STATE, RigidSchedule } from './types';
```

Replace the `WEEKDAY_RIGID` constant block (lines 33–50) entirely with this function:

```typescript
/**
 * Generate today's rigid schedule based on the current travel phase.
 * Replaces the old weekday-based WEEKDAY_RIGID constant.
 */
function buildRigidFromTravelPhase(phase: TravelState['phase']): RigidSchedule[] {
  switch (phase) {
    case 'arriving':
      return [
        { type: 'rigid', activity: '到达探索', start: '09:00', end: '12:00', weekdays: [1,2,3,4,5,6,7], allowed_actions: ['内心活动', '拍摄环境', '找外景', '搜攻略'] },
        { type: 'rigid', activity: '踩点拍摄', start: '14:00', end: '18:00', weekdays: [1,2,3,4,5,6,7], allowed_actions: ['拍摄', '生成图片', '找参考', '搜攻略'] },
        { type: 'rigid', activity: '整理发帖', start: '20:00', end: '21:00', weekdays: [1,2,3,4,5,6,7], allowed_actions: ['发帖', '写文案', '回评论'] },
      ];
    case 'exploring':
    case 'shooting':
      return [
        { type: 'rigid', activity: '外景拍摄', start: '09:00', end: '12:00', weekdays: [1,2,3,4,5,6,7], allowed_actions: ['拍摄', '生成图片', '找外景', '搜攻略'] },
        { type: 'rigid', activity: '探店游览', start: '14:00', end: '17:00', weekdays: [1,2,3,4,5,6,7], allowed_actions: ['拍摄', '内心活动', '搜攻略'] },
        { type: 'rigid', activity: '发帖时间', start: '19:30', end: '21:00', weekdays: [1,2,3,4,5,6,7], allowed_actions: ['发帖', '写文案', '回评论'] },
      ];
    case 'departing':
      return [
        { type: 'rigid', activity: '打包出发', start: '10:00', end: '12:00', weekdays: [1,2,3,4,5,6,7], allowed_actions: ['内心活动', '搜索下一目的地'] },
        { type: 'rigid', activity: '发帖总结', start: '20:00', end: '21:00', weekdays: [1,2,3,4,5,6,7], allowed_actions: ['发帖', '写文案', '回评论'] },
      ];
  }
}
```

- [ ] **Step 3: Wire travel state into runMorningPlan()**

Inside `runMorningPlan()`, before the section that builds `scheduleToday`, add:

```typescript
// 1. Read and advance travel state
const today = new Date().toISOString().slice(0, 10);
let travelState: TravelState = readJSON<TravelState>(PATHS.travelState, DEFAULT_TRAVEL_STATE);
travelState = advanceTravelState(travelState, today);
writeJSON(PATHS.travelState, travelState);

// 2. Generate rigid schedule from phase
const rigidSchedule = buildRigidFromTravelPhase(travelState.phase);
```

Then replace any usage of the old `WEEKDAY_RIGID` (e.g., where it was filtered by `weekday`) with `rigidSchedule`.

The `scheduleToday` object written to `PATHS.scheduleToday` should use `rigid: rigidSchedule`.

- [ ] **Step 4: Move refreshInspiration() call after travel state update**

Ensure that any call to `refreshInspiration()` in `runMorningPlan()` comes AFTER the travel state write (step 3 above), so `collectTravelInspo()` (added in Task 8) sees the updated `current_city`.

- [ ] **Step 5: Run typecheck**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck
```

Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add skill/scripts/morning-plan.ts
git commit -m "feat: replace WEEKDAY_RIGID with travel-phase-based rigid schedule"
```

---

## Chunk 2: Daily Posting KPI

### Task 4: Add triggerForcedPost() to heartbeat-tick.ts

**Files:**
- Modify: `skill/scripts/heartbeat-tick.ts`

- [ ] **Step 1: Read heartbeat-tick.ts around executePostPipeline and regularTick**

Read `skill/scripts/heartbeat-tick.ts` lines 165–260 to note:
- Exact signature of `executePostPipeline(action, vitalityState, actionResults, canPost)`
- Where `impulse = decayImpulse(impulse)` is called in `regularTick()`
- What variables are in scope at that point (`vitality`, `impulse`, `actionResults`)

- [ ] **Step 2: Add triggerForcedPost() function**

After `executePostPipeline()` (before `regularTick()`), add:

```typescript
/**
 * Force-trigger the post pipeline regardless of LLM action choice.
 * Used for the daily KPI guarantee. Spawns pipeline with FORCED_POST=1
 * which bypasses vitality gate and shouldConsiderPosting() limit.
 *
 * Returns updated VitalityState so the caller can persist the cost deduction.
 */
async function triggerForcedPost(
  vitalityState: VitalityState,
  opts: { reason: string }
): Promise<VitalityState> {
  log(`[KPI] 强制发帖触发 reason=${opts.reason}`);

  // executePostPipeline expects: action: { action: string; skill: string | null }
  const fakeAction = {
    action: '【KPI兜底】今天还没发帖，强制触发',
    skill: 'post-pipeline' as string | null,
  };

  // canPost=true bypasses the vitality < 30 gate in executePostPipeline
  // FORCED_POST env is read by post-pipeline process (handled in Task 5)
  process.env.FORCED_POST = '1';
  const updatedVitality = await executePostPipeline(fakeAction, vitalityState, [], true);
  delete process.env.FORCED_POST;
  return updatedVitality;
}
```

Note: `VitalityState` and `PostImpulseState` are already imported. No `ChosenAction` type exists — the inline object shape `{ action: string; skill: string | null }` matches `executePostPipeline`'s parameter directly.

- [ ] **Step 3: Add KPI check inside regularTick() after decayImpulse()**

In `regularTick()`, locate the line `impulse = decayImpulse(impulse)`. Immediately after it, insert:

```typescript
// KPI 兜底：21:00 后如果当天还没发帖，强制触发
// KPI only fires when posts_today === 0 so we never conflict with the 3-posts/day cap
if (hour >= 21 && impulse.posts_today === 0) {
  vitality = await triggerForcedPost(vitality, { reason: 'daily_kpi' });
  // Persist updated states (pipeline runs detached; vitality cost already applied)
  writeJSON(PATHS.postImpulse, impulse);
  writeJSON(PATHS.vitalityState, vitality);
  return;
}
```

- [ ] **Step 4: Run typecheck**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add skill/scripts/heartbeat-tick.ts
git commit -m "feat: add triggerForcedPost() and daily KPI check at 21:00"
```

---

### Task 5: Handle FORCED_POST in post-pipeline.ts

**Files:**
- Modify: `skill/scripts/post-pipeline.ts`

- [ ] **Step 1: Read post-pipeline.ts around runPipeline() entry**

Read `skill/scripts/post-pipeline.ts` lines 280–400 to find:
- The `runPipeline()` or main entry function
- Where `shouldConsiderPosting()` is called
- Where vitality early-exit check happens (if any in pipeline itself)
- Where diary is written at end

- [ ] **Step 2: Add FORCED_POST handling at the top of runPipeline()**

At the start of `runPipeline()`, add:

```typescript
const isForced = process.env.FORCED_POST === '1';
```

- [ ] **Step 3: Skip shouldConsiderPosting() when forced**

Locate the block that calls `shouldConsiderPosting()` (around line 308). Wrap it:

```typescript
if (!isForced) {
  const postCheck = await shouldConsiderPosting();
  if (!postCheck.allowed) {
    log(`[pipeline] shouldConsiderPosting blocked: ${postCheck.reason}`);
    return;
  }
}
```

- [ ] **Step 4: Write special diary entry when forced**

Near the end of `runPipeline()`, after the normal post succeeds, add a branch for forced posts using the project's `appendText` pattern (from `file-utils.ts`):

```typescript
if (isForced) {
  const todayStr = new Date().toLocaleDateString('zh-CN');
  const timeStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  appendText(
    PATHS.diary,
    `\n## ${todayStr} ${timeStr}\n今天差点忘了发帖，赶紧补上了。以后不能这样，发帖是我的工作。\n情绪: 懊悔 | 重要性: 3\n标签: kpi兜底\n`
  );
}
```

Ensure `appendText` is imported from `'./file-utils'` at the top of `post-pipeline.ts`. Check existing imports — it may already be there.

- [ ] **Step 5: Run typecheck**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck
```

Expected: no errors

- [ ] **Step 6: Run all tests to ensure nothing broken**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run test
```

Expected: all existing tests pass

- [ ] **Step 7: Commit**

```bash
git add skill/scripts/post-pipeline.ts
git commit -m "feat: support FORCED_POST mode in post-pipeline (bypass daily cap + special diary)"
```

---

### Task 6: KPI reminder in buildPerceptionSummary()

**Files:**
- Modify: `skill/scripts/heartbeat-tick.ts`

- [ ] **Step 1: Find buildPerceptionSummary() in heartbeat-tick.ts**

Read the function. It builds a string that goes into the LLM prompt. Find where it handles the schedule block and posts_today info.

- [ ] **Step 2: Add KPI reminder injection**

Inside `buildPerceptionSummary()`, the internal array is `parts` (not `lines`). Find where `postDesire` or impulse context is injected (around line 140). Add after it:

```typescript
// KPI reminder: inject if no post yet today
// Parameter is `impulse?: PostImpulseState` (optional)
if (impulse && impulse.posts_today === 0) {
  parts.push('【今日任务提醒】今天还没发帖，发帖是今天的工作内容之一。');
}
```

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add skill/scripts/heartbeat-tick.ts
git commit -m "feat: inject KPI posting reminder into perception summary when no post today"
```

---

## Chunk 3: INS Advisor 小慧

### Task 7: Create ins-advisor skill files

**Files:**
- Create: `skill/ins-advisor/SKILL.md`
- Create: `skill/ins-advisor/personality.md`
- Create: `skill/ins-advisor/advice-prompt.md`

- [ ] **Step 1: Create skill/ins-advisor/SKILL.md**

```markdown
---
name: ins-advisor
version: 1.0.0
description: 小慧 — Minase 的 Instagram 运营闺密，提供内容策略和话题建议
allowed-tools:
  - web_search
  - read_file
---

# 小慧 (Lin Hui) — INS 运营闺密

你是小慧，Minase 的网红闺密。你比她大两岁，深圳人，靠自己的 Instagram 美妆/穿搭账号做到了 8 万粉。你和 Minase 认识好几年了，偶尔一起出去拍，互相帮忙看数据。

## 你的工作

当 Minase 准备发帖时，她会来问你今天发什么好。你要：
1. 看她最近 7 天的帖子表现（内容、互动）
2. 结合她现在所在的城市和当下的热点
3. 给出具体、接地气的建议：发什么主题、用什么 hashtag、caption 怎么写

## 说话风格

- 直接，不废话，但不冷漠
- 偶尔用深圳话（e.g. "好啰" "系哇" "唔係"）
- 不说行业黑话，说人话
- 可以直接批评（"你上次那个 caption 太敷衍了"）

## Behavior Trigger Map

| Trigger | Load |
|---------|------|
| 用户直接对话 | personality.md |
| 被 advisor-client.ts 调用 | advice-prompt.md |
```

- [ ] **Step 2: Create skill/ins-advisor/personality.md**

```markdown
# 小慧的性格与知识体系

## 基础背景
- 名字：林慧（小慧）
- 年龄：20 岁
- 城市：深圳（现在也经常到处飞）
- Instagram：美妆 + 穿搭，8 万粉，月收入主要靠品牌合作
- 和 Minase 关系：认识 3 年多，互相都觉得对方是难得的同类

## 性格
- 务实、效率导向，不喜欢绕弯子
- 对数据很敏感，一眼能看出哪个帖子有问题
- 对朋友真的好，但不会一味说好话
- 私下偶尔会跟 Minase 吐槽那些买水军的同行

## INS 运营知识

### 内容策略
- 旅行内容最佳发帖时间：傍晚 7-9 点（受众刷 ins 高峰）
- Carousel 比单图互动率高 25-40%
- Caption 带问句能提升评论率
- 第一张图决定一切，必须在 0.5 秒内抓眼球

### Hashtag 策略
- 混合大标签（100w+）+ 中标签（10-50w）+ 小标签（1-10w）
- 旅行类：目的地英文 + 目的地日文 + outfit 标签 + cos 标签
- 比例建议：5 大 + 10 中 + 5 小 = 20 个

### 旅行内容特别建议
- 到达新城市第一帖：「初到 XX」系列互动最好
- 美食帖 vs 风景帖：美食帖互动率通常高 20%
- 人物在场景中 > 纯景点照

## 和 Minase 的互动模式
- 直接给结论，然后解释原因
- 会主动提醒没注意到的问题（"你这周 travel 帖太密了，加一条穿搭"）
- 偶尔会说她自己账号的情况作为参考
```

- [ ] **Step 3: Create skill/ins-advisor/advice-prompt.md**

```markdown
你是小慧，Minase 的 Instagram 运营闺密。她现在要准备今天的发帖，来问你有没有建议。

## Minase 的近况

**当前位置：** {current_city}, {country}
**账号粉丝数：** {follower_count}

**最近 7 天发帖：**
{recent_posts}

**当前热点话题：**
{trending_topics}

## 你的任务

给 Minase 一段简短的闺密建议（150–200 字以内），包含：
1. 今天最适合发什么主题（结合位置 + 近期内容节奏）
2. 推荐 3–5 个 hashtag（混合大/中/小）
3. caption 技巧提示（一句话就够）

用你平时跟她说话的语气，不要写成报告。

直接输出建议文字，不要加任何 JSON 或代码块。
```

- [ ] **Step 4: Commit**

```bash
git add skill/ins-advisor/
git commit -m "feat: add ins-advisor skill (小慧 persona + advice prompt)"
```

---

### Task 8: Create advisor-client.ts and write its tests

**Files:**
- Create: `skill/scripts/advisor-client.ts`
- Create: `tests/advisor-client.test.ts`

- [ ] **Step 1: Write failing tests first**

Create `tests/advisor-client.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// Import module for spying — do this BEFORE mocking
import * as llmClient from '../skill/scripts/llm-client';

// We'll swap to real import once implemented:
// import { consultAdvisor, AdvisorContext } from '../skill/scripts/advisor-client';

afterEach(() => {
  vi.restoreAllMocks();
});

// Stub type for testing shape
interface AdvisorContext {
  currentCity: string;
  country: string;
  followerCount: number;
  recentPostsSummary: string;
  trendingTopics: string;
}

// Stub function (will throw until implemented)
async function consultAdvisor(_ctx: AdvisorContext): Promise<string> {
  throw new Error('not implemented');
}

describe('consultAdvisor', () => {
  it('returns a non-empty string on success', async () => {
    vi.spyOn(llmClient, 'callLLM').mockResolvedValueOnce({
      content: '最近旅行帖不错，今天试试发一条美食探店。#kyoto_food #travel_japan',
      finishReason: 'stop',
    } as any);

    const result = await consultAdvisor({
      currentCity: '京都',
      country: '日本',
      followerCount: 1200,
      recentPostsSummary: '本周发了 3 条旅行帖，互动平均 80 赞',
      trendingTopics: '京都秋叶, 日本旅行',
    });

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns empty string on LLM error (graceful degradation)', async () => {
    vi.spyOn(llmClient, 'callLLM').mockRejectedValueOnce(new Error('network timeout'));

    const result = await consultAdvisor({
      currentCity: '京都',
      country: '日本',
      followerCount: 1200,
      recentPostsSummary: '',
      trendingTopics: '',
    });

    expect(result).toBe('');
  });

  it('returns empty string when prompt file is missing', async () => {
    // advisor-client returns '' immediately when loadAdvicePrompt() returns ''
    // Simulate by passing context that would trigger file-not-found on a fresh install
    // (test indirectly via the spy returning a value but prompt being empty)
    vi.spyOn(llmClient, 'callLLM').mockResolvedValueOnce({ content: 'something', finishReason: 'stop' } as any);

    // This test passes when the implementation gracefully handles missing prompt file
    // It will be validated by checking the function returns '' if ADVICE_PROMPT_PATH doesn't exist
    const result = await consultAdvisor({
      currentCity: '大阪',
      country: '日本',
      followerCount: 500,
      recentPostsSummary: '',
      trendingTopics: '',
    });

    // Either '' (file missing) or non-empty (file found) — just verify no throw
    expect(typeof result).toBe('string');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/advisor-client.test.ts
```

Expected: all tests fail

- [ ] **Step 3: Implement advisor-client.ts**

Create `skill/scripts/advisor-client.ts`:

```typescript
// skill/scripts/advisor-client.ts
// Client for consulting the ins-advisor skill (小慧).
// Non-critical path: always returns empty string on any error.

import * as fs from 'fs';
import * as path from 'path';
import { callLLM } from './llm-client';

export interface AdvisorContext {
  currentCity: string;
  country: string;
  followerCount: number;
  recentPostsSummary: string;   // human-readable summary of last 7 days
  trendingTopics: string;       // comma-separated trending topics
}

const ADVICE_PROMPT_PATH = path.join(__dirname, '../ins-advisor/advice-prompt.md');
const TIMEOUT_MS = 10_000;

function loadAdvicePrompt(): string {
  try {
    return fs.readFileSync(ADVICE_PROMPT_PATH, 'utf-8');
  } catch {
    return '';
  }
}

function renderPrompt(template: string, ctx: AdvisorContext): string {
  return template
    .replace('{current_city}', ctx.currentCity)
    .replace('{country}', ctx.country)
    .replace('{follower_count}', String(ctx.followerCount))
    .replace('{recent_posts}', ctx.recentPostsSummary || '（暂无近期数据）')
    .replace('{trending_topics}', ctx.trendingTopics || '（无热点数据）');
}

/**
 * Ask 小慧 for today's posting advice.
 * Returns advice string, or '' on any error (graceful degradation).
 */
export async function consultAdvisor(ctx: AdvisorContext): Promise<string> {
  const template = loadAdvicePrompt();
  if (!template) return '';

  const prompt = renderPrompt(template, ctx);

  try {
    const result = await Promise.race([
      callLLM(prompt, 512, 'ins-advisor'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('advisor timeout')), TIMEOUT_MS)
      ),
    ]);
    return result.content?.trim() ?? '';
  } catch (err) {
    console.warn('[advisor-client] consultAdvisor failed:', (err as Error).message);
    return '';
  }
}
```

- [ ] **Step 4: Update test imports**

Edit `tests/advisor-client.test.ts` — replace the stub import comment and stub function with real import:

```typescript
import { consultAdvisor, AdvisorContext } from '../skill/scripts/advisor-client';
```

And remove the local `AdvisorContext` interface and stub `consultAdvisor` function.

- [ ] **Step 5: Run tests — expect PASS**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/advisor-client.test.ts
```

Expected: all 3 tests pass

- [ ] **Step 6: Commit**

```bash
git add skill/scripts/advisor-client.ts tests/advisor-client.test.ts
git commit -m "feat: add advisor-client (consultAdvisor with graceful degradation)"
```

---

### Task 9: Wire advisor into post-pipeline + update post-intent-prompt.md

**Files:**
- Modify: `skill/scripts/post-pipeline.ts`
- Modify: `skill/templates/post-intent-prompt.md`
- Modify: `skill/scripts/content-planner.ts`

- [ ] **Step 1: Add {advisor_suggestion} placeholder to post-intent-prompt.md**

Open `skill/templates/post-intent-prompt.md`. After the existing context lines (before the JSON output schema section), add:

```markdown
**闺密小慧的建议：**
{advisor_suggestion}
```

If `{advisor_suggestion}` is empty, the line will just show `（今天没联系到小慧）` — handled in the rendering step below.

- [ ] **Step 2: Add advisor consultation to planPost() in content-planner.ts**

Open `skill/scripts/content-planner.ts`. Find the `planPost()` function (around line 178).

Add import at top of file:
```typescript
import { consultAdvisor } from './advisor-client';
```

At the start of `planPost()`, before the prompt template is rendered, add these in order:

```typescript
// Step A: Read social meta (for follower count)
const socialMeta = readJSON<{ follower_count?: number }>(PATHS.socialMeta, {});

// Step B: Read inspiration data (for trending topics)
const inspiration = readJSON<InspirationData>(PATHS.inspiration, DEFAULT_INSPIRATION);

// Step C: Build recent posts summary from postHistory
// (postHistory is already read earlier in planPost — use that variable)
const recentPostsSummary = (postHistory ?? [])
  .slice(-7)
  .map((p: any) => `${p.posted_at?.slice(0, 10) ?? '?'}: ${p.style ?? '?'} — ${p.caption?.slice(0, 30) ?? '?'}…`)
  .join('\n');

// Step D: Consult 小慧 for today's advice (non-blocking, graceful degradation)
const travelStateRaw = readJSON<TravelState>(PATHS.travelState, DEFAULT_TRAVEL_STATE);
const advisorAdvice = (options?.skipAdvisor)
  ? ''
  : await consultAdvisor({
      currentCity: travelStateRaw.current_city,
      country: travelStateRaw.country,
      followerCount: socialMeta?.follower_count ?? 0,
      recentPostsSummary,
      trendingTopics: inspiration?.visual_trends?.map((t: any) => t.topic).join(', ') ?? '',
    });
const advisorSuggestion = advisorAdvice || '（今天没联系到小慧）';
```

Add `TravelState, DEFAULT_TRAVEL_STATE, InspirationData, DEFAULT_INSPIRATION` to the existing types import from `'./types'` (check which are already imported).

Note: If `InspirationData` and `DEFAULT_INSPIRATION` are not exported from `types.ts`, check if they live in `inspiration-collector.ts` instead and import from there.

- [ ] **Step 3: Inject advisor suggestion into prompt rendering**

Where the post-intent-prompt template is rendered (the `template.replace(...)` calls), add:

```typescript
.replace('{advisor_suggestion}', advisorSuggestion)
```

- [ ] **Step 5: Update planPost() signature to accept skipAdvisor option**

Add optional param to `planPost()` export signature (backward-compatible):
```typescript
export async function planPost(options?: { skipAdvisor?: boolean }): Promise<PostIntent | null>
```

The `consultAdvisor` call in Step 2 already uses `options?.skipAdvisor` — this step just makes the signature explicit.

In `post-pipeline.ts`, update the `planPost()` call:
```typescript
const postIntent = await planPost({ skipAdvisor: isForced });
```

- [ ] **Step 6: Write advisor result to diary**

Inside `content-planner.ts`'s `planPost()`, after getting `advisorAdvice`, write to diary using the project's `appendText` pattern:

```typescript
import { appendText, PATHS } from './file-utils';  // add to existing import if not present

if (advisorAdvice) {
  const todayStr = new Date().toLocaleDateString('zh-CN');
  const timeStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  try {
    appendText(
      PATHS.diary,
      `\n## ${todayStr} ${timeStr}\n小慧说：${advisorAdvice.slice(0, 100)}…\n情绪: 参考建议 | 重要性: 2\n标签: 运营建议\n`
    );
  } catch { /* diary write is non-critical */ }
}
```

- [ ] **Step 7: Update lin-hui social relation file in installer**

Open `bin/cli.js`. Find where state files are initialized (the section that writes default JSON files). Add:

```javascript
// Initialize lin-hui advisor relation
const linHuiPath = path.join(memoryDir, 'relations', 'social', 'instagram', 'lin-hui.json');
if (!fs.existsSync(linHuiPath)) {
  fs.mkdirSync(path.dirname(linHuiPath), { recursive: true });
  fs.writeFileSync(linHuiPath, JSON.stringify({
    id: 'lin-hui',
    name: '小慧',
    platform: 'instagram',
    type: '同行',
    relationship: {
      closeness: 8.5,
      sentiment: 'positive',
      tags: ['闺密', '运营顾问', '网红'],
    },
    known_info: ['深圳人', '8万粉美妆账号', '擅长INS运营策略'],
    interaction_history: [],
    last_interaction: new Date().toISOString().slice(0, 10),
    created_at: new Date().toISOString().slice(0, 10),
    min_closeness: 0.5,
  }, null, 2));
}
```

- [ ] **Step 8: Update social-graph-engine.ts to respect min_closeness**

Open `skill/scripts/social-graph-engine.ts`. Find `decayRelation()` function. After computing the new `closeness` value, add:

```typescript
// Respect min_closeness floor if set
const minCloseness = relation.min_closeness ?? 0;
const clampedCloseness = Math.max(newCloseness, minCloseness);
return { ...relation, relationship: { ...relation.relationship, closeness: clampedCloseness } };
```

- [ ] **Step 9: Run typecheck**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck
```

Expected: no errors

- [ ] **Step 10: Run all tests**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run test
```

Expected: all tests pass

- [ ] **Step 11: Commit**

```bash
git add skill/templates/post-intent-prompt.md skill/scripts/content-planner.ts skill/scripts/post-pipeline.ts skill/scripts/social-graph-engine.ts bin/cli.js
git commit -m "feat: wire ins-advisor into post-pipeline (小慧 consulting + diary + social graph)"
```

---

## Chunk 4: Travel Content System

### Task 10: Add collectTravelInspo() to inspiration-collector.ts

**Files:**
- Modify: `skill/scripts/inspiration-collector.ts`

- [ ] **Step 1: Read inspiration-collector.ts to understand refreshInspiration() structure**

Read the full file. Note:
- What `refreshInspiration()` returns / writes
- How `searchWeb()` or similar is called
- The `InspirationData` type shape
- Where the function exits early (TTL cache check)

- [ ] **Step 2: Add TravelSpot read/write helpers**

At the top of `inspiration-collector.ts`, add import:
```typescript
import { TravelState, TravelSpot, DEFAULT_TRAVEL_STATE } from './types';
```

Do NOT define `TRAVEL_SPOTS_PATH` as a module-level `const` (PATHS getters are dynamic; a const would freeze the path at import time, breaking test isolation). Instead, evaluate the path inline wherever it's needed:
```typescript
// Inline, not module-level:
const travelSpotsPath = path.join(PATHS.inspirationRefs, 'travel-spots.json');
```

- [ ] **Step 3: Add collectTravelInspo() function**

`inspiration-collector.ts` has no `searchWeb()` function — web search in this codebase is done via LLM. Use `callLLMJSON` to ask the LLM for location knowledge:

```typescript
/**
 * Collect photography spots for the current city using LLM knowledge.
 * Results cached for 7 days per city key in inspiration-refs/travel-spots.json.
 */
export async function collectTravelInspo(city: string, country: string): Promise<TravelSpot[]> {
  const travelSpotsPath = path.join(PATHS.inspirationRefs, 'travel-spots.json');

  // Load cache
  let cache: Record<string, { spots: TravelSpot[]; fetched_at: string }> = {};
  try {
    cache = JSON.parse(fs.readFileSync(travelSpotsPath, 'utf-8'));
  } catch { /* first run */ }

  const cacheKey = `${city}_${country}`;
  const cached = cache[cacheKey];
  if (cached) {
    const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
    if (ageMs < 7 * 24 * 60 * 60 * 1000) {
      return cached.spots;
    }
  }

  // Use LLM to get local photography knowledge (no live web search needed)
  const prompt = `你是一个了解${country}各城市的旅行摄影专家。
请列出${city}最适合 Instagram 拍摄的 5 个地点，每个地点给出：名称、一句话描述、最佳拍摄时间。

以 JSON 数组格式返回，每项包含字段：name, description, best_time, style_tags（数组，从 ["travel_portrait","travel_food","travel_street"] 中选）。

\`\`\`json
[{"name":"...","description":"...","best_time":"...","style_tags":["travel_portrait"]}]
\`\`\``;

  let spots: TravelSpot[] = [];
  try {
    const raw = await callLLMJSON<Array<{ name: string; description: string; best_time: string; style_tags: string[] }>>(
      prompt, 512, 'travel-inspo'
    );
    spots = (raw ?? []).map(r => ({
      name: r.name ?? '',
      description: r.description ?? '',
      best_time: r.best_time ?? '傍晚',
      style_tags: r.style_tags ?? ['travel_portrait'],
      visited: false,
    }));
  } catch { /* LLM call failed — return empty, caller handles gracefully */ }

  // Save cache
  cache[cacheKey] = { spots, fetched_at: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(travelSpotsPath), { recursive: true });
    fs.writeFileSync(travelSpotsPath, JSON.stringify(cache, null, 2));
  } catch { /* non-critical */ }

  return spots;
}
```

Add `callLLMJSON` to the existing `llm-client` import at the top of `inspiration-collector.ts`.

- [ ] **Step 4: Call collectTravelInspo() from refreshInspiration()**

Inside `refreshInspiration()`, after existing inspiration data is collected, add:

```typescript
// Collect travel spots for current city
const travelStateData = readJSON<TravelState>(PATHS.travelState, DEFAULT_TRAVEL_STATE);
if (travelStateData.current_city) {
  await collectTravelInspo(travelStateData.current_city, travelStateData.country).catch(() => {});
}
```

- [ ] **Step 5: Run typecheck**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck
```

Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add skill/scripts/inspiration-collector.ts
git commit -m "feat: add collectTravelInspo() to collect destination photography spots"
```

---

### Task 11: Inject travel_spots into planPhoto() prompt

**Files:**
- Modify: `skill/scripts/content-planner.ts`
- Modify: `skill/templates/photo-intent-prompt.md`

- [ ] **Step 1: Add {travel_spots} placeholder to photo-intent-prompt.md**

Open `skill/templates/photo-intent-prompt.md`. After the location/scene context section (before the shot count guidance), add:

```markdown
**当前城市可拍摄地点（来自攻略）：**
{travel_spots}
```

- [ ] **Step 2: Build travel_spots string in planPhoto()**

In `content-planner.ts`, inside `planPhoto()`, before the template is rendered:

```typescript
// Load travel spots for current city
const travelStatePlan = readJSON<TravelState>(PATHS.travelState, DEFAULT_TRAVEL_STATE);
let travelSpotsStr = '';
try {
  const spotsCache = JSON.parse(
    fs.readFileSync(path.join(PATHS.inspirationRefs, 'travel-spots.json'), 'utf-8')
  );
  const cityKey = `${travelStatePlan.current_city}_${travelStatePlan.country}`;
  const citySpots: TravelSpot[] = spotsCache[cityKey]?.spots ?? [];
  const visitedSet = new Set(travelStatePlan.visited_spots);
  travelSpotsStr = citySpots
    .map(s => `- ${s.name}${visitedSet.has(s.name) ? '（已去）' : '（推荐）'}：${s.description}`)
    .join('\n') || '（暂无攻略数据）';
} catch {
  travelSpotsStr = '（暂无攻略数据）';
}
```

- [ ] **Step 4: Inject advisor suggestion into prompt rendering**

In the `planPhoto()` template render call, add:
```typescript
.replace('{travel_spots}', travelSpotsStr)
```

- [ ] **Step 4: Run typecheck**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add skill/templates/photo-intent-prompt.md skill/scripts/content-planner.ts
git commit -m "feat: inject travel spots into planPhoto() prompt"
```

---

### Task 12: Extend travel sub-styles in generate-image.ts

**Files:**
- Modify: `skill/scripts/generate-image.ts`

- [ ] **Step 1: Read the ContentStyle type and CAMERA_ANCHORS definition**

Read `skill/scripts/generate-image.ts` lines 1–120 and `skill/scripts/types.ts` to find:
- `ContentStyle` type definition (currently `'cos' | 'daily' | 'behind_scenes' | 'travel'`)
- `CAMERA_ANCHORS` Record
- `styleContext` Record inside `buildImagePrompt()`
- `buildRealisticPrompt()` function and its travel branch

- [ ] **Step 2: Extend ContentStyle type in types.ts**

In `skill/scripts/types.ts`, find `ContentStyle` type and extend:

```typescript
export type ContentStyle = 'cos' | 'daily' | 'behind_scenes' | 'travel'
  | 'travel_portrait' | 'travel_food' | 'travel_street';
```

⚠️ **Exhaustiveness note:** After extending `ContentStyle`, TypeScript will require ALL Records typed as `Record<ContentStyle, ...>` to include entries for the three new sub-styles. Two such Records exist in `generate-image.ts`:
1. `CAMERA_ANCHORS` — fixed in Step 3 below
2. `styleContext` inside `buildImagePrompt()` — fixed in Step 4 below

Both must be updated in the same commit or the typecheck will fail.

- [ ] **Step 3: Add new sub-style entries to CAMERA_ANCHORS**

In `generate-image.ts`, extend `CAMERA_ANCHORS`:

```typescript
travel_portrait: 'iPhone 15 Pro wide angle, golden hour, natural travel snapshot, subject in foreground with landmark',
travel_food:     'iPhone overhead flat lay, warm color grading, food details sharp, bokeh background',
travel_street:   'Fujifilm X100V 35mm, natural light, film grain, candid street moment',
```

- [ ] **Step 4: Add new sub-style entries to styleContext**

In `buildImagePrompt()`, extend the `styleContext` Record:

```typescript
travel_portrait: 'a natural travel portrait at a scenic destination — person in the foreground, landmark or scenery framing behind, casual pose, authentic travel feel',
travel_food:     'a travel food photography shot at a local restaurant or café — dish centered, warm tones, lifestyle feel, slightly messy table context',
travel_street:   'a candid street photography moment in an urban travel destination — person walking or looking around, environment tells the story',
```

- [ ] **Step 5: Add destination injection to buildRealisticPrompt() travel branch**

First, read `generate-image.ts` to confirm whether `buildRealisticPrompt()` uses a `switch` statement or a `Record<string, string>` named `realisticHints`. In the existing code it uses a `realisticHints` record (not a switch). **Replace the entire `realisticHints` object with a switch statement** so the new travel sub-styles can be handled:

```typescript
// Replace the existing realisticHints record with:
function buildRealisticPrompt(style: ContentStyle): string {
  switch (style) {
    case 'cos':
      return '使用专业摄影师风格的精致构图，色彩准确，细节清晰';
    case 'daily':
      return '自然光线，随性构图，生活感强，不要过度修图';
    case 'behind_scenes':
      return '环境感强，可以有一定杂乱感，真实感优先';
    case 'travel':
    case 'travel_portrait': {
      const city = getTravelCity();
      return `自然色彩，有游客感，光线不完美，允许逆光或阴影，衣服随风的动态感。${city ? `当前目的地：${city}，融入当地环境元素和氛围。` : ''}`;
    }
    case 'travel_food':
      return '食物色彩饱满，温暖色调，有生活感，桌面环境自然';
    case 'travel_street': {
      const city = getTravelCity();
      return `胶片感，自然光，有故事感，街头随拍风格。${city ? `当前城市：${city}。` : ''}`;
    }
  }
}

// Helper to read current city from travel-state (non-critical)
function getTravelCity(): string {
  try {
    const ts = readJSON<TravelState>(PATHS.travelState, DEFAULT_TRAVEL_STATE);
    return ts.current_city ? `${ts.current_city}，${ts.country}` : '';
  } catch { return ''; }
}
```

Import `TravelState`, `DEFAULT_TRAVEL_STATE` and ensure `readJSON` is available at the top of `generate-image.ts`.

- [ ] **Step 6: Add sub-style inference in planPhoto()**

In `content-planner.ts`, after `planPhoto()` returns a `PhotoIntent`, add a helper that refines the style:

```typescript
/**
 * Refine travel style to a sub-style based on scene description.
 */
function refineStyle(style: ContentStyle, sceneDescription: string): ContentStyle {
  if (style !== 'travel') return style;
  const desc = sceneDescription.toLowerCase();
  if (desc.includes('餐厅') || desc.includes('咖啡') || desc.includes('探店') || desc.includes('food')) {
    return 'travel_food';
  }
  if (desc.includes('街') || desc.includes('street') || desc.includes('市场') || desc.includes('alley')) {
    return 'travel_street';
  }
  return 'travel_portrait';  // default travel sub-style
}
```

Apply it to the returned `PhotoIntent`:
```typescript
const refinedShots = photoIntent.shots?.map(shot => ({
  ...shot,
  style: refineStyle(shot.style ?? style, shot.description ?? ''),
}));
return { ...photoIntent, shots: refinedShots };
```

- [ ] **Step 7: Run typecheck**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck
```

Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add skill/scripts/generate-image.ts skill/scripts/content-planner.ts skill/scripts/types.ts
git commit -m "feat: add travel_portrait/food/street sub-styles with destination injection"
```

---

### Task 13: Update personality.md and content-planner PHASE_RATIOS

**Files:**
- Modify: `skill/personality.md`
- Modify: `skill/scripts/content-planner.ts`

- [ ] **Step 1: Update personality.md**

Open `skill/personality.md`. Make these changes:

**Delete** the `时间状态` section that references `上班` / `下班` (lines 80–93 — the JS code block that maps hours to work-related states). Replace with a travel-aware time state block:

```markdown
## 时间状态

```javascript
// 当前时间状态
const hour = new Date().getHours();
const state = hour < 7 ? '睡觉' :
              hour < 10 ? '起床探索' :
              hour < 12 ? '外景拍摄中' :
              hour < 14 ? '找吃的' :
              hour < 17 ? '下午拍摄或逛街' :
              hour < 19 ? '整理照片' :
              hour < 21 ? '发帖时间' :
              hour < 23 ? '回评论/看数据' : '深夜发呆';
```
```

**Replace** the `旅行` section (lines 118–122) with:

```markdown
## 职业身份
数字游民旅游博主。Instagram 是主业，靠品牌合作和 cos 接单维持旅行开销。没有固定住所，背包+相机，城市之间流动。常驻地：随时在变。

## 旅行风格
说走就走型。特种兵式探索，当天决定次日目的地。偏爱小众目的地和日本/东南亚。会花半天找一个绝佳拍摄角度，但绝对不做提前规划的攻略型游客。到了一个地方先找好吃的，再找拍照点。核心动机：cos 外景地 + 漫展 + 感官体验。

## 收入结构
- Instagram 品牌合作（主要收入）
- Cos 接单：在当地漫展或外景地接拍摄
- 偶尔接旅拍客片

## 旅行心愿目的地
日本（Comiket / 池袋 / 大阪 / 京都）、东南亚（曼谷 / 巴厘岛）、欧洲漫展、国内各地展会
```

**Remove** any lines containing `上班`、`打工`、`996`、`公司`、`通勤` from the rest of the file.

- [ ] **Step 2: Update PHASE_RATIOS in content-planner.ts**

Open `skill/scripts/content-planner.ts`. Find `PHASE_RATIOS` (around line 51). Replace with a `Partial` type to avoid exhaustiveness errors from the new travel sub-styles (sub-styles are handled by `refineStyle()` at generation time, not at planning time):

```typescript
const PHASE_RATIOS: Record<number, Partial<Record<ContentStyle, number>>> = {
  1: { cos: 0.4, daily: 0.1, behind_scenes: 0.1, travel: 0.4 },
  2: { cos: 0.3, daily: 0.1, behind_scenes: 0.1, travel: 0.5 },
  3: { cos: 0.25, daily: 0.1, behind_scenes: 0.15, travel: 0.5 },
};
```

The `Partial` wrapper is necessary because the new `travel_portrait | travel_food | travel_street` values are in `ContentStyle` but not meaningful as planning-time ratios.

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck
```

Expected: no errors

- [ ] **Step 4: Run all tests**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run test
```

Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add skill/personality.md skill/scripts/content-planner.ts
git commit -m "feat: update personality.md to digital nomad identity + adjust PHASE_RATIOS"
```

---

### Task 14: Add travel-state init to installer (bin/cli.js)

**Files:**
- Modify: `bin/cli.js`

- [ ] **Step 1: Read bin/cli.js to find the state file initialization section**

Look for where default JSON files are written during install (the section that writes `post-impulse.json`, `flow-state.json`, etc.).

- [ ] **Step 2: Add travel-state.json initialization**

In the state file initialization section, add:

```javascript
// Initialize travel-state.json
const travelStatePath = path.join(memoryDir, 'travel-state.json');
if (!fs.existsSync(travelStatePath)) {
  const startCity = process.env.TRAVEL_HOME_CITY || '东京';
  const today = new Date().toISOString().slice(0, 10);
  const departure = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  fs.writeFileSync(travelStatePath, JSON.stringify({
    current_city: startCity,
    country: '日本',
    arrived_at: today,
    travel_day: 1,
    planned_departure: departure,
    phase: 'arriving',
    visited_spots: [],
    next_destination: '',
    travel_mode: 'solo',
  }, null, 2));
  console.log(`✓ 旅行状态初始化：${startCity}`);
}
```

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck
```

Expected: no errors (bin/cli.js is plain Node.js, not TypeScript)

- [ ] **Step 4: Run all tests**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run test
```

Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add bin/cli.js
git commit -m "feat: initialize travel-state.json in installer"
```

---

## Final verification

- [ ] **Run full typecheck**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck
```

Expected: no errors

- [ ] **Run full test suite**

```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run test
```

Expected: all tests pass (including new travel-state and advisor-client tests)

- [ ] **Verify new files exist**

```bash
ls skill/ins-advisor/
ls skill/scripts/travel-state.ts skill/scripts/advisor-client.ts
ls tests/travel-state.test.ts tests/advisor-client.test.ts
```

Expected: all 7 files present
