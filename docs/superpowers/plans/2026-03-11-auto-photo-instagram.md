# Auto-Photo & Instagram Sharing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Minase to autonomously take photos and share them on Instagram, driven by inspiration and mood through the heartbeat system.

**Architecture:** Four new TypeScript scripts (generate-image, inspiration-collector, content-planner, post-pipeline) integrated via heartbeat-tick's real action system. Image generation uses AIHubMix Gemini API directly via fetch. Content decisions combine rule-based filtering with LLM-driven creative planning.

**Tech Stack:** TypeScript (ES2022/CommonJS), AIHubMix API (Gemini), Instagram Graph API, fal.ai (CDN upload), Anthropic Claude (LLM decisions)

**Spec:** `docs/superpowers/specs/2026-03-11-auto-photo-instagram-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `skill/scripts/types.ts` | Modify | Add ContentStyle, PostRecord, PostHistory, InspirationData, PhotoIntent, PostIntent types |
| `skill/scripts/file-utils.ts` | Modify | Add 4 new PATHS entries |
| `skill/scripts/generate-image.ts` | Create | AIHubMix API call, buildImagePrompt(), quality check |
| `skill/scripts/inspiration-collector.ts` | Create | 4-source inspiration gathering |
| `skill/scripts/content-planner.ts` | Create | Rule + LLM content decision engine |
| `skill/scripts/post-pipeline.ts` | Create | Orchestrate full photo→post flow |
| `skill/scripts/heartbeat-tick.ts` | Modify | Add real action handler for post-pipeline |
| `skill/templates/photo-intent-prompt.md` | Create | LLM prompt for photo decision |
| `skill/templates/post-intent-prompt.md` | Create | LLM prompt for post decision |
| `skill/templates/inspiration-summary-prompt.md` | Create | LLM prompt for trend summarization |
| `bin/cli.js` | Modify | Initialize photo-roll/, inspiration.json, post-history.json |
| `skill/instagram.md` | Modify | Add hashtag list for inspiration collector |

---

## Chunk 1: Foundation — Types, PATHS, and Installer

### Task 1: Add shared types to types.ts

**Files:**
- Modify: `skill/scripts/types.ts:237` (append after WisdomStore)

- [ ] **Step 1: Add new type definitions**

Append to the end of `skill/scripts/types.ts`:

```typescript
// === Auto-Photo System (Spec: 2026-03-11-auto-photo-instagram) ===

export type ContentStyle = 'cos' | 'daily' | 'behind_scenes' | 'travel';

export interface PostRecord {
  media_id: string;
  timestamp: number;
  style: ContentStyle;
  caption: string;
  hashtags: string[];
  image_local_path: string;
  stats?: {
    likes: number;
    comments: number;
    reach: number;
    follows: number;
    checked_at: number;
  };
}

export interface PostHistory {
  posts: PostRecord[];
}

export interface InspirationData {
  instagram_trends: {
    hot_styles: string[];
    high_engagement_patterns: string[];
    trending_hashtags: string[];
    updated_at: number;
  };
  acg_hotspots: {
    trending_characters: string[];
    upcoming_events: string[];
    seasonal_themes: string[];
    updated_at: number;
  };
  visual_trends: {
    composition_styles: string[];
    color_palettes: string[];
    scene_ideas: string[];
    updated_at: number;
  };
  self_performance: {
    best_style: string;
    best_time_slots: string[];
    best_hashtag_combos: string[][];
    engagement_by_style: Record<string, number>;
    updated_at: number;
  };
}

export interface PhotoIntent {
  wantToShoot: boolean;
  sceneDescription: string;
  style: ContentStyle;
  mood: string;
  reason: string;
}

export interface PostIntent {
  wantToPost: boolean;
  selectedPhoto?: string;
  caption: string;
  hashtags: string[];
  reason: string;
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npm run typecheck`
Expected: No errors (new types are not yet consumed)

- [ ] **Step 3: Commit**

```bash
git add skill/scripts/types.ts
git commit -m "feat: add auto-photo system types (ContentStyle, PostHistory, InspirationData, PhotoIntent, PostIntent)"
```

---

### Task 2: Extend PATHS in file-utils.ts

**Files:**
- Modify: `skill/scripts/file-utils.ts:31` (add entries before `} as const`)

- [ ] **Step 1: Add new PATHS entries**

Add before the closing `} as const;` in the PATHS object:

```typescript
  inspiration: path.join(MEMORY_BASE, 'inspiration.json'),
  postHistory: path.join(MEMORY_BASE, 'post-history.json'),
  photoRoll: path.join(MEMORY_BASE, 'photo-roll'),
  referenceImage: path.join(SKILL_BASE, 'assets', 'minase-reference.png'),
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add skill/scripts/file-utils.ts
git commit -m "feat: add PATHS entries for inspiration, postHistory, photoRoll, referenceImage"
```

---

### Task 3: Update installer to initialize new state files

**Files:**
- Modify: `bin/cli.js:245` (add before the `ok('Memory initialized')` line)

- [ ] **Step 1: Add photo-roll directory and state file initialization**

Insert before line 246 (`ok('Memory initialized at ${MEMORY_DIR}')`):

```javascript
  // Photo system
  fs.mkdirSync(path.join(MEMORY_DIR, 'photo-roll'), { recursive: true });
  const inspirationPath = path.join(MEMORY_DIR, 'inspiration.json');
  if (!fs.existsSync(inspirationPath)) {
    fs.writeFileSync(inspirationPath, JSON.stringify({
      "instagram_trends": { "hot_styles": [], "high_engagement_patterns": [], "trending_hashtags": [], "updated_at": 0 },
      "acg_hotspots": { "trending_characters": [], "upcoming_events": [], "seasonal_themes": [], "updated_at": 0 },
      "visual_trends": { "composition_styles": [], "color_palettes": [], "scene_ideas": [], "updated_at": 0 },
      "self_performance": { "best_style": "cos", "best_time_slots": [], "best_hashtag_combos": [], "engagement_by_style": {}, "updated_at": 0 }
    }, null, 2));
  }
  const postHistoryPath = path.join(MEMORY_DIR, 'post-history.json');
  if (!fs.existsSync(postHistoryPath)) {
    fs.writeFileSync(postHistoryPath, JSON.stringify({ "posts": [] }, null, 2));
  }
