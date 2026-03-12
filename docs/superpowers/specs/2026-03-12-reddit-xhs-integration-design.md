# Reddit Enhancement + XiaoHongShu Integration Design

**Date:** 2026-03-12
**Status:** Draft
**Scope:** Read-only external content integration for Minase's "browsing" behavior

## Goal

Connect Minase to real Reddit post bodies/comments and XiaoHongShu recommendation feeds, replacing the current title-only Reddit scraping and non-existent XHS integration. This gives Minase genuine, varying daily input from two major content platforms.

## Background

Current state:
- **Instagram**: Working (instagrapi Python bridge)
- **Reddit**: Limited — `fetch-trends.ts` fetches only post titles via public `.json` endpoints
- **XiaoHongShu**: Data structures exist (`SocialMeta.xiaohongshu_following`) but zero implementation

Target state:
- **Reddit**: Post titles + selftext (body) + top comments for high-engagement posts
- **XiaoHongShu**: Algorithm-recommended feed + keyword search via xiaohongshu-mcp

## Architecture Overview

```
                    External Services
                    ─────────────────
  Reddit public JSON API         xiaohongshu-mcp (Go binary, :18060)
        │                                │
        │ HTTP GET .json                 │ MCP JSON-RPC over HTTP
        │                                │
                    Minase Scripts
                    ──────────────
  fetch-trends.ts (enhanced)     xhs-mcp-client.ts (new)
        │                                │
        ▼                                ▼
    world.md                     inspiration-collector.ts
                                         │
                                         ▼
                                   inspiration.json
                                         │
                                    ┌────┴────┐
                              content-planner  heartbeat-tick
                              (photo/post      (browsing triggers
                               decisions)       refreshInspiration)
```

Two independent subsystems that share no code:
1. **Reddit enhancement** — changes only `fetch-trends.ts`, writes to `world.md`
2. **XHS integration** — new `xhs-mcp-client.ts`, changes to `inspiration-collector.ts`, `types.ts`, `content-planner.ts`

---

## Subsystem 1: Reddit Enhancement

### Scope

Upgrade `fetch-trends.ts` to fetch richer data from the same public `.json` endpoints. No new dependencies, no API keys, no new files.

**Note:** `fetch-trends.ts` currently defines its own `MEMORY_BASE` and `WORLD_PATH` constants independently of `file-utils.ts`. Keep this standalone approach — this script is designed to run independently without importing the shared module.

### Data Flow

```
r/cosplay/top.json?t=week&limit=5
r/Animecosplay/top.json?t=week&limit=5
        │
        ▼
  For top 3 posts (by score):
    GET r/{sub}/comments/{id}.json
        │
        ▼
  Extract: title, score, selftext (first 200 chars), top 3 comments (by score)
        │
        ▼
  Append to world.md
```

### Changes to fetch-trends.ts

**Interface updates:**

```typescript
interface RedditPost {
  data: {
    title: string;
    score: number;
    url: string;
    selftext: string;       // NEW: post body text
    permalink: string;       // NEW: for comment fetching
    num_comments: number;    // NEW: to decide if worth fetching comments
    id: string;              // NEW: post id
    subreddit: string;       // NEW: for display
  };
}

interface RedditComment {
  data: {
    body: string;
    score: number;
    author: string;
  };
}
```

**New function — fetchPostComments:**

```typescript
async function fetchPostComments(permalink: string, limit: number): Promise<RedditComment[]>
```

- GET `https://www.reddit.com{permalink}.json?limit={limit}&sort=top`
- Response is an array of two listings: `[post, comments]`
- Extract from `[1].data.children` where `kind === 't1'`
- Filter: `score > 10`, take top `limit` by score
- Timeout: 10 seconds per request

**New function — delay:**

```typescript
function delay(ms: number): Promise<void>
```

1-second delay between comment fetches to respect rate limits.

**Enhanced fetchRedditTrends:**

Returns enriched post objects instead of bare title strings:

```typescript
interface TrendPost {
  title: string;
  score: number;
  selftext: string;        // truncated to 200 chars
  subreddit: string;
  topComments: string[];   // top 3 comment bodies, truncated to 150 chars each
}

async function fetchRedditTrends(url: string): Promise<TrendPost[]>
```

**Enhanced output format (world.md):**

```markdown
## 2026-03-12 趋势观察

### r/cosplay
1. **[标题]** (↑1234)
   > 正文摘要前200字...
   - 热评: "评论内容前150字..." (↑567)
   - 热评: "评论内容..." (↑234)

2. **[标题]** (↑890)
   - 纯图片帖，无正文
```

**Rate limiting:**

