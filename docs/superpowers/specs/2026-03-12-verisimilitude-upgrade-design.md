# Minase 拟真度升级设计

**日期**: 2026-03-12
**范围**: 情绪引擎、行为流、意图引擎、随机事件、叙事连续性 — 全面重构
**约束**: 引擎层可重做，上层架构（OpenClaw Skill+Hook+Cron、文件 IO 模式、LLM 裁决流程）不变

---

## 问题诊断

Minase 当前系统有 5 个让行为「像机器人」的结构性问题：

1. **钟表心跳**：每小时一次 tick，每次做 1-2 件事，重要性固定 4。缺乏「沉浸 3 小时修图」或「一下午啥也没干」的真实波动。
2. **情绪太浅**：10% 线性衰减向固定基线回归，重大打击 5 小时基本消化。缺乏惯性、反刍、阈值爆发。
3. **随机事件像掷骰子**：12 个固定事件等权随机，和当前状态无关，事件之间无因果链。
4. **意图选择太理性**：按强度排序选最强的。缺乏冲动、拖延、自我对抗。
5. **叙事无连续性**：每次心跳独立生成日记，10:00 的水瀬不知道 9:00 的自己在想什么。

---

## §1 情绪惯性模型

### 三层衰减替代线性衰减

当前 `decayTowardBaseline` 每小时向 ESTP 基线衰减 10%。替换为三层模型：

**瞬时反应（Impulse）**
- 事件直接触发，幅度大但衰减快。
- 衰减率：20%/tick（约 3-4 小时消退）。
- 例：收到暖心评论 → valence 立刻 +0.2。

**惯性层（Momentum）**
- 最近 N 次 impulse 的指数加权移动平均，代表「最近几小时的情绪基调」。
- **适用维度**：全部 6 个维度（valence、arousal、energy、stress、creativity、sociability）都参与 momentum 计算。momentum 对象存储每个维度的加权平均值。
- 衰减率动态变化 — momentum 持续时间越长，衰减越慢：
  - 持续 <3h：衰减 8%/tick
  - 持续 3-6h：衰减 5%/tick（沉浸效应）
  - 持续 >6h：衰减 3%/tick（惯性锁定）
- momentum 的「持续时间」定义：从 momentum 主方向（由 valence 符号决定）最近一次翻转算起。即 valence 连续为正或连续为负的 tick 数。
- 模拟「连续好几个小时心情不好，就越来越难走出来」。

**基调层（Undertone）**
- 跨天的情绪底色，由睡前反思写入，代替固定 ESTP baseline 作为衰减目标。
- 包含全部 6 个维度。各维度分别向 undertone 对应值衰减。
- 晨规划可以重置 undertone。
- 例：连续两天帖子数据差 → undertone.valence 被压到 0.1。

### 反刍机制（Rumination）

每次心跳有概率「想起」之前的情绪事件：

```
rumination_probability = importance / 10
                       × 2^(-tick_age / 16)
                       × (1.0 + resonance_bonus)

其中：
  importance: 事件重要性 1-10，归一化到 0-1
  tick_age: 距事件发生了多少个 tick
  半衰期 = 16 ticks（约 16 小时），即 decay_factor = 2^(-tick_age / 16)
  resonance_bonus:
    如果 sign(当前 valence) == sign(事件 delta.valence)：+0.5
    否则：0
  最终概率 clamp 到 [0, 0.3]（每 tick 最多 30% 概率反刍某一事件）
```

- 每 tick 最多触发 1 次反刍（遍历 impulse_history，按概率逐个 roll，首个命中即停止）。
- 触发时：注入一个衰减后的 impulse（原始幅度 × `0.3 + 0.2 × (importance / 10)`，即重要性越高反刍越强烈）。
- 写入日记：「突然又想起了XX的事...」。

### 阈值爆发（Threshold Break）

当 stress 连续 3+ ticks 高于 0.6：
- stress 一次性降到 0.2。
- valence 根据积累方向剧烈波动。
- 强制产生一条高重要性日记。
- 写入反刍池（之后可能反复想起）。
- **爆发冷却**：爆发后设置 `threshold_break_cooldown = 5`，每 tick 减 1，冷却期间不再触发爆发。防止 stress 源持续存在时的振荡。

### 数据结构变化