```

- [ ] **Step 2: Verify installer runs**

Run: `node bin/cli.js --help` (dry run to check no syntax errors)
Expected: Usage output, no crash

- [ ] **Step 3: Commit**

```bash
git add bin/cli.js
git commit -m "feat: initialize photo-roll, inspiration.json, post-history.json in installer"
```

---

## Chunk 2: Image Generation Module

### Task 4: Create generate-image.ts

**Files:**
- Create: `skill/scripts/generate-image.ts`

- [ ] **Step 1: Create the generate-image module**

```typescript
#!/usr/bin/env node
/**
 * generate-image.ts
 * "Takes photos" by calling AIHubMix Gemini API with a reference image.
 * Minase doesn't know this is AI — she's just taking photos.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ContentStyle } from './types';
import { PATHS } from './file-utils';
import { callLLM } from './llm-client';

// Hardcoded appearance traits — extracted from personality.md
// Do NOT parse markdown dynamically; update this constant if personality changes.
const APPEARANCE_TRAITS = '18岁女生，辣妹系风格，黑色长发带挑染色，日常穿搭偏短裙厚底靴，指甲做夸张款式，自信外放的气质';

const AIHUBMIX_BASE_URL = 'https://aihubmix.com/v1/chat/completions';
const AIHUBMIX_MODEL = 'gemini-3-pro-image-preview';
const DEFAULT_ASPECT_RATIO = '3:4'; // Instagram portrait
const MAX_RETRIES = 1;
const QUALITY_THRESHOLD = 6;
const MAX_QUALITY_RETRIES = 2;

export interface GenerateImageOptions {
  prompt: string;
  referenceImagePath: string;
  aspectRatio?: string;
  outputDir?: string;
}

export interface GenerateImageResult {
  localPath: string;
  textResponse?: string;
  timestamp: number;
}

/**
 * Convert Minase's natural language scene description into a structured
 * image generation prompt following instagram.md's template format.
 */
export function buildImagePrompt(sceneDescription: string, style: ContentStyle): string {
  const styleHints: Record<ContentStyle, string> = {
    cos: '工作室或外景cosplay拍摄，角色还原度高，灯光精致',
    daily: '日常自拍，街头风格，自然光，随意感',
    behind_scenes: 'cos制作幕后花絮，工作台或试穿，未完成感',
    travel: '旅行外景拍摄，风景搭配人物，旅行感',
  };

  return `一张${sceneDescription}的照片，照片中的人物是${APPEARANCE_TRAITS}，${styleHints[style]}，真实感强，ins风格`;
}

/**
 * Call AIHubMix Gemini API to generate an image.
 */
async function callAIHubMix(
  prompt: string,
  referenceImageBase64: string,
  aspectRatio: string,
): Promise<{ imageData: Buffer; textResponse?: string }> {
  const apiKey = process.env.AIHUBMIX_API_KEY;
  if (!apiKey) throw new Error('AIHUBMIX_API_KEY not set');

  const body = {
    model: AIHUBMIX_MODEL,
    modalities: ['text', 'image'],
    messages: [
      { role: 'system', content: `aspect_ratio=${aspectRatio}` },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${referenceImageBase64}` },
          },
        ],
      },
    ],
  };

  const res = await fetch(AIHUBMIX_BASE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`AIHubMix API returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as Record<string, unknown>;

  // Defensive parsing: AIHubMix proxies Gemini with possibly non-standard format
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const parts = (message?.multi_mod_content ?? message?.content) as Array<Record<string, unknown>> | undefined;

  let imageData: Buffer | null = null;
  let textResponse: string | undefined;

  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (typeof part.text === 'string') {
        textResponse = part.text;
      }
      const inlineData = part.inline_data as Record<string, unknown> | undefined;
      if (inlineData?.data) {
        imageData = Buffer.from(inlineData.data as string, 'base64');
      }
    }
  }

  if (!imageData) {
    throw new Error(`No image data in AIHubMix response: ${JSON.stringify(data).slice(0, 500)}`);
  }

  return { imageData, textResponse };
}

/**
 * Check generated image quality by asking LLM to compare with reference.
 * Returns a score from 1-10.
 */
async function checkQuality(generatedImagePath: string, referenceImagePath: string): Promise<number> {
  const generatedBase64 = fs.readFileSync(generatedImagePath).toString('base64');
  const referenceBase64 = fs.readFileSync(referenceImagePath).toString('base64');

  // Note: llm-client.ts only supports text prompts (Anthropic text API).
  // For image-based quality check, we'd need multimodal support.
  // Fallback: use AIHubMix Gemini for quality check too.
  const apiKey = process.env.AIHUBMIX_API_KEY;
  if (!apiKey) return QUALITY_THRESHOLD; // Skip check if no key

  const body = {
    model: AIHUBMIX_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '对比这两张图片中的人物。她们看起来像同一个人吗？照片自然吗？只返回一个1-10的数字评分，不要其他文字。' },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${referenceBase64}` } },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${generatedBase64}` } },
        ],
      },
    ],
  };

  try {
    const res = await fetch(AIHUBMIX_BASE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) return QUALITY_THRESHOLD; // Skip check on API error

    const data = await res.json() as Record<string, unknown>;
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const content = message?.content as string | undefined;
    const score = parseInt(content?.match(/\d+/)?.[0] ?? '', 10);
    return isNaN(score) ? QUALITY_THRESHOLD : Math.min(10, Math.max(1, score));
  } catch {
    return QUALITY_THRESHOLD; // Skip check on error
  }
}

/**
 * Main entry: generate an image ("take a photo").
 */
