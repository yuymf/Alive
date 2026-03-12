# Reddit Enhancement + XiaoHongShu Integration Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Minase to real Reddit post content/comments and XiaoHongShu recommendation feeds, with visual inspiration saving for photo generation.

**Architecture:** Two independent subsystems — (1) enhance `fetch-trends.ts` for rich Reddit data into `world.md`, (2) new `xhs-mcp-client.ts` + changes to `inspiration-collector.ts` for XHS feed/search/inspiration saving into `inspiration.json`. No shared code between subsystems.

**Tech Stack:** TypeScript (ES2022, CommonJS), vitest, MCP JSON-RPC 2.0 over HTTP, Reddit public JSON API.

**Spec:** `docs/superpowers/specs/2026-03-12-reddit-xhs-integration-design.md`

---

## File Structure

| File | Responsibility | Subsystem |
|------|---------------|-----------|
| `skill/scripts/fetch-trends.ts` | Reddit trend fetching with post bodies + comments → `world.md` | Reddit |
| `tests/fetch-trends.test.ts` | Tests for Reddit enhancement | Reddit |
| `skill/scripts/xhs-mcp-client.ts` | **NEW** — Thin MCP JSON-RPC client for xiaohongshu-mcp | XHS |
| `tests/xhs-mcp-client.test.ts` | Tests for XHS MCP client | XHS |
| `skill/scripts/types.ts` | Add `xiaohongshu_trends` to `InspirationData` | XHS |
| `skill/scripts/inspiration-collector.ts` | New `collectXiaohongshuTrends()` with inspiration saving | XHS |
| `tests/inspiration-collector.test.ts` | Tests for XHS collection + inspiration merge | XHS |
| `skill/scripts/content-planner.ts` | Inject XHS trends + saved inspirations into `planPhoto()` | XHS |
| `skill/templates/xhs-inspiration-prompt.md` | **NEW** — LLM prompt for XHS trend extraction | XHS |
| `skill/templates/photo-intent-prompt.md` | Add XHS + saved inspiration placeholders | XHS |

---

## Chunk 1: Reddit Enhancement

### Task 1: Add Reddit comment fetching + rich output tests

**Files:**
- Create: `tests/fetch-trends.test.ts`
- Modify: `skill/scripts/fetch-trends.ts`

- [ ] **Step 1: Write tests for the new Reddit types and formatting**

Create `tests/fetch-trends.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We'll test the internal functions by importing the module.
// Since fetch-trends.ts uses global fetch, we mock it.

// First, let's test the output formatting function we'll extract.
// We need to make formatTrendEntry and formatTrendSection exportable for testing.

describe('fetch-trends', () => {
  describe('formatTrendEntry', () => {
    it('should format a post with selftext and comments', async () => {
      // Dynamic import after mocking
      const { formatTrendEntry } = await import('../skill/scripts/fetch-trends');
      const entry = formatTrendEntry({
        title: 'Amazing Yor Forger cosplay',
        score: 1500,
        selftext: 'First time doing Yor! Used real fabric for the dress.',
        subreddit: 'cosplay',
        topComments: [
          'The fabric choice is perfect!',
          'Best Yor I have seen',
        ],
      });
      expect(entry).toContain('**Amazing Yor Forger cosplay**');
      expect(entry).toContain('↑1500');
      expect(entry).toContain('> First time doing Yor!');
      expect(entry).toContain('热评:');
      expect(entry).toContain('The fabric choice is perfect!');
    });

    it('should handle posts with no selftext', async () => {
      const { formatTrendEntry } = await import('../skill/scripts/fetch-trends');
      const entry = formatTrendEntry({
        title: 'My Marin Kitagawa',
        score: 800,
        selftext: '',
        subreddit: 'cosplay',
        topComments: [],
      });
      expect(entry).toContain('**My Marin Kitagawa**');
      expect(entry).toContain('↑800');
      expect(entry).not.toContain('>');
      expect(entry).not.toContain('热评');
    });

    it('should truncate long selftext to 200 chars', async () => {
      const { formatTrendEntry } = await import('../skill/scripts/fetch-trends');
      const longText = 'A'.repeat(300);
      const entry = formatTrendEntry({
        title: 'Test',
        score: 100,
        selftext: longText,
        subreddit: 'cosplay',
        topComments: [],
      });
      // The > line should contain at most ~200 chars of text
      const quoteLine = entry.split('\n').find(l => l.startsWith('   >'));
      expect(quoteLine!.length).toBeLessThanOrEqual(210); // 200 + prefix "   > " + "..."
    });

    it('should truncate comment bodies to 150 chars', async () => {
      const { formatTrendEntry } = await import('../skill/scripts/fetch-trends');
      const longComment = 'B'.repeat(200);
      const entry = formatTrendEntry({
        title: 'Test',
        score: 100,
        selftext: '',
        subreddit: 'cosplay',
        topComments: [longComment],
      });
      const commentLine = entry.split('\n').find(l => l.includes('热评'));
      expect(commentLine!.length).toBeLessThanOrEqual(175); // 150 + prefix + "..."
    });
  });

  describe('formatTrendSection', () => {
    it('should format a section with subreddit header and numbered entries', async () => {
      const { formatTrendSection } = await import('../skill/scripts/fetch-trends');
      const section = formatTrendSection('cosplay', [
        { title: 'Post 1', score: 500, selftext: 'text', subreddit: 'cosplay', topComments: [] },
        { title: 'Post 2', score: 300, selftext: '', subreddit: 'cosplay', topComments: ['nice'] },
      ]);
      expect(section).toContain('### r/cosplay');
      expect(section).toContain('1. **Post 1**');
      expect(section).toContain('2. **Post 2**');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/fetch-trends.test.ts`
