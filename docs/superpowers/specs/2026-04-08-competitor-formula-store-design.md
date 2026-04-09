# 竞品爆款句式库 (Competitor Formula Store) — Design Spec

**Date:** 2026-04-08
**Feature:** Competitor Analysis Deepening — Formula Store
**Persona context:** Miss V (V姐)
**Status:** Approved for implementation

---

## 1. Problem Statement

The current competitor analysis pipeline (`competitor-analyzer.ts`) extracts `hook_patterns[]` from competitor posts, but each entry only contains a *category name* (e.g., `"数字冲击型"`) rather than a reusable *sentence formula* (e.g., `"[数字]个[身份]不会告诉你的[场景]秘密"`). This means the content generation pipeline (`topic-generator.ts`) cannot directly apply competitor-proven patterns to new draft creation — the signal exists but isn't actionable.

The goal of this feature is to:

1. **Extract formula strings** from competitor post analysis, not just category labels
2. **Store them in an independent, identity-mode-indexed store** (`FormulaStore`) separate from Miss V's own content patterns
3. **Inject them into content generation prompts** so the LLM can adapt proven competitor formulas to Miss V's voice and style
4. **Run analysis lifecycle-bound**, not on a fixed cron — triggered whenever an account enters `competitors[]` or the candidate pool

---

## 2. Architecture Overview

```
competitor-posts.json         (existing: raw fetched posts per account)
        │
        ▼
competitor-analyzer.ts        (UPGRADED: extracts formula strings)
        │
        ▼
competitor-analysis.json      (existing: AccountAnalysis per account)
        │
        ▼
formula-store.ts              (NEW: FormulaStore manager)
        │
        ▼
competitor-formulas.json      (NEW: FormulaStore on disk)
        │
        ▼
topic-generator.ts            (UPGRADED: buildFormulaContext() injection)
        │
        ▼
LLM content draft             (formulas available as writing aids)
```

The `FormulaStore` is semantically distinct from `ContentPatterns` (`content-patterns.json`):

| Store | Tracks | Updated by | Purpose |
|-------|--------|------------|---------|
| `FormulaStore` | Competitor-sourced formula templates | competitor analysis pipeline | Borrow proven patterns |
| `ContentPatterns` | Miss V's own pattern success rates | content performance feedback | Track what works for her |

---

## 3. New Types (`alive/scripts/utils/types.ts`)

### `HookFormula`

```typescript
export interface HookFormula {
  /** Reusable sentence template, e.g. "[数字]个[身份]不会告诉你的[场景]秘密" */
  formula: string;
  /** 2-4 verbatim example titles from source posts */
  examples: string[];
  /** How often this formula appears across the account's posts */
  frequency: '高' | '中' | '低';
  /** Canonical account key: "name:platform" */
  source_account: string;
  /** Platform of origin */
  source_platform: string;
  /** ISO timestamp of last analysis run */
  last_analyzed: string;
}
```

### `FormulaStore`

```typescript
export interface FormulaStore {
  version: 1;
  /**
   * Top-level key: IdentityMode ('esports' | 'singer' | 'racer' | 'daily')
   * Second-level key: accountKey ("name:platform")
   * Value: list of HookFormula for that account under that identity mode
   */
  formulas: Partial<Record<IdentityMode, Record<string, HookFormula[]>>>;
  last_updated: string;
}
```

### Upgrade to `HookPatternAnalysis`

Add `formula` field to the existing type:

```typescript
export interface HookPatternAnalysis {
  /** Category label for classification, e.g. "数字冲击型" */
  pattern: string;
  /** Reusable sentence template, e.g. "[数字]个[身份]不会告诉你的秘密" */
  formula: string;
  /** 2-4 verbatim example titles */
  examples: string[];
  /** Occurrence frequency across analyzed posts */
  frequency: '高' | '中' | '低';
}
```

---

## 4. New PATHS Entry (`alive/scripts/utils/file-utils.ts`)

Add to the `PATHS` object under `// === Ops desk ===`:

```typescript
get formulaStore() { return path.join(getMemoryBase(), 'competitor-formulas.json'); },
```

---

## 5. New Module: `formula-store.ts`

**File:** `alive/scripts/ops/formula-store.ts`
**Responsibility:** All read/write/query operations on `FormulaStore`. No LLM calls, no analysis logic — pure data management.

### Public API

