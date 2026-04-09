# 爆款内容自动沉淀知识库 — 实现计划

**设计文档**: `2026-04-09-viral-content-kb-design.md`
**日期**: 2026-04-09

---

## 阶段概览

```
Phase 1: 数据层 + 核心模块（无副作用，可独立测试）
Phase 2: 流程接入（ops-trends 调用链）
Phase 3: 反馈集成（topic-generator + 模板升级）
Phase 4: 人工查询（/alive kb 命令）
Phase 5: 测试 + 配置 + 文档
```

---

## Phase 1：数据层 + 核心模块

### Step 1.1 — 定义类型

**文件**：`alive/scripts/utils/types.ts`（已存在，追加）

新增以下类型定义：

```ts
// 爆款知识库
export interface ViralEntry { ... }        // 见设计文档
export interface UniversalFormula { ... }  // 见设计文档
export interface DissectQueue {
  items: DissectQueueItem[]
}
export interface DissectQueueItem {
  id: string
  platform: "douyin" | "xhs"
  source_id: string
  source_type: "competitor" | "trending_feed" | "search"
  title: string
  description: string
  likes: number
  comments: number
  shares: number
  queued_at: string
  identity_mode?: string
}
```

### Step 1.2 — `viral-kb-store.ts`

**文件**：`alive/scripts/ops/viral-kb-store.ts`（新增）

实现以下函数（全部使用 `file-utils.ts` 的 readJson/writeJson，immutable 模式）：

```ts
// 读写
loadEntries(basePath): ViralEntry[]
saveEntries(basePath, entries): void
loadFormulas(basePath): UniversalFormula[]
saveFormulas(basePath, formulas): void
loadQueue(basePath): DissectQueueItem[]
saveQueue(basePath, items): void

// 业务
addToQueue(basePath, item): void           // 去重后追加
dequeueItems(basePath, n): DissectQueueItem[]  // 取出并从队列移除
upsertEntry(basePath, entry): void         // 新增或更新
checkFormulaPromotion(basePath, entry, personaConfigPath): PromotionResult
  // PromotionResult: { promoted: boolean, formula?: UniversalFormula }
  // 每次调用最多升级 1 个公式

// 查询
queryTrack(basePath, opts: { platform, identity_mode, limit, sort }): ViralEntry[]
queryAll(basePath, opts: { platform?, type?, keyword?, limit? }): ViralEntry[]
queryFormulas(basePath, opts: { platform? }): UniversalFormula[]
getStats(basePath): KBStats
  // KBStats: { total, by_platform, by_tier, queue_length, formula_count }
```

**测试**：`alive/tests/viral-kb-store.test.ts`
- upsert 去重
- checkFormulaPromotion: count 1→2→3 正确升级，单次上限1个
- queryTrack 正确过滤 platform + identity_mode
- 冷启动（空文件）不报错

---

### Step 1.3 — `viral-detector.ts`

**文件**：`alive/scripts/ops/viral-detector.ts`（新增）

```ts
interface TrendItem {       // ops-trends 已有类型，确认或补充
  id: string
  platform: "douyin" | "xhs"
  title: string
  description: string
  likes: number
  comments: number
  shares: number
  source_type: "competitor" | "trending_feed" | "search"
  identity_mode?: string
}

function detectViral(
  items: TrendItem[],
  basePath: string,
  threshold: number      // ops.viral_threshold，默认5000
): DissectQueueItem[]
  // 过滤 likes > threshold
  // 排除已在 entries.json 中的 id
  // 排除已在 queue 中的 id
  // 返回新候选列表（不写文件，由调用方决定）
```

**测试**：`alive/tests/viral-detector.test.ts`
- 低于阈值的过滤掉
- 已入库的去重
- 已在队列的去重
- 空输入返回 []

---

### Step 1.4 — `content-dissector.ts`

**文件**：`alive/scripts/ops/content-dissector.ts`（新增）