- 1-second delay between comment fetches
- Only fetch comments for top 3 posts per subreddit (max 6 comment requests per run)
- Total requests per run: 2 (listings) + up to 6 (comments) = 8, well within ~10 req/min limit

**Error handling:**

- Comment fetch failure → fall back to title-only for that post (log warning)
- Entire subreddit fetch failure → skip that subreddit (existing behavior)
- Network timeout → 10 seconds per request

### Files Changed

| File | Change |
|------|--------|
| `skill/scripts/fetch-trends.ts` | Enhanced interfaces, new `fetchPostComments()`, richer output format |

---

## Subsystem 2: XiaoHongShu Integration

### External Dependency: xiaohongshu-mcp

**What:** Go-compiled MCP server binary from [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) (11.4k stars)

**Installation (manual, per-machine):**
- macOS arm64: download `xiaohongshu-mcp-darwin-arm64.tar.gz` from GitHub Releases
- Linux x86_64: download `xiaohongshu-mcp-linux-amd64.tar.gz` from GitHub Releases
- Extract binary, run login tool once (manual QR code scan)
- Start MCP server on port 18060

**mcporter config (already exists):**
```json
{ "xiaohongshu": { "baseUrl": "http://localhost:18060/mcp" } }
```

**Runtime requirement:** headless Chrome (~150MB, auto-downloaded on first run)

**MCP tools used (read-only subset):**

| Tool | Purpose | Parameters |
|------|---------|------------|
| `list_notes` | Homepage recommendation feed | none |
| `search` | Keyword search | `keyword: string` |
| `get_feed_detail` | Note detail + comments | `note_id: string, xsec_token: string` |

### New File: xhs-mcp-client.ts

Thin MCP JSON-RPC 2.0 client over HTTP. Follows the same organizational principle as `instagram-bridge-client.ts` — a focused client module that other scripts import — but uses HTTP JSON-RPC instead of subprocess execution.

**Constants:**

```typescript
const XHS_MCP_URL = process.env.XHS_MCP_URL ?? 'http://localhost:18060/mcp';
const XHS_MCP_TIMEOUT = 30_000; // 30s
```

**Core function:**

```typescript
async function callXhsMcp(toolName: string, args: Record<string, unknown>): Promise<unknown>
```

- POST to `XHS_MCP_URL` with JSON-RPC 2.0 body: `{ jsonrpc: "2.0", method: "tools/call", params: { name: toolName, arguments: args }, id: counter++ }`
- Parse response, extract `result.content[0].text` (MCP standard response format)
- Throw on error or timeout

**Exported functions:**

```typescript
// Homepage recommendation feed — different content each call (MCP tool: list_notes)
export async function listXhsFeed(): Promise<XhsNote[]>

// Keyword search (MCP tool: search)
export async function searchXhsNotes(keyword: string): Promise<XhsNote[]>

// Full note detail with comments (MCP tool: get_feed_detail)
export async function getXhsNoteDetail(noteId: string, xsecToken: string): Promise<XhsNoteDetail>

// Health check — is the MCP server reachable?
export async function isXhsMcpAvailable(): Promise<boolean>
```

**Note on XhsNote/XhsNoteDetail field names:** The interface field names above are the *desired* shape after normalization. The actual MCP response may use different field names (e.g., `note_id` vs `id`, `like_count` vs `likes`). Each exported function is responsible for mapping MCP response fields to these normalized interfaces. The implementer should verify field names against the actual MCP binary response during development.

