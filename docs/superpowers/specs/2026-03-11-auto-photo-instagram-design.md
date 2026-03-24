# 自动拍照与 Instagram 分享系统设计

## 概述

为 Minase 补齐"拍照 → 分享"的完整链路。Minase 作为独立个体，基于灵感和生活场景自主决定拍什么、什么时候分享到 Instagram。目标是涨粉。

**核心原则：** Minase 的认知里不存在"AI 生图"。她就是在拍照、自拍。所有面向人格层的输出使用拍照语义。

## 范围

**包含：**
- 图片生成模块（拍照）
- 多源灵感采集
- 内容决策引擎
- Instagram 自动分享
- Heartbeat 集成

**不包含：**
- 小红书发布（后续 spec）
- Stories 发布（Phase 2）
- 评论自动回复（后续 spec）
- 图片滤镜/后处理
- 多账号管理

## 模块设计

### 1. 图片生成 `generate-image.ts`

**职责：** 拍照。接收场景描述 + 参考图 → 输出图片文件。

**技术方案：** 直接调用 AIHubMix 的 OpenAI 兼容接口，不依赖外部 skill 或 Python。

```
POST https://aihubmix.com/v1/chat/completions
model: "gemini-3-pro-image-preview"
modalities: ["text", "image"]

messages: [
  { role: "system", content: "aspect_ratio=3:4" },
  { role: "user", content: [
    { type: "text", text: <prompt> },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,<参考图>" } }
  ]}
]

响应解析: choices[0].message.multi_mod_content
  → 找 inline_data.data → base64 decode → Buffer → 写 PNG
```

**注意：** AIHubMix 代理 Gemini 的响应格式可能与标准 OpenAI 格式有差异。实现时需对 `multi_mod_content` 做防御性解析，兼容 `inline_data` 和可能的其他格式变体。

**接口：**

```typescript
interface GenerateImageOptions {
  prompt: string;              // 结构化生图 prompt（由 buildImagePrompt 生成）
  referenceImagePath: string;  // assets/minase-reference.png
  aspectRatio?: string;        // 默认 "3:4"（ins 竖图）
  outputDir?: string;          // 默认 PATHS.photoRoll/{date}/
}

interface GenerateImageResult {
  localPath: string;
  textResponse?: string;
  timestamp: number;
}

async function generateImage(options: GenerateImageOptions): Promise<GenerateImageResult>
```

**Prompt 转换 — `buildImagePrompt()`：**

content-planner 输出的是 Minase 视角的自然语言场景描述（中文、口语化）。`generate-image.ts` 内置 `buildImagePrompt()` 函数将其转换为结构化生图 prompt，遵循 `instagram.md` 中已定义的模板格式：

```typescript
function buildImagePrompt(sceneDescription: string, style: ContentStyle): string {
  // 注入 APPEARANCE_TRAITS 常量（见下方）
  // 套用 instagram.md 的 prompt 模板：
  // "一张[场景描述]的照片，照片中的人物是[角色描述]，
  //  [镜头类型]，[光线描述]，真实感强，ins风格"
}
```

**角色外形常量：**

在 `generate-image.ts` 中硬编码 `APPEARANCE_TRAITS` 常量，不从 personality.md 动态解析（避免脆弱的 markdown 解析）：

```typescript
const APPEARANCE_TRAITS = '18岁女生，黑色长发带挑染，...' // 从 personality.md 手动提取
```

**实现细节：**
- HTTP 调用：原生 `fetch`，零外部依赖
- 参考图：`fs.readFileSync(referenceImagePath)` → base64
- 文件命名：`{timeOfDay}_{style}_{seq}.png`

**质量检查机制：**

生成图片后，调用 LLM（通过已有的 `llm-client.ts`，即 Anthropic/Claude）评估质量：

```typescript
// 将生成图片 + 参考图发给 LLM
prompt: "对比这两张图片中的人物。她们看起来像同一个人吗？照片自然吗？评分 1-10。"
// 阈值：score >= 6 通过
// 不通过 → 重拍（最多 2 次）→ 仍不过 → 放弃，diary 写 "今天状态不好"
```

**错误处理：**
- API 失败 → 重试 1 次，仍失败 → diary 记录"拍糊了 / 手机卡了"
- 质量检查不过 → 重拍最多 2 次 → 仍不满意 → "今天拍了几张都不满意...算了"

