# Photo Pipeline Upgrade Design

## Overview

升级 Minase 的拍照 → 发帖系统，解决五个核心问题：自拍人脸一致性差、缺少视觉灵感参考、只能发单图、发帖节奏机械化、生活照不够真实。采用渐进增强方案，在现有 pipeline 上逐步叠加能力，每个模块可独立开发和验证。

## Approach

渐进增强（方案 A）。保持现有单次生成 → 质检 → 重试的核心流程，逐步叠加多角度参考、灵感图收集、多图生成、冲动值发帖、后处理调色等能力。如果后续多图一致性不够，再按需引入 session 滚雪球机制。

---

## Module 1: Face Consistency Enhancement

### Problem

当前用单张 `minase-reference.png` 做参考，质检阈值 6 分，1 次重试。自拍人脸经常不像。

### Design

**参考图集扩展：**

- 从 1 张扩展为 3-5 张多角度参考图
- 存放路径：`skill/assets/references/`
- 包含：`front.png`（正脸）、`left-profile.png`（左侧脸）、`right-profile.png`（右侧脸）、`half-body.png`（半身）、`full-body.png`（全身）

**参考图选择逻辑：**

新增 `selectReferences(style: ContentStyle, sceneDescription: string): string[]` 函数：

| 拍摄类型 | 选取的参考图 |
|----------|-------------|
| 自拍/正脸特写 | front + left-profile |
| 半身 cos/daily | front + half-body |
| 全身 cos/travel | half-body + full-body |
| 远景/风景为主 | full-body（仅 1 张） |

在多图模式下（Module 3），`generateImageSet()` 为每张 shot 调用 `selectReferences(style, shot.description)` 分别选取参考图，因为同一组图中不同 shot 可能需要不同的参考（如特写 vs 全身）。

**多参考图传入 API 的策略：**

当前 Gemini image-generation 模式支持在 `messages.content` 中传入多个 `image_url` content part（已在 `checkQuality()` 中验证过双图传入可行）。多张参考图的传入方式：

- 将每张参考图作为独立的 `image_url` content part 传入
- prompt 中明确标注每张参考图的用途（如"参考图1：正脸特征""参考图2：体型比例"）
- **Fallback：** 如果 API 在生成模式下拒绝多张图片输入（返回错误），自动降级为拼接方案 — 使用 jimp 将多张参考图拼接为一张 2xN 网格图传入，prompt 标注"左图为正脸参考，右图为体型参考"
- **最终 Fallback：** 如果拼接也失败，退回单张模式 — 使用 `selectReferences()` 返回的第一张（最相关的）参考图

**`generateImage()` 接口变更：**

```typescript
// Before
interface GenerateImageOptions {
  prompt: string;
  referenceImagePath: string;
  style?: ContentStyle;
  aspectRatio?: string;
  outputDir?: string;
}

// After
interface GenerateImageOptions {
  prompt: string;
  referenceImages: string[];        // 替代 referenceImagePath
  styleReference?: string;          // 灵感参考图（Module 2）
  style?: ContentStyle;
  aspectRatio?: string;
  outputDir?: string;
}
```

**质检增强：**

| 维度 | 自拍类 | 非自拍类 |
|------|--------|---------|
| 质检阈值 | 7 | 6（不变） |
| 重试次数 | 2 次 | 1 次（不变） |
| 质检 prompt 维度 | 五官轮廓、发型发色、体型比例 | 整体相似度 |
| 第二次重试修正 | 追加"保持人脸特征一致"指令 | — |

**判断是否"自拍类"的逻辑：**
- `style === 'daily'` 且 sceneDescription 包含自拍/特写/正脸相关关键词
- `style === 'cos'` 且非远景
- 保守判断：有疑问时按自拍类处理

### Files to Modify

- `skill/scripts/generate-image.ts` — 接口变更 + 多参考图支持 + 质检增强 + fallback 逻辑
- 新增 `skill/scripts/reference-selector.ts` — 参考图选择逻辑
- `skill/scripts/content-planner.ts` — `planPhoto()` 传递参考图信息
- `skill/assets/references/` — 新目录，放置 3-5 张参考图
- `bin/cli.js` — installer 复制 references 目录到安装路径

---

## Module 2: Inspiration Image Collection & Reference

### Problem

当前 `inspiration-collector.ts` 只保存文字信息，无法让 Minase 参考别人照片的构图/风格来拍照。

### Design

**收集阶段 — `collectInstagramTrends()` 增强：**