```typescript
interface EmotionState {
  // 现有 6 维度不变：
  //   mood: { valence, arousal, description }
  //   energy, stress, creativity, sociability
  //   last_updated, recent_cause

  // 新增字段：
  momentum: {
    valence: number;
    arousal: number;
    energy: number;
    stress: number;
    creativity: number;
    sociability: number;
    duration_ticks: number;   // valence 主方向连续持续的 tick 数
  };
  undertone: {                // 代替固定 ESTP baseline 的衰减目标
    valence: number;
    arousal: number;
    energy: number;
    stress: number;
    creativity: number;
    sociability: number;
  };
  impulse_history: Array<{    // 最近事件记录，用于反刍。最多保留 50 条，超出丢弃最旧。
    delta: EmotionDelta;
    cause: string;
    importance: number;
    timestamp: string;
    tick_age: number;         // 每 tick +1，用于衰减计算
  }>;
  consecutive_high_stress: number;
  threshold_break_cooldown: number;  // 爆发后冷却计数，0 表示可触发
}
```

### 默认值（向后兼容）

读入旧 `emotion-state.json` 时，缺失字段用以下默认值补全：

```typescript
const DEFAULT_MOMENTUM = {
  valence: 0, arousal: 0, energy: 0,
  stress: 0, creativity: 0, sociability: 0,
  duration_ticks: 0,
};

const DEFAULT_UNDERTONE = {
  // 即 ESTP baseline，首次运行时等同于旧行为
  valence: 0.3, arousal: 0.5, energy: 0.6,
  stress: 0.2, creativity: 0.4, sociability: 0.5,
};

const DEFAULT_IMPULSE_HISTORY: [] = [];
const DEFAULT_CONSECUTIVE_HIGH_STRESS = 0;
const DEFAULT_THRESHOLD_BREAK_COOLDOWN = 0;
```

---

## §2 行为流（Flow State）与可变密度心跳

### Flow State（沉浸态）

触发条件：上一个 tick 做了某件事 且 该意图 `intensity - resistance > 2.0`（即不仅强度够，而且「余量」充足，超过执行门槛有一定裕度）。

进入 flow 后：
- 自动继续同一件事，不重新走 LLM 裁决（省 token，更真实）。
- arousal 和对应维度小幅上升。
- 活力消耗 ×0.7。
- 日记写「不知不觉又过了一小时」。
- **创作类 flow 的发帖出口**：如果 flow 类别 = '创作' 且 duration_ticks >= 3 且 post-pipeline 条件满足（vitality gate + 16h since last post），允许在 flow tick 中触发 post-pipeline 作为 flow 的「成果输出」，不需要退出 flow。

退出条件：
- 意图 `intensity - resistance < 0`（做够了/门槛升高了）。
- 活力 <20（累到不行）。
- 被刚性日程打断。
- 随机中断：每 tick `interrupt_chance` 概率（初始 15%，每持续 1 tick 增加 3%，上限 40%）。

### Drift State（摆烂态）

触发条件：活力 <40 且 所有意图的 `intensity - resistance < 1.0`（即没有任何意图能轻松跨过执行门槛）且 stress <0.3。

进入 drift 后：
- 只做「刷手机」「发呆」「看窗外」。
- 活力缓慢恢复（+2/tick）。
- 不调用 LLM，用本地模板生成简短日记。
- 窥屏意图累积 ×1.5。

退出条件：
- 任何意图 `intensity - resistance > 2.0`（有了真正想做且能做的事）。
- 外部事件触发（新事件进入 event queue）。
- 活力恢复到 >55。

### 心跳密度可变

| 状态 | 产出密度（重要性） | LLM 调用 | 说明 |
|------|-------------------|----------|------|
| Flow | 6-8 | 否（仅模拟叙事） | 在做正事 |
| Drift | 1-2 | 否（模板生成） | 刷手机/发呆 |
| Normal | 3-5 | 是（完整裁决） | 标准流程 |

重要性值按 tick 单独计算，flow 中每 tick 独立贡献 6-8 重要性（不按整个 session 累加）。

### 数据结构

```typescript
interface FlowState {
  status: 'none' | 'flow' | 'drift';
  activity: string | null;
  category: IntentCategory | null;
  entered_at: string | null;
  duration_ticks: number;
  interrupt_chance: number;   // 初始 0.15，每 tick +0.03，上限 0.40
}
```

### 默认值

```typescript
const DEFAULT_FLOW_STATE: FlowState = {
  status: 'none',
  activity: null,
  category: null,
  entered_at: null,
  duration_ticks: 0,
  interrupt_chance: 0.15,
};
```

### heartbeat-tick.ts 新流程

