# 爆款内容自动沉淀知识库 — 设计文档

**日期**: 2026-04-09
**状态**: 待实现
**作者**: Brainstorming session

---

## 背景与目标

当推荐流/竞品账号中出现高热度内容（点赞 >5000）时，自动进行结构化拆解并分类沉淀到知识库，形成可被内容生成流程复用的爆款规律库。

**目标用户**：
- `topic-generator.ts` 内容生成流程（自动消费）
- 运营人员（通过 `/alive kb` 命令人工查询）

**现有覆盖**：`trend-analyzer.ts` 抓取热点、`competitor-tracker.ts` 监控竞品、`topic-generator.ts` 生成草稿时注入竞品 benchmark。
**缺口**：无爆款自动检测→拆解→分类→知识库沉淀→反馈闭环。

---

## 方案选择

采用**分层模块方案**（方案 B）：3个内聚模块 + 1个数据层，与现有 `ops/` 目录下5个模块风格一致，每个模块职责单一，可独立测试。

---

## 数据模型

### `ViralEntry` — 爆款条目

```ts
interface ViralEntry {
  id: string                    // hash(platform + source_id)
  platform: "douyin" | "xhs"   // 平台隔离
  source_id: string             // 原始内容 ID
  source_type: "competitor" | "trending_feed" | "search"
  persona_id: string            // 归属 persona（多 persona 隔离）

  // 原始数据
  title: string
  description: string
  likes: number
  comments: number
  shares: number
  collected_at: string          // ISO timestamp

  // 6维拆解（LLM 产出）
  dissection: {
    hook_type: string           // 如"反问式"/"数字冲击"/"悬念留白"
    content_type: string        // 如"工具类"/"种草类"/"情绪类"/"赛事解读"
    identity_mode?: string      // 赛道标记，如"esports_commentator"；null = 通用
    emotion_arc: string         // 情绪弧线描述，如"焦虑→共鸣→解脱"
    interaction_design: string  // 互动引导手法
    visual_style: string        // 视觉风格特征
    cta_type: string            // 结尾 CTA，如"评论区投票"/"关注解锁"
    summary: string             // 一句话爆款逻辑总结
  }

  dissection_status: "pending" | "done" | "failed"
  kb_tier: "track" | "universal"  // 赛道爆款 or 通用爆款
  promoted_to_template: boolean   // 是否已升级为正式模板
  times_referenced: number        // 被生成流程引用次数
}
```

**分类规则**：
- `identity_mode` 非空 → `kb_tier = "track"`（赛道爆款）
- `identity_mode` 为 null → `kb_tier = "universal"`（通用爆款）

### `UniversalFormula` — 通用爆款公式（升级产物）

```ts
interface UniversalFormula {
  id: string
  platform: "douyin" | "xhs"
  content_type: string
  hook_type: string
  formula_summary: string       // 提炼的可复用公式描述
  source_entry_ids: string[]    // 来源 ViralEntry id 列表
  occurrence_count: number      // 出现次数（≥3 触发升级）
  injected_to_templates: boolean
  created_at: string
  last_seen_at: string
}
```

**升级阈值**：同 `platform + content_type + hook_type` 组合出现 ≥3 次 → 自动生成 `UniversalFormula` 并注入 `persona.yaml`。

### 存储路径

```
{MEMORY_BASE}/viral-kb/
  entries.json        # ViralEntry[]
  formulas.json       # UniversalFormula[]
  dissect-queue.json  # 待拆解队列（去重用）
```

---

## 模块架构

```
alive/scripts/ops/
  viral-detector.ts      # 从 ops-trends 输出筛选爆款候选
  content-dissector.ts   # LLM 6维结构化拆解
  viral-kb-store.ts      # 知识库 CRUD + 通用公式升级逻辑

alive/sub-skills/ops-desk/scripts/
  kb-query.ts            # /alive kb slash command 处理

alive/scripts/lifecycle/
  ops-trends.ts          # [修改] 末尾调用 viral-detector + content-dissector
  ops-brief.ts           # [修改] brief 中包含知识库升级事件

alive/scripts/ops/
  topic-generator.ts     # [修改] 生成草稿前注入赛道爆款 Top3
```

---

## 处理流程

### 主流程（每小时随 ops-trends 运行）

```
ops-trends.ts（每小时）
    │
    ├─ 抓取 douyin-hot-trend + daily-hot-news（现有）
    ├─ 速度评分 + LLM 相关性过滤（现有）
    │
    └─→ viral-detector.ts（新增）
            │  筛选：likes > viral_threshold AND 未入库
            └─→ dissect-queue.json（追加候选，去重）

    └─→ content-dissector.ts（新增）
            │  从队列取最多 N 条（默认3）
            │  LLM 拆解 6维 + 判断 kb_tier
            └─→ viral-kb-store.ts（新增）
                    │  写入 entries.json
                    │  通用路径：检查升级条件，occurrence ≥3 → 生成公式 → 注入模板
                    │  赛道路径：仅入库
                    └─→ 升级事件写入 ops-brief-log.json
```

### `viral-detector.ts` 筛选条件

- `likes > ops.viral_threshold`（默认 5000，persona 可配置）
- `platform in ["douyin", "xhs"]`
- `id not in entries.json`（去重）
- `id not in dissect-queue.json`（防重复入队）
- **不新增网络请求**，复用 ops-trends 已有的抓取结果

### `content-dissector.ts` LLM Prompt 核心结构