Expected: FAIL — `formatTrendEntry` and `formatTrendSection` not found in module exports.

- [ ] **Step 3: Add TrendPost interface and formatting functions to fetch-trends.ts**

In `skill/scripts/fetch-trends.ts`, add after the existing `RedditPost` interface:

```typescript
interface RedditComment {
  data: {
    body: string;
    score: number;
    author: string;
  };
}

export interface TrendPost {
  title: string;
  score: number;
  selftext: string;
  subreddit: string;
  topComments: string[];
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

export function formatTrendEntry(post: TrendPost): string {
  const lines: string[] = [];
  lines.push(`**${post.title}** (↑${post.score})`);
  if (post.selftext.trim()) {
    lines.push(`   > ${truncate(post.selftext.trim(), 200)}`);
  }
  for (const comment of post.topComments) {
    lines.push(`   - 热评: "${truncate(comment, 150)}"`);
  }
  return lines.join('\n');
}

export function formatTrendSection(subreddit: string, posts: TrendPost[]): string {
  const lines: string[] = [`### r/${subreddit}`];
  posts.forEach((post, i) => {
    lines.push(`${i + 1}. ${formatTrendEntry(post)}`);
  });
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/fetch-trends.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add tests/fetch-trends.test.ts skill/scripts/fetch-trends.ts
git commit -m "feat(reddit): add TrendPost formatting with tests"
```

---

### Task 2: Add comment fetching and enhance fetchRedditTrends

**Files:**
- Modify: `skill/scripts/fetch-trends.ts`
- Modify: `tests/fetch-trends.test.ts`

- [ ] **Step 1: Write tests for fetchPostComments**

Add to `tests/fetch-trends.test.ts`:

```typescript
describe('fetchPostComments', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should extract top comments from Reddit JSON response', async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve([
        { data: { children: [] } }, // post listing (unused)
        {
          data: {
            children: [
              { kind: 't1', data: { body: 'Great cosplay!', score: 100, author: 'user1' } },
              { kind: 't1', data: { body: 'Love the details', score: 50, author: 'user2' } },
              { kind: 't1', data: { body: 'Low effort', score: 5, author: 'user3' } }, // below threshold
              { kind: 'more', data: {} }, // "load more" node — should be filtered out
            ],
          },
        },
      ]),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const { fetchPostComments } = await import('../skill/scripts/fetch-trends');
    const comments = await fetchPostComments('/r/cosplay/comments/abc123/title/', 3);
    expect(comments).toHaveLength(2); // score > 10 only
    expect(comments[0].data.body).toBe('Great cosplay!');
    expect(comments[1].data.body).toBe('Love the details');
  });

  it('should return empty array on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const { fetchPostComments } = await import('../skill/scripts/fetch-trends');
    const comments = await fetchPostComments('/r/cosplay/comments/abc123/title/', 3);
    expect(comments).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/fetch-trends.test.ts`
Expected: FAIL — `fetchPostComments` not found in exports.

- [ ] **Step 3: Implement fetchPostComments and delay**

Add to `skill/scripts/fetch-trends.ts`:

```typescript
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchPostComments(permalink: string, limit: number): Promise<RedditComment[]> {
  try {
    const url = `https://www.reddit.com${permalink}.json?limit=${limit}&sort=top`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'minase-digital-life/0.1' },
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json() as Array<{ data: { children: Array<{ kind: string; data: RedditComment['data'] }> } }>;
    if (!Array.isArray(data) || data.length < 2) return [];
    return data[1].data.children
      .filter(c => c.kind === 't1' && c.data.score > 10)
      .sort((a, b) => b.data.score - a.data.score)
      .slice(0, limit)
      .map(c => ({ data: c.data }));
  } catch (err) {
    console.warn(`Failed to fetch comments for ${permalink}: ${(err as Error).message}`);
    return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/fetch-trends.test.ts`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Commit**

```bash
git add skill/scripts/fetch-trends.ts tests/fetch-trends.test.ts
git commit -m "feat(reddit): add fetchPostComments with rate limiting"
```

---

### Task 3: Enhance fetchRedditTrends and main output

**Files:**
- Modify: `skill/scripts/fetch-trends.ts`

- [ ] **Step 1: Update RedditPost interface**

In `skill/scripts/fetch-trends.ts`, update the existing `RedditPost` interface to include the new fields:

```typescript
interface RedditPost {
  data: {
    title: string;
    score: number;
    url: string;
    selftext: string;
    permalink: string;
    num_comments: number;
    id: string;
    subreddit: string;
  };
}
```

- [ ] **Step 2: Rewrite fetchRedditTrends to return TrendPost[]**

Replace the existing `fetchRedditTrends` function:

```typescript
async function fetchRedditTrends(url: string): Promise<TrendPost[]> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'minase-digital-life/0.1' },
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json() as RedditResponse;
  const posts = data.data.children
    .sort((a, b) => b.data.score - a.data.score)
    .slice(0, 3);

  const results: TrendPost[] = [];
  for (const post of posts) {
    const topComments: string[] = [];
    if (post.data.num_comments > 0) {
      await delay(1000);
      const comments = await fetchPostComments(post.data.permalink, 3);
      topComments.push(...comments.map(c => c.data.body));
    }
    results.push({
      title: post.data.title,
      score: post.data.score,
      selftext: post.data.selftext ?? '',
      subreddit: post.data.subreddit,
      topComments,
    });
  }
  return results;
}
```

- [ ] **Step 3: Rewrite fetchTrends to use new output format**

Replace the `fetchTrends` function body:

```typescript
async function fetchTrends(query?: string): Promise<void> {
  const allPosts: Map<string, TrendPost[]> = new Map();

  for (const source of TREND_SOURCES) {
    try {
      const posts = await fetchRedditTrends(source);
      if (posts.length > 0) {
        const sub = posts[0].subreddit;
        allPosts.set(sub, [...(allPosts.get(sub) ?? []), ...posts]);
      }
    } catch (e) {
      // Silently skip failed sources
    }
  }

  if (allPosts.size === 0) {
    console.log('No trends fetched.');
    return;
  }

  const now = getLocalDate();
  const sections: string[] = [`\n## ${now} 趋势观察\n`];
  for (const [sub, posts] of allPosts) {
    sections.push(formatTrendSection(sub, posts));
  }
  const entry = sections.join('\n') + '\n';

  fs.mkdirSync(MEMORY_BASE, { recursive: true });
  if (!fs.existsSync(WORLD_PATH)) {
    fs.writeFileSync(WORLD_PATH, '# 世界观察\n\n_水瀬在浏览网络时学到的事情。_\n');
  }
  fs.appendFileSync(WORLD_PATH, entry);
  const totalPosts = [...allPosts.values()].reduce((sum, p) => sum + p.length, 0);
  console.log(`Wrote ${totalPosts} trends to world.md`);
}
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Run all tests**