- 获取热门帖子时，同时保存缩略图 URL（需扩展 `instagram-bridge.py` 的 `hashtag_top` 命令返回 `thumbnail_url` 字段）
- LLM 扮演 Minase 从热门帖子中筛选"心动"图片（符合她审美偏好的）
- 下载选中图片到本地

**图片下载错误处理：**
- 下载超时：10 秒
- 最大文件大小：5MB
- 失败时静默跳过（log warning），不阻断灵感收集流程
- 下载后校验文件有效性（文件大小 > 0，检查 magic bytes 确认是图片格式）

**存储结构：**

```typescript
interface SavedReference {
  url: string;                // 原始 URL
  local_path: string;         // 本地路径
  source_hashtag: string;     // 来源话题
  style_tags: string[];       // 风格标签（LLM 生成）
  scene_description: string;  // 画面描述（LLM 生成）
  saved_at: number;           // 保存时间戳
}
```

- 图片存储路径：`~/.openclaw/workspace/memory/minase/inspiration-refs/`
- 元数据存入 `inspiration.json` 新增 `saved_references: SavedReference[]` 字段
- 上限 20 张，FIFO 淘汰
- 每次刷新时清理超过 7 天的旧图

**引用阶段：**

- `planPhoto()` 的 LLM prompt 新增 saved_references 列表（文件名 + scene_description + style_tags）
- Minase 决定是否参考某张灵感图
- `PhotoIntent` 新增可选字段：`referenceInspiration?: string`（灵感图文件名）

**传给 Gemini API 的区分：**

- 人脸参考图（`referenceImages`）→ 身份一致性用途，prompt 指令："保持人物外观与参考图一致"
- 灵感参考图（`styleReference`）→ 风格构图用途，prompt 指令："参考这张图的构图风格和氛围，但不要复制内容"
- 两类参考图在 API 调用时明确区分用途

### Files to Modify

- `skill/scripts/inspiration-collector.ts` — 新增图片下载 + LLM 筛选 + 存储管理
- `skill/scripts/content-planner.ts` — `planPhoto()` prompt 注入灵感图列表
- `skill/scripts/generate-image.ts` — 支持 `styleReference` 参数
- `skill/scripts/types.ts` — 新增 `SavedReference` 类型，`PhotoIntent` 新增字段，`InspirationData` 新增 `saved_references` 字段
- `skill/templates/photo-intent-prompt.md` — 新增灵感图片列表区块
- `skill/scripts/file-utils.ts` — 新增 `PATHS.inspirationRefs` 路径
- `skill/scripts/instagram-bridge.py` — `hashtag_top` 命令返回值新增 `thumbnail_url` 字段

---

## Module 3: Multi-Image Generation & Carousel Posts

### Problem

当前系统只能生成和发布单张图片，无法发轮播（carousel）。真人经常发多图组。

### Design

**PhotoIntent 扩展：**

```typescript
interface ShotDescription {
  description: string;   // 这张图拍什么
  angle: string;         // 机位/角度
  variation: string;     // 与其他图的差异点（表情、动作、远近）
}

interface PhotoIntent {
  wantToShoot: boolean;
  sceneDescription: string;
  style: ContentStyle;
  mood: string;
  reason: string;
  imageCount: number;           // 新增：计划张数
  shots: ShotDescription[];     // 新增：每张图描述
  referenceInspiration?: string; // Module 2
}
```

**类型驱动的默认数量范围：**

| 内容类型 | 数量范围 | 说明 |
|---------|---------|------|
| cos | 3-6 张 | 多角度/多表情组图 |
| daily | 1-2 张 | 随手拍，不需要太多 |
| behind_scenes | 2-4 张 | 过程记录 |
| travel | 4-8 张 | 旅行多场景 |

LLM 在范围内自行决定具体张数，输出完整 shots 列表。

**批量生成 — `generateImageSet()`：**

```typescript
interface GenerateSetOptions {
  shots: ShotDescription[];
  referenceImages: string[];
  styleReference?: string;
  style: ContentStyle;
  aspectRatio?: string;
  outputDir?: string;
}

interface GenerateSetResult {
  images: GenerateImageResult[];  // 通过质检的图片
  failed: number;                 // 未通过质检的张数
}
```

- 内部循环调用现有 `generateImage()`
- 所有图共享同一组人脸参考图 + 灵感参考图
- 每张图用各自的 shot description 作为场景 prompt
- 质检独立：每张图单独打分，不过关的单独重试
- 降级规则：剔除后剩余不足类型最小值时，整组降级为单图发帖（不放弃）

**Instagram 轮播上传：**

Python bridge 新增命令：