```
你是内容分析专家。请对以下{platform}内容进行结构化拆解：

标题：{title}
描述：{desc}
点赞：{likes} | 评论：{comments} | 分享：{shares}
账号赛道（如已知）：{identity_mode or "未知"}

请输出 JSON：
{
  "hook_type": "",
  "content_type": "",
  "identity_mode": null,
  "emotion_arc": "",
  "interaction_design": "",
  "visual_style": "",
  "cta_type": "",
  "summary": ""
}

identity_mode 规则：若内容明显属于特定垂直赛道（如电竞/美妆/赛车）填写，否则返回 null。
```

### 批处理量控制

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `ops.viral_threshold` | 5000 | 点赞阈值 |
| `ops.kb_dissect_batch` | 3 | 每次最多拆解条数（1-10，控成本） |

---

## 反馈集成

### 1. 赛道爆款 → 软注入 `topic-generator.ts`

生成每条草稿前新增 `queryTrackPatterns()` 步骤：

```
generateDraft(trend, identityMode, platform)
    │
    ├─ [新增] viral-kb-store.queryTrack({
    │     platform, identity_mode: identityMode, limit: 3, sort: "recency"
    │  })
    │  → 返回 ViralEntry[] Top3（按收录时间降序）
    │
    └─ 注入 prompt 额外段落：
       "近期{platform}【{identity_mode}】赛道爆款规律（供参考）：
        1. 钩子：{hook_type} | 情绪弧：{emotion_arc} | 互动：{interaction_design}
           一句话逻辑：{summary}
        ..."
```

冷启动期（无匹配记录）：静默跳过，不影响现有逻辑。

### 2. 通用爆款 → 自动升级 `content_templates[]`

```
checkFormulaPromotion(entry)
    │
    ├─ formulas.json 中查找同 platform + content_type + hook_type
    ├─ 不存在 → 新建 UniversalFormula（count = 1）
    ├─ count < 3 → count++，更新 last_seen_at
    └─ count == 3 → 触发升级：
            └─ 生成 ContentTemplate：
               { type, platform, scene: formula_summary,
                 hook_suggestion, cta, source: "auto_promoted",
                 promoted_at }
               → 追加到 persona.yaml ops.content_templates[]
               → 写升级日志到 ops-brief-log.json
```

**保护机制**：
- 每次运行最多升级 1 个公式（防批量污染）
- `source: "auto_promoted"` 标记，人工可识别并清理
- 升级事件出现在 daily brief 中

### 3. `/alive kb` 人工查询

在 `command-handler.ts` 新增 `kb` 子命令：

| 命令 | 说明 |
|------|------|
| `/alive kb status` | 统计信息（总条数/平台分布/队列长度） |
| `/alive kb search <关键词>` | 全文搜索 summary + content_type |
| `/alive kb list --platform douyin --type 种草类` | 按平台+类型列出 |
| `/alive kb formulas` | 列出所有通用公式 |
| `/alive kb top --platform xhs --limit 5` | 按 likes 排列 Top N |

输出格式：Markdown 表格，每条显示 `content_type | hook_type | emotion_arc | likes | summary`。

---

## Persona 配置扩展

`persona.yaml` 新增两个可选字段：

```yaml
ops:
  viral_threshold: 5000      # 点赞阈值，默认5000
  kb_dissect_batch: 3        # 每次拆解条数，默认3
```

---

## 新增文件清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `scripts/ops/viral-detector.ts` | 新增 | 爆款候选筛选 |
| `scripts/ops/content-dissector.ts` | 新增 | LLM 6维拆解 |
| `scripts/ops/viral-kb-store.ts` | 新增 | 知识库 CRUD + 升级逻辑 |
| `sub-skills/ops-desk/scripts/kb-query.ts` | 新增 | `/alive kb` 命令处理 |
| `tests/viral-detector.test.ts` | 新增 | 单元测试 |
| `tests/content-dissector.test.ts` | 新增 | 单元测试 |
| `tests/viral-kb-store.test.ts` | 新增 | 单元测试（含升级逻辑） |
| `tests/kb-query.test.ts` | 新增 | 单元测试 |

## 修改文件清单

| 文件 | 说明 |
|------|------|
| `scripts/lifecycle/ops-trends.ts` | 末尾调用 viral-detector + content-dissector |
| `scripts/lifecycle/ops-brief.ts` | brief 中包含知识库升级事件 |
| `scripts/ops/topic-generator.ts` | 生成草稿前注入赛道爆款 Top3 |
| `scripts/admin/command-handler.ts` | 新增 `kb` 子命令分发 |
| `persona-schema.yaml` | 新增 `viral_threshold`、`kb_dissect_batch` 字段说明 |
| `CLAUDE.md` | 更新架构文档 |

---

## 测试策略

- **单元测试**：每个新模块独立测试，mock LLM 调用和文件 I/O
- **升级逻辑测试**：验证 occurrence_count < 3 不触发升级，== 3 正确生成公式并注入模板
- **冷启动测试**：知识库为空时 topic-generator 行为不变
- **去重测试**：同一 source_id 不重复入队/入库
- **保护机制测试**：单次运行升级条数上限为 1

---

## 不在本次范围内

- 自家账号发布内容的表现回收（仅监控推荐流/竞品）
- 跨 persona 的知识库共享
- 知识库条目的手工编辑界面
- 相似度/语义搜索（仅关键词 + 过滤）