```typescript
/** Load FormulaStore from disk, returning empty store if missing */
export function loadFormulaStore(): FormulaStore

/** Save FormulaStore to disk (immutable: receives new object, writes it) */
export function saveFormulaStore(store: FormulaStore): void

/**
 * Merge formulas for one account into the store.
 * Overwrites existing entries for this accountKey under each affected identityMode.
 * Returns a new FormulaStore (immutable).
 */
export function mergeAccountFormulas(
  store: FormulaStore,
  identityModes: IdentityMode[],
  accountKey: string,
  formulas: HookFormula[],
): FormulaStore

/**
 * Query all formulas for a given identityMode, aggregated across all accounts.
 * Deduplicates by formula string (keeps highest-frequency version).
 * Sorts: '高' first, then '中', then '低'.
 */
export function queryFormulasByMode(
  store: FormulaStore,
  identityMode: IdentityMode,
): HookFormula[]
```

### AI虚拟偶像 Group Handling

`identityModeForLabel('AI虚拟偶像')` returns `undefined` in `ops-taxonomy.ts`. For accounts in this group, formulas are written to **all 4 IdentityMode buckets** (`esports`, `singer`, `racer`, `daily`) — cross-pollination approach. This maximises formula reuse since AI vtubers produce content across all tracks.

The `identityModes` parameter of `mergeAccountFormulas()` accepts an array to support this case:

```typescript
// Single-mode account
mergeAccountFormulas(store, ['esports'], 'GameKOL:douyin', formulas)

// Cross-mode account (AI虚拟偶像 group)
mergeAccountFormulas(store, ['esports', 'singer', 'racer', 'daily'], 'VTuberX:douyin', formulas)
```

---

## 6. Upgrade: `competitor-analyzer.ts`

### 6.1 Prompt Schema Upgrade (`buildAnalysisPrompt`)

Add `formula` to each entry in the `hook_patterns[]` JSON schema requirement:

```
"hook_patterns": [
  {
    "pattern": "分类名称（例如：数字冲击型、痛点直击型）",
    "formula": "可复用句式模板，用[占位符]标记变量部分，例如：[数字]个[身份]不会告诉你的[场景]秘密",
    "examples": ["原文标题1", "原文标题2"],
    "frequency": "高|中|低"
  }
]
```

The prompt instructs the LLM that `formula` must be an **actionable template**, not a description:
- ✅ `"[数字]个[类别]让你[结果]"`
- ❌ `"使用数字制造视觉冲击"`

### 6.2 Parser Upgrade (`parseAnalysisResponse`)

Pass `formula` through from the LLM response:

```typescript
hook_patterns: raw.hook_patterns.map((p: any) => ({
  pattern: p.pattern ?? '',
  formula: p.formula ?? '',      // NEW
  examples: p.examples ?? [],
  frequency: p.frequency ?? '低',
})),
```

### 6.3 Post-Analysis FormulaStore Write (`analyzeCompetitors`)

After parsing each `AccountAnalysis`, write formulas to `FormulaStore`:

```typescript
// Determine identityMode(s) for this account
const label = profile.group ?? profile.tag;
const singleMode = identityModeForLabel(label);
const modes: IdentityMode[] = singleMode
  ? [singleMode]
  : ALL_IDENTITY_MODES;   // fallback for unmapped groups (AI虚拟偶像)

// Map HookPatternAnalysis → HookFormula
const formulas: HookFormula[] = analysis.hook_patterns
  .filter(p => p.formula && p.formula.trim() !== '')
  .map(p => ({
    formula: p.formula,
    examples: p.examples,
    frequency: p.frequency as '高' | '中' | '低',
    source_account: accountKey,
    source_platform: profile.platform,
    last_analyzed: analysis.analyzed_at,
  }));

if (formulas.length > 0) {
  const updated = mergeAccountFormulas(formulaStore, modes, accountKey, formulas);
  formulaStore = updated;  // accumulate across all accounts in the batch
}
```

At the end of `analyzeCompetitors()`, call `saveFormulaStore(formulaStore)`.

---

## 7. Upgrade: `topic-generator.ts`

### 7.1 New function: `buildFormulaContext`

```typescript
/**
 * Build a formula context string for LLM prompts.
 * Reads FormulaStore for the given identityMode,
 * returns top N formulas as a formatted block.
 */
export function buildFormulaContext(
  identityMode: IdentityMode,
  options?: { maxFormulas?: number },
): string
```

Output format (Chinese, for LLM consumption):

```
【竞品爆款句式参考（可借鉴改编，保持V姐风格）】
- [数字]个[身份]不会告诉你的[场景]秘密（高频 · 来自 GameKOL）
- 当[X]遇到[Y]，[结果]才是真相（中频 · 来自 SingerZ）
- 为什么[普通人]不敢[行动]？（高频 · 来自 RacerW）
```