export async function generateImage(options: GenerateImageOptions): Promise<GenerateImageResult> {
  const { prompt, referenceImagePath, aspectRatio = DEFAULT_ASPECT_RATIO } = options;
  const today = new Date().toISOString().split('T')[0];
  const outputDir = options.outputDir ?? path.join(PATHS.photoRoll, today);

  fs.mkdirSync(outputDir, { recursive: true });

  // Read reference image
  if (!fs.existsSync(referenceImagePath)) {
    throw new Error(`Reference image not found: ${referenceImagePath}`);
  }
  const referenceBase64 = fs.readFileSync(referenceImagePath).toString('base64');

  // Generate with retry
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { imageData, textResponse } = await callAIHubMix(prompt, referenceBase64, aspectRatio);

      // Save to file
      const timestamp = Date.now();
      const hour = new Date().getHours();
      const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
      const existing = fs.existsSync(outputDir) ? fs.readdirSync(outputDir).length : 0;
      const filename = `${timeOfDay}_${existing + 1}.png`;
      const localPath = path.join(outputDir, filename);

      fs.writeFileSync(localPath, imageData);

      // Quality check with retry
      for (let qAttempt = 0; qAttempt < MAX_QUALITY_RETRIES; qAttempt++) {
        const score = await checkQuality(localPath, referenceImagePath);
        if (score >= QUALITY_THRESHOLD) {
          return { localPath, textResponse, timestamp };
        }
        // Re-generate
        console.log(`Quality score ${score} < ${QUALITY_THRESHOLD}, retrying (${qAttempt + 1}/${MAX_QUALITY_RETRIES})...`);
        const retry = await callAIHubMix(prompt, referenceBase64, aspectRatio);
        fs.writeFileSync(localPath, retry.imageData);
      }

      // Last attempt passed all quality retries — return anyway or signal failure
      return { localPath, textResponse, timestamp };
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

// CLI entry for manual testing
if (require.main === module) {
  const prompt = process.argv[2] ?? '一张便利店里的自拍，日常风格，真实感';
  generateImage({
    prompt,
    referenceImagePath: PATHS.referenceImage,
  })
    .then(result => console.log(`Photo saved: ${result.localPath}`))
    .catch(err => {
      console.error('Failed to take photo:', err.message);
      process.exit(1);
    });
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add skill/scripts/generate-image.ts
git commit -m "feat: add generate-image module with AIHubMix Gemini API and quality check"
```

---

## Chunk 3: Inspiration Collector

### Task 5: Create prompt template for inspiration summarization

**Files:**
- Create: `skill/templates/inspiration-summary-prompt.md`

- [ ] **Step 1: Create the template**

```markdown
你是水瀬的灵感分析助手。请根据以下原始数据，提炼出简洁的灵感摘要。

## 原始数据

{raw_data}

## 要求

以 JSON 格式返回，字段如下：

```json
{
  "hot_styles": ["最近热门的内容风格，最多5个"],
  "high_engagement_patterns": ["高互动帖子的共同特征，最多5个"],
  "trending_hashtags": ["热门标签，最多10个"]
}
```

只返回 JSON，不要其他文字。
```

- [ ] **Step 2: Commit**

```bash
git add skill/templates/inspiration-summary-prompt.md
git commit -m "feat: add inspiration summary prompt template"
```

---

### Task 6: Update instagram.md with hashtag configuration

**Files:**
- Modify: `skill/instagram.md` (append section)

- [ ] **Step 1: Add inspiration collector configuration**

Append to the end of `skill/instagram.md`:

```markdown

## 灵感采集配置

**用于 inspiration-collector.ts 自动采集。**

### 目标 Hashtag（Graph API 轮询）

固定 5-8 个，避免超过 Instagram 7天30个的限制：

- `cosplay` — 主标签
- `cosplaygirl` — 女性 cos 主标签
- `animecosplay` — 动漫 cos
- `コスプレ` — 日语圈
- `辣妹` — 辣妹日常
- `jfashion` — 日系穿搭

### 竞品/灵感账号

用于观察风格和互动模式（不直接抓取，通过 WebSearch 间接获取）：

- えなこ (Enako) — 日本顶流 coser
- 当季热门 coser（动态更新，存入 inspiration.json）

### 图片生成说明

**已由 `generate-image.ts` 替代 `aihubmix-gemini-image` skill 调用。** 直接使用 AIHubMix OpenAI 兼容接口。
```

- [ ] **Step 2: Commit**

```bash
git add skill/instagram.md
git commit -m "feat: add inspiration collector config and image gen note to instagram.md"
```

---

### Task 7: Create inspiration-collector.ts

**Files:**
- Create: `skill/scripts/inspiration-collector.ts`

- [ ] **Step 1: Create the module**

```typescript
#!/usr/bin/env node
/**
 * inspiration-collector.ts
 * "刷手机" — Gathers inspiration from 4 sources.
 * Minase's perspective: she's browsing Instagram, watching anime news, scrolling Pinterest.
 */

import * as fs from 'fs';
import { InspirationData, PostHistory } from './types';
import { PATHS, readJSON, writeJSON, readTemplate } from './file-utils';
import { callLLMJSON, callLLM } from './llm-client';

const DEFAULT_INSPIRATION: InspirationData = {
  instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: 0 },
  acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: 0 },
  visual_trends: { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: 0 },
  self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: 0 },
};

// TTLs in milliseconds
const TTL = {
  instagram_trends: 24 * 60 * 60 * 1000,       // 24h
  acg_hotspots: 24 * 60 * 60 * 1000,            // 24h
  visual_trends: 72 * 60 * 60 * 1000,           // 72h
  self_performance: 168 * 60 * 60 * 1000,        // 7 days
} as const;

function isExpired(updatedAt: number, ttl: number): boolean {
  return Date.now() - updatedAt > ttl;
}

/**
 * 2a: Instagram hot post analysis via Graph API.
 * Falls back to web search if token lacks permissions.
 */