Run: `npx vitest run tests/fetch-trends.test.ts`
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add skill/scripts/fetch-trends.ts
git commit -m "feat(reddit): enhance fetchRedditTrends with post bodies and comments"
```

---

## Chunk 2: XHS MCP Client

### Task 4: Add InspirationData.xiaohongshu_trends type

**Files:**
- Modify: `skill/scripts/types.ts:264-290`

- [ ] **Step 1: Add the xiaohongshu_trends optional field**

In `skill/scripts/types.ts`, add before the closing brace of `InspirationData` (currently line 290):

```typescript
  xiaohongshu_trends?: {
    feed_highlights: Array<{ title: string; likes: number; topic: string }>;
    cosplay_notes: Array<{ title: string; likes: number; topic: string }>;
    trending_topics: string[];
    cosplay_insights: string[];
    saved_inspirations: Array<{
      source_note_id: string;
      source_title: string;
      visual_description: string;
      style_tags: string[];
      saved_at: number;
    }>;
    updated_at: number;
  };
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors (field is optional, so no consumers break).

- [ ] **Step 3: Commit**

```bash
git add skill/scripts/types.ts
git commit -m "feat(xhs): add xiaohongshu_trends type to InspirationData"
```

---

### Task 5: Create xhs-mcp-client.ts with tests

**Files:**
- Create: `skill/scripts/xhs-mcp-client.ts`
- Create: `tests/xhs-mcp-client.test.ts`

- [ ] **Step 1: Write tests for the MCP client**

