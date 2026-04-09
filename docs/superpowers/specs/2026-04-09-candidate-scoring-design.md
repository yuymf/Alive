# 候选账号综合推荐评分 — 设计文档

**日期**: 2026-04-09
**状态**: 已批准，待实现
**范围**: `alive/scripts/ops/` — 候选对标账号发现与推荐逻辑强化

---

## 背景

现有 `discovery-engine.ts` 已实现候选账号发现闭环（`CandidateAccount` + `processInspirationForAccountDiscovery`），但推荐排序仅按 `avg_engagement` 单维度排序，无法区分"多赛道重叠的跨界选手"和"单赛道高互动账号"，也无法捕捉账号的短期爆发信号。

**目标**：加入综合评分逻辑，推荐标准为"**多 Persona identity 赛道重叠 × 有短期爆款帖（peak engagement 远超均值）× 高频出现**"。

---

## 方案选择

采用**方案 B — 独立 Scorer 模块**：

- 新增 `candidate-scorer.ts`，专门负责综合打分
- `CandidateAccount` 存原始数据，分数在需要时实时计算（不持久化）
- 与现有 `competitor-analyzer.ts`、`trend-analyzer.ts` 保持一致的模块化风格
- 评分公式集中在一处，调权重只改一个文件，纯函数易单元测试

---

## 数据模型变更

### `CandidateAccount` 新增字段（`discovery-engine.ts`）

```ts
peak_engagement: number;   // 历史所有出现记录里互动最高的一次（代表爆款帖点赞）
score_breakdown?: {        // 可选，调试/展示用，存上次计算结果
  track_overlap: number;   // 0–1
  burst_intensity: number; // 0–1
  frequency: number;       // 0–1
  composite: number;       // 0–1
};
```

**维护策略**（在 `processInspirationForAccountDiscovery` 中）：
- 新候选：`peak_engagement = item.engagement`
- 已有候选：`peak_engagement = Math.max(existing.peak_engagement, item.engagement)`

不需要历史时间序列，单字段即可捕捉"最近爆款帖"强度。

**向后兼容**：读取旧数据时，`peak_engagement` 缺失则 fallback 到 `avg_engagement`（不会 crash）。

---

## 新模块：`candidate-scorer.ts`

路径：`alive/scripts/ops/candidate-scorer.ts`

### 导出接口

```ts
export interface ScoredCandidate extends CandidateAccount {
  score_breakdown: {
    track_overlap: number;    // 0–1
    burst_intensity: number;  // 0–1
    frequency: number;        // 0–1
    composite: number;        // 0–1，最终综合分
  };
}

// 给单个候选账号打分（纯函数，可单测）
export function scoreCandidateAccount(
  candidate: CandidateAccount,
  identityKeys: string[],         // persona identities 键列表，如 ['singer','racer','esports','daily']
  peerCandidates: CandidateAccount[],  // 同批，用于 avg_engagement 百分位（备用）
): ScoredCandidate

// 给整批候选账号排序（由 brief / /candidates 调用）
export function rankCandidates(
  store: CandidateAccountsStore,
  identityKeys: string[],
  statusFilter?: 'pending' | 'approved' | 'dismissed',
): ScoredCandidate[]
```

### 评分公式

| 维度 | 计算逻辑 | 权重 |
|------|----------|------|
| **赛道重叠率** `track_overlap` | 遍历 `candidate.topics`，对每个 topic 做关键词模糊匹配，统计命中几个不同 `identityKey`，除以 `identityKeys.length` | **0.45** |
| **爆发强度** `burst_intensity` | `Math.min(peak_engagement / Math.max(avg_engagement, 1), 5) / 5`（peak/avg capped 5x，归一到 0–1） | **0.35** |
| **出现频率** `frequency` | `Math.min(appearance_count / 5, 1)`（≥5 次即满分） | **0.20** |

**综合分** = `track_overlap × 0.45 + burst_intensity × 0.35 + frequency × 0.20`

### 赛道关键词表

模块顶部维护，简单可扩展：

```ts
const IDENTITY_KEYWORDS: Record<string, string[]> = {
  singer:  ['音乐','唱歌','歌曲','vocal','翻唱','原创','mv','歌手','单曲'],
  racer:   ['赛车','漂移','赛道','motorsport','gt','超跑','驾驶','改装'],
  esports: ['电竞','游戏','直播','战队','解说','fps','moba','比赛'],
  daily:   ['日常','vlog','生活','穿搭','美食','旅行','打卡','探店'],
};
```

**Fallback**：`identityKeys` 为空时（persona 无 `identities` 字段），`track_overlap` 默认 `0.5`，不惩罚也不加成，爆发强度和频率仍正常计算。

---