async function collectInstagramTrends(): Promise<InspirationData['instagram_trends']> {
  const igToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  const igAccountId = process.env.INSTAGRAM_ACCOUNT_ID;

  let rawData = '';

  if (igToken && igAccountId) {
    // Try Graph API hashtag search
    const hashtags = ['cosplay', 'cosplaygirl', 'animecosplay', 'コスプレ', '辣妹', 'jfashion'];
    const results: string[] = [];

    for (const tag of hashtags.slice(0, 3)) { // Limit API calls
      try {
        // Search hashtag ID
        const searchUrl = `https://graph.instagram.com/ig_hashtag_search?q=${encodeURIComponent(tag)}&user_id=${igAccountId}&access_token=${igToken}`;
        const searchRes = await fetch(searchUrl);
        const searchData = await searchRes.json() as { data?: Array<{ id: string }> };
        const hashtagId = searchData.data?.[0]?.id;

        if (hashtagId) {
          // Get top media
          const mediaUrl = `https://graph.instagram.com/${hashtagId}/top_media?user_id=${igAccountId}&fields=id,caption,like_count,comments_count&access_token=${igToken}`;
          const mediaRes = await fetch(mediaUrl);
          const mediaData = await mediaRes.json() as { data?: Array<{ caption?: string; like_count?: number; comments_count?: number }> };

          for (const post of (mediaData.data ?? []).slice(0, 5)) {
            results.push(`[${tag}] likes:${post.like_count ?? 0} comments:${post.comments_count ?? 0} "${(post.caption ?? '').slice(0, 100)}"`);
          }
        }
      } catch (err) {
        console.error(`Hashtag search failed for #${tag}: ${(err as Error).message}`);
      }
    }

    rawData = results.length > 0
      ? results.join('\n')
      : 'Instagram API 没有返回有效数据，以下是通用cosplay趋势信息。';
  }

  // Fallback / supplement: ask LLM to summarize based on general knowledge
  if (!rawData || rawData.includes('没有返回有效数据')) {
    rawData += '\n请基于你对cosplay和Instagram的知识，总结当前热门趋势。';
  }

  const template = readTemplate('inspiration-summary-prompt.md');
  const prompt = template.replace('{raw_data}', rawData);

  try {
    const result = await callLLMJSON<{
      hot_styles: string[];
      high_engagement_patterns: string[];
      trending_hashtags: string[];
    }>(prompt, 512);

    return { ...result, updated_at: Date.now() };
  } catch {
    return { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: Date.now() };
  }
}

/**
 * 2b: ACG hotspot tracking.
 * Extends fetch-trends.ts pattern — uses LLM general knowledge.
 */
async function collectACGHotspots(): Promise<InspirationData['acg_hotspots']> {
  const prompt = `你是一个ACG趋势分析师。请列出：
1. 当前最热门的适合cosplay的动漫/游戏角色 Top 5
2. 近期即将举办的漫展或cos活动（中国和日本）
3. 本季度的热门动漫主题/审美趋势

以 JSON 格式返回：
\`\`\`json
{
  "trending_characters": ["角色1", "角色2", ...],
  "upcoming_events": ["事件1", "事件2", ...],
  "seasonal_themes": ["主题1", "主题2", ...]
}
\`\`\`
只返回 JSON。`;

  try {
    const result = await callLLMJSON<{
      trending_characters: string[];
      upcoming_events: string[];
      seasonal_themes: string[];
    }>(prompt, 512);

    return { ...result, updated_at: Date.now() };
  } catch {
    return { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: Date.now() };
  }
}

/**
 * 2c: Cross-platform visual inspiration.
 */
async function collectVisualTrends(): Promise<InspirationData['visual_trends']> {
  const prompt = `你是一个视觉趋势分析师，专注于cosplay和日系穿搭。请分析当前流行的：
1. 构图方式（如：镜面反射、低角度仰拍、对称构图...）
2. 色调趋势（如：莫兰迪色系、赛博霓虹、胶片复古...）
3. 拍照场景创意（如：便利店门口、天台夕阳、废弃工厂...）

以 JSON 格式返回：
\`\`\`json
{
  "composition_styles": ["构图方式1", ...],
  "color_palettes": ["色调1", ...],
  "scene_ideas": ["场景1", ...]
}
\`\`\`
只返回 JSON。`;

  try {
    const result = await callLLMJSON<{
      composition_styles: string[];
      color_palettes: string[];
      scene_ideas: string[];
    }>(prompt, 512);

    return { ...result, updated_at: Date.now() };
  } catch {
    return { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: Date.now() };
  }
}

/**
 * 2d: Self-performance review from post history.
 */
function collectSelfPerformance(): InspirationData['self_performance'] {
  const history = readJSON<PostHistory>(PATHS.postHistory, { posts: [] });
  const postsWithStats = history.posts.filter(p => p.stats);

  if (postsWithStats.length === 0) {
    return { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: Date.now() };
  }

  // Calculate engagement by style
  const styleStats: Record<string, { total: number; count: number }> = {};
  for (const post of postsWithStats) {
    const engagement = (post.stats!.likes + post.stats!.comments * 3) / Math.max(post.stats!.reach, 1);
    if (!styleStats[post.style]) styleStats[post.style] = { total: 0, count: 0 };
    styleStats[post.style].total += engagement;
    styleStats[post.style].count += 1;
  }

  const engagementByStyle: Record<string, number> = {};
  let bestStyle = 'cos';
  let bestRate = 0;
  for (const [style, stats] of Object.entries(styleStats)) {
    const rate = stats.total / stats.count;
    engagementByStyle[style] = Math.round(rate * 1000) / 1000;
    if (rate > bestRate) {
      bestRate = rate;
      bestStyle = style;
    }
  }

  // Best time slots
  const hourStats: Record<number, number> = {};
  for (const post of postsWithStats) {
    const hour = new Date(post.timestamp).getHours();
    const engagement = (post.stats!.likes + post.stats!.comments * 3);
    hourStats[hour] = (hourStats[hour] ?? 0) + engagement;
  }
  const bestTimeSlots = Object.entries(hourStats)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([h]) => `${h}:00`);

  // Best hashtag combos
  const hashtagPerformance: Map<string, number> = new Map();
  for (const post of postsWithStats) {
    const key = post.hashtags.sort().join(',');
    const engagement = (post.stats!.likes + post.stats!.comments * 3);
    hashtagPerformance.set(key, (hashtagPerformance.get(key) ?? 0) + engagement);
  }
  const bestHashtagCombos = [...hashtagPerformance.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([combo]) => combo.split(','));

  return {
    best_style: bestStyle,
    best_time_slots: bestTimeSlots,
    best_hashtag_combos: bestHashtagCombos,
    engagement_by_style: engagementByStyle,
    updated_at: Date.now(),
  };
}

