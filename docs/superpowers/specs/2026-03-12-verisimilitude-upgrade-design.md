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
- 衰减率动态变化 — momentum 持续时间越长，衰减越慢：
  - 持续 <3h：衰减 8%/tick
  - 持续 3-6h：衰减 5%/tick（沉浸效应）
  - 持续 >6h：衰减 3%/tick（惯性锁定）
- 模拟「连续好几个小时心情不好，就越来越难走出来」。

**基调层（Undertone）**
- 跨天的情绪底色，由睡前反思写入，代替固定 ESTP baseline 作为衰减目标。
- 晨规划可以重置 undertone。
- 例：连续两天帖子数据差 → undertone.valence 被压到 0.1。

### 反刍机制（Rumination）

每次心跳有概率「想起」之前的情绪事件：
- 概率 = `事件重要性 × 时间衰减因子 × 情绪共振因子`
- 时间衰减：半衰期 8 小时。
- 情绪共振：当前情绪和事件情绪同方向时概率更高（心情差时更容易想起坏事）。
- 触发时：注入一个衰减后的 impulse（原始幅度的 30-50%），写入日记「突然又想起了XX的事...」。

### 阈值爆发（Threshold Break）

当 stress 连续 3+ ticks 高于 0.6：
- stress 一次性降到 0.2。
- valence 根据积累方向剧烈波动。
- 强制产生一条高重要性日记。
- 写入反刍池（之后可能反复想起）。

### 数据结构变化

```typescript
interface EmotionState {
  // 现有 6 维度不变：mood, energy, stress, creativity, sociability
  momentum: {
    valence: number;
    arousal: number;
    duration_ticks: number;
    direction: 'positive' | 'negative' | 'neutral';
  };
  undertone: EmotionDelta;
  impulse_history: Array<{
    delta: EmotionDelta;
    cause: string;
    importance: number;
    timestamp: string;
    tick_age: number;
  }>;
  consecutive_high_stress: number;
}
```

---

## §2 行为流（Flow State）与可变密度心跳

### Flow State（沉浸态）

触发条件：上一个 tick 做了某件事 且 当前意图池中该类别强度仍 >5.0。

进入 flow 后：
- 自动继续同一件事，不重新走 LLM 裁决（省 token，更真实）。
- arousal 和对应维度小幅上升。
- 活力消耗 ×0.7。
- 日记写「不知不觉又过了一小时」。

退出条件：
- 意图强度降到 <3.0（做够了）。
- 活力 <20（累到不行）。
- 被刚性日程打断。
- 随机中断：每 tick 15% 概率（手机响了、肚子饿了）。

### Drift State（摆烂态）

触发条件：活力 <40 且 所有意图强度都 <3.0 且 stress <0.3。

进入 drift 后：
- 只做「刷手机」「发呆」「看窗外」。
- 活力缓慢恢复（+2/tick）。
- 不调用 LLM，用本地模板生成简短日记。
- 窥屏意图累积 ×1.5。

退出条件：
- 任何意图强度 >5.0。
- 外部事件触发。
- 活力恢复到 >55。

### 心跳密度可变

| 状态 | 产出密度（重要性） | LLM 调用 | 说明 |
|------|-------------------|----------|------|
| Flow | 6-8 | 否（仅模拟叙事） | 在做正事 |
| Drift | 1-2 | 否（模板生成） | 刷手机/发呆 |
| Normal | 3-5 | 是（完整裁决） | 标准流程 |

### 数据结构

```typescript
interface FlowState {
  status: 'none' | 'flow' | 'drift';
  activity: string | null;
  category: IntentCategory | null;
  entered_at: string | null;
  duration_ticks: number;
  interrupt_chance: number;
}
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
- 活力低 → 高耗能类别 resistance ×1.5。
- 正在 flow → 其他类别 resistance +3.0。
- 刚性日程中 → 非 allowed_actions 类别 resistance +5.0。
- 上次做这件事效果差 → resistance +2.0。

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

### 数据结构变化

```typescript
interface Intent {
  // 现有字段不变
  resistance: number;
  skipped_count: number;
  last_attempted: string | null;
}

const BASE_RESISTANCE: Record<IntentCategory, number> = {
  '创作': 4.0, '社交': 1.5, '窥屏': 0.5,
  '表达': 2.0, '学习': 5.0, '休息': 0.3, '梦想': 6.0,
};
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
| 工作遇到烦心事 | 下班后余波 | 60% | 下班时段 |
| 工作遇到烦心事 | 睡前反刍 | 30% | 睡前 |
| 收到同好私信 | 聊了很久停不下来 | 50% | 1-2 tick |

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
    delay_ticks: [number, number];
    emotion_delta: EmotionDelta;
    intent_boosts: Array<{ category: IntentCategory; boost: number }>;
    diary_entry: string;
  }>;
}

interface PendingChainEvent {
  source_event_id: string;
  trigger_at_tick: number;
  ticks_remaining: number;
  event: RandomEventDef['chain_events'][0];
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

实现：在 simulated-action.md 模板中根据状态注入 `voice_directive`。

### 叙事一致性

在 prompt 中注入上一条日记 + 当前状态，加一句：「保持和上一条日记的逻辑连贯。如果状态变了，解释为什么变了。」

### 数据结构变化

```typescript
interface HeartbeatLogEntry {
  // 现有字段
  tick_summary: string;
  inner_monologue: string | null;
  flow_state: 'flow' | 'drift' | 'none';
  voice_directive: string;
}
```

---

## §6 模块联动与整体数据流

### 状态文件变化总结

| 文件 | 变化 |
|------|------|
| `emotion-state.json` | 新增 momentum, undertone, impulse_history, consecutive_high_stress |
| `intent-pool.json` | Intent 新增 resistance, skipped_count, last_attempted |
| `heartbeat-log.json` | LogEntry 新增 tick_summary, inner_monologue, flow_state, voice_directive |
| `flow-state.json` | **新文件** — FlowState 对象 |
| `pending-chains.json` | **新文件** — PendingChainEvent 数组 |

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
- 重置 flowState 为 none。
- 清空 pendingChainEvents。
- 重置所有意图的 skipped_count。

**night-reflect.ts**：
- 读取全天 flow 记录，生成沉浸统计。
- undertone 由反思结果决定（明天带着什么底色醒来）。
- 长期被拖延的意图纳入反思素材（可能产出「我一直想XX但总是做不到」的 wisdom）。

---

## 设计原则

1. **引擎层可重做，架构层不动**：不改变 OpenClaw Skill/Hook/Cron 机制、文件 IO 模式（file-utils.ts）、LLM 调用方式（llm-client.ts）。
2. **不可变数据**：所有引擎函数继续返回新对象，不原地修改。
3. **向后兼容**：新字段都有默认值，旧的 emotion-state.json 读入时自动补全缺失字段。
4. **可测试**：每个新机制（惯性衰减、flow 判定、resistance 计算、事件过滤）都是纯函数，可单独单测。
5. **LLM token 节约**：flow/drift 态跳过 LLM 裁决，每天约 40-60% 的 tick 可以不调 LLM。