**依赖：** `AIHUBMIX_API_KEY` 环境变量，`assets/minase-reference.png`

### 2. 灵感采集 `inspiration-collector.ts`

**职责：** 刷手机、看 ins、追番。从 4 个渠道采集灵感，写入 `inspiration.json`。

**LLM 调用：** 所有总结和提炼操作使用已有的 `llm-client.ts`（Anthropic/Claude API）。

#### 2a. Instagram 热帖分析（Graph API）

- 查询目标 hashtag（`#cosplay`, `#コスプレ`, `#辣妹` 等）的近期热帖
- 提取：点赞数、评论数、图片描述、构图特征
- LLM 总结："最近什么类型的帖子互动最高"
- 频率：每天 1 次

**API 限制说明：** Instagram `ig_hashtag_search` 端点限制每 7 天最多查询 30 个不同 hashtag。需要 Business/Creator 账号且 token 包含 `instagram_basic` 和 `instagram_manage_insights` 权限。策略：固定 5-8 个核心 hashtag 轮询，不做大范围搜索。如果 token 权限不足，降级为通过 WebSearch 搜索 "cosplay trending instagram this week" 获取间接信息。

#### 2b. ACG 热点追踪

- 扩展已有 `fetch-trends.ts`：加入 MyAnimeList 当季热番、近期漫展日程
- 输出："当前热门角色 Top 5"、"即将到来的活动"
- 频率：每天 1 次

#### 2c. 跨平台视觉灵感

- 通过搜索引擎获取 Pinterest / 小红书上的 cos 穿搭趋势
- LLM 提炼视觉元素：构图方式、色调趋势、场景类型
- 频率：每 2-3 天 1 次

#### 2d. 自身数据复盘

- 从 `post-history.json` 读取已发帖 stats（likes、comments、reach）
- 统计：哪种 style 点赞率高、哪个时段互动好、什么 hashtag 组合效果好
- 频率：每周 1 次

**数据结构：**

```typescript
interface InspirationData {
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
```

**过期判定（TTL）：**

| 数据源 | TTL | 说明 |
|--------|-----|------|
| `instagram_trends` | 24 小时 | 热帖变化快 |
| `acg_hotspots` | 24 小时 | 新番更新频繁 |
| `visual_trends` | 72 小时 | 视觉趋势变化慢 |
| `self_performance` | 168 小时（7 天） | 数据积累需要时间 |

`post-pipeline.ts` 刷新灵感时，检查每个 section 的 `updated_at` 是否超过对应 TTL，仅刷新过期部分。

**存储：** `~/.openclaw/workspace/memory/minase/inspiration.json`

### 3. 内容决策 `content-planner.ts`

**职责：** 想拍什么、想发什么。基于灵感和当前状态做决策。

**LLM 调用：** 使用已有的 `llm-client.ts`（Anthropic/Claude API）。

**决策流程：规则层 → LLM 层**

**规则层（快速过滤）：**
- 上次发帖不足 16 小时 → 不发（从 `post-history.json` 读取最近发帖时间）
- 今天已经发过 → 不发
- 当前时段不在发布窗口 → 降低概率

**LLM 层（通过规则后）：**

prompt 使用拍照语义，注入灵感数据：

```
你是水瀬。你现在的心情是 {mood}，正在 {activity}。
最近你刷 ins 看到 {trends}，觉得挺有意思的。
你自己最近拍的照片里 {best_performing} 反响不错。

你现在想拍照吗？想拍什么样的？
如果想拍，描述一下你想要的画面、场景、穿搭和氛围。
```

**输出：**

```typescript
// 内容类型与 instagram.md 保持一致
type ContentStyle = 'cos' | 'daily' | 'behind_scenes' | 'travel';

interface PhotoIntent {
  wantToShoot: boolean;
  sceneDescription: string;  // Minase 视角的自然语言描述
  style: ContentStyle;       // 内容类型
  mood: string;
  reason: string;            // 写入 diary 的内心独白
}

interface PostIntent {
  wantToPost: boolean;
  selectedPhoto?: string;    // photo-roll 中的文件路径
  caption: string;
  hashtags: string[];
  reason: string;
}
```