Create `tests/xhs-mcp-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('xhs-mcp-client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('isXhsMcpAvailable', () => {
    it('should return true when MCP server responds', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ jsonrpc: '2.0', result: {} }),
      }));
      const { isXhsMcpAvailable } = await import('../skill/scripts/xhs-mcp-client');
      const result = await isXhsMcpAvailable();
      expect(result).toBe(true);
    });

    it('should return false when MCP server is unreachable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
      const { isXhsMcpAvailable } = await import('../skill/scripts/xhs-mcp-client');
      const result = await isXhsMcpAvailable();
      expect(result).toBe(false);
    });
  });

  describe('listXhsFeed', () => {
    it('should parse MCP response into XhsNote array', async () => {
      const mcpResponse = {
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify([
              { id: 'note1', xsec_token: 'tok1', title: 'JK制服穿搭', description: '今日穿搭分享', likes: 2000, user: 'fashionista', tags: ['jk', '穿搭'] },
              { id: 'note2', xsec_token: 'tok2', title: 'Cos妆容教程', description: '简单日常妆', likes: 500, user: 'cosbeauty', tags: ['cos', '妆容'] },
            ]),
          }],
        },
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mcpResponse),
      }));
      const { listXhsFeed } = await import('../skill/scripts/xhs-mcp-client');
      const notes = await listXhsFeed();
      expect(notes).toHaveLength(2);
      expect(notes[0].title).toBe('JK制服穿搭');
      expect(notes[0].likes).toBe(2000);
    });

    it('should throw when MCP returns error', async () => {
      const mcpResponse = {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'Not logged in' },
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mcpResponse),
      }));
      const { listXhsFeed } = await import('../skill/scripts/xhs-mcp-client');
      await expect(listXhsFeed()).rejects.toThrow('Not logged in');
    });
  });

  describe('searchXhsNotes', () => {
    it('should pass keyword as argument to MCP search tool', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          jsonrpc: '2.0', id: 1,
          result: { content: [{ type: 'text', text: '[]' }] },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);
      const { searchXhsNotes } = await import('../skill/scripts/xhs-mcp-client');
      await searchXhsNotes('cosplay');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.params.name).toBe('search');
      expect(body.params.arguments.keyword).toBe('cosplay');
    });
  });

  describe('getXhsNoteDetail', () => {
    it('should pass note_id and xsec_token to MCP', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          jsonrpc: '2.0', id: 1,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                id: 'note1', xsec_token: 'tok1', title: 'Test', description: 'desc',
                likes: 100, user: 'u', tags: [], comments: [], images: [],
                collected_count: 10, share_count: 5,
              }),
            }],
          },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);
      const { getXhsNoteDetail } = await import('../skill/scripts/xhs-mcp-client');
      const detail = await getXhsNoteDetail('note1', 'tok1');
      expect(detail.id).toBe('note1');
      expect(detail.comments).toEqual([]);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.params.name).toBe('get_feed_detail');
      expect(body.params.arguments.note_id).toBe('note1');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/xhs-mcp-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create xhs-mcp-client.ts**

Create `skill/scripts/xhs-mcp-client.ts`:

```typescript
/**
 * xhs-mcp-client.ts
 * Thin MCP JSON-RPC 2.0 client for xiaohongshu-mcp.
 * Follows the same organizational principle as instagram-bridge-client.ts —
 * a focused client module that other scripts import —
 * but uses HTTP JSON-RPC instead of subprocess execution.
 */

const XHS_MCP_URL = process.env.XHS_MCP_URL ?? 'http://localhost:18060/mcp';
const XHS_MCP_TIMEOUT = 30_000;

let requestId = 1;

export interface XhsNote {
  id: string;
  xsec_token: string;
  title: string;
  description: string;
  likes: number;
  user: string;
  tags: string[];
}

export interface XhsNoteDetail extends XhsNote {
  comments: Array<{ user: string; content: string; likes: number }>;
  images: string[];
  collected_count: number;
  share_count: number;
}

interface McpResponse {
  jsonrpc: string;
  id: number;
  result?: { content: Array<{ type: string; text: string }> };
  error?: { code: number; message: string };
}

async function callXhsMcp(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: toolName, arguments: args },
    id: requestId++,
  });

  const res = await fetch(XHS_MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(XHS_MCP_TIMEOUT),
  });

  const data = await res.json() as McpResponse;
  if (data.error) {
    throw new Error(data.error.message);
  }
  if (!data.result?.content?.[0]?.text) {
    throw new Error('Empty MCP response');
  }
  return JSON.parse(data.result.content[0].text);
}

/** Check if the xiaohongshu-mcp server is reachable. */
export async function isXhsMcpAvailable(): Promise<boolean> {
  try {
    await fetch(XHS_MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 0 }),
      signal: AbortSignal.timeout(5_000),
    });
    return true;
  } catch {
    return false;
  }
}

/** Homepage recommendation feed — different content each call (MCP tool: list_notes). */
export async function listXhsFeed(): Promise<XhsNote[]> {
  const result = await callXhsMcp('list_notes', {});
  return Array.isArray(result) ? result : [];
}

/** Keyword search (MCP tool: search). */
export async function searchXhsNotes(keyword: string): Promise<XhsNote[]> {
  const result = await callXhsMcp('search', { keyword });
  return Array.isArray(result) ? result : [];
}

