# 心跳循环协议

{persona.meta.name}不是被动等人找她聊天的 NPC — 她有自己的一天。心跳循环让她每小时感知世界、产生意图、执行行动，像一个真实的人一样生活。

## 心跳周期

| 时段 | 类型 | 说明 |
|------|------|------|
| {persona.schedule.wake_hour}:00 | 晨规划 (morning) | 起床，回顾昨天，生成今日意图种子和日程 |
| {persona.schedule.wake_hour+1}:00-{persona.schedule.sleep_hour-1}:00 | 常规心跳 (regular) | 每小时一次，感知-意图-行动循环 |
| {persona.schedule.sleep_hour}:00 | 睡前反思 (night) | 日终反思，更新记忆、情绪、偏好、梦想 |
| {persona.schedule.sleep_hour+1}:00-{persona.schedule.wake_hour-1}:00 | 睡眠 | 无心跳，无活动 |

每天约 {active_hours} 次心跳。睡眠时段收到的事件写入 `event-queue.json`，晨规划时消费。

## Cron 触发

OpenClaw cron 触发入口：

| 触发器 | 脚本 | 说明 |
|--------|------|------|
| `cron:morning` | `scripts/lifecycle/morning-plan.js` | 晨规划 |
| `cron:tick` | `scripts/lifecycle/heartbeat-tick.js` | 常规心跳 |
| `cron:night` | `scripts/lifecycle/night-reflect.js` | 睡前反思 |

`heartbeat-tick.js` 是统一入口，内部根据时间判断心跳类型。

## 动态 Cron

晨规划脚本生成当天的 cron 配置，写入 `cron-schedule.json`：

```
路径: {baseDir}/cron-schedule.json
```

{persona.meta.name}可以调整自己的心跳时间 — 周末晚起、某天兴奋到凌晨不睡等。晨规划输出的 cron 配置覆盖默认的每小时整点。

如果 OpenClaw 尚不支持动态 cron 注册，退化方案：固定每整点执行，`heartbeat-tick.js` 内部判断是否在活跃时段，不在则跳过。

## 单次心跳流程

```
1. 感知 (Perceive)
   读取：当前时间、情绪状态、未处理事件队列
   读取：今日日程 → 判断当前日程状态
   读取：记忆上下文（Core Wisdom + 关系 + 近期日记）
   检查：外部信号（新事件？趋势？）
   输出：感知摘要（~200 tokens）

2. 意图 (Intend)
   读取：意图池当前状态 + 人格参数
   运行：规则引擎更新基础意图强度（衰减/累积/事件触发）
   调用：LLM 综合判断，可能产生新冲动、调整优先级
   选出：本次心跳要做的 1-2 件事
   输出：行动决策 + 意图池更新

3. 行动 (Act)
   匹配：最合适的 sub-skill 执行（真实行动 / 模拟行动 / 内心行动）
   写入：行动日志到日记
   更新：情绪状态
   输出：行动日志 + 情绪变化
```

感知输入控制在 500-800 tokens，避免单次心跳消耗过大。

## 三层优先级模型

```
┌─────────────────────────────────┐
│  Layer 0: 刚性日程（不可违抗）     │  固定约定、协作任务、不能更改的安排
├─────────────────────────────────┤
│  Layer 1: 弹性日程（倾向执行）     │  计划中的活动、打算做的事
├─────────────────────────────────┤
│  Layer 2: 意图池（竞争选择）       │  produce/connect/consume/express...
└─────────────────────────────────┘
```

- 先查刚性日程 — 有刚性事件时行为直接锁定，但意图池不停止运转
- 再查弹性日程 — 作为高强度意图注入池中参与竞争
- 最后从意图池选择 — 没有日程约束时正常竞争

刚性日程下仍有缝隙行为（间隙刷手机、等候时刷社交等），不完全屏蔽意图。

## 状态文件路径

所有运行时状态文件位于 `$MEMORY_BASE`（`~/.openclaw/workspace/memory/{persona.meta.id}/`）：

| 文件 | 用途 |
|------|------|
| `emotion-state.json` | 当前情绪（valence/arousal/energy/stress/creativity/sociability） |
| `intent-pool.json` | 所有活跃意图及强度 |
| `schedule-today.json` | 今日刚性 + 弹性日程 |
| `event-queue.json` | 心跳间隔中到达的未处理外部事件 |
| `preferences.json` | 偏好权重（兴趣、内容风格等） |
| `aspirations.json` | 从反思中涌现的梦想和长期目标 |
| `personality-drift.json` | {persona.personality.mbti} 基底上的性格微调 |
| `heartbeat-log.json` | 心跳执行日志 |

Cron 配置：
```
{baseDir}/cron-schedule.json
```

## 容错规则

1. **睡眠跳过**：睡眠时段收到 cron 触发时直接跳过，不执行任何逻辑
2. **LLM 失败重试**：失败后等待 10 秒重试一次，仍失败则跳过本次心跳，写入 `heartbeat-log.json` 标记 `status: "skipped"`
3. **心跳缺失不补**：机器休眠或 OpenClaw 宕机导致心跳缺失时，下次醒来不补执行。晨规划检测到昨天心跳异常少时，在日记中记录「昨天好像断片了」
4. **JSON 备份**：每次写入 JSON 状态文件前，先备份到 `.bak` 文件。读取时如果 JSON 解析失败，回退到 `.bak`；`.bak` 也损坏则使用默认初始值
5. **日志轮转**：`heartbeat-log.json` 文件大小上限 100KB，超出时截断旧条目。晨规划时清理 7 天前的日志
6. **事件队列溢出**：`event-queue.json` 最多 50 个未处理事件，超出时丢弃最旧的，丢弃数量记入日志