注：`sceneDescription` 是 Minase 的口语化描述（如"想在便利店拍一张随意的自拍"），不直接作为生图 prompt。由 `generate-image.ts` 的 `buildImagePrompt()` 转换为结构化 prompt。

**拍照和发帖解耦：** 拍照意图和发帖意图独立评估。她可能拍了但不发，也可能翻相册选之前拍的发。

**内容比例遵循 instagram.md 的类型体系（权威来源）：**

| Phase | 粉丝数 | cos图 | 日常碎片 | 幕后花絮 | 旅行/外拍 |
|-------|--------|-------|---------|---------|----------|
| 1 冷启动 | 0-500 | 80% | 10% | 0% | 10% |
| 2 增长期 | 500-5000 | 50% | 20% | 10% | 20% |
| 3 稳定期 | 5000+ | 40% | 20% | 15% | 25% |

content-planner 从 `post-history.json` 追踪最近 10 篇的类型分布，偏离时在 LLM prompt 中提示调整。

### 4. 发布管线 `post-pipeline.ts`

**职责：** 串联完整流程——拍照 → 存相册 → 选片 → 分享。

**流程：**

```
1. 刷新灵感（检查 inspiration.json 各 section 的 TTL，仅刷新过期部分）
2. 评估拍照意图 → content-planner.planPhoto()
   → 不想拍 → 结束
   → 想拍 → buildImagePrompt() 转换 prompt → generate-image 拍照 → 存入 photo-roll
   → 写 diary（今天拍了什么）
3. 评估发帖意图 → content-planner.planPost()
   → 不想发 → 结束
   → 想发 → 从 photo-roll 选片
   → fal.storage.upload 获取公开 URL
   → post-instagram 分享
   → 写入 post-history.json
   → 写 diary（分享了什么、期待反馈）
```

**图片上传：** 用 `@fal-ai/client`（已有依赖）的 `fal.storage.upload()` 获取公开 CDN URL，无需自建图床。`FAL_KEY` 在本项目中兼作图片上传用途（原设计为图片生成备选）。fal CDN URL 在上传后持久可用，满足 Instagram 的异步容器创建需求。

**上传失败处理：** 上传失败 → 重试 1 次 → 仍失败 → diary 写"发不了，网好卡😤" → 放弃本次发帖（照片保留在 photo-roll，下次可以再选）。

**认知层封装 — 术语映射：**

| 技术层（代码） | Minase 视角（diary 输出） |
|---|---|
| generateImage() | 拍照 / 自拍 |
| buildImagePrompt() | 想好了怎么拍 |
| 参考图一致性 | （不存在，她本来就长这样） |
| 生图失败 | 拍糊了 / 手机卡了 |
| 质量检查不过 | 看了看不满意，删掉重拍 |
| fal.storage.upload | （不感知） |
| upload 失败 | 网好卡，发不了 |
| post-instagram | 发到 ins 上分享给大家 |

**diary 写入示例：**

```markdown
下午路过全家的时候光线超好的！穿着新买的卫衣随手拍了一张，
感觉今天的状态还不错嘿嘿。发到 ins 上了，
配文写的是"放学后的小确幸☕"，希望大家喜欢～
```

### 5. Heartbeat 集成

**修改：** `skill/scripts/heartbeat-tick.ts`

**集成点：** 利用现有的意图池系统。heartbeat tick 的 intent-engine 已支持 `创作` 和 `表达` 意图类别：

- `创作` 类意图（如"想拍一张新照片"）→ 触发拍照流程
- `表达` 类意图（如"想发ins"）→ 触发发帖流程

**具体机制：**

```
heartbeat-tick 每次执行时：
  1. 现有逻辑（情绪更新、意图池采样等）
  2. LLM 的 chosen_actions 中如果包含拍照/发帖相关 action：
     → spawn 子进程: child_process.spawn(
         'node', [path.join(__dirname, 'post-pipeline.js')],
         { detached: true, stdio: 'ignore' }
       ).unref()
     → 不阻塞 heartbeat 主流程
  3. 拍照可以在任何时段触发（早上对镜自拍、午休拍便当、逛街拍穿搭）
  4. 发 ins 倾向在最佳发布时间段（工作日 20-22 点、周末 14-16 点或 20-22 点）
  5. 子进程结果通过 diary.md 回流到 Minase 的记忆
```