/** Full note detail with comments (MCP tool: get_feed_detail). */
export async function getXhsNoteDetail(noteId: string, xsecToken: string): Promise<XhsNoteDetail> {
  const result = await callXhsMcp('get_feed_detail', { note_id: noteId, xsec_token: xsecToken });
  return result as XhsNoteDetail;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/xhs-mcp-client.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add skill/scripts/xhs-mcp-client.ts tests/xhs-mcp-client.test.ts
git commit -m "feat(xhs): add xhs-mcp-client with MCP JSON-RPC transport"
```

---

## Chunk 3: XHS Inspiration Collector + Content Planner Integration

### Task 6: Create XHS inspiration prompt template

**Files:**
- Create: `skill/templates/xhs-inspiration-prompt.md`

- [ ] **Step 1: Create the template file**

Create `skill/templates/xhs-inspiration-prompt.md`:

```markdown
你是水瀬的小红书趋势分析助手。根据以下她刷到的小红书内容，提取关键信息。

## 推荐流内容
{feed_data}

## Cosplay 搜索结果
{search_data}

## 高互动笔记详情
{detail_data}

请以 JSON 格式返回：
```json
{
  "feed_highlights": [{"title": "...", "likes": 0, "topic": "..."}],
  "cosplay_notes": [{"title": "...", "likes": 0, "topic": "..."}],
  "trending_topics": ["话题1", "话题2"],
  "cosplay_insights": ["洞察1", "洞察2"],
  "saved_inspirations": [
    {
      "source_note_id": "笔记ID",
      "source_title": "笔记标题",
      "visual_description": "详细的视觉描述：构图方式、穿搭风格、色调、姿势、场景环境（100-200字）",
      "style_tags": ["标签1", "标签2"]
    }
  ]
}
```

注意：
- feed_highlights: 从推荐流中挑选最有趣的 5 条
- cosplay_notes: 从搜索结果中挑选最相关的 5 条
- trending_topics: 当前小红书上的热门话题关键词（5-8个）
- cosplay_insights: 对cos/穿搭创作者有价值的洞察（3-5条）
- saved_inspirations: 只收藏真正有视觉参考价值的笔记（适合cos/穿搭拍照的），不是所有笔记都需要收藏

只返回 JSON。
```

- [ ] **Step 2: Commit**

```bash
git add skill/templates/xhs-inspiration-prompt.md
git commit -m "feat(xhs): add XHS inspiration prompt template"
```

---

### Task 7: Add collectXiaohongshuTrends to inspiration-collector.ts

**Files:**
- Modify: `skill/scripts/inspiration-collector.ts:1-18` (imports + defaults)
- Modify: `skill/scripts/inspiration-collector.ts:20-26` (TTL)
- Modify: `skill/scripts/inspiration-collector.ts:224-250` (refreshInspiration)
- Create: `tests/inspiration-collector.test.ts`

- [ ] **Step 1: Write tests for collectXiaohongshuTrends**

Create `tests/inspiration-collector.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all dependencies before importing
vi.mock('../skill/scripts/xhs-mcp-client', () => ({
  isXhsMcpAvailable: vi.fn(),
  listXhsFeed: vi.fn(),
  searchXhsNotes: vi.fn(),
  getXhsNoteDetail: vi.fn(),
}));

vi.mock('../skill/scripts/llm-client', () => ({
  callLLMJSON: vi.fn(),
}));

vi.mock('../skill/scripts/file-utils', () => ({
  PATHS: {
    inspiration: '/tmp/test-inspiration.json',
    postHistory: '/tmp/test-post-history.json',
    socialMeta: '/tmp/test-social-meta.json',
  },
  readJSON: vi.fn().mockReturnValue({
    instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: 0 },
    acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: 0 },
    visual_trends: { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: 0 },
    self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: 0 },
  }),
  writeJSON: vi.fn(),
  readTemplate: vi.fn().mockReturnValue('template {feed_data} {search_data} {detail_data}'),
}));

vi.mock('../skill/scripts/instagram-bridge-client', () => ({
  callInstagramBridge: vi.fn(),
}));