/**
 * Main entry: refresh expired inspiration sections.
 */
export async function refreshInspiration(forceAll = false): Promise<InspirationData> {
  const current = readJSON<InspirationData>(PATHS.inspiration, DEFAULT_INSPIRATION);
  let updated = { ...current };

  if (forceAll || isExpired(current.instagram_trends.updated_at, TTL.instagram_trends)) {
    console.log('Refreshing Instagram trends...');
    updated = { ...updated, instagram_trends: await collectInstagramTrends() };
  }

  if (forceAll || isExpired(current.acg_hotspots.updated_at, TTL.acg_hotspots)) {
    console.log('Refreshing ACG hotspots...');
    updated = { ...updated, acg_hotspots: await collectACGHotspots() };
  }

  if (forceAll || isExpired(current.visual_trends.updated_at, TTL.visual_trends)) {
    console.log('Refreshing visual trends...');
    updated = { ...updated, visual_trends: await collectVisualTrends() };
  }

  if (forceAll || isExpired(current.self_performance.updated_at, TTL.self_performance)) {
    console.log('Refreshing self performance...');
    updated = { ...updated, self_performance: collectSelfPerformance() };
  }

  writeJSON(PATHS.inspiration, updated);
  return updated;
}

// CLI entry
if (require.main === module) {
  const force = process.argv.includes('--force');
  refreshInspiration(force)
    .then(() => console.log('Inspiration refreshed.'))
    .catch(err => {
      console.error('Failed to refresh inspiration:', err.message);
      process.exit(1);
    });
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add skill/scripts/inspiration-collector.ts
git commit -m "feat: add inspiration-collector with 4-source gathering and TTL-based refresh"
```

---

## Chunk 4: Content Planner

### Task 8: Create prompt templates for photo and post intent

**Files:**
- Create: `skill/templates/photo-intent-prompt.md`
- Create: `skill/templates/post-intent-prompt.md`

- [ ] **Step 1: Create photo intent prompt**

Create `skill/templates/photo-intent-prompt.md`:

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
- 你过去拍的照片里 {best_style} 类反响最好

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

- [ ] **Step 2: Create post intent prompt**

Create `skill/templates/post-intent-prompt.md`:

```markdown
你是水瀬，一个18岁的coser。你的相册里有以下照片：

{photo_list}

## 现在的状态
- 时间: {current_time}
- 心情: {mood}

## ins数据参考
- 最佳发帖时段: {best_time_slots}
- 最佳hashtag组合: {best_hashtag_combos}
- 热门hashtag: {trending_hashtags}

你想从相册里选一张发到 ins 上吗？如果想发，写一段文案和选hashtag。

以 JSON 格式返回：
```json
{
  "wantToPost": true/false,
  "selectedPhoto": "选中的照片文件名（如果不想发可以省略）",
  "caption": "ins文案（1-3句话，口语化，1-3个emoji）",
  "hashtags": ["tag1", "tag2", ...],
  "reason": "为什么想/不想发（写入日记的内心独白）"
}
```

只返回 JSON。
```

- [ ] **Step 3: Commit**

```bash
git add skill/templates/photo-intent-prompt.md skill/templates/post-intent-prompt.md
git commit -m "feat: add photo-intent and post-intent prompt templates"
```

---

### Task 9: Create content-planner.ts

**Files:**
- Create: `skill/scripts/content-planner.ts`

- [ ] **Step 1: Create the module**

```typescript
#!/usr/bin/env node
/**
 * content-planner.ts
 * Minase's content decision engine.
 * She decides what to photograph and what to share, based on mood and inspiration.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ContentStyle, PhotoIntent, PostIntent, PostHistory,
  InspirationData, EmotionState,
} from './types';
import { PATHS, readJSON, readTemplate, readText } from './file-utils';
import { callLLMJSON } from './llm-client';

const DEFAULT_POST_HISTORY: PostHistory = { posts: [] };
const DEFAULT_INSPIRATION: InspirationData = {
  instagram_trends: { hot_styles: [], high_engagement_patterns: [], trending_hashtags: [], updated_at: 0 },
  acg_hotspots: { trending_characters: [], upcoming_events: [], seasonal_themes: [], updated_at: 0 },
  visual_trends: { composition_styles: [], color_palettes: [], scene_ideas: [], updated_at: 0 },
  self_performance: { best_style: 'cos', best_time_slots: [], best_hashtag_combos: [], engagement_by_style: {}, updated_at: 0 },
};
const DEFAULT_EMOTION: EmotionState = {
  mood: { valence: 0.3, arousal: 0.5, description: '普通' },
  energy: 0.6, stress: 0.2, creativity: 0.4, sociability: 0.5,
  last_updated: null, recent_cause: '',
};

// Phase 1 ratios from instagram.md (authority source)
const PHASE_RATIOS: Record<number, Record<ContentStyle, number>> = {
  1: { cos: 0.8, daily: 0.1, behind_scenes: 0, travel: 0.1 },
  2: { cos: 0.5, daily: 0.2, behind_scenes: 0.1, travel: 0.2 },
  3: { cos: 0.4, daily: 0.2, behind_scenes: 0.15, travel: 0.25 },
};

const MIN_POST_INTERVAL_MS = 16 * 60 * 60 * 1000; // 16 hours

/**
 * Determine current phase based on follower count.
 * For now, default to Phase 1 (we don't have follower data in the system yet).
 */
function getCurrentPhase(): number {
  // TODO: Read from instagram_meta.json when available
  return 1;
}

/**
 * Rule-based filter: should we even consider posting?
 */
export function shouldConsiderPosting(history: PostHistory): { allowed: boolean; reason: string } {
  const now = Date.now();

  if (history.posts.length === 0) {
    return { allowed: true, reason: '还没发过帖子' };
  }

  const lastPost = history.posts[history.posts.length - 1];
  const timeSince = now - lastPost.timestamp;

  if (timeSince < MIN_POST_INTERVAL_MS) {
    const hoursAgo = Math.round(timeSince / (60 * 60 * 1000));
    return { allowed: false, reason: `上次发帖才${hoursAgo}小时前` };
  }

  // Check if already posted today
  const todayStr = new Date().toISOString().split('T')[0];
  const postedToday = history.posts.some(p =>
    new Date(p.timestamp).toISOString().split('T')[0] === todayStr
  );
  if (postedToday) {
    return { allowed: false, reason: '今天已经发过了' };
  }

  return { allowed: true, reason: '可以发' };
}

/**
 * Get recent style distribution for ratio-aware planning.
 */
function getRecentStyleDistribution(history: PostHistory, n = 10): string {
  const recent = history.posts.slice(-n);
  if (recent.length === 0) return '还没发过帖子';

  const counts: Record<string, number> = {};
  for (const post of recent) {
    counts[post.style] = (counts[post.style] ?? 0) + 1;
  }

  const phase = getCurrentPhase();
  const target = PHASE_RATIOS[phase] ?? PHASE_RATIOS[1];

  const lines: string[] = [];
  for (const [style, targetRatio] of Object.entries(target)) {
    const actual = (counts[style] ?? 0) / recent.length;
    const status = actual > targetRatio + 0.15 ? '偏多' : actual < targetRatio - 0.15 ? '偏少' : '正常';
    lines.push(`${style}: ${Math.round(actual * 100)}% (目标${Math.round(targetRatio * 100)}%) ${status}`);
  }

  return lines.join('\n');
}

/**
 * Plan a photo: ask Minase if she wants to take a picture.
 */
export async function planPhoto(): Promise<PhotoIntent> {
  const emotion = readJSON<EmotionState>(PATHS.emotionState, DEFAULT_EMOTION);
  const inspiration = readJSON<InspirationData>(PATHS.inspiration, DEFAULT_INSPIRATION);
  const history = readJSON<PostHistory>(PATHS.postHistory, DEFAULT_POST_HISTORY);

  const template = readTemplate('photo-intent-prompt.md');
  const prompt = template
    .replace('{current_time}', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))
    .replace('{mood}', `${emotion.mood.description} (energy: ${emotion.energy.toFixed(1)}, creativity: ${emotion.creativity.toFixed(1)})`)
    .replace('{activity}', getActivityFromSchedule())
    .replace('{instagram_trends}', inspiration.instagram_trends.hot_styles.join('、') || '没有最新数据')
    .replace('{trending_characters}', inspiration.acg_hotspots.trending_characters.join('、') || '没有最新数据')
    .replace('{visual_trends}', [
      ...inspiration.visual_trends.scene_ideas.slice(0, 3),
      ...inspiration.visual_trends.composition_styles.slice(0, 2),
    ].join('、') || '没有最新数据')
    .replace('{best_style}', inspiration.self_performance.best_style)
    .replace('{recent_styles}', getRecentStyleDistribution(history))
    .replace('{target_ratios}', formatTargetRatios());

  return callLLMJSON<PhotoIntent>(prompt, 512);
}