**Types (defined in this file, not in types.ts — they're MCP response shapes, not domain types):**

```typescript
interface XhsNote {
  id: string;
  xsec_token: string;
  title: string;
  description: string;
  likes: number;
  user: string;
  tags: string[];
}

interface XhsNoteDetail extends XhsNote {
  comments: Array<{ user: string; content: string; likes: number }>;
  images: string[];
  collected_count: number;
  share_count: number;
}
```

**Graceful degradation:** If MCP server is unreachable (port 18060 not open), `isXhsMcpAvailable()` returns false, and all data functions throw. The caller (`inspiration-collector.ts`) handles this by returning empty data — never blocking other collectors.

### Changes to types.ts

Add `xiaohongshu_trends` as an **optional** field on `InspirationData`. This ensures backward compatibility — existing `inspiration.json` files without this field will not cause runtime errors:

```typescript
export interface InspirationData {
  // ... existing fields ...
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
}
```

### Changes to inspiration-collector.ts

**New import:**

```typescript
import { isXhsMcpAvailable, listXhsFeed, searchXhsNotes, getXhsNoteDetail } from './xhs-mcp-client';
```

**New TTL entry:**

```typescript
const TTL = {
  // ... existing ...
  xiaohongshu_trends: 6 * 60 * 60 * 1000,  // 6h — enables 2-4 refreshes/day
};
```

**New DEFAULT_INSPIRATION field (in BOTH `inspiration-collector.ts` and `content-planner.ts`):**

Both files have their own `DEFAULT_INSPIRATION` constant. Add the same field to both:

```typescript
xiaohongshu_trends: {
  feed_highlights: [],
  cosplay_notes: [],
  trending_topics: [],
  cosplay_insights: [],
  saved_inspirations: [],
  updated_at: 0,
}
```

**New function — collectXiaohongshuTrends:**

```typescript
async function collectXiaohongshuTrends(): Promise<InspirationData['xiaohongshu_trends']>
```

Flow:
1. Check `isXhsMcpAvailable()` — if false, return empty data immediately
2. Call `listXhsFeed()` — get recommendation feed (~10-20 notes)
3. Call `searchXhsNotes('cosplay')` — get cos-specific notes
4. For top 3 high-engagement notes (likes > 500 from combined results), call `getXhsNoteDetail()` to get full content + comments
5. Combine raw data into a text block
6. Call `callLLMJSON()` with the `xhs-inspiration-prompt.md` template to extract structured trends + saved inspirations
7. Merge new `saved_inspirations` with existing ones (from previous refreshes), cap at 20, oldest first
8. Return `{ feed_highlights, cosplay_notes, trending_topics, cosplay_insights, saved_inspirations, updated_at }`

**Saved inspirations merge logic (step 7):**
```typescript
const existing = current.xiaohongshu_trends?.saved_inspirations ?? [];
const newInspos = llmResult.saved_inspirations ?? [];
// Deduplicate by source_note_id, then cap at 20
const merged = [...existing, ...newInspos]
  .filter((item, idx, arr) => arr.findIndex(x => x.source_note_id === item.source_note_id) === idx)
  .slice(-20);  // keep most recent 20
```

**Error handling in collectXiaohongshuTrends:**
- MCP unavailable → return empty data with `updated_at: 0` (will retry next tick)
- Individual API call fails → continue with partial data
- LLM summarization fails → return raw data without insights

**Integration into refreshInspiration:**

Add a new block after the existing 4 collectors (use optional chaining for backward compatibility with existing `inspiration.json` files):

```typescript
if (forceAll || isExpired(current.xiaohongshu_trends?.updated_at ?? 0, TTL.xiaohongshu_trends)) {
  console.log('Refreshing XiaoHongShu trends...');
  updated = { ...updated, xiaohongshu_trends: await collectXiaohongshuTrends() };
}
```

### New Template: xhs-inspiration-prompt.md

Located at `skill/templates/xhs-inspiration-prompt.md`.

Prompt for LLM to summarize raw XHS data into structured trends. Similar structure to existing `inspiration-summary-prompt.md`.

```markdown
你是水瀬的小红书趋势分析助手。根据以下她刷到的小红书内容，提取关键信息。

## 推荐流内容
{feed_data}

## Cosplay 搜索结果
{search_data}

## 高互动笔记详情
{detail_data}

请以 JSON 格式返回：
{
  "feed_highlights": [{"title": "...", "likes": 0, "topic": "..."}],
  "cosplay_notes": [{"title": "...", "likes": 0, "topic": "..."}],
  "trending_topics": ["话题1", "话题2", ...],
  "cosplay_insights": ["洞察1", "洞察2", ...],
  "saved_inspirations": [
    {
      "source_note_id": "笔记ID",
      "source_title": "笔记标题",
      "visual_description": "详细的视觉描述：构图方式、穿搭风格、色调、姿势、场景环境（100-200字）",
      "style_tags": ["标签1", "标签2"]
    }
  ]
}

saved_inspirations 只收藏真正有视觉参考价值的笔记（适合cos/穿搭拍照的），不是所有笔记都需要收藏。
只返回 JSON。
```

### Changes to content-planner.ts

**1. Add `xiaohongshu_trends` to `DEFAULT_INSPIRATION`** (see above).

**2. In `planPhoto()`, inject XHS trends and saved inspirations into the prompt context:**

```typescript
const xhsTrends = inspiration.xiaohongshu_trends?.trending_topics?.join('、') || '没有最新数据';
const xhsCosInsights = inspiration.xiaohongshu_trends?.cosplay_insights?.join('、') || '没有最新数据';
const savedInspo = inspiration.xiaohongshu_trends?.saved_inspirations?.slice(-5) ?? [];
const inspoText = savedInspo.length > 0
  ? savedInspo.map(s => `- ${s.visual_description} (${s.style_tags.join(', ')})`).join('\n')
  : '没有收藏的灵感图';
```

Add three new `.replace()` calls at the end of the existing chain (after `.replace('{target_ratios}', formatTargetRatios())`):

```typescript
    .replace('{xhs_trends}', xhsTrends)
    .replace('{xhs_cosplay_insights}', xhsCosInsights)
    .replace('{saved_inspirations}', inspoText);
```

### Changes to photo-intent-prompt.md

Add XHS trend lines to the `## 最近的灵感` section, after the `{visual_trends}` line:

```markdown
- 小红书热门话题: {xhs_trends}
- 小红书cos洞察: {xhs_cosplay_insights}
```

Add a new section after `## 最近的灵感`, before `## 最近发过的类型`:

```markdown
## 收藏的灵感图（小红书上看到的好图）
{saved_inspirations}
```

The full `## 最近的灵感` section becomes:
```markdown
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
```

### Files Changed

| File | Change |
|------|--------|
| `skill/scripts/xhs-mcp-client.ts` | **NEW** — MCP client for xiaohongshu-mcp |
| `skill/scripts/types.ts` | Add `xiaohongshu_trends` to `InspirationData` |
| `skill/scripts/inspiration-collector.ts` | Add `collectXiaohongshuTrends()`, 6h TTL, integration in `refreshInspiration()` |
| `skill/scripts/content-planner.ts` | Inject XHS trends into `planPhoto()` prompt |
| `skill/templates/xhs-inspiration-prompt.md` | **NEW** — LLM prompt for XHS trend extraction |
| `skill/templates/photo-intent-prompt.md` | Add XHS trend placeholders |

---

## Integration Points

### heartbeat-tick.ts (no changes needed)

The existing logic at line 323:
```typescript
if (action.action.includes('刷') || action.action.includes('看手机') || action.action.includes('窥屏')) {
  const { refreshInspiration } = await import('./inspiration-collector');
  await refreshInspiration();
}
```

This already calls `refreshInspiration()`, which will now include `collectXiaohongshuTrends()`. Every time Minase "scrolls her phone", she'll get fresh XHS recommendations. With 6h TTL, she gets genuinely different content 2-4 times per day.

### world.md vs inspiration.json

- **Reddit data → world.md** (markdown, read by morning-plan and heartbeat-tick as raw text context)
- **XHS data → inspiration.json** (structured JSON, read by content-planner and heartbeat-tick via `refreshInspiration()`)

This follows the existing separation: `world.md` is "what Minase observes about the world", `inspiration.json` is "structured creative input for content decisions".

### Inspiration Image Saving ("收藏好图")

When Minase browses XHS and encounters visually appealing notes (high engagement + images), the system extracts a structured visual description and saves it as a "saved inspiration" for future photo shoots.

**Trigger:** During `collectXiaohongshuTrends()`, when fetching `getXhsNoteDetail()` for high-engagement notes (step 4 in the collection flow), the system also evaluates whether the note's visual content is useful as photo reference.

**What gets saved:**

A new `saved_inspirations` array in `InspirationData.xiaohongshu_trends`:

```typescript
xiaohongshu_trends?: {
  // ... existing fields ...
  saved_inspirations: Array<{
    source_note_id: string;
    source_title: string;
    visual_description: string;  // LLM-extracted: composition, outfit, color palette, pose, setting
    style_tags: string[];         // e.g. ['jk制服', '镜面反射', '暖色调']
    saved_at: number;
  }>;
};
```

**How the LLM extracts visual descriptions:**

The `xhs-inspiration-prompt.md` template includes an additional instruction block:

```markdown
## 灵感图片收藏

对于以下高互动笔记，如果图片内容适合用作拍照参考（好看的穿搭/构图/场景），请提取视觉描述。

{detail_data}

在 JSON 结果中额外返回：
"saved_inspirations": [
  {
    "source_note_id": "笔记ID",
    "source_title": "笔记标题",
    "visual_description": "详细的视觉描述：构图方式、穿搭风格、色调、姿势、场景环境（100-200字）",
    "style_tags": ["标签1", "标签2", ...]
  }
]

只收藏真正有视觉参考价值的笔记（适合cos/穿搭拍照的），不是所有笔记都需要收藏。
```

**How it feeds into photo generation:**

In `content-planner.ts`'s `planPhoto()`, the saved inspirations are injected as additional context:

```typescript
const savedInspo = inspiration.xiaohongshu_trends?.saved_inspirations?.slice(-5) ?? [];
const inspoText = savedInspo.length > 0
  ? savedInspo.map(s => `- ${s.visual_description} (${s.style_tags.join(', ')})`).join('\n')
  : '没有收藏的灵感图';
```

Add `{saved_inspirations}` placeholder to `photo-intent-prompt.md`:

```markdown
## 收藏的灵感图（小红书上看到的好图）
{saved_inspirations}
```

This is inserted after the `## 最近的灵感` section, before `## 最近发过的类型`. When Minase's `planPhoto()` runs, the LLM sees these visual descriptions and can use them to craft a `sceneDescription` that references a saved inspiration (e.g., "想试试那个JK制服镜面反射的构图").

**Retention:** `saved_inspirations` accumulates over multiple refreshes. Cap at 20 entries; when exceeding, remove oldest first. The 6h TTL on `xiaohongshu_trends` does not clear `saved_inspirations` — they persist across refreshes and only get pruned by the cap.

**Key point:** No actual images are downloaded. Only text descriptions are stored. The visual description is rich enough for `generate-image.ts` to understand the desired composition/style through the prompt, while the existing `referenceImagePath` (Minase's reference photo) continues to ensure character consistency.

---

## Testing Strategy

### Reddit Enhancement

- Unit test `fetchPostComments()` with mocked Reddit JSON responses
- Unit test the output formatting (markdown generation)
- Integration test: mock HTTP responses, verify `world.md` output format

### XHS Integration

- Unit test `callXhsMcp()` with mocked HTTP responses
- Unit test `collectXiaohongshuTrends()` with mocked MCP client
- Test graceful degradation: MCP unavailable → empty data, no crash
- Test partial failure: feed succeeds, search fails → partial data returned
- Integration test: verify `inspiration.json` contains `xiaohongshu_trends` after refresh

### Manual Verification

- Run `fetch-trends.ts` and check `world.md` has rich post content
- Start xiaohongshu-mcp, run `inspiration-collector.ts --force`, check `inspiration.json` has XHS data
- Trigger heartbeat with browsing action, verify XHS data refreshes

---

## Constraints & Risks

| Risk | Mitigation |
|------|------------|
| Reddit rate limiting (429) | 1s delay between requests, max 8 requests per run |
| Reddit JSON endpoint deprecation | Low risk — has been stable for years; if it breaks, fails gracefully |
| XHS MCP server not running | `isXhsMcpAvailable()` check; empty data fallback; other collectors unaffected |
| XHS Cookie expiration | Manual re-login required; logs clear warning when auth fails |
| XHS content policy changes | MCP server community (11.4k stars) tracks changes; binary updates via GitHub Releases |
| XHS rate limiting by platform | xiaohongshu-mcp handles internal rate limiting; `collectXiaohongshuTrends` runs at most once per 6h TTL |
| Headless Chrome on Linux server | Auto-downloaded by xiaohongshu-mcp binary; may need system libs (`apt install libgbm1 libnss3`) |

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `XHS_MCP_URL` | `http://localhost:18060/mcp` | xiaohongshu-mcp server endpoint |

Add `XHS_MCP_URL` to the environment variables documentation in `CLAUDE.md`.

---

## Out of Scope

- XHS publishing/interaction (write operations)
- Reddit API OAuth2 authentication
- Reddit MCP server integration
- New subreddit sources for fetch-trends.ts (keep existing cosplay subs)
- xiaohongshu-mcp installation automation (manual per-machine setup)

---

## Summary: All Files Changed

| File | Subsystem | Change |
|------|-----------|--------|
| `skill/scripts/fetch-trends.ts` | Reddit | Enhanced interfaces, new `fetchPostComments()`, richer markdown output |
| `skill/scripts/xhs-mcp-client.ts` | XHS | **NEW** — MCP JSON-RPC client for xiaohongshu-mcp |
| `skill/scripts/types.ts` | XHS | Add optional `xiaohongshu_trends` (with `saved_inspirations`) to `InspirationData` |
| `skill/scripts/inspiration-collector.ts` | XHS | New import, `collectXiaohongshuTrends()` with inspiration saving + merge, 6h TTL, `DEFAULT_INSPIRATION` update |
| `skill/scripts/content-planner.ts` | XHS | `DEFAULT_INSPIRATION` update, inject XHS trends + saved inspirations into `planPhoto()` prompt |
| `skill/templates/xhs-inspiration-prompt.md` | XHS | **NEW** — LLM prompt for XHS trend extraction + inspiration saving |
| `skill/templates/photo-intent-prompt.md` | XHS | Add `{xhs_trends}`, `{xhs_cosplay_insights}`, `{saved_inspirations}` placeholders |