describe('collectXiaohongshuTrends', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty data when MCP is unavailable', async () => {
    const { isXhsMcpAvailable } = await import('../skill/scripts/xhs-mcp-client');
    (isXhsMcpAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { collectXiaohongshuTrends } = await import('../skill/scripts/inspiration-collector');
    const result = await collectXiaohongshuTrends();
    expect(result.feed_highlights).toEqual([]);
    expect(result.updated_at).toBe(0);
  });

  it('should collect feed + search data and call LLM', async () => {
    const xhsMock = await import('../skill/scripts/xhs-mcp-client');
    (xhsMock.isXhsMcpAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (xhsMock.listXhsFeed as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'n1', xsec_token: 't1', title: 'Feed Post', description: 'desc', likes: 100, user: 'u1', tags: [] },
    ]);
    (xhsMock.searchXhsNotes as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'n2', xsec_token: 't2', title: 'Cos Post', description: 'desc', likes: 200, user: 'u2', tags: ['cos'] },
    ]);

    const { callLLMJSON } = await import('../skill/scripts/llm-client');
    (callLLMJSON as ReturnType<typeof vi.fn>).mockResolvedValue({
      feed_highlights: [{ title: 'Feed Post', likes: 100, topic: 'fashion' }],
      cosplay_notes: [{ title: 'Cos Post', likes: 200, topic: 'cosplay' }],
      trending_topics: ['jk制服'],
      cosplay_insights: ['镜面反射构图很火'],
      saved_inspirations: [],
    });

    const { collectXiaohongshuTrends } = await import('../skill/scripts/inspiration-collector');
    const result = await collectXiaohongshuTrends();
    expect(result.feed_highlights).toHaveLength(1);
    expect(result.trending_topics).toContain('jk制服');
    expect(result.updated_at).toBeGreaterThan(0);
  });

  it('should merge saved_inspirations with existing ones and cap at 20', async () => {
    const xhsMock = await import('../skill/scripts/xhs-mcp-client');
    (xhsMock.isXhsMcpAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (xhsMock.listXhsFeed as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (xhsMock.searchXhsNotes as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { callLLMJSON } = await import('../skill/scripts/llm-client');
    const newInspos = Array.from({ length: 5 }, (_, i) => ({
      source_note_id: `new_${i}`,
      source_title: `New ${i}`,
      visual_description: `Description ${i}`,
      style_tags: ['tag'],
      saved_at: Date.now(),
    }));
    (callLLMJSON as ReturnType<typeof vi.fn>).mockResolvedValue({
      feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [],
      saved_inspirations: newInspos,
    });

    // Mock existing inspiration with 18 saved items
    const { readJSON } = await import('../skill/scripts/file-utils');
    const existingInspos = Array.from({ length: 18 }, (_, i) => ({
      source_note_id: `old_${i}`,
      source_title: `Old ${i}`,
      visual_description: `Old desc ${i}`,
      style_tags: ['old'],
      saved_at: Date.now() - 100000,
    }));
    (readJSON as ReturnType<typeof vi.fn>).mockReturnValue({
      instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: 0 },
      acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: 0 },
      visual_trends: { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: 0 },
      self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: 0 },
      xiaohongshu_trends: {
        feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [],
        saved_inspirations: existingInspos, updated_at: 0,
      },
    });

    const { collectXiaohongshuTrends } = await import('../skill/scripts/inspiration-collector');
    const result = await collectXiaohongshuTrends();
    // 18 existing + 5 new = 23, capped at 20, oldest removed
    expect(result.saved_inspirations.length).toBeLessThanOrEqual(20);
    // Should contain the new items (most recent)
    expect(result.saved_inspirations.some(s => s.source_note_id === 'new_0')).toBe(true);
  });

  it('should prefer new entries over old ones with same source_note_id', async () => {
    const xhsMock = await import('../skill/scripts/xhs-mcp-client');
    (xhsMock.isXhsMcpAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (xhsMock.listXhsFeed as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (xhsMock.searchXhsNotes as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { callLLMJSON } = await import('../skill/scripts/llm-client');
    (callLLMJSON as ReturnType<typeof vi.fn>).mockResolvedValue({
      feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [],
      saved_inspirations: [{
        source_note_id: 'overlap_1',
        source_title: 'Updated Title',
        visual_description: 'New description with better detail',
        style_tags: ['updated'],
      }],
    });

    const { readJSON } = await import('../skill/scripts/file-utils');
    (readJSON as ReturnType<typeof vi.fn>).mockReturnValue({
      instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: 0 },
      acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: 0 },
      visual_trends: { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: 0 },
      self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: 0 },
      xiaohongshu_trends: {
        feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [],
        saved_inspirations: [{
          source_note_id: 'overlap_1',
          source_title: 'Old Title',
          visual_description: 'Old description',
          style_tags: ['old'],
          saved_at: Date.now() - 100000,
        }],
        updated_at: 0,
      },
    });

    const { collectXiaohongshuTrends } = await import('../skill/scripts/inspiration-collector');
    const result = await collectXiaohongshuTrends();
    // Should have exactly 1 entry (not 2) — new replaces old
    const overlapping = result.saved_inspirations.filter(s => s.source_note_id === 'overlap_1');
    expect(overlapping).toHaveLength(1);
    expect(overlapping[0].visual_description).toBe('New description with better detail');
    expect(overlapping[0].style_tags).toEqual(['updated']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/inspiration-collector.test.ts`
Expected: FAIL — `collectXiaohongshuTrends` not found in exports.

- [ ] **Step 3: Add imports and DEFAULT_INSPIRATION update to inspiration-collector.ts**

In `skill/scripts/inspiration-collector.ts`, add after the existing imports (line 4):

```typescript
import { isXhsMcpAvailable, listXhsFeed, searchXhsNotes, getXhsNoteDetail } from './xhs-mcp-client';
```

Update `DEFAULT_INSPIRATION` (line 13) to add the new field:

```typescript
const DEFAULT_INSPIRATION: InspirationData = {
  instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: 0 },
  acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: 0 },
  visual_trends: { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: 0 },
  self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: 0 },
  xiaohongshu_trends: { feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [], saved_inspirations: [], updated_at: 0 },
};
```

Add to TTL (line 22):

```typescript
const TTL = {
  instagram_trends: 24 * 60 * 60 * 1000,
  acg_hotspots: 24 * 60 * 60 * 1000,
  visual_trends: 72 * 60 * 60 * 1000,
  self_performance: 168 * 60 * 60 * 1000,
  xiaohongshu_trends: 6 * 60 * 60 * 1000,    // 6h — enables 2-4 refreshes/day
} as const;
```

- [ ] **Step 4: Implement collectXiaohongshuTrends**

Add before `refreshInspiration()`:

```typescript
/**
 * 2e: XiaoHongShu feed + search trends via xiaohongshu-mcp.
 * Browses recommendation feed and searches cos-specific content.
 * Also extracts visual inspiration descriptions for future photo shoots.
 */
