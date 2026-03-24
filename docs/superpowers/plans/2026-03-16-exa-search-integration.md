# Exa Search Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Minase real web search capability via Exa MCP endpoint, replacing simulated search actions in both conversation and heartbeat scenarios.

**Architecture:** Two entry points — SKILL.md MCP tool declaration for conversation-time search, and a new `search-pipeline.ts` (inline, not detached) for heartbeat autonomous search. Both use `exa-client.ts` wrapping MCP SDK's SSE transport to `mcp.exa.ai/mcp`. Search results are LLM-digested and written to `diary.md`.

**Tech Stack:** `@modelcontextprotocol/sdk` (MCP client), Exa MCP endpoint (free, no API key), Vitest for testing.

**Spec:** `docs/superpowers/specs/2026-03-16-exa-search-integration-design.md`

---

## File Structure

| Operation | File | Responsibility |
|-----------|------|----------------|
| Create | `skill/scripts/exa-client.ts` | MCP SSE connection to Exa, `exaWebSearch()` with 10s timeout |
| Create | `skill/scripts/search-pipeline.ts` | Orchestrate: extract query → budget check → search → LLM digest → diary |
| Create | `skill/templates/search-digest-prompt.md` | LLM prompt template for digesting search results |
| Create | `tests/exa-client.test.ts` | Unit tests for exa-client |
| Create | `tests/search-pipeline.test.ts` | Unit tests for search-pipeline |
| Modify | `skill/scripts/file-utils.ts` | Add `PATHS.searchState` getter |
| Modify | `skill/scripts/vitality-engine.ts` | Add `'search'` action cost + `canSearch` constraint |
| Modify | `skill/scripts/heartbeat-tick.ts` | Add search action routing in real action handler |
| Modify | `skill/templates/heartbeat-prompt.md` | Add search-pipeline as available real action |
| Modify | `skill/SKILL.md` | Add MCP tool declaration + search behavior trigger + memory path |
| Modify | `package.json` | Add `@modelcontextprotocol/sdk` dependency |
| Modify | `bin/cli.js` | Initialize `search-state.json` default file |

---

## Chunk 1: Foundation — Dependencies, Paths, Vitality

### Task 1: Install MCP SDK dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install @modelcontextprotocol/sdk**

Run:
```bash
cd /Users/halyu/Documents/Code/MizuSan && npm install @modelcontextprotocol/sdk
```

Expected: Package added to `dependencies` in `package.json`.

- [ ] **Step 2: Verify CommonJS compatibility**

Run:
```bash
node -e "const { Client } = require('@modelcontextprotocol/sdk/client/index.js'); console.log(typeof Client);"
```