```python
# instagram-bridge.py 新增
elif args.command == 'upload_album':
    paths = json.loads(args.images)
    media = cl.album_upload(
        paths=[Path(p) for p in paths],
        caption=args.caption
    )
    print(json.dumps({"media_pk": str(media.pk)}))
```

TypeScript client 对应新增：

```typescript
async function uploadAlbum(imagePaths: string[], caption: string): Promise<string> {
  const result = await callInstagramBridge('upload_album', {
    images: JSON.stringify(imagePaths),
    caption
  });
  return (result as { media_pk: string }).media_pk;
}
```

Python bridge 解析时使用 `json.loads(args.images)` 获取路径数组（避免逗号分隔符在文件路径中冲突）。

`postToInstagram()` 改为检测图片数量：单张走 `upload_photo`，多张走 `upload_album`。

**PostIntent 扩展：**

```typescript
interface PostIntent {
  wantToPost: boolean;
  selectedPhotos: string[];   // 改为数组
  caption: string;
  hashtags: string[];
  reason: string;
}
```

- `planPost()` prompt 改为从 photo-roll 选一组图并排序
- 强调第一张图最重要（决定封面/首图印象）

**PostRecord 扩展：**

```typescript
interface PostRecord {
  media_id: string;
  timestamp: number;
  style: ContentStyle;
  caption: string;
  hashtags: string[];
  image_local_paths: string[];  // 改为数组
  image_url?: string;
  stats?: { ... };
}
```

- 向后兼容：读取旧记录时，如果存在 `image_local_path`（字符串），自动包装为 `[image_local_path]`

### Files to Modify

- `skill/scripts/types.ts` — 新增 `ShotDescription`，修改 `PhotoIntent`、`PostIntent`、`PostRecord`
- `skill/scripts/generate-image.ts` — 新增 `generateImageSet()`
- `skill/scripts/content-planner.ts` — `planPhoto()` 支持多图，`planPost()` 支持多选
- `skill/scripts/post-pipeline.ts` — 整合多图生成 + 轮播上传流程
- `skill/scripts/instagram-bridge-client.ts` — 新增 `uploadAlbum()`
- `skill/scripts/instagram-bridge.py` — 新增 `upload_album` 命令
- `skill/templates/photo-intent-prompt.md` — 注入数量范围 + 要求输出 shots 列表
- `skill/templates/post-intent-prompt.md` — 支持多图选择 + 排序

---

## Module 4: Organic Posting Rhythm

### Problem

固定 16h 间隔 + 每日 1 帖上限，节奏机械，缺乏活人感。

### Design

**移除硬性限制：**

- 移除 `MIN_POST_INTERVAL_MS = 16 * 60 * 60 * 1000`
- 移除每日 1 帖检查逻辑
- 新增柔性日上限：3 帖/24h，硬性不可突破（防异常）

**发帖冲动值模型：**

```typescript
interface PostImpulseState {
  value: number;          // 0-100
  last_post_at: number;   // 上次发帖时间戳
  posts_today_date: string; // 今日日期 (YYYY-MM-DD)，用于检测日期翻转
  posts_today: number;    // 今日已发帖数
}
```

- `days_since_post` 不存储，每次 tick 从 `last_post_at` 实时计算
- `posts_today` 在每 tick 开始时检查 `posts_today_date !== getLocalDate()`，若日期翻转则重置为 0
- 存储为独立文件 `PATHS.postImpulse`（`~/.openclaw/workspace/memory/minase/post-impulse.json`），与其他 state 文件（emotion-state.json、vitality-state.json）保持一致的 one-file-per-state 模式
- 默认初始值导出为命名常量 `DEFAULT_POST_IMPULSE: PostImpulseState = { value: 0, last_post_at: 0, posts_today_date: "", posts_today: 0 }`（遵循项目中 `DEFAULT_EMOTION`、`DEFAULT_VITALITY` 等命名约定）
- 使用现有 `readJSON(path, default)` 模式，文件不存在时自动使用默认值
- installer (`bin/cli.js`) 需将此文件加入初始化列表

**积累规则：**

| 来源 | 增量 | 触发条件 |
|------|------|---------|
| 拍出满意照片 | +20~30 | 质检通过的图片产生 |
| 灵感心动 | +10~15 | 刷到喜欢的内容并保存 |
| 情绪高涨 | +5~10/tick | emotion valence > 0.6 且 arousal > 0.5 |
| 创作 intent | 联动 | 与现有 intent engine 的创作类 intent 值正相关 |
| 沉寂兜底 | +50 | 连续 5 天未发帖，强制注入 |