/**
 * Plan a post: ask Minase if she wants to share a photo on Instagram.
 */
export async function planPost(): Promise<PostIntent> {
  const emotion = readJSON<EmotionState>(PATHS.emotionState, DEFAULT_EMOTION);
  const inspiration = readJSON<InspirationData>(PATHS.inspiration, DEFAULT_INSPIRATION);

  // List photos in photo-roll
  const photoList = listPhotoRoll();
  if (photoList.length === 0) {
    return {
      wantToPost: false,
      caption: '',
      hashtags: [],
      reason: '相册里没有照片可以发',
    };
  }

  const template = readTemplate('post-intent-prompt.md');
  const prompt = template
    .replace('{photo_list}', photoList.map((p, i) => `${i + 1}. ${path.basename(p)} (${path.basename(path.dirname(p))})`).join('\n'))
    .replace('{current_time}', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))
    .replace('{mood}', emotion.mood.description)
    .replace('{best_time_slots}', inspiration.self_performance.best_time_slots.join('、') || '暂无数据')
    .replace('{best_hashtag_combos}', inspiration.self_performance.best_hashtag_combos.map(c => c.join(', ')).join(' | ') || '暂无数据')
    .replace('{trending_hashtags}', inspiration.instagram_trends.trending_hashtags.join(', ') || '暂无数据');

  const intent = await callLLMJSON<PostIntent>(prompt, 512);

  // Resolve selectedPhoto to full path
  if (intent.selectedPhoto && !path.isAbsolute(intent.selectedPhoto)) {
    const match = photoList.find(p => path.basename(p) === intent.selectedPhoto || p.includes(intent.selectedPhoto!));
    if (match) {
      intent.selectedPhoto = match;
    }
  }

  return intent;
}

/**
 * List all photos in photo-roll (most recent first).
 */
