# Minase（水瀬）数字生命 — 技术深度解析

> **用途：** 技术分享前的全面熟悉材料
> **基于：** ppt-outline.md + 全部源代码实现
> **最后更新：** 2026-03-23

---

## 目录

1. [项目全景](#1-项目全景)
2. [六维情绪引擎](#2-六维情绪引擎)
3. [七类意图引擎](#3-七类意图引擎)
4. [Flow/Drift 行为流引擎](#4-flowdrift-行为流引擎)
5. [活力（代谢）引擎](#5-活力代谢引擎)
6. [信心引擎](#6-信心引擎)
7. [上下文感知随机事件引擎](#7-上下文感知随机事件引擎)
8. [社交图谱引擎](#8-社交图谱引擎)
9. [旅行状态机](#9-旅行状态机)
10. [帖子冲动引擎](#10-帖子冲动引擎)
11. [心跳 Tick 编排](#11-心跳-tick-编排)
12. [晨规划与夜反思](#12-晨规划与夜反思)
13. [发帖流水线](#13-发帖流水线)
14. [AI 图像生成与后处理](#14-ai-图像生成与后处理)
15. [评论互动引擎](#15-评论互动引擎)
16. [四层记忆与反思系统](#16-四层记忆与反思系统)
17. [涌现式成长系统](#17-涌现式成长系统)
18. [AI-对-AI 顾问系统](#18-ai-对-ai-顾问系统)
19. [OpenClaw 平台集成](#19-openclaw-平台集成)
20. [工程品质与防御性设计](#20-工程品质与防御性设计)
21. [系统间耦合关系全图](#21-系统间耦合关系全图)

---

## 1. 项目全景

### 1.1 Minase 是什么

Minase（水瀬）是一个 **7×24 自主运转的数字生命**，以 OpenClaw 平台的 Skill 形式运行。她不是聊天机器人——她有自己的情感、记忆、日程和社交圈，每天独立做出约 16 次行为决策，并自主经营一个真实的 Instagram 账号。

- **身份**：18 岁数字游民旅行博主 + Cosplayer
- **性格基底**：ESTP（元气辣妹、行动派）
- **语言风格**：中文为主，自然夹入日语（すごい、やばい、まじ）
- **运行平台**：OpenClaw（Skill 系统）

### 1.2 技术架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                    OpenClaw 平台（基础设施层）                   │
│  Skill 系统 · Hooks · Cron · 环境变量 · Channel · MCP 工具     │
├──────────────────────────────────────────────────────────────┤
│                    自研引擎（核心差异化层）                       │
│  情绪 · 意图 · 行为流 · 活力 · 信心 · 随机事件                   │
│  社交图谱 · 旅行状态 · 帖子冲动 · 发帖流水线                      │
├──────────────────────────────────────────────────────────────┤
│                    微创新模块（工程化改良层）                      │
│  记忆反思 · 涌现系统 · AI顾问 · 照片后处理 · 评论互动引擎         │
├──────────────────────────────────────────────────────────────┤
│                    外部服务（第三方集成层）                       │
│  AIHubMix/fal.ai · ImgURL · Instagram API · Exa 搜索         │
└──────────────────────────────────────────────────────────────┘
```

### 1.3 一天的时间轴

```
🌅 07:00  晨规划 — 旅行推进、灵感采集、日程生成、Cron 动态同步
☀️ 08:00-22:00  每小时"心跳" — 三层情绪衰减 → 意图竞争 → LLM 决策 → 行动执行
🌙 23:00  夜反思 — 智慧提炼、偏好更新、梦想推进、性格微调
😴 00:00-06:00  睡觉 — 真的不活动
```

---

## 2. 六维情绪引擎

> 源文件：`skill/scripts/emotion-engine.ts`（561 行）  
> 类型定义：`skill/scripts/types.ts` → `EmotionState`

### 2.1 设计哲学

传统 AI 角色的情感系统通常采用离散标签（开心/难过/生气），或简单的加减分。Minase 的情绪引擎追求的是**连续、有惯性、有自我调节能力**的情感空间，更接近人类的真实情感运作方式。

### 2.2 六个情绪维度

| 维度 | 英文字段 | 值域 | ESTP 基线值 | 说明 |
|------|---------|------|-----------|------|
| 正负情绪 | `valence` | -1.0 ~ 1.0 | 0.3 | 整体心情好坏 |
| 激动程度 | `arousal` | 0 ~ 1.0 | 0.5 | 平静还是兴奋 |
| 精力 | `energy` | 0 ~ 1.0 | 0.6 | 活力充沛还是疲惫 |
| 压力 | `stress` | 0 ~ 1.0 | 0.2 | 轻松还是焦虑 |
| 创造力 | `creativity` | 0 ~ 1.0 | 0.4 | 灵感水平 |
| 社交欲 | `sociability` | 0 ~ 1.0 | 0.5 | 想独处还是想聊天 |

基线值定义在 `EMOTION_BASELINE` 常量中，反映 ESTP 性格的默认状态——偏积极（valence=0.3）、中等兴奋（arousal=0.5）、精力充沛（energy=0.6）。

### 2.3 三层情绪模型（核心创新）

这是情绪系统最重要的设计——**冲动层 → 惯性层 → 基调层**的三层衰减模型：

```
┌─────────────────────────────────────────────────┐
│  冲动层（Impulse Layer）                          │
│  · 当前情绪维度的实际值                             │
│  · 每 tick 以 20% 速率向惯性层衰减                  │
│  · 响应最快，波动最大                               │
├─────────────────────────────────────────────────┤
│  惯性层（Momentum Layer）                         │
│  · 近期情绪的加权趋势                               │
│  · 动态衰减率：3-8%/tick（持续越久衰减越慢）          │
│  · 新冲动通过 EMA（alpha=0.3）混入                  │
├─────────────────────────────────────────────────┤
│  基调层（Undertone Layer）                         │
│  · 每天一次更新，由夜反思设定                         │
│  · 代表"今天的情绪底色"                             │
│  · 最稳定，几乎不随单个事件变化                       │
└─────────────────────────────────────────────────┘
```

**关键函数 `decayThreeLayer()`** 的执行逻辑：

1. **计算惯性层衰减率**：根据 `duration_ticks`（惯性持续时间）动态调整
   - duration > 6 ticks → 3%/tick（长期惯性很难改变）
   - duration 3-6 ticks → 5%/tick
   - duration < 3 ticks → 8%/tick（短期惯性容易消散）
   
2. **惯性层向基调层衰减**：`momentum = momentum + (undertone - momentum) × rate`

3. **冲动层向惯性层衰减**：`current = current + (momentum - current) × 0.20`

4. **impulse_history 老化**：所有历史条目 `tick_age += 1`，超过 50 条裁剪

**为什么用三层模型？** 类比真实人类：
- 被夸了一句立刻开心（冲动层），但 3-4 小时后就淡了
- 如果连续一周被夸，心情形成正向惯性（惯性层），不会因为一句差评立刻崩掉
- 如果昨天整体心情不好，今天的情绪基调也会偏低（基调层）

### 2.4 情绪冲动与 EMA 融合

当新事件发生时（如收到好评论），调用 **`applyImpulse()`**：

1. 通过 `applyDelta()` 立即影响冲动层
2. 记录到 `impulse_history`（包含 delta、cause、importance、tick_age）
3. 用 **指数加权移动平均（EMA, alpha=0.3）** 更新惯性层：
   ```
   momentum.valence += delta.valence × 0.3
   momentum.arousal += delta.arousal × 0.3
   ...
   ```
   alpha=0.3 意味着新事件对惯性的影响是 30%——既不会一个事件就改变趋势，又能累积多个同方向事件的效果。

### 2.5 跨维度耦合

**`applyCoupling()`** 实现了 5 条耦合规则，确保情绪维度不会独立运动：

| 触发条件 | 影响 | 耦合系数 | 设计思路 |
|---------|------|---------|---------|
| stress↑ | creativity↓ energy↓ sociability↓ | 0.3 / 0.2 / 0.2 | 压力抑制创造力、消耗精力、让人退缩 |
| energy 大幅下降（>0.15） | arousal↓ | 0.3 | 精力崩塌时很难保持兴奋 |
| valence 上升（>0.1） | stress↓ | 0.15 | 好心情缓解压力 |
| creativity↑（>0.1） | arousal↑ | 0.15 | 创作灵感让人兴奋 |
| stress↑ | sociability↓ | 0.2 | 压力大时不想社交 |

### 2.6 边际递减效应

**`applyDiminishingReturns()`** 使用 **headroom（剩余空间）** 方法：

```
dampening = max(0.1, min(1.0, headroom / halfRange))
newValue = current + delta × dampening
```

- `headroom`：当前值到边界的距离（向上推则算到 max 的距离）
- `halfRange`：总范围的一半（"典型空间"）
- 当接近边界时，dampening 降到最低 0.1——不会完全无效，但效果大幅减弱

**作用**：防止情绪维度卡在极值。即使连续发生好事，valence 也不会永远停在 1.0；会有越来越强的回弹力。

### 2.7 反刍机制（Rumination）

**`rollRumination()`** 模拟人类"突然想起旧事"的心理现象：

每个 tick 遍历 `impulse_history`，对每条记录计算反刍概率：

```
P = (importance / 10) × 2^(-tick_age / 16) × (1 + resonance_bonus)
capped at 0.30
```

其中：
- `importance / 10`：重要的事更容易被想起（importance=8 → 基础概率 0.8）
- `2^(-tick_age / 16)`：时间衰减，半衰期=16 ticks（约 16 小时），越久概率越低
- `resonance_bonus`：如果当前心情方向和旧事一致（都是正面或都是负面），+0.5 共鸣加成

触发后：
- 注入一个**衰减版的原始冲动**（原始 delta × 0.3~0.5 的 ruminationStrength）
- 生成日记：`突然又想起了${cause}的事...`
- **每 tick 最多触发 1 次**，第一条命中就停止循环

### 2.8 情绪爆发（Threshold Break）

**`checkThresholdBreak()`** 模拟压力累积到极限后的情绪崩溃：

```
触发条件：stress > 0.6 连续 3+ ticks（约 3 小时）
  AND threshold_break_cooldown == 0

触发效果：
  · stress 直降到 0.2（压力释放）
  · valence 在当前方向上 +0.4（如果已经负面就更负面）
  · arousal +0.3（情绪激动）
  · 生成重要性=8 的日记条目
  · 设置 5 tick 冷却期（防止连续爆发）
```

日记内容也根据 valence 方向区分：
- 正面 valence：`受不了了！！！压力太大了但是我要坚持！！`
- 负面 valence：`真的好烦！！！为什么每次都这样...`

### 2.9 Russell 环形模型心情描述

**`describeMood()`** 基于 Russell 的情绪环形模型（valence × arousal），但做了重要改良——在正面区域引入 energy、stress、creativity 三个次要维度细分：

- **负面区（valence ≤ -0.2）**：粗粒度网格（很烦躁/很低落/焦虑/有点烦/低落）
- **中性区（-0.2 ~ 0.2）**：平静/凑合/兴奋/还不错/普通
- **正面区（> 0.2）**：20+ 种细分描述（灵感大爆发/嗨到飞起但快没电了/创作欲爆棚/慵懒的幸福/好奇心涌上来了...）

**设计思路**：日常大部分时间 Minase 处于正面区域，如果只用 valence × arousal 会导致描述单调（总是"开心"）。引入次要维度让正面区有丰富的语义区分。

### 2.10 情绪→意图耦合

**`computeEmotionIntentCoupling()`** 计算每种意图类别的情绪倍率：

```typescript
'创作': 1.0 + 0.5 × creativity          // 创造力高 → 更想创作
'社交': 1.0 + 0.3 × sociability - 0.2 × stress  // 社交欲高、压力低 → 更想社交
'窥屏': 1.0 + 0.2 × (1.0 - energy)      // 精力低 → 更想刷手机
'休息': 1.0 + 0.8 × (1.0 - energy)      // 精力低 → 强烈想休息（系数最大）
'表达': 1.0 + 0.3 × |valence|           // 情绪强烈（无论正负） → 想表达
'学习': 1.0 + 0.2 × creativity - 0.3 × stress  // 好奇心高但压力大就不想学
'梦想': 1.0 + 0.2 × valence             // 心情好时才想追梦
```

这些倍率在每个心跳 tick 中应用到意图池的强度值上。

### 2.11 预定义事件 Delta

`EVENT_DELTAS` 定义了 9 种已知事件的情绪影响，例如：

- `post_data_good`：valence +0.3, arousal +0.2, creativity +0.2, stress -0.1
- `troll_comment`：valence -0.2, arousal +0.3, stress +0.3, sociability -0.2
- `completed_cos_work`：valence +0.4, energy -0.2, stress -0.3

### 2.12 社交亲密度缩放

**`scaleByCloseness()`**：核心圈（closeness=10）的互动有完整情绪影响，而陌生人（closeness=1）的影响只有 10%。

```
scale = max(0.1, closeness / 10.0)
```

---

## 3. 七类意图引擎

> 源文件：`skill/scripts/intent-engine.ts`（401 行）

### 3.1 设计哲学

灵感来自行为心理学：**人的行动 = 动机 - 阻力**。Minase 的意图引擎不是简单的优先级队列，而是模拟人类"想做但懒得做"的真实心理过程。

### 3.2 七种欲望类别与基础阻力

| 类别 | BASE_RESISTANCE | 设计思路 |
|------|----------------|---------|
| 🎨 创作 | 4.0 | 创作需要很强的驱动力才会开始 |
| 💬 社交 | 1.5 | 社交门槛不高 |
| 📱 窥屏 | 0.5 | 刷手机几乎无阻力 |
| ✍️ 表达 | 2.0 | 发动态需要一点动力 |
| 📚 学习 | 5.0 | 学习是最难开始的 |
| 😴 休息 | 0.3 | 休息几乎不需要动力 |
| ⭐ 梦想 | 6.0 | 追梦是阻力最大的——需要极强的驱动力 |

**净强度 = intensity - resistance**，只有净强度 > 0 的意图才能被执行。

### 3.3 意图生命周期

```
创建（accumulation/event/schedule/llm）
  → 强度自然累积（每 tick 按类别规则增长）
  → 被事件/日程/情绪进一步提升
  → 应用动态阻力
  → 参与竞争排序（按净强度）
  → 被 LLM 选中执行 / 被跳过
  → 执行后标记 satisfied_at → 按 decay_rate 衰减 → 低于 0.1 被清除
```

### 3.4 自然累积规则

**`accumulateIntents()`** 每个 tick 对未满足的意图按类别增加强度：

| 类别 | 基础增长 | 条件加成 |
|------|---------|---------|
| 创作 | +0.3/tick | 48h 没发帖 → 额外 +1.0 |
| 社交 | +0.2/tick | 有未读事件 → +2.0 |
| 窥屏 | +0.3/tick | 午间/下午 → +1.5（摸鱼时段） |
| 休息 | 0/tick | +0.5 × 连续活跃心跳数 |
| 表达 | +0.2/tick | - |
| 学习 | +0.2/tick | - |
| 梦想 | +0.1/tick | 增长最慢，需要长期积累 |

时段判断 `getTimePeriod(hour)` 将一天分为 6 个时段（morning/work/lunch/afternoon/evening/night），午间和下午为"摸鱼时段"。

### 3.5 动态阻力系统

**`computeDynamicResistance()`** 在基础阻力上叠加 4 个上下文修正：

| 修正条件 | 影响 | 说明 |
|---------|------|------|
| vitality < 30 + 高能耗类别 | resistance × 1.5 | 累了做不动难的事 |
| 当前在 Flow 状态 + 非 Flow 类别 | resistance + 3.0 | Flow 中很难切换到其他事 |
| 刚性日程不允许 | resistance + 5.0 | 日程限制几乎不可逾越 |
| confidence < 0.8 + 创作类 | resistance + 2.0 | 信心不足时创作更难 |

### 3.6 冲动穿透（Impulse Breakthrough）

**`checkImpulseBreakthrough()`** 定义了 3 种可以**无视阻力直接执行**的情况：

1. **事件驱动穿透**：某个 event 源的意图强度 > 8.0 → 直接穿透（甚至打断 Flow）
2. **刷手机穿透**：不在 Flow + vitality < 50 → 窥屏几乎必然发生（模拟"累了就想刷手机"）
3. **强制休息穿透**：vitality < 15 → 休息意图直接穿透（身体在强制休息）

### 3.7 拖延追踪系统

**`processProcrastination()`** 追踪每个可执行但未被选中的意图：

```
意图净强度 > 0 但未被 LLM 选中：
  skipped_count += 1

  3 次：stress += 0.05，日记 "一直想{描述}但还没开始..."
  
  5 次：进入决断
    · 放弃概率 = stress > 0.5 ? 80% : stress < 0.3 ? 30% : 50%
    · 放弃：intensity 降到 1.0，日记 "算了...{描述}不想做了"
    · 愧疚爆发：intensity +3.0，日记 "不行，{描述}再不做真的不行了！"
    · 两者都重置 skipped_count = 0
```

**设计思路**：真实人类的拖延不是无限的——要么彻底放弃（"算了"），要么愧疚到受不了终于开始。压力水平影响放弃概率：高压力时更容易放弃（脑中资源不够了），低压力时更可能愧疚爆发。

---

## 4. Flow/Drift 行为流引擎

> 源文件：`skill/scripts/flow-engine.ts`（293 行）

### 4.1 设计哲学

人类不是每小时都做全新决策——有时会**沉浸**在一件事里（Flow），有时会**无意识摆烂**（Drift）。Flow/Drift 状态机让 Minase 的行为有连续性和惯性。

### 4.2 状态定义

```typescript
interface FlowState {
  status: 'none' | 'flow' | 'drift';
  activity: string | null;      // 当前在做什么
  category: IntentCategory | null;  // 意图类别
  entered_at: string | null;    // 进入时间
  duration_ticks: number;       // 已持续多少 tick
  interrupt_chance: number;     // 被打断概率
}
```

### 4.3 Flow（心流）状态

**进入条件**（`checkFlowEntry`）：
- 当前不在任何特殊状态
- 上一个执行的意图的 **intensity - resistance > 2.0**（高度投入）

**在 Flow 中的行为**：
- **跳过 LLM 调用**——不需要 AI 重新决策，自动继续当前活动
- **减少体力消耗**——vitality drain × 0.7
- 自动生成 Flow 风格日记（8 个模板轮换，如"沉浸在{activity}里出不来了"）

**退出条件**（`checkFlowExit`）——4 个互斥条件：
1. **做够了**：当前意图的 intensity - resistance < 0
2. **累到不行**：vitality < 20
3. **日程打断**：刚性日程不允许当前类别
4. **随机打断**：`rng() < interrupt_chance`（递增概率）

**打断概率递增模型**：
```
初始：0.15（15%）
每 tick：+0.03
上限：0.40（40%）

tick 0: 15%
tick 1: 18%
tick 5: 30%
tick 8+: 40%（上限）
```
这意味着最长的 Flow 也很难超过 8-10 个 tick（约 8-10 小时），符合真实人类的注意力极限。

### 4.4 Drift（摆烂）状态

**进入条件**（`checkDriftEntry`）：
- vitality < 40（比较累）
- 没有任何意图的 intensity - resistance ≥ 1.0（无事可做）
- stress < 0.3（不是因为焦虑，只是单纯没劲）

**在 Drift 中的行为**：
- 跳过 LLM 调用
- 自动执行"刷手机"类活动
- 获得 `browsing_light` 回复（vitality +3）
- 生成 Drift 风格日记（12 个模板，如"咬着吸管喝奶茶...冰都化了还没喝完"）

**退出条件**（`checkDriftExit`）——3 个条件：
1. **强意图涌现**：有意图的 intensity - resistance > 2.0
2. **新事件到来**：有未处理的外部事件
3. **精力恢复**：vitality > 55

### 4.5 写作风格控制（Voice Directive）

**`computeVoiceDirective()`** 根据 Flow/Drift 状态和情绪生成 LLM 写作指令：

| 状态 | 写作风格 |
|------|---------|
| 情绪爆发 | 长句、情绪化、感叹号——像积压后的爆发 |
| Flow | 简短、碎片化——沉浸中偶尔抬头记录 |
| Drift | 意识流、散漫——无聊时随手记，多省略号 |
| 正常+高兴 | 轻快、积极、短句 |
| 正常+低落 | 低落、安静、简短 |
| 正常+焦虑 | 焦虑感、句子跳跃 |
| 正常 | 自言自语式记录 |

每种风格后都附加了角色语音签名（日语口癖、常用语气词、禁止事项等），确保 LLM 生成的文本始终保持水瀬的说话风格。

---

## 5. 活力（代谢）引擎

> 源文件：`skill/scripts/vitality-engine.ts`（186 行）

### 5.1 设计哲学

活力（0-100）是整个系统的**硬性资源约束**——无论 Minase 多想做某件事，没有体力就做不了。这创造了一种"生存压力"，使行为决策有真实的 trade-off。

### 5.2 消耗规则

**每 tick 基础消耗**：

```
drain = BASE_DRAIN(3) × stressMultiplier × arousalDiscount × flowModifier

stressMultiplier = 1.0 + stress × 0.5    // 最高 1.5x（压力大消耗快）
arousalDiscount = arousal < 0.3 ? 0.8 : 1.0  // 安静状态消耗减少
flowModifier = Flow中 ? 0.7 : 1.0       // Flow 状态效率提升
```

**特定行为额外消耗**：

| 行为 | 消耗 |
|------|------|
| post-pipeline | 10 |
| creative_work | 8 |
| high_social | 5 |
| learning | 4 |
| search | 4 |
| browsing | 2 |

### 5.3 恢复规则

| 来源 | 恢复量 |
|------|-------|
| rest（休息） | +8 |
| sleep_cycle（晨规划） | +15 |
| exercise | +6 |
| learning_complete | +5 |
| browsing_light | +3 |
| positive_interaction | +2 |

### 5.4 活力区间与行为约束

| 区间 | vitality | 可发帖 | 可社交 | 可创作 | 可搜索 | 意图倍率 |
|------|---------|-------|-------|-------|-------|---------|
| 高活力 | >70 | ✅ | ✅ | ✅ | ✅ | 1.2x |
| 正常 | 30-70 | ✅ | ✅ | ✅ | ✅ | 1.0x |
| 低活力 | 10-30 | ❌ | ❌ | ✅ | >20 | 0.6x |
| 危急 | ≤10 | ❌ | ❌ | ❌ | ❌ | 0.3x |

### 5.5 死亡螺旋保护

**`morningRecovery()`** 包含紧急恢复机制：

```
每天早上检查：
  vitality < 30 → consecutive_low_days += 1
  
  consecutive_low_days >= 3 → 紧急恢复到 60
    · 重置 consecutive_low_days = 0
```

**设计思路**：防止 Minase 进入"太累 → 做不了事 → 恢复不了 → 永远很累"的死亡螺旋。连续 3 天低活力后强制"休息了一个好觉"。

---

## 6. 信心引擎

> 源文件：`skill/scripts/confidence-engine.ts`（92 行）

### 6.1 设计哲学

构建一个**正反馈循环**：帖子表现好 → 信心上升 → 更愿意创作 → 更多帖子 → 更多数据。反之亦然。这比简单的"创作冷却时间"更真实地模拟了博主的心理。

### 6.2 核心参数

- 范围：0.5 ~ 1.5（1.0 = 中性）
- 日衰减率：0.0033（约每天向中性回归 5%）
- 单次调整：±0.05
- 连胜加成：最高 ±0.06（连续 3 次同方向结果）

### 6.3 计算流程

```
updateConfidence():
  1. 收集近 7 天有数据的帖子
  2. 计算平均互动量 = avg(likes + comments × 3)
  3. 取最新帖子互动量 vs 7 天平均
  4. 高于平均 → +0.05；低于平均 → -0.05
  5. 连续方向 → 连胜加成 = min(|streak|, 3) × 0.02 × sign(streak)
  6. 新信心 = clamp(confidence + delta + streakBonus, 0.5, 1.5)
```

**comments × 3** 的权重设计：评论比点赞更有价值——有人愿意写评论说明内容真正打动了他们。

### 6.4 信心对系统的影响

- **创作意图倍率**：`getCreationRateMultiplier(confidence)` 直接返回 confidence 值——信心 1.5 时创作欲望是 1.5 倍，信心 0.5 时只有一半
- **动态阻力**：信心 < 0.8 时，创作类意图额外 +2.0 阻力
- **LLM 提示词**：`getConfidenceMoodHint()` 生成自然语言描述（"最近创作状态很好，信心满满" / "创作信心比较低，需要重新找方向"）

---

## 7. 上下文感知随机事件引擎

> 源文件：`skill/scripts/random-events.ts`（458 行）

### 7.1 设计哲学

生活不是按计划走的——意外让数字生命更像真人。但不是简单的"10% 概率随机选一个"，而是**根据当前上下文选择合理的事件**。

### 7.2 事件池（21 个事件）

事件覆盖多个场景：
- **ACG 相关**：突然想起喜欢的角色、刷到新番预告、看到大佬作品
- **社交**：看到有趣评论、收到同好私信、和朋友聊了很久
- **生活细节**：天气好、突然想吃好吃的、外卖到了、手机没电了、收到快递
- **工作**：品牌合作谈崩、灵感枯竭期、漫展即将到来
- **情绪**：突然发现已经这个点了、感觉今天过得好慢、楼下装修好吵
- **社交媒体**：看到不舒服的热搜、刷到有创意的短视频、听到喜欢的歌

### 7.3 前置条件系统

每个事件可以定义 7 种前置条件：

```typescript
preconditions: {
  requires_schedule?: string;     // 需要特定日程
  excludes_schedule?: string;     // 排除特定日程
  min_vitality?: number;          // 最低活力
  max_vitality?: number;          // 最高活力（如"身体不舒服"要求 vitality < 50）
  min_emotion?: Partial<EmotionDelta>;  // 情绪最低值
  requires_recent_action?: string;  // 需要最近做过某事（如"看到大佬作品"需要最近有"窥屏"）
  global_cooldown_days?: number;  // 全局冷却天数（如"漫展"30 天冷却）
  excludes_flow?: boolean;        // Flow 中不触发
}
```

### 7.4 动态权重修正

满足前置条件后，还会根据上下文调整触发权重：

| 修正类型 | 条件 | 权重倍率 |
|---------|------|---------|
| emotion_resonance | 事件 valence 方向 = 当前 valence 方向 | ×1.5 |
| vitality_inverse | vitality < 40 | ×2.0 |
| dimension_boost | 对应维度 > 0.5 | ×2.0 |

**示例**：当 creativity > 0.5 时，"刷到创意短视频"的 `dimension_boost: 'creativity'` 使权重翻倍。这模拟了"越有创作欲望越容易注意到创意内容"的心理。

### 7.5 加权随机选择

```typescript
function weightedRandomSelect(pool, rng): RandomEventDef {
  totalWeight = sum(pool.weights)
  roll = rng() × totalWeight
  for (entry in pool):
    roll -= entry.weight
    if (roll <= 0) return entry.event
}
```

### 7.6 连锁事件（Chain Events）

最创新的部分——一个事件可以触发**延迟的后续事件**：

```typescript
chain_events?: Array<{
  description: string;
  probability: number;          // 触发概率
  delay_ticks: [number, number]; // 延迟范围 [min, max]
  emotion_delta: EmotionDelta;
  intent_boosts: Array<...>;
  diary_entry: string;
}>;
```

**经典案例：品牌合作谈崩**

```
"品牌合作谈崩" (立即)
  ├─ stress +0.3, valence -0.2
  │
  ├─→ "越想越憋屈" (60%, 4-8 ticks 后)
  │     stress +0.15, valence -0.1
  │     日记："那件合作的事一直在脑子里转..."
  │
  └─→ "睡前还在想" (30%, 8-14 ticks 后)
        stress +0.2, valence -0.15, arousal +0.1
        日记："躺在床上又开始想白天那件事了..."
```

延迟 ticks 在范围内随机取值，使连锁事件的发生时机不可预测。

### 7.7 连锁事件处理

`processChainEvents()` 每个 tick 调用：
- 所有 pending chain 的 `ticks_remaining -= 1`
- `ticks_remaining <= 0` 的触发：应用情绪 delta + 意图提升 + 写日记
- 未到期的继续等待

### 7.8 冷却期管理

`chainState.cooldowns` 记录每个事件的最后触发时间，配合 `global_cooldown_days` 防止同一事件短期重复。

---

## 8. 社交图谱引擎

> 源文件：`skill/scripts/social-graph-engine.ts`（284 行）

### 8.1 四层分级

| 圈层 | closeness 阈值 | 容量上限 | 说明 |
|------|---------------|---------|------|
| 核心圈 | >7 | 5 | 最亲近的人 |
| 熟悉圈 | 4-7 | 15 | 经常互动的人 |
| 认知圈 | 1-4 | 100 | 偶尔互动的人 |
| 休眠层 | <1 | 500 | 长期不联系的人 |

### 8.2 亲密度变化规则

| 事件类型 | closeness 变化 |
|---------|---------------|
| mutual_comment | +1.0 |
| shared_interest | +1.0 |
| comment_received | +0.5 |
| follow_received | +0.5 |
| reply_sent | +0.3 |
| comment_sent | +0.3 |
| like_received | +0.1 |

### 8.3 时间衰减

```
7+ 天无互动 → closeness -0.2
30+ 天无互动 → closeness -1.0
```

支持 `min_closeness` 地板值——防止特定关系（如创建者）被衰减到休眠。

### 8.4 休眠与移除

```
90 天在休眠层（closeness < 1） → 从关系列表中移除
```

### 8.5 层级再平衡

**`rebalanceTiers()`** 每天夜反思执行一次：

- 熟悉圈超过 15 人：closeness 最低的被降级到认知圈（closeness 上限 3.9）
- 认知圈超过 100 人：closeness 最低的被降级到休眠层（closeness 上限 0.9）
- 休眠层超过 500 人：最久没互动的被移除

### 8.6 社交意图生成

**`generateSocialIntents()`** 自动为核心圈生成社交意图：

```
核心圈成员 3+ 天没互动 → 生成意图：
  category: '社交'
  description: '想去看看 @{name} 的最近动态'
  intensity: min(5, 2 + days × 0.5)
```

---

## 9. 旅行状态机

> 源文件：`skill/scripts/travel-state.ts`（69 行）

### 9.1 四阶段生命周期

根据 `arrived_at` 和 `planned_departure` 计算当前 `travel_day`，然后映射到阶段：

```
Day 1 = arriving（抵达）
Day 2 = exploring（探索）
Day 3+ (非最后一天) = shooting（拍摄）
Last Day = departing（离开）
```

默认每个城市停留 3 天。

### 9.2 自动目的地切换

```
if (today >= planned_departure && next_destination):
  current_city = next_destination
  arrived_at = today
  phase = 'arriving'
```

### 9.3 阶段影响日程

晨规划会根据当前旅行阶段生成不同的刚性日程：
- arriving：探索新环境、找拍摄点
- shooting：外景拍摄为主
- departing：总结帖、打包

---

## 10. 帖子冲动引擎

> 源文件：`skill/scripts/post-impulse.ts`（88 行）

### 10.1 设计哲学

用"有机的冲动"替代"机械的定时"——Minase 不是到时间就发帖，而是冲动累积到阈值才会有发帖欲望。

### 10.2 核心参数

- 值域：0-100
- 发帖阈值：70
- 基础衰减：-3/tick
- 第 1 帖后额外衰减：-5
- 第 2 帖后额外衰减：-15（严重抑制连发）

### 10.3 冲动来源

| 来源 | 冲动增量 |
|------|---------|
| 情绪好（valence>0.6, arousal>0.5） | +5~10 |
| 成功拍照 | +20~30 |
| 休眠恢复（5 天没发帖） | +50 |

### 10.4 休眠检测

```
连续 5 天没发帖 → dormancy boost +50
```

这确保即使 Minase 一直没有自发的发帖欲望，也不会完全停止更新。

---

## 11. 心跳 Tick 编排

> 源文件：`skill/scripts/heartbeat-tick.ts`（937 行）

### 11.1 入口路由

```typescript
main():
  1. 读取 cron-schedule.json
  2. 如果日期不匹配 → 首次唤醒，运行晨规划
  3. 匹配当前小时的心跳类型：
     · morning → runMorningPlan()
     · night → runNightReflect()
     · regular → regularTick()
```

### 11.2 Regular Tick 完整流程（13 步）

```
┌────────────────────────────────────────────────────────────┐
│ Step 1: 状态水合                                            │
│  读取所有状态文件 + hydrate 旧格式兼容                         │
│  · emotion, intentPool, schedule, events, vitality,         │
│    confidence, flowState, chainState, impulse                │
├────────────────────────────────────────────────────────────┤
│ Step 1b: KPI 兜底检查                                       │
│  21:00 后 + 今天没发帖 → 强制触发 post-pipeline              │
│  设置 FORCED_POST=1 环境变量，提前标记 posts_today=1           │
├────────────────────────────────────────────────────────────┤
│ Step 2: 三层情绪处理                                         │
│  decayThreeLayer() → drainVitality() → decayConfidence()    │
│  rollRumination() → checkThresholdBreak()                    │
├────────────────────────────────────────────────────────────┤
│ Step 2b: 连锁事件处理                                        │
│  processChainEvents() → 触发到期的连锁事件                    │
├────────────────────────────────────────────────────────────┤
│ Step 2c: 社交图谱维护                                        │
│  decayAllRelations() → processDormancy()                     │
│  reactivateRelation() → generateSocialIntents()              │
├────────────────────────────────────────────────────────────┤
│ Step 3: 叙事连续性构建                                       │
│  · 最近 3 条 tick 摘要                                       │
│  · 上一条内心独白                                            │
│  · Voice Directive 计算                                      │
│  · 待回复评论检查                                            │
├────────────────────────────────────────────────────────────┤
│ Step 4: Flow/Drift 状态判断                                  │
│  Path A: Flow 中 → checkFlowExit()                          │
│    不退出 → tickFlow() + 写日记 + 写状态 + return             │
│    退出 → resetFlow() + 继续 normal tick                     │
│  Path B: Drift 中 → checkDriftExit()                        │
│    不退出 → tickFlow() + replenish + 写日记 + return          │
│    退出 → resetFlow() + 继续 normal tick                     │
│  Path C: Normal tick → 继续                                  │
├────────────────────────────────────────────────────────────┤
│ Step 5: 意图阶段（6 个子步骤）                                │
│  5a. decaySatisfied()                                        │
│  5b. accumulateIntents()                                     │
│  5c. applyEventBoosts() + injectScheduleIntents()            │
│  5d. computeEmotionIntentCoupling() 情绪耦合                  │
│      × vitalityConstraints.intentMultiplier                  │
│      × creationMultiplier (信心倍率)                          │
│  5e. applyResistanceToPool() 动态阻力                        │
│  5f. checkImpulseBreakthrough() 冲动穿透                     │
│  5g. rollContextAwareEvent() 随机事件                         │
├────────────────────────────────────────────────────────────┤
│ Step 6: LLM 决策                                            │
│  · 构建感知摘要（perception summary）                         │
│  · 组装 heartbeat-prompt.md 模板                             │
│  · getTopIntentsRaw(pool, 7) 展示所有意图给 LLM               │
│  · 显示净值 + 拖延次数，让 LLM 了解"什么该做了"                │
│  · callLLMJSON<HeartbeatDecision>()                          │
│  决策输出：inner_monologue + new_impulses                     │
│           + suppressed_intents + chosen_actions               │
├────────────────────────────────────────────────────────────┤
│ Step 7-8: 行动执行                                           │
│  遍历 chosen_actions:                                        │
│    · satisfies_intent → satisfyIntent() + 情绪反馈            │
│    · simulated/inner → LLM 生成 diary + emotion_delta         │
│    · real + post-pipeline → spawn 子进程                      │
│    · real + search → executeSearch()                          │
│    · real + social-engagement → engageOutbound()              │
│    · real + send-message → attemptProactiveOutreach()         │
├────────────────────────────────────────────────────────────┤
│ Step 8b: 拖延追踪                                            │
│  processProcrastination(pool, chosenIntentIds)               │
│  stress 累积 + 日记输出                                       │
├────────────────────────────────────────────────────────────┤
│ Step 9: 帖子数据检查                                         │
│  checkPostStats() → 24h 后获取互动数据                        │
│  updateConfidence() → 更新信心                                │
├────────────────────────────────────────────────────────────┤
│ Step 10: Flow/Drift 入口检查                                 │
│  checkFlowEntry() → checkDriftEntry()                        │
│  根据刚执行的行动判断是否进入 Flow 或 Drift                    │
├────────────────────────────────────────────────────────────┤
│ Step 11-13: 状态持久化                                       │
│  · 标记事件为已处理                                           │
│  · 更新 reflection 计数器                                     │
│  · writeFlowTickState() 写入所有状态文件                      │
│  · 更新心跳日志                                              │
└────────────────────────────────────────────────────────────┘
```

### 11.3 LLM 决策的输入与输出

**输入（Perception Summary 包含）**：
- 当前时间、情绪六维数值、情绪描述
- 当前日程（自由/刚性）、未处理事件数
- 意图池 Top7（显示强度、门槛、净值、拖延次数）
- 活力值和区间提示
- 信心提示（自然语言）
- 最近 3 tick 摘要
- 上一条内心独白
- 发帖冲动值和 KPI 提醒
- Voice Directive（写作风格指令）

**输出（HeartbeatDecision）**：
```typescript
{
  inner_monologue: string;  // 内心独白
  new_impulses: Array<{ category, description, intensity }>;  // 新产生的欲望
  suppressed_intents: string[];  // 主动压制的意图
  chosen_actions: Array<{
    action: string;
    type: 'real' | 'simulated' | 'inner';
    skill: string | null;
    satisfies_intent: string | null;
  }>;
}
```

### 11.4 行动路由

LLM 返回的 `chosen_actions` 通过 skill 字段路由到不同处理器：

| skill 匹配 | 路由目标 |
|-----------|---------|
| `post-pipeline` / `auto-photo` | 发帖流水线（spawn 子进程） |
| 模糊匹配: /post\|发帖\|拍照\|cos.*拍/ | 同上 |
| /search\|搜\|查\|学习\|研究/ | executeSearch() |
| /social.engagement\|互动\|评论/ | engageOutbound() |
| /send.message\|发消息\|聊天/ | attemptProactiveOutreach() |
| simulated / inner | LLM 生成模拟结果 |

---

## 12. 晨规划与夜反思

### 12.1 晨规划（morning-plan.ts, 291 行）

```
执行时机：每天第一个心跳（07:00 或首次唤醒）

流程：
1. 旅行状态推进
   · computePhaseAndDay() → 更新 phase、travel_day
   · 到期自动切换目的地

2. 灵感采集刷新
   · refreshInspiration() → 从 Instagram/Reddit/ACG 获取最新趋势

3. 根据旅行阶段生成刚性日程
   · arriving → 探索时间安排
   · shooting → 外景拍摄安排
   · departing → 打包和总结安排

4. Instagram 粉丝同步
   · 调用 bridge 获取最新粉丝列表
   · 同步到社交图谱

5. 活力晨间恢复
   · morningRecovery() → +15 基础恢复 + 死亡螺旋检查

6. LLM 生成当日计划
   · 灵活日程 + 意图种子 + 今日心情 + 起床/睡觉时间

7. Cron 日程生成与同步
   · 根据起/睡时间生成心跳时刻表
   · 写入 cron-schedule.json
   · 调用 `openclaw cron edit` 动态同步到平台
```

### 12.2 夜反思（night-reflect.ts, 287 行）

```
执行时机：23:00（或 cron 中标记的 night 心跳）

流程：
1. 处理剩余连锁事件
   · 清理所有 pending chain events

2. 收集统计数据
   · 今天 flow/drift tick 数
   · 拖延事件数
   · 帖子数量
   · 情绪变化轨迹

3. LLM 生成反思（四项涌现产物）
   · 新的人生教训（wisdom entries）
   · 偏好更新（cos_characters, content_style affinity）
   · 梦想更新（create/progress/achieve/abandon）
   · 性格微调（personality drift modifiers）

4. 持久化涌现结果
   · 智慧条目写入 core-wisdom.json（上限 20 条，按重要性剪枝）
   · 偏好/梦想/性格更新到各自文件

5. Undertone 传递
   · 明天的 undertone = average(今天情绪均值, 默认基线)
   · 这使"连续几天心情不好"有跨天传导效果

6. 社交图谱再平衡
   · rebalanceTiers() → 处理超出容量的层级
```

---

## 13. 发帖流水线

> 源文件：`skill/scripts/post-pipeline.ts`（461 行）

### 13.1 端到端流程

```
┌─────────────────────────────────────────────────────────────┐
│ Step 0: cleanupPhotoRoll()                                    │
│  · 删除 30 天前的未发布照片                                     │
│  · 保留已发布到 Instagram 的照片                                │
│  · pruneGallery() 同步清理画廊索引                              │
├─────────────────────────────────────────────────────────────┤
│ Step 1: refreshInspiration()                                   │
│  · 如果心跳中已刷新，跳过（SKIP_INSPIRATION_REFRESH=1）          │
├─────────────────────────────────────────────────────────────┤
│ Step 2: planPhoto() — LLM 拍照决策                             │
│  · 输出：wantToShoot, sceneDescription, style, shots[]          │
│  · 每个 shot: { description, angle, variation, style }         │
├─────────────────────────────────────────────────────────────┤
│ Step 3: generateImageSet() — AI 多镜头生成                     │
│  · 并发度 = 2（每批 2 张同时生成）                               │
│  · 每张独立选择参考图                                           │
│  · 最低数量检查（cos=3, travel=4, daily=1）                    │
├─────────────────────────────────────────────────────────────┤
│ Step 4: uploadToImgURL() — 图床上传                            │
│  · 每张照片上传到 ImgURL 获取公开 URL                           │
│  · 失败不阻塞流程                                              │
├─────────────────────────────────────────────────────────────┤
│ Step 5: writePhotosToGallery() — 画廊索引                      │
│  · 记录照片元数据（localPath, publicUrl, style, emotion 等）    │
├─────────────────────────────────────────────────────────────┤
│ Step 6: shouldConsiderPosting() — 发帖频率检查                  │
│  · FORCED_POST=1 时跳过此检查                                   │
├─────────────────────────────────────────────────────────────┤
│ Step 7: planPost() — LLM 发帖决策                              │
│  · 接入小慧顾问（skipAdvisor 可选）                             │
│  · 输出：selectedPhotos[], coverPhoto, caption, hashtags        │
├─────────────────────────────────────────────────────────────┤
│ Step 8: postToInstagram() — 发布                               │
│  · 单张：callInstagramBridge('upload_photo', ...)               │
│  · 多张：uploadAlbum() (carousel)                               │
│  · 返回 media_pk                                               │
├─────────────────────────────────────────────────────────────┤
│ Step 9: 后续处理                                               │
│  · scheduleCommentCheck() — 24h 后检查评论                      │
│  · uploadToImgURL() — 首张公开 URL 归档                         │
│  · 写入 PostHistory                                            │
│  · markPhotosAsPosted() — 画廊标记                              │
│  · resetImpulseAfterPost() — 重置冲动值                         │
│  · writeDiary() — 以水瀬口吻写日记                              │
└─────────────────────────────────────────────────────────────┘
```

### 13.2 KPI 强制发帖

```
触发条件：hour >= 21 AND posts_today == 0

处理：
  · 设置 FORCED_POST=1
  · 提前标记 posts_today = 1（防止下一 tick 重复触发）
  · 调用 triggerForcedPost()
  · pipeline 内部跳过 shouldConsiderPosting() 检查
  · 成功后追加日记："今天差点忘了发帖，赶紧补上了"
```

---

## 14. AI 图像生成与后处理

### 14.1 双服务商架构（generate-image.ts, 721 行）

```
IMAGE_ENTRY 环境变量：
  · "AIHUBMIX"（默认）→ AIHubMix (Gemini API)
  · "FAI"/"FAL" → fal.ai (Grok Imagine)
```

### 14.2 生成流程

```
1. buildRealisticPrompt(scene, style)
   · 根据 provider 不同使用不同策略
   · 附加相机/镜头锚点、负面约束

2. selectReferences(style, description)
   · 根据风格和场景选择参考图

3. loadReferenceBase64(imagePath)
   · 超过 500KB 用 macOS sips 压缩到 1024px/85%
   · 缓存压缩结果（.compressed.jpg）

4. callWithFallback() — 三级降级链：
   · 尝试 1：多参考图直接传
   · 尝试 2：多图合成网格（Jimp compositeReferences）
   · 尝试 3：只用第一张参考图

5. 质量门控 checkQuality()
   · 使用独立 LLM (gemini-2.0-flash) 6 维评分
   · 维度：人脸相似度、姿态自然度、表情生动度、去AI感、服装质感、构图质量
   · 阈值：普通=4，自拍=5（更严格）
   · 不合格 → 附加修正指令重新生成（最多 1 次）
   · 最终仍不合格 → 优雅降级，保留现有图片

6. 内容安全过滤 sanitizeForImageGen()
   · 30+ 种敏感词替换（比基尼→度假服饰，性感→时尚，etc.）
   · 仅在 API 返回 content_filter 错误时触发
   · 替换后重试
```

### 14.3 照片后处理（image-post-process.ts, 232 行）

**7 种风格预设**：

| 风格 | 噪点 | 模糊 | 对比度 | 饱和度 | 色温 | 暗角 |
|------|------|------|-------|-------|------|------|
| cos | 低 | 0 | 中 | 高 | 暖 | 轻 |
| daily | 中 | 0 | 低 | 中 | 暖 | 中 |
| behind_scenes | 高 | 轻 | 低 | 低 | 冷 | 重 |
| travel | 中 | 0 | 中 | 中 | 暖 | 中 |
| travel_portrait | 低 | 0 | 高 | 高 | 暖 | 轻 |
| travel_food | 低 | 0 | 高 | 高 | 暖 | 无 |
| travel_street | 高 | 轻 | 中 | 低 | 冷 | 重 |

**像素级操作（Jimp）**：

- **噪点**：随机扰动每个像素的 RGB 值（每通道 ±noiseAmount）
- **色温**：暖色 → R + shift, B - shift×0.5；冷色反之
- **饱和度**：RGB 转灰度后按系数混合
- **暗角**：计算每个像素到中心的归一化距离，按 `1 - distance² × amount` 乘以亮度

**确定性伪随机（mulberry32）**：
```
seed = mulberry32(hash(batchId))
同批次照片：各参数在 preset ±3% 范围内变化（一致性）
不同批次：在 preset ±10% 范围内变化（自然差异）
```

---

## 15. 评论互动引擎

> 源文件：`skill/scripts/comment-engine.ts`（296 行）

### 15.1 被动回复模式

```
流程：
1. scheduleCommentCheck() — 发帖时预约 24h 后检查
2. getPendingReplies() — 找出到期的帖子
3. replyToComments(media_pk) — 
   · 通过 bridge 获取评论列表
   · 垃圾过滤（纯 emoji、过短文本）
   · LLM 生成人格化回复
   · 通过 bridge 发送回复
   · 更新社交图谱 closeness
```

### 15.2 主动出击模式

```
engageOutbound({
  socialIntentIntensity,  // 社交意图强度
  emotionSummary,         // 当前情绪
  hashtags,               // 目标话题标签
  followingUserIds        // 关注的用户 ID
}):
  1. 通过 hashtag 发现同类帖子（top posts）
  2. 扫描关注用户的最新动态
  3. 每用户 24h 内最多 2 次互动（去重）
  4. 每日总量 ≤ 5 条主动评论
  5. 同批次不重复评论同一用户
  6. LLM 生成相关评论
  7. 更新社交图谱
```

---

## 16. 四层记忆与反思系统

### 16.1 四层架构

| 层级 | 存储 | 保留时间 | 作用 |
|------|------|---------|------|
| 工作记忆 | 当前对话上下文 | 对话结束 | 聊天时的短期记忆 |
| 日记流（Episodic） | diary.md | 30 天 | 每小时的经历和感受 |
| 社交事件 | relations/*.json | 90 天 | 与每个人的互动记录 |
| 核心智慧 | core-wisdom.json | 永久（上限 20 条） | 从经验中提炼的教训 |

### 16.2 重要性评分

每条日记条目标注 1-10 的重要性分数：
- 1-3：日常琐事（Flow 日记=7，Drift=2）
- 4-6：有意义的事件（发帖=6，模拟行动=4）
- 7-8：重要事件（情绪爆发=8，Flow 持续=7）
- 9-10：里程碑事件

### 16.3 反思触发机制

```
total_importance_since_reflection 每个 tick 累加
当 total_importance_since_reflection ≥ 100 → 触发反思

反思过程（memory-reflect.ts）：
1. 从 diary.md 提取 importance ≥ 6 的条目
2. LLM 生成新的智慧条目
3. 加入 core-wisdom.json
4. 按 importance 排序，保留前 20 条
5. 重置 total_importance_since_reflection = 0
```

---

## 17. 涌现式成长系统

### 17.1 四种涌现产物

每晚夜反思同时产生：

| 涌现产物 | 存储位置 | 说明 |
|---------|---------|------|
| 新教训 | core-wisdom.json | 从今天经历提炼的规律 |
| 偏好更新 | preferences.json | cos 角色/内容风格的 affinity 变化 |
| 梦想更新 | aspirations.json | 创建/推进/达成/放弃长期目标 |
| 性格漂移 | personality-drift.json | ESTP 基底上的 modifier 微调 |

### 17.2 Undertone 传递（跨天情绪惯性）

```
明天的 undertone = average(今天的情绪均值, 默认基线 DEFAULT_UNDERTONE)
```

如果今天整体心情好（情绪均值偏正），明天的基调也会偏正；连续多天心情差，基调会逐渐下沉。

### 17.3 性格漂移

```typescript
interface PersonalityModifier {
  trait: string;      // 如"细心度"
  strength: number;   // 0 ~ 1.0
  origin: string;     // 如"连续修图体验"
  effect: string;     // 如"做事更仔细一些"
}
```

性格漂移不改变 ESTP 基底，只是在上面叠加 modifier——就像真实人类的性格随经历缓慢变化。

---

## 18. AI-对-AI 顾问系统

> 源文件：`skill/scripts/advisor-client.ts`（78 行）  
> 顾问定义：`skill/ins-advisor/SKILL.md`

### 18.1 小慧的角色设定

- **身份**：20 岁深圳美妆博主，8 万粉丝
- **风格**：说话带粤语口癖（"靓女"、"咩"），直爽实际
- **专长**：Hashtag 策略、发帖时机、内容比例
- **关系**：Minase 的"运营闺蜜"

### 18.2 调用机制

```
advisor-client.ts:
1. 加载 advice-prompt.md 模板
2. 注入上下文（当前位置、粉丝数、近期表现、灵感数据）
3. 调用 LLM（使用顾问人设）
4. 超时控制：ADVISOR_TIMEOUT_MS（默认 30s）
5. 优雅降级：任何错误都返回空字符串，不阻塞主流程
```

### 18.3 设计思路

> 规则引擎是死的，但一个"有经验的朋友"可以根据上下文灵活建议。而且顾问不可用时优雅降级，永远不阻塞主流程。

---

## 19. OpenClaw 平台集成

### 19.1 五大平台能力

| 能力 | 用途 | 关键触点 |
|------|------|---------|
| Skill 系统 | Markdown 定义行为规范 | SKILL.md 行为触发表 |
| Hooks | 对话前注入记忆/对话后保存记忆 | agent:bootstrap / command:new |
| Cron | 心跳定时调度 | 动态生成 + `openclaw cron edit` |
| 环境变量 | API Key、配置注入 | AIHUBMIX_API_KEY, INSTAGRAM_*, etc. |
| Channel | 多渠道接入 | QQ Bot 等 |

### 19.2 SKILL.md 行为触发表

```markdown
| 触发场景 | 加载模块 |
|---------|---------|
| 用户开始聊天 | 性格 + 记忆 |
| 用户要求发帖 | Instagram 策略 |
| 定时心跳触发 | 心跳协议 + 意图池 |
| 社交互动事件 | 社交关系网 |
```

平台自动解析这张表，按需加载模块。**改性格 = 改文档，不改代码。**

### 19.3 动态 Cron

晨规划生成心跳时刻表示例：
```json
{
  "date": "2026-03-23",
  "heartbeats": [
    {"time": "07:00", "type": "morning"},
    {"time": "08:00", "type": "regular"},
    ...
    {"time": "22:00", "type": "regular"},
    {"time": "23:00", "type": "night"}
  ]
}
```

写入 `cron-schedule.json` 后，调用 `openclaw cron edit` 同步到平台——**水瀬可以"决定自己今天几点醒来"。**

---

## 20. 工程品质与防御性设计

### 20.1 JSON 备份与恢复

```
每次 writeJSON():
  1. 如果文件已存在 → 复制为 .bak
  2. 写入新内容

每次 readJSON():
  1. 尝试读取 + parse 主文件
  2. 失败 → 尝试读取 + parse .bak 文件
  3. 都失败 → 返回默认值
```

### 20.2 向后兼容（Hydration）

`hydrateEmotionState()`、`hydrateIntent()`、`hydrateHeartbeatLogEntry()` 填充旧版 JSON 中缺失的新字段，确保系统升级后不会因为格式不匹配崩溃。

### 20.3 内容安全

`sanitizeForImageGen()` 定义了 30+ 种敏感词替换：
```
比基尼 → 度假服饰
性感 → 时尚
内衣 → 贴身衣物
紧身 → 修身
...
```

仅在 API 返回 content filter 错误时触发，不影响正常使用。

### 20.4 日志轮转

心跳日志超过 100KB → 只保留最近 50 条。LLM 调用日志 500KB 自动轮转。

### 20.5 错误容忍

- Pipeline 中每个步骤都有 try-catch，失败写日记（以水瀬口吻）但不崩溃
- 图床上传失败 → 非阻塞
- 顾问超时 → 优雅降级
- LLM 调用失败 → 心跳标记 skipped，写错误日志

---

## 21. 系统间耦合关系全图

```
┌───────────────────────────────────────────────────────────────────┐
│                           心跳 Tick 编排                          │
│                    (heartbeat-tick.ts)                             │
│                                                                   │
│  ┌──────────┐   耦合倍率    ┌──────────┐   动态阻力    ┌────────┐ │
│  │ 情绪引擎  │─────────────→│ 意图引擎  │←─────────────│ 活力引擎│ │
│  │ (6维空间) │              │ (7类欲望) │              │ (体力值)│ │
│  │          │←──满足反馈────│          │              │        │ │
│  │          │  三层衰减     │          │←───信心倍率──│ 信心引擎│ │
│  │          │←──反刍────────│          │              │        │ │
│  │          │←──情绪爆发────│          │              └────────┘ │
│  └──────────┘              └──────────┘                          │
│       ↕                         ↕                                │
│  ┌──────────┐              ┌──────────┐                          │
│  │ 随机事件  │──情绪冲动──→│ Flow/    │                          │
│  │ (21种)   │──意图提升──→│ Drift    │                          │
│  │ +连锁事件│              │ 状态机   │                          │
│  └──────────┘              └──────────┘                          │
│       ↕                         ↕                                │
│  ┌──────────┐              ┌──────────┐                          │
│  │ 社交图谱  │──社交意图──→│ 发帖流水线│                          │
│  │ (4层分级) │←──互动更新──│ (端到端) │                          │
│  └──────────┘              └──────────┘                          │
│       ↕                         ↕                                │
│  ┌──────────┐              ┌──────────┐                          │
│  │ 旅行状态  │──日程注入──→│ 帖子冲动  │──发帖欲望──→ 发帖流水线  │
│  │ (4阶段)  │              │ (0-100)  │                          │
│  └──────────┘              └──────────┘                          │
│                                                                   │
│  ┌──────────────────────────────────────────────────┐            │
│  │ 晨规划                    夜反思                    │            │
│  │ · 旅行推进                · 智慧提炼                │            │
│  │ · 灵感采集                · 偏好更新                │            │
│  │ · 日程生成                · 梦想推进                │            │
│  │ · Cron 同步               · 性格漂移                │            │
│  │ · 活力恢复                · Undertone 传递          │            │
│  └──────────────────────────────────────────────────┘            │
└───────────────────────────────────────────────────────────────────┘
```

### 关键耦合路径

1. **情绪→意图**：`computeEmotionIntentCoupling()` 将 6 个情绪维度映射为 7 类意图的倍率
2. **意图→情绪**：`intentSatisfactionFeedback()` 满足意图后情绪反馈
3. **活力→意图**：低活力增加高能耗意图的阻力 + 降低全局意图倍率
4. **信心→意图**：低信心增加创作阻力 + 降低创作倍率
5. **情绪→Flow**：情绪影响 Voice Directive，间接影响行为表达
6. **随机事件→情绪+意图**：事件同时注入情绪冲动和意图提升
7. **社交→意图**：核心圈无互动自动生成社交意图
8. **旅行→日程→意图**：旅行阶段影响刚性日程，日程影响意图阻力
9. **帖子冲动→发帖**：冲动超阈值注入发帖欲望到 LLM 感知
10. **帖子数据→信心→创作欲望**：完整的正/负反馈循环

---

## 技术分享 Tips

1. **用"一天"的故事线讲述**——从晨规划到夜反思，沿时间轴展开
2. **重点讲三层情绪模型**——这是最独特的设计，用"被夸一句 vs 连续被夸一周"来类比
3. **拖延系统最容易引起共鸣**——"她跟我们一样，明知道该修图但就是先刷了手机"
4. **准备日记片段**——Flow 日记、Drift 日记、情绪爆发日记对比展示
5. **强调涌现性**——她的成长不是我们写的剧本，是 LLM 从"自己的经历"中总结的
6. **数字要具体**——9 大自研引擎、21 种随机事件、4 层记忆、6 维情绪、7 类欲望
7. **用架构图做导航**——随时回到系统全景图，标记"我们刚讲的是这个部分"