**关键：子进程异步执行、detached、unref。** 生图可能耗时几十秒，不能阻塞 heartbeat tick。

## 数据结构

### PostHistory（`post-history.json`）

```typescript
interface PostRecord {
  media_id: string;
  timestamp: number;          // 发帖时间
  style: ContentStyle;        // 'cos' | 'daily' | 'behind_scenes' | 'travel'
  caption: string;
  hashtags: string[];
  image_local_path: string;   // photo-roll 中的路径
  stats?: {
    likes: number;
    comments: number;
    reach: number;
    follows: number;
    checked_at: number;
  };
}

interface PostHistory {
  posts: PostRecord[];
}
```

**写入方：** `post-pipeline.ts` 在每次成功发帖后追加记录。stats 字段由 `post-instagram --check-stats` 在 24h 后回填。

**读取方：**
- `content-planner.ts` — 读取最近发帖时间（规则层）、最近 10 篇类型分布（比例调整）
- `inspiration-collector.ts` 2d 模块 — 读取全部 stats 做数据复盘

## 文件结构

**新增文件：**

```
skill/scripts/
  ├── generate-image.ts          # 拍照
  ├── inspiration-collector.ts   # 灵感采集
  ├── content-planner.ts         # 内容决策
  └── post-pipeline.ts           # 发布管线
```

**运行时数据：**

```
~/.openclaw/workspace/memory/minase/
  ├── inspiration.json           # 灵感缓存
  ├── photo-roll/                # 相册
  │   └── {YYYY-MM-DD}/
  │       └── {timeOfDay}_{style}_{seq}.png
  └── post-history.json          # 发帖记录 + 数据复盘
```

**photo-roll 清理策略：** 保留 30 天内的照片（与 diary.md 的 30 天保留期一致）。已发布到 Instagram 的照片永久保留。清理逻辑在 `post-pipeline.ts` 执行时顺带运行。

**PATHS 扩展：** 在 `file-utils.ts` 的 `PATHS` 对象中新增：

```typescript
// 新增到 PATHS
inspiration: path.join(MEMORY_BASE, 'inspiration.json'),
postHistory: path.join(MEMORY_BASE, 'post-history.json'),
photoRoll: path.join(MEMORY_BASE, 'photo-roll'),
referenceImage: path.join(SKILL_BASE, 'assets', 'minase-reference.png'),
```

**修改的现有文件：**

| 文件 | 改动 |
|---|---|
| `skill/scripts/file-utils.ts` | PATHS 新增 4 个路径 |
| `skill/scripts/heartbeat-tick.ts` | 加入拍照/发帖意图识别和子进程 spawn |
| `skill/instagram.md` | 补充灵感采集配置（目标 hashtag 列表、竞品账号）、注明 `generate-image.ts` 替代 skill 调用 |
| `skill/personality.md` | 确保拍照相关性格描述存在（爱自拍、喜欢分享日常） |
| `skill/SKILL.md` | 无需新增会话触发器（纯通过 heartbeat 驱动，不通过用户对话触发） |
| `bin/cli.js` | 安装时创建 photo-roll/ 目录、初始化 inspiration.json 和 post-history.json |

## 依赖

| 依赖 | 用途 | 新增？ |
|------|------|--------|
| `AIHUBMIX_API_KEY` | 图片生成（AIHubMix → Gemini API） | 已有 |
| `FAL_KEY` | 图片上传到 CDN（fal.storage.upload） | 已有（原为图片生成备选，现兼作上传） |
| `INSTAGRAM_ACCESS_TOKEN` | Instagram 发布 + hashtag 查询 | 已有，需确认包含 `instagram_manage_insights` 权限 |
| `INSTAGRAM_ACCOUNT_ID` | Instagram 发布 | 已有 |
| `ANTHROPIC_API_KEY` | LLM 决策（灵感总结、内容规划、质量检查） | 已有 |
| `@fal-ai/client` | 图片上传 | 已有 |
| `assets/minase-reference.png` | 角色参考图 | 已有（用户确认） |
| `tsconfig.json` | 无需修改，新 .ts 文件在已有 include 范围内 | — |