export async function collectXiaohongshuTrends(): Promise<NonNullable<InspirationData['xiaohongshu_trends']>> {
  const empty: NonNullable<InspirationData['xiaohongshu_trends']> = {
    feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [],
    saved_inspirations: [], updated_at: 0,
  };

  const available = await isXhsMcpAvailable();
  if (!available) {
    console.warn('XHS MCP server not available, skipping XiaoHongShu trends.');
    return empty;
  }

  // Collect feed and search results
  let feedNotes: Awaited<ReturnType<typeof listXhsFeed>> = [];
  let searchNotes: Awaited<ReturnType<typeof searchXhsNotes>> = [];

  try {
    feedNotes = await listXhsFeed();
  } catch (err) {
    console.warn(`XHS feed fetch failed: ${(err as Error).message}`);
  }

  try {
    searchNotes = await searchXhsNotes('cosplay');
  } catch (err) {
    console.warn(`XHS search failed: ${(err as Error).message}`);
  }

  if (feedNotes.length === 0 && searchNotes.length === 0) {
    return { ...empty, updated_at: Date.now() };
  }

  // Fetch details for top 3 high-engagement notes
  const allNotes = [...feedNotes, ...searchNotes]
    .filter((note, idx, arr) => arr.findIndex(n => n.id === note.id) === idx)
    .sort((a, b) => b.likes - a.likes);
  const topNotes = allNotes.filter(n => n.likes > 500).slice(0, 3);

  const details: string[] = [];
  for (const note of topNotes) {
    try {
      const detail = await getXhsNoteDetail(note.id, note.xsec_token);
      const commentSummary = detail.comments.slice(0, 3).map(c => `  - ${c.user}: ${c.content}`).join('\n');
      details.push(`标题: ${detail.title}\n描述: ${detail.description}\n点赞: ${detail.likes}\n评论:\n${commentSummary}`);
    } catch (err) {
      console.warn(`XHS detail fetch failed for ${note.id}: ${(err as Error).message}`);
    }
  }

  // Format raw data for LLM
  const feedText = feedNotes.slice(0, 10).map(n => `- ${n.title} (❤️${n.likes}) [${n.tags.join(', ')}]`).join('\n') || '无数据';
  const searchText = searchNotes.slice(0, 10).map(n => `- ${n.title} (❤️${n.likes}) [${n.tags.join(', ')}]`).join('\n') || '无数据';
  const detailText = details.join('\n---\n') || '无高互动笔记';

  const template = readTemplate('xhs-inspiration-prompt.md');
  const prompt = template
    .replace('{feed_data}', feedText)
    .replace('{search_data}', searchText)
    .replace('{detail_data}', detailText);

  try {
    const result = await callLLMJSON<{
      feed_highlights: Array<{ title: string; likes: number; topic: string }>;
      cosplay_notes: Array<{ title: string; likes: number; topic: string }>;
      trending_topics: string[];
      cosplay_insights: string[];
      saved_inspirations: Array<{
        source_note_id: string;
        source_title: string;
        visual_description: string;
        style_tags: string[];
      }>;
    }>(prompt, 1024);

    // Merge saved_inspirations with existing (persists across refreshes)
    const current = readJSON<InspirationData>(PATHS.inspiration, DEFAULT_INSPIRATION);
    const existingInspos = current.xiaohongshu_trends?.saved_inspirations ?? [];
    const newInspos = (result.saved_inspirations ?? []).map(s => ({
      ...s,
      saved_at: Date.now(),
    }));
    // Prefer new entries over old when source_note_id collides
    const newIds = new Set(newInspos.map(s => s.source_note_id));
    const filteredExisting = existingInspos.filter(s => !newIds.has(s.source_note_id));
    const merged = [...filteredExisting, ...newInspos].slice(-20);

    return {
      feed_highlights: result.feed_highlights ?? [],
      cosplay_notes: result.cosplay_notes ?? [],
      trending_topics: result.trending_topics ?? [],
      cosplay_insights: result.cosplay_insights ?? [],
      saved_inspirations: merged,
      updated_at: Date.now(),
    };
  } catch (err) {
    console.error(`XHS LLM summarization failed: ${(err as Error).message}`);
    return { ...empty, updated_at: Date.now() };
  }
}
```

- [ ] **Step 5: Add XHS block to refreshInspiration**

In `refreshInspiration()`, after the `self_performance` block (currently around line 246), add:

```typescript
  if (forceAll || isExpired(current.xiaohongshu_trends?.updated_at ?? 0, TTL.xiaohongshu_trends)) {
    console.log('Refreshing XiaoHongShu trends...');
    updated = { ...updated, xiaohongshu_trends: await collectXiaohongshuTrends() };
  }
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/inspiration-collector.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 7: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add skill/scripts/inspiration-collector.ts tests/inspiration-collector.test.ts
git commit -m "feat(xhs): add collectXiaohongshuTrends with inspiration saving"
```

---

### Task 8: Update content-planner.ts and photo-intent-prompt.md

**Files:**
- Modify: `skill/scripts/content-planner.ts:18-23` (DEFAULT_INSPIRATION)
- Modify: `skill/scripts/content-planner.ts:128-141` (planPhoto template chain)
- Modify: `skill/templates/photo-intent-prompt.md`

- [ ] **Step 1: Update DEFAULT_INSPIRATION in content-planner.ts**

In `skill/scripts/content-planner.ts`, update `DEFAULT_INSPIRATION` (line 18) to add:

```typescript
const DEFAULT_INSPIRATION: InspirationData = {
  instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: 0 },
  acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: 0 },
  visual_trends: { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: 0 },
  self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: 0 },
  xiaohongshu_trends: { feed_highlights: [], cosplay_notes: [], trending_topics: [], cosplay_insights: [], saved_inspirations: [], updated_at: 0 },
};
```

- [ ] **Step 2: Add XHS data injection in planPhoto()**

In `planPhoto()`, before the existing `.replace('{current_time}', ...)` chain (line 129), add the XHS data extraction:

```typescript
  const xhsTrends = inspiration.xiaohongshu_trends?.trending_topics?.join('、') || '没有最新数据';
  const xhsCosInsights = inspiration.xiaohongshu_trends?.cosplay_insights?.join('、') || '没有最新数据';
  const savedInspo = inspiration.xiaohongshu_trends?.saved_inspirations?.slice(-5) ?? [];
  const inspoText = savedInspo.length > 0
    ? savedInspo.map(s => `- ${s.visual_description} (${s.style_tags.join(', ')})`).join('\n')
    : '没有收藏的灵感图';