If `FormulaStore` is empty or has no formulas for the given mode, returns `''` (empty string — no injection).

### 7.2 Injection into `buildContentPrompt`

Add `formulaContext` to the context assembly in `buildContentPrompt()`, between `competitorCtx` and `patternsContext`:

```typescript
if (competitorCtx) contextParts.push(`【对标竞品参考】\n${competitorCtx}`);
// NEW ↓
if (formulaContext) contextParts.push(formulaContext);
// END NEW ↑
if (patternsContext) contextParts.push(patternsContext);
if (strategyContext) contextParts.push(strategyContext);
```

Ordering rationale: competitor live data → competitor formulas → Miss V's own patterns → strategy. The LLM receives external benchmarks before internal guidance, so it can layer Miss V's style on top.

---

## 8. Trigger Lifecycle

Formula extraction is **not time-based**. It runs as part of the account analysis pipeline in two scenarios:

### Scenario A: Competitor Account Analysis (existing ops command)

When `/post`, `/brief`, or the ops-trends cron triggers `analyzeCompetitors()` (in `ops-trends.ts`), the FormulaStore is updated as part of the same call (Section 6.3 above).

### Scenario B: Candidate Account Entry

When a new account enters `PATHS.candidateAccounts` (candidate pool), the same `analyzeCompetitors()` call should be made for that account. The calling code (wherever candidate pool writes occur) should queue an analysis run.

> **Implementation note:** The exact trigger point for Scenario B (which script adds to `candidateAccounts`) should be identified during implementation and wired accordingly. If the write happens inside `discovery-engine.ts` or a similar module, add a post-write hook there.

### Minimum posts gate

Reuse the existing `MIN_POSTS_FOR_ANALYSIS = 5` gate from `competitor-analyzer.ts`. If an account has fewer than 5 posts in `competitor-posts.json`, skip formula extraction for that account (same behavior as today).

---

## 9. Miss V Integration

Miss V has 4 identity modes:

| IdentityMode | Taxonomy labels | % of content |
|---|---|---|
| `esports` | `硬核电竞解说`, `电竞解说` | 40% |
| `singer` | `偶像歌手`, `音乐` | 25% |
| `racer` | `赛道飒爽女车手`, `赛车` | 20% |
| `daily` | `低调轻奢富家千金`, `生活日常` | 15% |
| *(cross-mode)* | `AI虚拟偶像` | → all 4 modes |

When `topic-generator.ts` generates a draft for a specific `identityMode`, `buildFormulaContext(identityMode)` returns formulas sourced from all competitors mapped to that track. The LLM prompt will contain formulas from multiple competitor accounts, giving Miss V a palette of proven patterns to adapt — not copy — in her own voice.

---

## 10. File Change Summary

| File | Change type | Description |
|------|-------------|-------------|
| `alive/scripts/utils/types.ts` | Modify | Add `HookFormula`, `FormulaStore` types; add `formula` field to `HookPatternAnalysis` |
| `alive/scripts/utils/file-utils.ts` | Modify | Add `formulaStore` to `PATHS` |
| `alive/scripts/ops/formula-store.ts` | **New file** | FormulaStore data manager (load/save/merge/query) |
| `alive/scripts/ops/competitor-analyzer.ts` | Modify | Upgrade prompt schema; pass `formula` through parser; write to FormulaStore after analysis |
| `alive/scripts/ops/topic-generator.ts` | Modify | Add `buildFormulaContext()`; inject into `buildContentPrompt()` |
| `alive/tests/ops/formula-store.test.ts` | **New file** | Unit tests: load/save/merge/query, AI虚拟偶像 cross-mode write, empty-store safety |
| `alive/tests/ops/competitor-analyzer.test.ts` | Modify | Add tests for `formula` field in `buildAnalysisPrompt` output; test FormulaStore write path |

---

## 11. Out of Scope

- **Content mix ratio visualization**: the `content_mix` field in `CompetitorProfile` is already static YAML — dynamic computation from live posts is a separate feature.
- **Formula performance tracking**: tracking which formulas performed well for Miss V (analogous to `ContentPatterns`) is out of scope for this iteration.
- **Candidate pool wiring (Scenario B full implementation)**: the trigger point identification and wiring is flagged as a discovery task during implementation, not fully specified here.
- **Formula deduplication across accounts**: `queryFormulasByMode()` deduplicates by exact string match. Fuzzy deduplication (e.g., semantically equivalent formulas from different accounts) is out of scope.