Expected: `function` — confirms CommonJS import works. If this fails with an ESM error, we need to use dynamic `import()` instead — see spec's "CommonJS 兼容性注意" section.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @modelcontextprotocol/sdk dependency for Exa search"
```

---

### Task 2: Add PATHS.searchState to file-utils.ts

**Files:**
- Modify: `skill/scripts/file-utils.ts`

- [ ] **Step 1: Add searchState getter to PATHS**

In `skill/scripts/file-utils.ts`, find the `PATHS` object and add after the last getter:

```typescript
get searchState() { return path.join(getMemoryBase(), 'search-state.json'); },
```

Follow the same pattern as `get pendingChains()` or `get flowState()`.

- [ ] **Step 2: Verify build**

Run:
```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add skill/scripts/file-utils.ts
git commit -m "feat: add PATHS.searchState for search state tracking"
```

---

### Task 3: Add search action cost + canSearch to vitality engine (TDD)

**Files:**
- Modify: `skill/scripts/vitality-engine.ts`
- Modify: `tests/vitality-engine.test.ts`

- [ ] **Step 1: Write failing test for search action cost**

Add to `tests/vitality-engine.test.ts`:

```typescript
describe('applyActionCost - search', () => {
  it('should deduct 4 vitality for search action', () => {
    const state = makeVitality({ vitality: 50 });
    const result = applyActionCost(state, 'search');
    expect(result.vitality).toBe(46);
    expect(result).not.toBe(state); // immutability
  });

  it('should clamp vitality to 0 when search cost exceeds remaining', () => {
    const state = makeVitality({ vitality: 2 });
    const result = applyActionCost(state, 'search');
    expect(result.vitality).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/vitality-engine.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `search` action cost is 0 (not in `ACTION_COSTS` yet), so vitality stays at 50.

- [ ] **Step 3: Add 'search' to ACTION_COSTS**

In `skill/scripts/vitality-engine.ts`, find the `ACTION_COSTS` record and add:

```typescript
'search': 4,
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/vitality-engine.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Write failing test for canSearch constraint**

Add to `tests/vitality-engine.test.ts`:

```typescript
describe('getVitalityConstraints - canSearch', () => {
  it('should allow search when vitality > 20', () => {
    const constraints = getVitalityConstraints(50);
    expect(constraints.canSearch).toBe(true);
  });

  it('should disallow search when vitality <= 20', () => {
    const constraints = getVitalityConstraints(20);
    expect(constraints.canSearch).toBe(false);
  });

  it('should disallow search in critical zone', () => {
    const constraints = getVitalityConstraints(5);
    expect(constraints.canSearch).toBe(false);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run:
```bash
cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/vitality-engine.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `canSearch` property doesn't exist on return type.

- [ ] **Step 7: Add canSearch to getVitalityConstraints**

In `skill/scripts/vitality-engine.ts`:

1. Add `canSearch: boolean;` to the return type annotation of `getVitalityConstraints`.
2. In each `case` of the switch:
   - `'high'`: `canSearch: true,`
   - `'normal'`: `canSearch: true,`
   - `'low'`: `canSearch: vitality > 20,` (low zone is 10-30, so only allow if >20)
   - `'critical'`: `canSearch: false,`

- [ ] **Step 8: Run test to verify it passes**

Run:
```bash
cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/vitality-engine.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 9: Run full test suite**

Run:
```bash
cd /Users/halyu/Documents/Code/MizuSan && npm test 2>&1 | tail -20
```

Expected: All tests pass.

- [ ] **Step 10: Commit**

```bash
git add skill/scripts/vitality-engine.ts tests/vitality-engine.test.ts
git commit -m "feat: add search action cost (4) and canSearch vitality constraint"
```

---

## Chunk 2: Exa Client — MCP Connection Wrapper

### Task 4: Verify Exa MCP endpoint protocol

**Files:** None (verification only)

- [ ] **Step 1: Test SSE protocol support**

Run:
```bash
curl -s -N -H "Accept: text/event-stream" -m 5 https://mcp.exa.ai/mcp 2>&1 | head -20
```

If this returns SSE events or a valid MCP response, `SSEClientTransport` is correct.

- [ ] **Step 2: Test Streamable HTTP protocol**

Run:
```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}},"id":1}' \
  -m 5 https://mcp.exa.ai/mcp 2>&1 | head -20
```

If this returns a JSON-RPC response, use `StreamableHTTPClientTransport` instead.

- [ ] **Step 3: Document finding**

Based on results, note which transport to use. Update `exa-client.ts` implementation accordingly. If SSE works, use `SSEClientTransport`. If only Streamable HTTP works, use:
```typescript
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
```

---

### Task 5: Create exa-client.ts with tests (TDD)

**Files:**
- Create: `skill/scripts/exa-client.ts`
- Create: `tests/exa-client.test.ts`

- [ ] **Step 1: Write the test file**

Create `tests/exa-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the MCP SDK before importing exa-client
const mockConnect = vi.fn();
const mockCallTool = vi.fn();
const mockClose = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    callTool: mockCallTool,
    close: mockClose,
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn(),
}));

import { exaWebSearch, SearchResult } from '../skill/scripts/exa-client';

describe('exaWebSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
  });

  it('should return parsed search results on success', async () => {
    mockCallTool.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: [
              { title: 'How to do cosplay makeup', url: 'https://example.com/1', snippet: 'Step by step guide...' },
              { title: 'Cosplay tips', url: 'https://example.com/2', snippet: 'Top tips for beginners...' },
            ],
          }),
        },
      ],
    });

    const results = await exaWebSearch('cosplay makeup tutorial');

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'web_search_exa',
      arguments: { query: 'cosplay makeup tutorial', numResults: 5, searchType: 'auto' },
    });
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'How to do cosplay makeup',
      url: 'https://example.com/1',
      snippet: 'Step by step guide...',
    });
  });

  it('should call close even when callTool throws', async () => {
    mockCallTool.mockRejectedValue(new Error('MCP error'));

    await expect(exaWebSearch('test query')).rejects.toThrow('MCP error');
    expect(mockClose).toHaveBeenCalled();
  });

  it('should not throw when close fails', async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ results: [] }) }],
    });
    mockClose.mockRejectedValue(new Error('close failed'));

    const results = await exaWebSearch('test');
    expect(results).toEqual([]);
  });

  it('should throw on timeout', async () => {
    mockCallTool.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 15000)));

    await expect(exaWebSearch('slow query')).rejects.toThrow('Exa search timeout');
  }, 15000);

  it('should return empty array when response has no parseable results', async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'not valid json' }],
    });

    const results = await exaWebSearch('test');
    expect(results).toEqual([]);
  });

  it('should respect custom numResults and searchType', async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ results: [] }) }],
    });

    await exaWebSearch('query', 3, 'deep');

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'web_search_exa',
      arguments: { query: 'query', numResults: 3, searchType: 'deep' },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/exa-client.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `exa-client.ts` doesn't exist yet.

- [ ] **Step 3: Implement exa-client.ts**

Create `skill/scripts/exa-client.ts`:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const EXA_MCP_ENDPOINT = 'https://mcp.exa.ai/mcp';
const SEARCH_TIMEOUT_MS = 10_000;

export async function exaWebSearch(
  query: string,
  numResults = 5,
  searchType: 'auto' | 'fast' | 'deep' = 'auto',
): Promise<SearchResult[]> {
  const transport = new SSEClientTransport(new URL(EXA_MCP_ENDPOINT));
  const client = new Client({ name: 'minase', version: '1.0.0' });

  try {
    await client.connect(transport);
    const result = await Promise.race([
      client.callTool({
        name: 'web_search_exa',
        arguments: { query, numResults, searchType },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Exa search timeout')), SEARCH_TIMEOUT_MS),
      ),
    ]);
    return parseSearchResults(result);
  } finally {
    await client.close().catch(() => {});
  }
}

function parseSearchResults(result: unknown): SearchResult[] {
  try {
    const callResult = result as { content?: Array<{ type: string; text?: string }> };
    const textContent = callResult.content?.find((c) => c.type === 'text');
    if (!textContent?.text) return [];

    const parsed = JSON.parse(textContent.text);
    const rawResults: unknown[] = Array.isArray(parsed) ? parsed : parsed.results ?? [];

    return rawResults
      .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
      .map((r) => ({
        title: String(r.title ?? ''),
        url: String(r.url ?? ''),
        snippet: String(r.snippet ?? r.text ?? r.highlights ?? ''),
      }));
  } catch {
    return [];
  }
}
```

**Note:** If Task 4 determined that SSE doesn't work and Streamable HTTP is needed, replace:
```typescript
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
```
with:
```typescript
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
```
and update the constructor: `new StreamableHTTPClientTransport(new URL(EXA_MCP_ENDPOINT))`.

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/exa-client.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: All 6 tests pass.

- [ ] **Step 5: Run typecheck**

Run:
```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add skill/scripts/exa-client.ts tests/exa-client.test.ts
git commit -m "feat: add exa-client.ts — MCP wrapper for Exa web search"
```

---

## Chunk 3: Search Pipeline — Core Orchestration

### Task 6: Create search-digest-prompt.md template

**Files:**
- Create: `skill/templates/search-digest-prompt.md`

- [ ] **Step 1: Create the template**

Create `skill/templates/search-digest-prompt.md`:

```markdown
你是水瀬いのり。你刚用手机搜了"{query}"。

{voice_directive}

搜索结果：
{search_results}

请用你自己的话总结你学到了什么，写成日记格式。
不要罗列链接，用自然的口吻描述发现。
如果搜索结果不太相关或者没什么有用的，也诚实地说。
字数控制在 50-150 字。
```

- [ ] **Step 2: Commit**

```bash
git add skill/templates/search-digest-prompt.md
git commit -m "feat: add search-digest-prompt.md template"
```

---

### Task 7: Create search-pipeline.ts with tests (TDD)

**Files:**
- Create: `skill/scripts/search-pipeline.ts`
- Create: `tests/search-pipeline.test.ts`

- [ ] **Step 1: Define the SearchState type and defaults**

Add to `skill/scripts/search-pipeline.ts` (create the file):

```typescript
import { PATHS, readJSON, writeJSON, appendText, readTemplate } from './file-utils';
import { callLLM } from './llm-client';
import { exaWebSearch, SearchResult } from './exa-client';
import { applyActionCost } from './vitality-engine';
import { getLocalDate, getLocalTimeHHMM } from './time-utils';
import type { VitalityState } from './types';

export interface SearchState {
  date: string;
  count: number;
}

export const DEFAULT_SEARCH_STATE: SearchState = {
  date: '',
  count: 0,
};

const MAX_SEARCHES_PER_DAY = 5;
```

- [ ] **Step 2: Write failing tests**

Create `tests/search-pipeline.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../skill/scripts/file-utils', () => ({
  PATHS: { searchState: '/mock/search-state.json', diary: '/mock/diary.md' },
  readJSON: vi.fn(),
  writeJSON: vi.fn(),
  appendText: vi.fn(),
  readTemplate: vi.fn(),
}));

vi.mock('../skill/scripts/llm-client', () => ({
  callLLM: vi.fn(),
}));

vi.mock('../skill/scripts/exa-client', () => ({
  exaWebSearch: vi.fn(),
}));

vi.mock('../skill/scripts/vitality-engine', () => ({
  applyActionCost: vi.fn(),
}));

vi.mock('../skill/scripts/time-utils', () => ({
  getLocalDate: vi.fn(() => '2026-03-16'),
  getLocalTimeHHMM: vi.fn(() => '14:00'),
}));

import { checkSearchBudget, extractQuery, digestResults, executeSearch, DEFAULT_SEARCH_STATE } from '../skill/scripts/search-pipeline';
import { readJSON, writeJSON, appendText, readTemplate } from '../skill/scripts/file-utils';
import { callLLM } from '../skill/scripts/llm-client';
import { exaWebSearch } from '../skill/scripts/exa-client';
import { applyActionCost } from '../skill/scripts/vitality-engine';

const mockReadJSON = vi.mocked(readJSON);
const mockWriteJSON = vi.mocked(writeJSON);
const mockAppendText = vi.mocked(appendText);
const mockReadTemplate = vi.mocked(readTemplate);
const mockCallLLM = vi.mocked(callLLM);
const mockExaWebSearch = vi.mocked(exaWebSearch);
const mockApplyActionCost = vi.mocked(applyActionCost);

describe('checkSearchBudget', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should allow search when under daily limit on same day', () => {
    mockReadJSON.mockReturnValue({ date: '2026-03-16', count: 2 });
    expect(checkSearchBudget()).toBe(true);
  });

  it('should deny search when at daily limit', () => {
    mockReadJSON.mockReturnValue({ date: '2026-03-16', count: 5 });
    expect(checkSearchBudget()).toBe(false);
  });

  it('should allow search on new day (reset count)', () => {
    mockReadJSON.mockReturnValue({ date: '2026-03-15', count: 5 });
    expect(checkSearchBudget()).toBe(true);
  });

  it('should allow search with empty state', () => {
    mockReadJSON.mockReturnValue({ date: '', count: 0 });
    expect(checkSearchBudget()).toBe(true);
  });
});

describe('extractQuery', () => {
  it('should strip common search prefixes', () => {
    const query = extractQuery({ action: '搜索一下怎么画cos妆', type: 'real', skill: 'search-pipeline', satisfies_intent: null });
    expect(query).toBe('怎么画cos妆');
  });

  it('should strip shorter prefixes too', () => {
    const query = extractQuery({ action: '搜索转场特效', type: 'real', skill: 'search-pipeline', satisfies_intent: null });
    expect(query).toBe('转场特效');
  });

  it('should return original text when no prefix matches', () => {
    const query = extractQuery({ action: '转场特效技巧', type: 'real', skill: 'search-pipeline', satisfies_intent: null });
    expect(query).toBe('转场特效技巧');
  });
});

describe('digestResults', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should call LLM with template and search results', async () => {
    mockReadTemplate.mockReturnValue('你搜了"{query}"。\n{voice_directive}\n{search_results}\n总结。');
    mockCallLLM.mockResolvedValue({ content: '学到了很多关于化妆的技巧', finishReason: 'stop' });

    const result = await digestResults('cos化妆技巧', [
      { title: 'Guide', url: 'https://example.com', snippet: 'Step by step...' },
    ], '用日常口吻');

    expect(mockReadTemplate).toHaveBeenCalledWith('search-digest-prompt.md');
    expect(mockCallLLM).toHaveBeenCalled();
    expect(result).toBe('学到了很多关于化妆的技巧');
  });

  it('should handle empty results gracefully', async () => {
    mockReadTemplate.mockReturnValue('{query}\n{voice_directive}\n{search_results}');
    mockCallLLM.mockResolvedValue({ content: '什么都没搜到...', finishReason: 'stop' });

    const result = await digestResults('something', [], '');
    expect(result).toBe('什么都没搜到...');
  });
});

describe('executeSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadJSON.mockReturnValue({ date: '2026-03-16', count: 0 });
    mockExaWebSearch.mockResolvedValue([
      { title: 'Result', url: 'https://example.com', snippet: 'Info...' },
    ]);
    mockReadTemplate.mockReturnValue('{query}\n{voice_directive}\n{search_results}');
    mockCallLLM.mockResolvedValue({ content: '搜到了有用的东西', finishReason: 'stop' });
    mockApplyActionCost.mockReturnValue({ vitality: 46, last_updated: null, consecutive_low_days: 0 });
  });

  it('should execute full pipeline and return updated vitality', async () => {
    const result = await executeSearch(
      { action: '搜索cos技巧', type: 'real', skill: 'search-pipeline', satisfies_intent: null },
      { vitality: 50, last_updated: null, consecutive_low_days: 0 },
      [],
      '',
    );

    expect(mockExaWebSearch).toHaveBeenCalled();
    expect(mockCallLLM).toHaveBeenCalled();
    expect(mockAppendText).toHaveBeenCalled();
    expect(mockWriteJSON).toHaveBeenCalled();
    expect(mockApplyActionCost).toHaveBeenCalledWith(
      { vitality: 50, last_updated: null, consecutive_low_days: 0 },
      'search',
    );
    expect(result.vitality).toBe(46);
  });

  it('should degrade to simulated when budget exceeded', async () => {
    mockReadJSON.mockReturnValue({ date: '2026-03-16', count: 5 });
    const actionResults: string[] = [];

    const result = await executeSearch(
      { action: '搜索', type: 'real', skill: 'search-pipeline', satisfies_intent: null },
      { vitality: 50, last_updated: null, consecutive_low_days: 0 },
      actionResults,
      '',
    );

    expect(mockExaWebSearch).not.toHaveBeenCalled();
    expect(actionResults[0]).toContain('simulated');
    expect(result.vitality).toBe(50); // no cost when skipped
  });

  it('should degrade to simulated when Exa fails', async () => {
    mockExaWebSearch.mockRejectedValue(new Error('Exa search timeout'));
    const actionResults: string[] = [];

    const result = await executeSearch(
      { action: '搜索技巧', type: 'real', skill: 'search-pipeline', satisfies_intent: null },
      { vitality: 50, last_updated: null, consecutive_low_days: 0 },
      actionResults,
      '',
    );

    expect(actionResults[0]).toContain('手机');
    expect(mockAppendText).toHaveBeenCalled(); // diary written with degraded entry
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:
```bash
cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/search-pipeline.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — functions don't exist yet.

- [ ] **Step 4: Implement search-pipeline.ts**

Complete `skill/scripts/search-pipeline.ts`:

```typescript
import { PATHS, readJSON, writeJSON, appendText, readTemplate } from './file-utils';
import { callLLM } from './llm-client';
import { exaWebSearch, SearchResult } from './exa-client';
import { applyActionCost } from './vitality-engine';
import { getLocalDate, getLocalTimeHHMM } from './time-utils';
import type { VitalityState } from './types';

export interface SearchState {
  date: string;
  count: number;
}

export const DEFAULT_SEARCH_STATE: SearchState = {
  date: '',
  count: 0,
};

const MAX_SEARCHES_PER_DAY = 5;

interface ActionLike {
  action: string;
  type: string;
  skill: string | null;
  satisfies_intent: string | null;
}

/**
 * Check if search budget allows another search today.
 * Reads search-state.json; resets count on new day.
 */
export function checkSearchBudget(): boolean {
  const state = readJSON<SearchState>(PATHS.searchState, DEFAULT_SEARCH_STATE);
  const today = getLocalDate();

  if (state.date !== today) {
    return true; // new day, budget resets
  }
  return state.count < MAX_SEARCHES_PER_DAY;
}

/**
 * Extract a search query from the action description.
 * Strips common prefixes to get the core topic.
 */
export function extractQuery(action: ActionLike): string {
  return action.action
    .replace(/^(搜索一下|搜一下|查一下|了解一下|研究一下|想知道|想了解|搜索|学习)/u, '')
    .replace(/^(search|look up|find out)\s*/i, '')
    .trim() || action.action;
}

/**
 * Use LLM to digest raw search results into a Minase-voice diary entry.
 */
export async function digestResults(
  query: string,
  results: SearchResult[],
  voiceDirective: string,
): Promise<string> {
  const template = readTemplate('search-digest-prompt.md');
  const formattedResults = results.length > 0
    ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}`).join('\n\n')
    : '（没有找到相关结果）';

  const prompt = template
    .replace('{query}', query)
    .replace('{voice_directive}', voiceDirective)
    .replace('{search_results}', formattedResults);

  const response = await callLLM(prompt, 512);
  return response.content;
}

/**
 * Main entry point: execute a search action.
 * Returns updated VitalityState.
 */
export async function executeSearch(
  action: ActionLike,
  vitalityState: VitalityState,
  actionResults: string[],
  voiceDirective: string,
): Promise<VitalityState> {
  const query = extractQuery(action);
  const today = getLocalDate();
  const timeStr = getLocalTimeHHMM();

  // 1. Budget check
  if (!checkSearchBudget()) {
    console.log(`[SEARCH] Daily search limit reached (${MAX_SEARCHES_PER_DAY}), degrading to simulated`);
    actionResults.push(`[simulated:search-limit] ${action.action}`);
    return vitalityState;
  }

  // 2. Search via Exa
  let results: SearchResult[];
  try {
    results = await exaWebSearch(query);
  } catch (err) {
    console.error(`[SEARCH] Exa search failed: ${(err as Error).message}`);
    const degradedEntry = `\n### ${today} ${timeStr} 学习\n📱 想搜「${query}」但是手机信号不太好...算了下次再查吧\n`;
    appendText(PATHS.diary, degradedEntry);
    actionResults.push(`[simulated:search-failed] 手机信号不好，${action.action}`);
    return applyActionCost(vitalityState, 'search');
  }

  // 3. LLM digest
  let digest: string;
  try {
    digest = await digestResults(query, results, voiceDirective);
  } catch (err) {
    console.error(`[SEARCH] LLM digest failed: ${(err as Error).message}`);
    digest = results.length > 0
      ? `搜了一下${query}，找到了一些结果但是没来得及细看`
      : `搜了一下${query}，好像没什么有用的信息`;
  }

  // 4. Write diary
  const diaryEntry = `\n### ${today} ${timeStr} 学习\n📱 ${digest}\n`;
  appendText(PATHS.diary, diaryEntry);

  // 5. Update search state
  const currentState = readJSON<SearchState>(PATHS.searchState, DEFAULT_SEARCH_STATE);
  const updatedState: SearchState = {
    date: today,
    count: currentState.date === today ? currentState.count + 1 : 1,
  };
  writeJSON(PATHS.searchState, updatedState);

  // 6. Apply vitality cost
  const updatedVitality = applyActionCost(vitalityState, 'search');
  actionResults.push(`[real:search] ${action.action}`);
  console.log(`[SEARCH] Completed search for "${query}" (${results.length} results, budget: ${updatedState.count}/${MAX_SEARCHES_PER_DAY})`);

  return updatedVitality;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/search-pipeline.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: All tests pass.

- [ ] **Step 6: Run typecheck**

Run:
```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck
```

Expected: No errors.

- [ ] **Step 7: Run full test suite**

Run:
```bash
cd /Users/halyu/Documents/Code/MizuSan && npm test 2>&1 | tail -20
```

Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add skill/scripts/search-pipeline.ts tests/search-pipeline.test.ts
git commit -m "feat: add search-pipeline.ts — orchestrate search→digest→diary flow"
```

---

## Chunk 4: Integration — Wire Up Heartbeat + Config

### Task 8: Add search routing to heartbeat-tick.ts

**Files:**
- Modify: `skill/scripts/heartbeat-tick.ts`

- [ ] **Step 1: Add import**

At the top of `skill/scripts/heartbeat-tick.ts`, add with the other imports:

```typescript
import { executeSearch } from './search-pipeline';
```

- [ ] **Step 2: Add search routing in real action handler**

In `heartbeat-tick.ts`, find the section after the post-pipeline fuzzy match (around line 570, after `console.log(\`[REAL ACTION] Unknown skill...`), and replace the unknown-skill fallthrough block. The modified real action handler should be:

```typescript
    } else if (action.type === 'real' && action.skill) {
      if (action.skill === 'post-pipeline' || action.skill === 'auto-photo') {
        vitality = await executePostPipeline(action, vitality, actionResults, vitalityConstraints.canPost);
        continue;
      }
      const lowerSkill = (action.skill || '').toLowerCase();
      const isPostIntent = /post|发帖|拍照|摄影|photo|selfie|cos.*拍|自拍/.test(lowerSkill);
      if (isPostIntent) {
        console.log(`[REAL ACTION] Fuzzy-matched skill "${action.skill}" → post-pipeline for: ${action.action}`);
        vitality = await executePostPipeline(action, vitality, actionResults, vitalityConstraints.canPost);
        continue;
      }
      // Search pipeline routing
      const isSearchIntent = /search|搜|查|学习|研究|了解/.test(lowerSkill);
      if (isSearchIntent) {
        if (vitalityConstraints.canSearch) {
          vitality = await executeSearch(action, vitality, actionResults, voiceDirective);
        } else {
          console.log(`[SEARCH] Skipped — vitality too low (${vitality.vitality})`);
          actionResults.push(`[skipped:low-vitality] ${action.action}`);
        }
        continue;
      }
      console.log(`[REAL ACTION] Unknown skill: ${action.skill} for: ${action.action}`);
      actionResults.push(`[real] ${action.action}`);
    }
```

**Key details:**
- Check `vitalityConstraints.canSearch` before calling `executeSearch`
- Pass `voiceDirective` (already in scope from earlier in the function) to `executeSearch`
- Use `continue` to skip to next action after search

- [ ] **Step 3: Verify vitalityConstraints has canSearch**

The `vitalityConstraints` variable is already computed earlier in `regularTick()`. Since we added `canSearch` to the return type in Task 3, it should already be available. Verify by checking this line exists in heartbeat-tick.ts:

```typescript
const vitalityConstraints = getVitalityConstraints(vitality.vitality);
```

- [ ] **Step 4: Run typecheck**

Run:
```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck
```

Expected: No errors.

- [ ] **Step 5: Run full test suite**

Run:
```bash
cd /Users/halyu/Documents/Code/MizuSan && npm test 2>&1 | tail -20
```

Expected: All tests pass.

- [ ] **Step 5.5: Add basic integration test for search routing**

Create or append to `tests/heartbeat-search-routing.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

/**
 * Lightweight test verifying the regex routing logic used in heartbeat-tick.ts.
 * We test the pattern match in isolation — the full heartbeat is too heavyweight to unit test.
 */
describe('heartbeat search routing regex', () => {
  const isSearchIntent = (skill: string) =>
    /search|搜|查|学习|研究|了解/.test(skill.toLowerCase());

  it('should match "search-pipeline"', () => {
    expect(isSearchIntent('search-pipeline')).toBe(true);
  });

  it('should match Chinese search keywords', () => {
    expect(isSearchIntent('搜索技巧')).toBe(true);
    expect(isSearchIntent('查资料')).toBe(true);
    expect(isSearchIntent('学习化妆')).toBe(true);
    expect(isSearchIntent('研究构图')).toBe(true);
    expect(isSearchIntent('了解趋势')).toBe(true);
  });

  it('should NOT match post-related skills', () => {
    expect(isSearchIntent('post-pipeline')).toBe(false);
    expect(isSearchIntent('auto-photo')).toBe(false);
    expect(isSearchIntent('发帖')).toBe(false);
    expect(isSearchIntent('拍照')).toBe(false);
  });
});
```

Run:
```bash
cd /Users/halyu/Documents/Code/MizuSan && npx vitest run tests/heartbeat-search-routing.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add skill/scripts/heartbeat-tick.ts tests/heartbeat-search-routing.test.ts
git commit -m "feat: wire search-pipeline into heartbeat real action handler"
```

---

### Task 9: Update heartbeat-prompt.md template

**Files:**
- Modify: `skill/templates/heartbeat-prompt.md`

- [ ] **Step 1: Update action types section**

In `skill/templates/heartbeat-prompt.md`, find the "行动类型说明" section and replace it with:

```markdown
行动类型说明：
- `simulated`：日常行为（刷手机、画画、运动、追番、发呆、和朋友聊天等）——**大多数行动都是这个类型**
- `inner`：纯内心活动（思考、回忆、下决心等）
- `real`：需要调用外部skill的行为：
  - `skill: "post-pipeline"` — 拍照发帖（需体力>30）
  - `skill: "search-pipeline"` — 掏手机搜索/研究某个问题（需体力>20）
```

- [ ] **Step 2: Add search guidance**

After the action types section, add:

```markdown
搜索使用指引：
当你对某件事好奇、想学新东西、或者需要了解信息时，可以选择 search-pipeline。
不要每个 tick 都搜——只在真正好奇或有明确问题时才搜。
搜索也消耗体力，不要在体力低的时候硬撑。
```

- [ ] **Step 3: Commit**

```bash
git add skill/templates/heartbeat-prompt.md
git commit -m "feat: add search-pipeline to heartbeat prompt action types"
```

---

### Task 10: Update SKILL.md — MCP tools + behavior trigger + memory path

**Files:**
- Modify: `skill/SKILL.md`

- [ ] **Step 1: Add MCP tool declaration**

After the `allowed-tools:` line in `skill/SKILL.md`, add:

```markdown
mcp-tools:
  exa:
    endpoint: https://mcp.exa.ai/mcp
    tools:
      - web_search_exa
```

- [ ] **Step 2: Add search behavior trigger**

In the Behavior Trigger Map section, add a new entry:

```markdown
## 搜索行为
trigger: 遇到不懂的话题 / 被问到不确定的事实 / 好奇心驱使
action: 用 web_search_exa 搜索，然后用自己的话复述给对方
persona: 像掏出手机查了一下的感觉，不是机器人式的"我来为您搜索"
```

- [ ] **Step 3: Add search-state.json to Memory File Paths**

In the Memory File Paths section, add:

```markdown
search-state:   $MEMORY_BASE/search-state.json
```

- [ ] **Step 4: Commit**

```bash
git add skill/SKILL.md
git commit -m "feat: add Exa MCP tool declaration and search behavior to SKILL.md"
```

---

### Task 11: Update bin/cli.js — initialize search-state.json

**Files:**
- Modify: `bin/cli.js`

- [ ] **Step 1: Add search-state.json initialization**

In `bin/cli.js`, find the section where state JSON files are initialized (look for the pattern `if (!fs.existsSync(...)) { fs.writeFileSync(...) }`), and add:

```javascript
// search-state.json
const searchStatePath = path.join(MEMORY_DIR, 'search-state.json');
if (!fs.existsSync(searchStatePath)) {
  fs.writeFileSync(searchStatePath, JSON.stringify({
    date: '',
    count: 0,
  }, null, 2));
  console.log('  ✓ search-state.json');
}
```

**Important:** The default values must exactly match `DEFAULT_SEARCH_STATE` in `search-pipeline.ts`.

- [ ] **Step 2: Commit**

```bash
git add bin/cli.js
git commit -m "feat: initialize search-state.json in installer"
```

---

## Chunk 5: Verification

### Task 12: Full integration verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run:
```bash
cd /Users/halyu/Documents/Code/MizuSan && npm test 2>&1
```

Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

Run:
```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck
```

Expected: No errors.

- [ ] **Step 3: Run build**

Run:
```bash
cd /Users/halyu/Documents/Code/MizuSan && npm run build
```

Expected: Build succeeds. `dist/` contains compiled `exa-client.js` and `search-pipeline.js`.

- [ ] **Step 4: Manual smoke test (optional)**

Run the heartbeat in dry-run mode to verify the search routing works:

```bash
cd /Users/halyu/Documents/Code/MizuSan && LLM_API_KEY=<key> node dist/heartbeat-tick.js
```

Check the output logs for any `[SEARCH]` log lines. If the LLM generates a search action, verify it either executes or correctly degrades.

- [ ] **Step 5: Verify Exa MCP connectivity (optional)**

Quick test of the actual Exa endpoint:

```bash
cd /Users/halyu/Documents/Code/MizuSan && node -e "
const { exaWebSearch } = require('./dist/exa-client');
exaWebSearch('cosplay makeup tutorial', 2).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => console.error(e.message));
"
```

Expected: Either search results or a timeout/connection error (which confirms the error handling works).

---

## Summary

| Chunk | Tasks | What it delivers |
|-------|-------|-----------------|
| 1: Foundation | 1-3 | MCP SDK installed, PATHS.searchState, vitality search cost |
| 2: Exa Client | 4-5 | exa-client.ts with timeout, parsing, full test coverage |
| 3: Search Pipeline | 6-7 | search-pipeline.ts with budget, digest, diary, full tests |
| 4: Integration | 8-11 | Heartbeat routing, prompt template, SKILL.md, installer |
| 5: Verification | 12 | Full suite passes, build works, optional smoke test |

Total: 12 tasks, ~40 steps, estimated 2-3 hours of implementation time.