**衰减规则：**

| 条件 | 衰减量/tick |
|------|-----------|
| 基础衰减 | -3 |
| 24h 内已发 1 帖 | 额外 -5 |
| 24h 内已发 2 帖 | 额外 -15 |
| 发帖后 | 立即归零 |

**触发逻辑（职责分离）：**

- **heartbeat-tick.ts**：每 tick 计算冲动值积累/衰减。当冲动值 >= 70 时，在 LLM 决策 context 中注入"想发帖的冲动很强"，作为 LLM 选择 post-pipeline action 的强信号
- **shouldConsiderPosting()**：仅检查硬性约束 — `posts_today < 3`（日上限）。不检查冲动值。函数签名保留向后兼容，内部移除 16h 间隔和每日 1 帖检查
- **post-pipeline.ts**：发帖后冲动值归零，更新 `last_post_at` 和 `posts_today`

**预期节奏效果：**

- 拍了一组好照片 → 冲动值飙升 → 可能当天连发 2 帖
- 连续几天没灵感 → 冲动值低迷 → 2-3 天不发帖
- 刷到别人好内容被激发 → 冲动值慢慢积累 → 隔天发帖
- 极端情况：沉寂 5 天后兜底触发，不会让账号死寂

### Files to Modify

- `skill/scripts/content-planner.ts` — `shouldConsiderPosting()` 改为仅检查 `posts_today < 3`
- `skill/scripts/heartbeat-tick.ts` — 冲动值积累/衰减逻辑，注入 LLM context
- `skill/scripts/types.ts` — 新增 `PostImpulseState`
- `skill/scripts/post-pipeline.ts` — 发帖后冲动值归零 + 更新 posts_today
- `skill/scripts/file-utils.ts` — 新增 `PATHS.postImpulse` 路径
- `bin/cli.js` — 初始化 post-impulse.json 默认值

---

## Module 5: Realistic Life Photos

### Problem

AI 生成的生活照/风景照看起来太"完美"，缺乏手机随拍的真实感。

### Design

**Prompt 层 — `buildRealisticPrompt(style, sceneDescription)`：**

按内容类型注入手机拍摄特征：

| 类型 | 注入的 prompt 特征 |
|------|------------------|
| daily | "用 iPhone 拍摄，自然光线，轻微过曝，浅景深，手持微晃感，非专业构图，主体偶尔偏离中心，背景有生活杂物，像发给朋友看的随手拍" |
| behind_scenes | "手机随手拍的花絮，光线一般，有工作台杂物，未完成感，不是摆拍" |
| travel | "手机广角，自然色彩，有游客感，背景有路人，光线不完美，有时逆光或阴影" |
| cos | 不注入手机质感（cos 照本来就是认真拍的，保持精致风格） |

**后处理层 — `postProcessImage(imagePath: string, style: ContentStyle, groupSeed?: number): Promise<string>`：**

新函数。`groupSeed` 由 `generateImageSet()` 通过 `Math.random() * 2**32 | 0` 生成一次，传给组内所有图片。groupSeed 用于初始化一个简易确定性 PRNG（如 mulberry32），使同组图片的随机参数偏移一致。返回处理后的图片路径（写入新文件，后缀 `_processed`，如 `morning_cos_1_processed.png`，保留原始文件作为回退）。

使用 jimp（纯 JS 图片处理库，无 native 依赖，通过 npm 安装即可在所有平台运行，避免 sharp 的 native addon 导致的安装问题）：

| 类型 | 处理 |
|------|------|
| daily | 轻微降低锐度、加 1-2% 高斯噪点、随机微调色温（偏暖或偏冷） |
| behind_scenes | 略微降低对比度、偏暖色调 |
| travel | 轻微提高饱和度、加暗角 |
| cos | 不处理或仅轻微锐化 |
| 未知类型 | 按 daily 处理（安全默认值） |

**随机性：**
- 每张图的处理参数有 ±10% 随机波动
- 避免每张图滤镜效果完全一致

**整组一致性：**
- `generateImageSet()` 生成一个 `groupSeed` 随机种子
- 同组图共享基础滤镜参数（同一次出门的照片色调一致）
- 组内波动缩小到 ±3%，组间波动保持 ±10%

**偏好演化：**
- Minase 的 `preferences.json` 中可记录调色倾向（如"最近喜欢偏暖的色调"）
- nightly reflection 可更新此偏好
- `postProcessImage()` 读取偏好作为基础色调偏移

### Files to Modify