```ts
async function dissectBatch(
  items: DissectQueueItem[],
  llmClient: LLMClient,
  personaId: string
): Promise<ViralEntry[]>
  // 对每个 item 调用 LLM（见设计文档 prompt 结构）
  // 解析 JSON 输出，填充 dissection 字段
  // identity_mode 非 null → kb_tier = "track"；null → "universal"
  // LLM 解析失败 → dissection_status = "failed"，仍返回条目
  // tag: "viral-dissector" 用于 llm-call-log
```

**测试**：`alive/tests/content-dissector.test.ts`
- mock LLM 返回正确 JSON → 正确映射6维
- LLM 返回无效 JSON → status = "failed"，不抛出
- identity_mode null → kb_tier = "universal"
- identity_mode 有值 → kb_tier = "track"

---

## Phase 2：流程接入

### Step 2.1 — 修改 `ops-trends.ts`

**文件**：`alive/scripts/lifecycle/ops-trends.ts`（修改）

在现有流程末尾（速度评分+相关性过滤之后）追加：

```ts
// 1. 检测爆款候选
const threshold = persona.ops?.viral_threshold ?? 5000
const candidates = detectViral(trendItems, basePath, threshold)
if (candidates.length > 0) {
  addToQueue(basePath, ...candidates)
  logger.info(`[viral-kb] ${candidates.length} candidates queued`)
}

// 2. 批量拆解
const batchSize = persona.ops?.kb_dissect_batch ?? 3
const toProcess = dequeueItems(basePath, batchSize)
if (toProcess.length > 0) {
  const entries = await dissectBatch(toProcess, llmClient, persona.meta.id)
  for (const entry of entries) {
    upsertEntry(basePath, entry)
    const result = checkFormulaPromotion(basePath, entry, personaConfigPath)
    if (result.promoted) {
      appendOpsBriefLog(basePath, {
        type: "formula_promoted",
        formula: result.formula,
        timestamp: wallNow()
      })
    }
  }
}
```

**注意**：若 `ops.enabled` 为 false，跳过整块逻辑（与现有 ops 门控一致）。

---

## Phase 3：反馈集成

### Step 3.1 — 修改 `topic-generator.ts`

**文件**：`alive/scripts/ops/topic-generator.ts`（修改）

在 `generateDraft()` 中，LLM prompt 构建之前插入：

```ts
// 查赛道爆款 Top3
const trackPatterns = queryTrack(basePath, {
  platform: draft.platform,
  identity_mode: identityMode,
  limit: 3,
  sort: "recency"
})

// 构建注入段落（有数据才注入）
const viralContext = trackPatterns.length > 0
  ? buildViralContext(trackPatterns, platform)  // 格式化成 prompt 段落
  : ""
```

`buildViralContext()` 输出格式：
```
近期{platform}上【{identity_mode}】赛道爆款规律（供参考，不强制模仿）：
1. 钩子：{hook_type} | 情绪弧：{emotion_arc} | 互动：{interaction_design}
   一句话逻辑：{summary}
...
```

同时将 `times_referenced` +1（`upsertEntry` 更新）。

### Step 3.2 — 升级逻辑写入 `persona.yaml`

`checkFormulaPromotion` 在升级时需要修改 `persona.yaml`：

- 读取 `personaConfigPath` 对应的 yaml
- 在 `ops.content_templates[]` 末尾追加新模板对象
- 写回（使用 `file-utils` 的备份机制）
- 新模板标记 `source: "auto_promoted"`，方便人工清理

---

## Phase 4：人工查询命令

### Step 4.1 — `kb-query.ts`

**文件**：`alive/sub-skills/ops-desk/scripts/kb-query.ts`（新增）

```ts
export async function handleKbCommand(
  args: string[],   // "/alive kb <subcommand> [flags]" 解析后的参数
  basePath: string
): Promise<string>  // 返回 Markdown 格式字符串
```

子命令路由：

| args[0] | 调用 | 输出 |
|---------|------|------|
| `status` | `getStats()` | 统计文字 |
| `search <kw>` | `queryAll({ keyword })` | Markdown 表格 |
| `list` | `queryAll({ platform, type })` | Markdown 表格 |
| `formulas` | `queryFormulas()` | Markdown 表格 |
| `top` | `queryAll({ platform, limit, sort:"likes" })` | Markdown 表格 |
| 其他 / 无 | — | 帮助文字 |