```
1. 读取状态
2. 感知阶段（情绪惯性/活力/信心/社交）
3. 连锁事件检查
4. Flow State 判定
   - 路径 A（flow 中）→ 检查退出 → 未退出则继续，跳过 5-6
   - 路径 B（drift 中）→ 检查退出 → 未退出则继续，跳过 5-6
   - 路径 C（正常态）→ 进入 5
5. 意图计算（含 resistance/冲动穿透/拖延）
6. LLM 裁决（含叙事连续性注入）
7. 执行动作 + 检查进入 flow/drift + 写状态
```

---

## §3 意图引擎 — 冲动穿透与自我对抗

### 抵抗力（Resistance）

每个意图类别有基础执行门槛：

| 类别 | 基础 resistance | 说明 |
|------|----------------|------|
| 创作 | 4.0 | 启动成本高 |
| 社交 | 1.5 | 回消息很容易 |
| 窥屏 | 0.5 | 几乎零门槛 |
| 表达 | 2.0 | |
| 学习 | 5.0 | 最难启动 |
| 休息 | 0.3 | 躺下就行 |
| 梦想 | 6.0 | 需要特别心理状态 |

动态修正：
- 活力低（vitality <30）→ 高耗能类别（创作、学习、梦想）resistance ×1.5。
- 正在 flow → 其他类别 resistance +3.0。
- 刚性日程中 → 非 allowed_actions 类别 resistance +5.0。
- 上次创作效果差（仅创作类，由 confidence <0.8 判定）→ resistance +2.0。

> **注**：「效果差」的 resistance 修正仅适用于创作类意图，因为只有创作类有 confidence-engine 提供的客观质量信号。其他类别不使用此修正。

执行判定：`intensity > resistance` 时才能执行。

### 冲动穿透（Impulse Breakthrough）

部分意图不走正常竞争，直接穿透当前状态：

| 条件 | 效果 |
|------|------|
| 意图强度 >8.0 且 source = 'event' | 打断 flow，强制执行 |
| 窥屏 且 无 flow 且 活力 <50 | 几乎不可避免地刷手机 |
| 休息 且 活力 <15 | 不管在做什么都得休息 |

穿透时日记叙事：「本来在XX，结果忍不住...」

### 拖延与内疚（Procrastination & Guilt）

当意图 `intensity > resistance` 但未被选中：
- `skipped_count` +1。
- 连续被跳过 3+ 次：stress +0.05/tick，日记标注「一直想XX但还没开始...」。
- 连续被跳过 5+ 次：触发二选一——
  - **内疚爆发**：intensity 一次性 +3.0（再不做不行了）。
  - **放弃**：intensity 骤降到 1.0（算了不想了）。
  - 概率由 stress 决定：stress >0.5 → 80% 放弃；stress <0.3 → 70% 爆发。
- **爆发/放弃后**：`skipped_count` 重置为 0。

### 数据结构变化

```typescript
interface Intent {
  // 现有字段不变：id, category, description, intensity, source, born_at, decay_rate, satisfied_at
  resistance: number;
  skipped_count: number;
  last_attempted: string | null;
}

const BASE_RESISTANCE: Record<IntentCategory, number> = {
  '创作': 4.0, '社交': 1.5, '窥屏': 0.5,
  '表达': 2.0, '学习': 5.0, '休息': 0.3, '梦想': 6.0,
};
```

### 默认值

读入旧 `intent-pool.json` 时，缺失字段用以下默认值补全：

```typescript
// 对每个 Intent：
//   resistance: BASE_RESISTANCE[intent.category]
//   skipped_count: 0
//   last_attempted: null
```

### LLM 裁决改造

prompt 增加 resistance + skipped_count 信息，并注入引导：
> 你不是一个理性的决策者。你是一个 18 岁的女孩，会拖延、会冲动、会明知故犯。如果「窥屏」的门槛很低而你又没什么精力，你很可能会选它而不是「创作」，即使创作强度更高。

---

## §4 上下文感知随机事件系统

### 前置条件过滤

每个事件新增触发条件，不满足则不进入候选池：

| 事件 | 条件 | 排除 |
|------|------|------|
| 突然想起喜欢的角色 | creativity >0.3 或最近 3 tick 有窥屏 | 正在 flow 中 |
| 工作遇到烦心事 | 当前刚性日程=上班 | 周末 |
| 身体不舒服 | vitality <50 或连续 5+ tick 未休息 | 刚健身完 |
| 漫展即将到来 | 距上次触发 >30 天 | — |
| 天气特别好 | 非上班时段 | — |
| 看到神仙作品 | 最近 2 tick 有窥屏 | — |
| 收到同好私信 | sociability >0.3 | — |

### 动态权重