```

Then append three new `.replace()` calls at the end of the chain (after `.replace('{target_ratios}', formatTargetRatios())`):

```typescript
    .replace('{xhs_trends}', xhsTrends)
    .replace('{xhs_cosplay_insights}', xhsCosInsights)
    .replace('{saved_inspirations}', inspoText);
```

- [ ] **Step 3: Update photo-intent-prompt.md**

Replace the full content of `skill/templates/photo-intent-prompt.md` with:

```markdown
你是水瀬，一个18岁的coser，辣妹系风格。

## 现在的状态
- 时间: {current_time}
- 心情: {mood}
- 正在做: {activity}

## 最近的灵感
- ins上热门: {instagram_trends}
- 当季热门角色: {trending_characters}
- 视觉灵感: {visual_trends}
- 小红书热门话题: {xhs_trends}
- 小红书cos洞察: {xhs_cosplay_insights}
- 你过去拍的照片里 {best_style} 类反响最好

## 收藏的灵感图（小红书上看到的好图）
{saved_inspirations}

## 最近发过的类型
{recent_styles}

## 目标比例
{target_ratios}

你现在想拍照吗？如果想拍，描述一下你想要的画面。

以 JSON 格式返回：
```json
{
  "wantToShoot": true/false,
  "sceneDescription": "你想拍的画面描述（用你自己的话，口语化）",
  "style": "cos/daily/behind_scenes/travel",
  "mood": "当前心情",
  "reason": "为什么想/不想拍（写入日记的内心独白，用你的语气）"
}
```

只返回 JSON。
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Run existing content-planner tests**

Run: `npx vitest run tests/content-planner.test.ts`
Expected: PASS (existing tests should still pass — they don't touch `planPhoto()`).

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`
Expected: PASS (all test files)

- [ ] **Step 7: Commit**

```bash
git add skill/scripts/content-planner.ts skill/templates/photo-intent-prompt.md
git commit -m "feat(xhs): inject XHS trends and saved inspirations into photo planning"
```

---

### Task 9: Final typecheck, full test run, and documentation update

**Files:**
- Modify: `.claude/CLAUDE.md` (environment variables)

- [ ] **Step 1: Run full typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS.

- [ ] **Step 3: Add XHS_MCP_URL to CLAUDE.md environment variables**

In `.claude/CLAUDE.md`, find the `Environment variables` line and add `XHS_MCP_URL` (optional, defaults to `http://localhost:18060/mcp`):

Current text:
```
- **Environment variables:** `AIHUBMIX_API_KEY` (image gen), `IMGURL_TOKEN` (image hosting), `INSTAGRAM_USERNAME`/`INSTAGRAM_PASSWORD`/`INSTAGRAM_TOTP_SECRET` (posting via instagrapi), `ANTHROPIC_API_KEY` (reflection).
```

Updated text:
```
- **Environment variables:** `AIHUBMIX_API_KEY` (image gen), `IMGURL_TOKEN` (image hosting), `INSTAGRAM_USERNAME`/`INSTAGRAM_PASSWORD`/`INSTAGRAM_TOTP_SECRET` (posting via instagrapi), `ANTHROPIC_API_KEY` (reflection), `XHS_MCP_URL` (XiaoHongShu MCP endpoint, default: `http://localhost:18060/mcp`).
```

- [ ] **Step 4: Commit**

```bash
git add .claude/CLAUDE.md
git commit -m "docs: add XHS_MCP_URL to environment variables"
```