## 三个呈现入口

### ① Brief 卡片（`buildCandidateContext` 重构）

`discovery-engine.ts` 的 `buildCandidateContext()` 改为接收 `identityKeys` 参数，内部调用 `rankCandidates()` 后按 `composite_score` 排序替代原有的 `avg_engagement` 排序。展示格式扩充评分标签：

```
━━ 🔍 发现候选对标 ━━
  @张小花（xhs）综合 0.78  出现4次  ❤️均值520 / 峰值3200
    话题: 赛车、电竞、日常
  回复 /candidates 查看全部 | /competitor add @名称 平台 添加
```

**签名变更**：
```ts
// 旧
export function buildCandidateContext(): string
// 新
export function buildCandidateContext(identityKeys?: string[]): string
```
调用方（`brief-generator.ts`、`ops-brief.ts`）传入 `buildPersonaIdentities` 解析出的 identity keys。

### ② `/candidates` 新指令（`ops-command-handler.ts`）

```
/candidates [N]   — 查看 Top-N 候选对标（默认 5）
/candidates all   — 显示全部 pending 候选
```

输出示例：
```
🔍 候选对标排行（Top 5）

1️⃣ @张小花（xhs）  综合分 0.78
   赛道 0.90 · 爆发 0.80 · 频率 0.60
   话题: 赛车、电竞、日常  |  峰值互动 3200  |  出现 4 次
   → /competitor add @张小花 xhs

2️⃣ ...

/competitor add @名称 平台 将候选加入竞品库
```

### ③ 自动触发（`discovery-engine.ts`）

在 `processInspirationForAccountDiscovery` 的候选修剪步骤之后，新增自动批准逻辑：

1. 对所有 `pending` 候选调用 `rankCandidates()`
2. 取 `composite_score ≥ 0.80` 的候选，按分数降序
3. 最多自动批准 **1 个**（防止批量误操作）
4. 调用已有 `approveCandidate()` → 自动写入 `persona.yaml`
5. 日志输出：`[discovery-engine] 🌟 自动批准 @名称（平台）综合分 X.XX`

**阈值配置**：0.80 和每次上限 1 写死为模块常量，后续可提升到 `ops` config：
```ts
const AUTO_APPROVE_THRESHOLD = 0.80;
const AUTO_APPROVE_PER_TICK = 1;
```

---

## 影响范围

| 文件 | 变更类型 |
|------|----------|
| `alive/scripts/ops/candidate-scorer.ts` | **新增** |
| `alive/scripts/ops/discovery-engine.ts` | 扩展 `CandidateAccount` 类型、维护 `peak_engagement`、`buildCandidateContext` 签名变更、自动批准逻辑 |
| `alive/scripts/ops/brief-generator.ts` | 传入 `identityKeys` 给 `buildCandidateContext` |
| `alive/scripts/ops/ops-brief.ts` | 同上 |
| `alive/scripts/ops/ops-command-handler.ts` | 新增 `cmdCandidates()` + dispatcher `case 'candidates'` |
| `alive/tests/discovery-engine.test.ts` | 更新测试覆盖 `peak_engagement` 字段 |
| `alive/tests/candidate-scorer.test.ts` | **新增**，覆盖评分公式的纯函数测试 |

---

## 边界情况

- **`peak_engagement` 缺失**（旧存档数据）：fallback 到 `avg_engagement`，不影响运行
- **`identityKeys` 为空**（通用 persona）：`track_overlap = 0.5`，分数仍有意义
- **单一候选**（`peerCandidates` 只有 1 个）：百分位对比降级，仅用绝对值打分
- **候选全被 dismiss**：`rankCandidates` 返回空数组，Brief 候选区块不展示
- **自动批准失败**（persona.yaml 写入报错）：捕获异常，仅打日志，不影响 tick 继续

---

## 测试策略

**`candidate-scorer.test.ts`**（单元测试，纯函数）：
- 全赛道命中 → `track_overlap = 1.0`
- 零赛道命中 → `track_overlap = 0.0`
- `identityKeys = []` → `track_overlap = 0.5`
- `peak / avg = 3` → `burst_intensity = 0.6`
- `peak / avg = 10`（超过 cap）→ `burst_intensity = 1.0`
- `appearance_count = 5` → `frequency = 1.0`
- 综合排序：分数高的候选排在前面

**`discovery-engine.test.ts`** 补充：
- 新候选首次出现 → `peak_engagement` 正确初始化
- 候选再次出现，互动更高 → `peak_engagement` 更新
- 候选再次出现，互动更低 → `peak_engagement` 不变
- 自动批准：综合分 ≥ 0.80 → 触发 `approveCandidate`
- 自动批准：每次 tick 最多 1 个