```
weight = base_weight × relevance_multiplier

relevance_multiplier 规则：
  - 情绪共振：事件情绪方向和当前情绪同向 → ×1.5
  - 活力相关：低活力时「身体不舒服」「灵感枯竭」权重翻倍
  - 维度共振：对应维度高时相关事件权重翻倍
```

### 连锁事件（Event Chains）

部分事件触发后在后续 tick 中有概率触发后续反应：

| 源事件 | 后续 | 概率 | 延迟 |
|--------|------|------|------|
| 看到神仙作品 | 忍不住研究技法 | 40% | 1-3 tick |
| 看到神仙作品 | 越看越焦虑 | 20% | 2-4 tick |
| 漫展即将到来 | 盘算要 cos 谁 | 70% | 1-2 tick |
| 漫展即将到来 | 算预算有点慌 | 50% | 3-5 tick |
| 工作遇到烦心事 | 下班后余波 | 60% | 4-8 tick（从上班时段触发算起） |
| 工作遇到烦心事 | 睡前反刍 | 30% | 8-14 tick（从上班时段触发算起） |
| 收到同好私信 | 聊了很久停不下来 | 50% | 1-2 tick |

> **注**：所有延迟统一用 tick 计数表示。「下班后余波」和「睡前反刍」的 tick 数已按典型工作时段（10:00 触发 → 下班 18:00 = 8 tick，睡前 23:00 = 13 tick）折算。

### 事件池扩充

从 12 个扩充到 20-25 个，新增类别：

**时间感知类**：「突然发现已经这个点了」「感觉今天过得好快/好慢」

**微小生活细节**：「外卖到了」「手机快没电了」「楼下在装修好吵」

**社交媒体类**：「看到让人不舒服的热搜」「刷到很有创意的短视频」

### 数据结构

```typescript
interface RandomEventDef {
  description: string;
  emotion_delta: EmotionDelta;
  intent_boosts: Array<{ category: IntentCategory; boost: number }>;
  diary_entry: string;
  preconditions: {
    requires_schedule?: string;
    excludes_schedule?: string;
    min_vitality?: number;
    max_vitality?: number;
    min_emotion?: Partial<EmotionDelta>;
    requires_recent_action?: string;
    global_cooldown_days?: number;
    excludes_flow?: boolean;
  };
  weight_modifiers: {
    emotion_resonance?: boolean;
    vitality_inverse?: boolean;
    dimension_boost?: string;
  };
  chain_events?: Array<{
    description: string;
    probability: number;
    delay_ticks: [number, number];   // [最小, 最大] tick 延迟
    emotion_delta: EmotionDelta;
    intent_boosts: Array<{ category: IntentCategory; boost: number }>;
    diary_entry: string;
  }>;
}

// 连锁事件只使用 ticks_remaining 倒计时，无全局 tick 计数器
interface PendingChainEvent {
  source_event_id: string;
  ticks_remaining: number;           // 每 tick 减 1，到 0 时触发
  event: {
    description: string;
    probability: number;             // 已在创建时 roll 过，此处仅记录
    emotion_delta: EmotionDelta;
    intent_boosts: Array<{ category: IntentCategory; boost: number }>;
    diary_entry: string;
  };
}
```

### 默认值

```typescript
const DEFAULT_PENDING_CHAINS: PendingChainEvent[] = [];
```

### 事件冷却状态

全局冷却存储在 `pending-chains.json` 同一文件中：

```typescript
interface ChainAndCooldownState {
  pending: PendingChainEvent[];
  cooldowns: Record<string, string>;  // event_description → last_triggered ISO date
}
```

---

## §5 叙事连续性与内心独白

### 心跳记忆窗口

每次 heartbeat prompt 注入过去 3 个 tick 的决策摘要：

```
「最近几小时的你：
 - 14:00 在上班摸鱼刷手机（drift态），看到了一个很厉害的coser
 - 15:00 还在想那个coser的事，有点焦虑但没动力做什么
 - 16:00 继续上班，偷偷在看cos技法教程（flow态，学习，已持续1h）」
```

从 heartbeat-log 最近 3 条 completed 记录的 `tick_summary` 字段提取。

### 内心独白连贯引导

prompt 中注入上一次的 inner_monologue：

> 你上一个小时的内心独白是：「好想回去继续修那张图啊...但是还在上班不能动」
>
> 现在请接着你的思绪继续。你的独白应该和上面有关联——可能是延续同一个念头，可能是被新事情打断后又回来，也可能是彻底转向了别的事情（但要有转折的理由）。

### 日记风格分化

根据 flow state 和情绪状态使用不同风格：