- `skill/scripts/generate-image.ts` — `buildRealisticPrompt()` 函数 + 后处理集成
- 新增 `skill/scripts/image-post-process.ts` — 后处理逻辑
- `skill/scripts/post-pipeline.ts` — 生成后调用后处理
- `package.json` — 新增 `jimp` 依赖

---

## Data Flow Summary

```
Heartbeat Tick
  → impulse >= 70? → inject "想发帖" into LLM context
  → LLM chooses post-pipeline action
  → Vitality gate (>30)
  → Spawn post-pipeline process

Post Pipeline:
  1. refreshInspiration()
     → collectInstagramTrends() [enhanced: save images]
     → LLM filters "心动" images → save to inspiration-refs/
     → impulse += 10~15 if saved new refs

  2. planPhoto()
     → inject inspiration refs list + content type ranges
     → LLM outputs: style, imageCount, shots[], referenceInspiration?

  3. generateImageSet()
     → for each shot:
        → selectReferences(style, shot.description) → pick 2-3 face refs per shot
        → buildRealisticPrompt(style, shot.description)
        → generateImage(prompt, referenceImages, styleReference?)
        → qualityCheck (threshold 7 for selfie, 6 for others)
        → retry up to 2x for selfie, 1x for others
     → postProcessImage(each image, style, groupSeed)
     → drop failed images, degrade to single if below minimum
     → impulse += 20~30

  4. shouldConsiderPosting()
     → check posts_today < 3 (hard gate only)
     → impulse check is in heartbeat, not here

  5. planPost()
     → LLM selects + orders photos from photo-roll
     → outputs: selectedPhotos[], caption, hashtags

  6. postToInstagram()
     → single image → upload_photo
     → multiple images → upload_album
     → record to post-history.json
     → impulse = 0
```

## Backward Compatibility

- `PostRecord.image_local_path` → `image_local_paths: string[]`：读取旧记录时自动 `[path]` 包装。影响范围：`post-pipeline.ts` 的 `cleanupPhotoRoll()`、`checkPostStats()`、`content-planner.ts` 的 `getRecentStyleDistribution()` 和 `formatRecentPerformance()`
- `generateImage()` 的旧 `referenceImagePath` 参数移除，统一用 `referenceImages: string[]`。影响范围：`post-pipeline.ts` 中 `generateImage({ referenceImagePath: PATHS.referenceImage })` 调用需更新
- `PostIntent.selectedPhoto` → `selectedPhotos: string[]`：模板输出格式变更
- `shouldConsiderPosting()`：函数签名保留（接收 `history` 参数），内部移除 16h 间隔和每日 1 帖检查，改为从 `history.posts` 中计算今日已发帖数（过滤 `timestamp` 在今日范围内的记录），仅检查该数 < 3。不读取 `PostImpulseState`，保持函数的纯输入依赖

## API Cost & Rate Limiting

- 每张图最坏情况：1 次生成 + 2 次质检重试 = 3 次 API 调用
- 一组 travel 8 张：最坏 24 次 API 调用，预计实际 10-12 次（多数图一次通过）
- 质检调用串行执行（每张图生成 → 质检 → 判断是否重试），不并行，自然限制 QPS
- 如果 AIHubMix 返回 429 rate limit，使用现有 exponential backoff（5s base delay）重试

## New Dependencies

- `jimp` — 纯 JS 图片后处理（锐度/噪点/色温/暗角），无 native 依赖，跨平台兼容

## New Files

- `skill/scripts/reference-selector.ts` — 参考图选择逻辑
- `skill/scripts/image-post-process.ts` — 后处理逻辑
- `skill/assets/references/` — 多角度参考图目录（需要用户提供图片）

## Testing Strategy

- **Unit tests** for each new module: reference-selector, image-post-process, post-impulse logic
- **Unit tests** for selfie detection classification（关键词匹配的 true/false 边界用例）
- **Unit tests** for multi-reference fallback chain（multi-image → grid composite → single）
- **Integration test** for `generateImageSet()` with mock API
- **Integration test** for `uploadAlbum()` with mock Instagram bridge
- **Backward compatibility test** for old PostRecord format reading（`image_local_path` → `image_local_paths` 自动迁移）
- **Impulse model simulation** to verify rhythm patterns match expectations（5 天沉寂兜底、连发 2 帖、日上限 3 帖）

## Documentation Updates

- 实现完成后更新 `CLAUDE.md` 中的 Post Pipeline 描述（步骤变更：多图生成、冲动值门控、后处理）
- 更新 `CLAUDE.md` 中的 Heartbeat System 描述（新增 post-impulse engine）