**flags 解析**（复用 command-handler 现有的简单 flag 解析模式）：
- `--platform douyin/xhs`
- `--type <类型名>`
- `--limit <n>`

### Step 4.2 — 修改 `command-handler.ts`

**文件**：`alive/scripts/admin/command-handler.ts`（修改）

在 switch/dispatch 中新增 `kb` case：

```ts
case "kb":
  return handleKbCommand(subArgs, basePath)
```

**帮助文字**更新：在 `/alive help` 输出中新增 `kb` 子命令说明。

**测试**：`alive/tests/kb-query.test.ts`
- status 输出含平台分布
- search 返回匹配条目
- list 支持 platform + type 过滤
- formulas 列出公式
- 未知子命令返回帮助文字

---

## Phase 5：配置 + 测试 + 文档

### Step 5.1 — `persona-schema.yaml` 新增字段

```yaml
ops:
  viral_threshold:
    type: integer
    default: 5000
    description: 点赞阈值，超过此值的内容进入爆款知识库候选队列
  kb_dissect_batch:
    type: integer
    default: 3
    min: 1
    max: 10
    description: 每次 ops-trends 运行时最多拆解的爆款条数（控制 LLM 成本）
```

### Step 5.2 — 更新 `CLAUDE.md`

- `scripts/ops/` 表格新增3个模块说明
- Memory File Paths 新增3个路径
- Ops Desk 节描述更新

### Step 5.3 — 集成测试

**文件**：`alive/tests/viral-kb-integration.test.ts`

场景：
1. ops-trends 输出含2条爆款候选 → 正确入队
2. 拆解2条 → entries.json 有2条记录
3. 第3次出现同一公式组合 → persona.yaml 模板增加1条，标记 `auto_promoted`
4. topic-generator 生成草稿，有匹配赛道记录 → prompt 包含 viralContext
5. topic-generator 生成草稿，无匹配记录 → prompt 不含 viralContext，功能正常

---

## 实现顺序（依赖链）

```
Step 1.1 (types)
    ↓
Step 1.2 (store) ← 独立，可先测试
Step 1.3 (detector) ← 依赖 store（去重查询）
Step 1.4 (dissector) ← 独立，mock LLM 测试
    ↓
Step 2.1 (ops-trends 接入) ← 依赖 1.2 + 1.3 + 1.4
    ↓
Step 3.1 (topic-generator 注入) ← 依赖 1.2
Step 3.2 (persona.yaml 写入) ← 依赖 1.2
    ↓
Step 4.1 (kb-query) ← 依赖 1.2
Step 4.2 (command-handler) ← 依赖 4.1
    ↓
Step 5.1-5.3 (配置 + 文档 + 集成测试) ← 全部完成后
```

---

## 文件变更总表

| 文件 | 操作 |
|------|------|
| `alive/scripts/utils/types.ts` | 修改：追加3个接口 |
| `alive/scripts/ops/viral-kb-store.ts` | **新增** |
| `alive/scripts/ops/viral-detector.ts` | **新增** |
| `alive/scripts/ops/content-dissector.ts` | **新增** |
| `alive/sub-skills/ops-desk/scripts/kb-query.ts` | **新增** |
| `alive/scripts/lifecycle/ops-trends.ts` | 修改：末尾追加爆款处理逻辑 |
| `alive/scripts/ops/topic-generator.ts` | 修改：注入赛道爆款上下文 |
| `alive/scripts/admin/command-handler.ts` | 修改：新增 `kb` 子命令 |
| `alive/persona-schema.yaml` | 修改：新增2个 ops 字段 |
| `alive/CLAUDE.md` | 修改：更新架构描述 |
| `alive/tests/viral-kb-store.test.ts` | **新增** |
| `alive/tests/viral-detector.test.ts` | **新增** |
| `alive/tests/content-dissector.test.ts` | **新增** |
| `alive/tests/kb-query.test.ts` | **新增** |
| `alive/tests/viral-kb-integration.test.ts` | **新增** |