| 状态 | 风格 | 示例 |
|------|------|------|
| Flow | 简短碎片化 | 「还在修图。眼睛有点酸。但是光影终于对了。」 |
| Drift | 意识流散漫 | 「刷了好久手机...也没看到什么有意思的...」 |
| 情绪爆发 | 长、情绪化、语气词 | 「真的好烦！！！为什么每次都这样」 |
| 普通 | 正常叙事 | 接近现有风格 |

实现：`heartbeat-tick.ts` 根据当前 `flowState.status` 和情绪状态计算 `voice_directive` 字符串，作为模板参数传入 `simulated-action.md`。模板中新增 `{voice_directive}` 占位符。

### 叙事一致性

在 prompt 中注入上一条日记 + 当前状态，加一句：「保持和上一条日记的逻辑连贯。如果状态变了，解释为什么变了。」

### 数据结构变化

```typescript
interface HeartbeatLogEntry {
  // 现有字段不变：timestamp, type, status, perception_summary,
  //   chosen_actions, emotion_after, importance_added, error
  tick_summary: string;           // 一句话摘要，给下次 tick 用
  inner_monologue: string | null; // 本次独白，给下次 tick 引用
  flow_state: 'flow' | 'drift' | 'none';
  voice_directive: string;        // 日记风格指令
}
```

### 默认值

读入旧 `heartbeat-log.json` 时，缺失字段用以下默认值补全：

```typescript
// tick_summary: ''
// inner_monologue: null
// flow_state: 'none'
// voice_directive: ''
```

---

## §6 模块联动与整体数据流

### 状态文件变化总结

| 文件 | 变化 | PATHS 键名 |
|------|------|-----------|
| `emotion-state.json` | 新增 momentum, undertone, impulse_history, consecutive_high_stress, threshold_break_cooldown | `emotionState`（已有） |
| `intent-pool.json` | Intent 新增 resistance, skipped_count, last_attempted | `intentPool`（已有） |
| `heartbeat-log.json` | LogEntry 新增 tick_summary, inner_monologue, flow_state, voice_directive | `heartbeatLog`（已有） |
| `flow-state.json` | **新文件** — FlowState 对象 | `flowState`（新增） |
| `pending-chains.json` | **新文件** — ChainAndCooldownState 对象 | `pendingChains`（新增） |

新文件在 `file-utils.ts` 的 `PATHS` 对象中注册：

```typescript
// 新增到 PATHS：
flowState: path.join(MEMORY_BASE, 'flow-state.json'),
pendingChains: path.join(MEMORY_BASE, 'pending-chains.json'),
```

### 模块依赖关系

```
emotion-engine.ts      重构：三层衰减、反刍、阈值爆发
  ↕ 双向耦合
intent-engine.ts       重构：resistance、拖延、冲动穿透
  ↓
flow-engine.ts         新模块：flow/drift 状态机
  ↓
random-events.ts       重构：条件过滤、权重调制、连锁事件
  ↓
heartbeat-tick.ts      主循环重构，整合所有模块

vitality-engine.ts     小改：flow 中消耗系数
confidence-engine.ts   不改
social-graph-engine.ts 不改
```

### 晨规划/睡前反思交互

**morning-plan.ts**：
- 写入 undertone（今天的情绪基调）。
- 重置 flowState 为 `DEFAULT_FLOW_STATE`。
- 清空 pendingChainEvents（注意：夜间连锁事件由 night-reflect 在 23:00 处理完毕后才清空，morning-plan 在 07:00 运行时不会误删夜间事件）。
- 重置所有意图的 skipped_count。

**night-reflect.ts**：
- 在反思前先处理所有 `ticks_remaining <= 0` 的 pending chain events（确保夜间连锁事件不被丢失）。
- 读取全天 flow 记录，生成沉浸统计。
- undertone 由反思结果决定（明天带着什么底色醒来）。
- 长期被拖延的意图纳入反思素材（可能产出「我一直想XX但总是做不到」的 wisdom）。

---

## 设计原则

1. **引擎层可重做，架构层不动**：不改变 OpenClaw Skill/Hook/Cron 机制、文件 IO 模式（file-utils.ts）、LLM 调用方式（llm-client.ts）。
2. **不可变数据**：所有引擎函数继续返回新对象，不原地修改。
3. **向后兼容**：每个新字段都有明确的默认值（见各节「默认值」小节），旧 JSON 读入时自动补全缺失字段。
4. **可测试**：每个新机制（惯性衰减、flow 判定、resistance 计算、反刍概率、事件过滤）都是纯函数，可单独单测。
5. **LLM token 节约**：flow/drift 态跳过 LLM 裁决，每天约 40-60% 的 tick 可以不调 LLM。