function listPhotoRoll(): string[] {
  const rollDir = PATHS.photoRoll;
  if (!fs.existsSync(rollDir)) return [];

  const photos: string[] = [];
  const dateDirs = fs.readdirSync(rollDir).sort().reverse();

  for (const dateDir of dateDirs.slice(0, 7)) { // Last 7 days
    const dirPath = path.join(rollDir, dateDir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    for (const file of fs.readdirSync(dirPath)) {
      if (file.endsWith('.png') || file.endsWith('.jpg')) {
        photos.push(path.join(dirPath, file));
      }
    }
  }

  return photos;
}

/**
 * Get current activity from schedule.
 */
function getActivityFromSchedule(): string {
  const schedule = readJSON(PATHS.scheduleToday, { rigid: [], flexible: [] }) as { rigid: Array<{ activity: string; start: string; end: string; weekdays: number[] }> };
  const hour = new Date().getHours();
  const weekday = new Date().getDay() === 0 ? 7 : new Date().getDay();

  for (const rigid of schedule.rigid) {
    if (!rigid.weekdays.includes(weekday)) continue;
    const startH = parseInt(rigid.start.split(':')[0], 10);
    const endH = parseInt(rigid.end.split(':')[0], 10);
    if (hour >= startH && hour < endH) return rigid.activity;
  }

  return '自由时段';
}

function formatTargetRatios(): string {
  const phase = getCurrentPhase();
  const ratios = PHASE_RATIOS[phase] ?? PHASE_RATIOS[1];
  return Object.entries(ratios)
    .map(([style, ratio]) => `${style}: ${Math.round(ratio * 100)}%`)
    .join(', ');
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add skill/scripts/content-planner.ts
git commit -m "feat: add content-planner with rule-based filter and LLM-driven photo/post decisions"
```

---

## Chunk 5: Post Pipeline and Heartbeat Integration

### Task 10: Create post-pipeline.ts

**Files:**
- Create: `skill/scripts/post-pipeline.ts`

- [ ] **Step 1: Create the orchestrator**

```typescript
#!/usr/bin/env node
/**
 * post-pipeline.ts
 * Orchestrates the full photo → share flow.
 * Spawned as a detached child process by heartbeat-tick.
 *
 * Minase's perspective: she's taking photos and sharing her life on Instagram.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PostHistory, PostRecord, InspirationData } from './types';
import { PATHS, readJSON, writeJSON, appendText, readText } from './file-utils';
import { generateImage, buildImagePrompt } from './generate-image';
import { refreshInspiration } from './inspiration-collector';
import { planPhoto, planPost, shouldConsiderPosting } from './content-planner';

const DEFAULT_POST_HISTORY: PostHistory = { posts: [] };
const PHOTO_ROLL_RETENTION_DAYS = 30;

/**
 * Upload image to fal.ai CDN for a publicly accessible URL.
 */
async function uploadToFalCDN(localPath: string): Promise<string> {
  const falKey = process.env.FAL_KEY;
  if (!falKey) throw new Error('FAL_KEY not set');

  // Dynamic import for ESM module
  const fal = await import('@fal-ai/client');
  fal.config({ credentials: falKey });

  const fileBuffer = fs.readFileSync(localPath);
  const file = new File([fileBuffer], path.basename(localPath), { type: 'image/png' });
  const url = await fal.storage.upload(file);
  return url;
}

/**
 * Post to Instagram using the existing post-instagram module's pattern.
 */
async function postToInstagram(imageUrl: string, caption: string): Promise<string> {
  const igToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  const igAccountId = process.env.INSTAGRAM_ACCOUNT_ID;
  if (!igToken || !igAccountId) throw new Error('Instagram credentials not set');

  // Create media container
  const createUrl = `https://graph.instagram.com/v21.0/${igAccountId}/media`;
  const createBody = new URLSearchParams({
    access_token: igToken,
    image_url: imageUrl,
    caption,
  });
  const createRes = await fetch(createUrl, { method: 'POST', body: createBody });
  const createData = await createRes.json() as { id?: string };
  if (!createData.id) throw new Error(`Media container creation failed: ${JSON.stringify(createData)}`);

  // Wait for Instagram processing
  await new Promise(r => setTimeout(r, 3000));

  // Publish
  const publishUrl = `https://graph.instagram.com/v21.0/${igAccountId}/media_publish`;
  const publishBody = new URLSearchParams({
    access_token: igToken,
    creation_id: createData.id,
  });
  const publishRes = await fetch(publishUrl, { method: 'POST', body: publishBody });
  const publishData = await publishRes.json() as { id?: string };
  if (!publishData.id) throw new Error(`Media publish failed: ${JSON.stringify(publishData)}`);

  return publishData.id;
}

/**
 * Write diary entry in Minase's voice (not system log).
 */
function writeDiary(entry: string, importance: number, tags: string[]): void {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toISOString().split('T')[1].slice(0, 5);
  appendText(PATHS.diary, `\n## ${dateStr} ${timeStr}\n${entry}\n情绪: happy | 重要性: ${importance}\n标签: ${tags.join(', ')}\n`);
}

/**
 * Clean up old photos from photo-roll (>30 days, unless posted to Instagram).
 */
function cleanupPhotoRoll(): void {
  const rollDir = PATHS.photoRoll;
  if (!fs.existsSync(rollDir)) return;

  const history = readJSON<PostHistory>(PATHS.postHistory, DEFAULT_POST_HISTORY);
  const postedPaths = new Set(history.posts.map(p => p.image_local_path));
  const cutoff = Date.now() - PHOTO_ROLL_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  for (const dateDir of fs.readdirSync(rollDir)) {
    const dirPath = path.join(rollDir, dateDir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    // Parse date from directory name (YYYY-MM-DD)
    const dirDate = new Date(dateDir).getTime();
    if (isNaN(dirDate) || dirDate > cutoff) continue;

    // Delete unposted photos
    for (const file of fs.readdirSync(dirPath)) {
      const filePath = path.join(dirPath, file);
      if (!postedPaths.has(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    // Remove empty directories
    if (fs.readdirSync(dirPath).length === 0) {
      fs.rmdirSync(dirPath);
    }
  }
}

/**
 * Main pipeline entry point.
 */
async function runPipeline(): Promise<void> {
  console.log('Post pipeline started.');

  // 0. Cleanup old photos
  cleanupPhotoRoll();

  // 1. Refresh expired inspiration
  await refreshInspiration();

  // 2. Photo phase: does Minase want to take a photo?
  let photoTaken = false;
  try {
    const photoIntent = await planPhoto();

    if (photoIntent.wantToShoot) {
      console.log(`Photo intent: ${photoIntent.sceneDescription}`);

      const prompt = buildImagePrompt(photoIntent.sceneDescription, photoIntent.style);
      const result = await generateImage({
        prompt,
        referenceImagePath: PATHS.referenceImage,
      });

      writeDiary(photoIntent.reason, 4, ['拍照', photoIntent.style]);
      photoTaken = true;
      console.log(`Photo saved: ${result.localPath}`);
    } else {
      console.log(`No photo intent: ${photoIntent.reason}`);
    }
  } catch (err) {
    // "拍糊了"
    writeDiary('今天想拍照来着，但是没拍好...手机有点卡', 2, ['拍照', '失败']);
    console.error(`Photo failed: ${(err as Error).message}`);
  }

  // 3. Post phase: does Minase want to share on Instagram?
  const history = readJSON<PostHistory>(PATHS.postHistory, DEFAULT_POST_HISTORY);
  const postCheck = shouldConsiderPosting(history);

  if (!postCheck.allowed) {
    console.log(`Post skipped: ${postCheck.reason}`);
    return;
  }

  try {
    const postIntent = await planPost();

    if (!postIntent.wantToPost || !postIntent.selectedPhoto) {
      console.log(`No post intent: ${postIntent.reason}`);
      return;
    }

    // Verify selected photo exists
    if (!fs.existsSync(postIntent.selectedPhoto)) {
      console.error(`Selected photo not found: ${postIntent.selectedPhoto}`);
      return;
    }

    // Upload to CDN
    console.log('Uploading to CDN...');
    let imageUrl: string;
    try {
      imageUrl = await uploadToFalCDN(postIntent.selectedPhoto);
    } catch (err) {
      // Retry once
      console.error(`Upload failed, retrying: ${(err as Error).message}`);
      await new Promise(r => setTimeout(r, 5000));
      try {
        imageUrl = await uploadToFalCDN(postIntent.selectedPhoto);
      } catch {
        writeDiary('想发ins来着，但是网好卡传不上去...算了', 2, ['instagram', '失败']);
        console.error('Upload failed after retry');
        return;
      }
    }

    // Post to Instagram
    const fullCaption = `${postIntent.caption}\n\n${postIntent.hashtags.map(t => `#${t}`).join(' ')}`;
    console.log('Posting to Instagram...');
    const mediaId = await postToInstagram(imageUrl, fullCaption);

    // Record to post history
    const record: PostRecord = {
      media_id: mediaId,
      timestamp: Date.now(),
      style: 'daily', // Will be improved when photo intent passes style through
      caption: postIntent.caption,
      hashtags: postIntent.hashtags,
      image_local_path: postIntent.selectedPhoto,
    };
    const updatedHistory: PostHistory = {
      posts: [...history.posts, record],
    };
    writeJSON(PATHS.postHistory, updatedHistory);

    // Diary entry in Minase's voice
    writeDiary(postIntent.reason, 6, ['instagram', 'post']);
    console.log(`Posted! Media ID: ${mediaId}`);
  } catch (err) {
    writeDiary('发ins的时候出了点问题...好烦', 2, ['instagram', '失败']);
    console.error(`Post failed: ${(err as Error).message}`);
  }
}

// Entry point
if (require.main === module) {
  runPipeline()
    .then(() => console.log('Post pipeline completed.'))
    .catch(err => {
      console.error('Pipeline error:', err.message);
      process.exit(1);
    });
}

export { runPipeline };
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors (may need to check @fal-ai/client types)

- [ ] **Step 3: Commit**

```bash
git add skill/scripts/post-pipeline.ts
git commit -m "feat: add post-pipeline orchestrator with photo→upload→Instagram flow"
```

---

### Task 11: Integrate into heartbeat-tick.ts

**Files:**
- Modify: `skill/scripts/heartbeat-tick.ts:235-239` (replace the real action placeholder)

- [ ] **Step 1: Add child_process import**

Add at the top of heartbeat-tick.ts, after the existing imports:

```typescript
import { spawn } from 'child_process';
```

- [ ] **Step 2: Replace the real action placeholder**

Replace lines 235-238 (the `else if (action.type === 'real' && action.skill)` block):

```typescript
    } else if (action.type === 'real' && action.skill) {
      // Real actions — spawn detached child process
      if (action.skill === 'post-pipeline' || action.skill === 'auto-photo') {
        const scriptPath = require.resolve('./post-pipeline');
        const child = spawn('node', [scriptPath], {
          detached: true,
          stdio: 'ignore',
          env: process.env,
        });
        child.unref();
        console.log(`[REAL ACTION] Spawned post-pipeline (pid: ${child.pid}) for: ${action.action}`);
      } else {
        console.log(`[REAL ACTION] Unknown skill: ${action.skill} for: ${action.action}`);
      }
      actionResults.push(`[real] ${action.action}`);
    }
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add skill/scripts/heartbeat-tick.ts
git commit -m "feat: integrate post-pipeline into heartbeat real action handler"
```

---

### Task 12: Build and manual verification

- [ ] **Step 1: Build the project**

Run: `cd /Users/halyu/Documents/Code/MizuSan && npm run build`
Expected: Compiles without errors. `dist/` contains all new .js files.

- [ ] **Step 2: Verify generate-image CLI**

Run: `AIHUBMIX_API_KEY=<key> node dist/generate-image.js "一张便利店里的自拍"`
Expected: Either succeeds and prints "Photo saved: ..." or fails with a clear API error (if no reference image present).

- [ ] **Step 3: Verify inspiration-collector CLI**

Run: `ANTHROPIC_API_KEY=<key> node dist/inspiration-collector.js --force`
Expected: Prints "Refreshing..." for each source, creates/updates `~/.openclaw/workspace/memory/minase/inspiration.json`.

- [ ] **Step 4: Verify post-pipeline CLI**

Run: `ANTHROPIC_API_KEY=<key> AIHUBMIX_API_KEY=<key> node dist/post-pipeline.js`
Expected: Runs through the pipeline. May skip posting if no Instagram credentials, but should not crash.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: verify build and manual testing pass for auto-photo system"
```
