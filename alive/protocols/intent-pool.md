# 意图池系统

{persona.meta.name}不按固定脚本执行行为 — 她有欲望、冲动和想法在脑子里竞争。意图池是驱动她行为的核心引擎：规则引擎计算基础强度，LLM 做最终裁决。

## 意图类别 (MetaIntent)

7 个元意图对应人类行为的底层驱动力，适用于任何角色类型。具体的 display_name 和活动示例由 `persona.yaml` 的 `intent_config` 定义。

| MetaIntent | 默认显示名 | 示例 | 产生方式 |
|------------|-----------|------|---------|
| produce | 创作 | 想创作、想制作、想产出内容 | 时间累积（越久没产出越强）+ 灵感触发 |
| connect | 社交 | 想互动、想回复、想聊天 | 事件触发（收到消息）+ 周期性（午休/晚上） |
| consume | 窥屏 | 想刷内容、想看热门、想搜素材 | 时间周期（间隙/休整时段）+ 好奇心 |
| express | 表达 | 想发动态、想分享心情 | 情绪波动触发（开心/委屈/兴奋） |
| learn | 学习 | 想研究新东西、想学技巧 | 灵感触发 + Core Wisdom 引导 |
| rest | 休息 | 想摸鱼、想追剧、想躺平 | 疲劳累积 + 时间段（深夜） |
| aspire | 梦想 | 涌现的长期目标相关冲动 | 反思系统产出，强度缓慢增长 |

## 意图数据结构

```json
{
  "id": "create_content",
  "category": "produce",
  "description": "想创作新内容",
  "intensity": 7.2,
  "source": "accumulation",
  "born_at": "2026-03-11T10:00:00",
  "decay_rate": 0.1,
  "satisfied_at": null
}
```

## 强度范围

所有意图强度范围 **0-10**，上限 cap 在 **10.0**。低于 **0.1** 时自动移除。

## 累积规则

每次心跳前由规则引擎执行：

### produce

- 基础累积：每小时 +0.3
- 超过 48h 没有产出：额外 +1.0

### connect

- 有未读事件时：+2.0
- 无事件时：每小时 +0.2

### consume

- 在间隙/休整时段：+1.0
- 其他时段：+0.2

### express

- 由情绪波动触发，不做时间累积
- valence 绝对值 > 0.6 时自动注入

### learn

- 由灵感触发，基础累积 +0.6
- Core Wisdom 中出现「想学习」「想提升」相关时注入

### rest

- 连续活跃心跳数 x 0.5
- 深夜时段额外 +2.0

### aspire

- 仅由反思系统产出
- 强度缓慢增长，不受时间累积影响

## 衰减规则

意图被满足（`satisfied_at` 不为 null）后：

- 强度按 `decay_rate` **每小时**下降
- 当强度降至 **< 0.1** 时，从意图池移除
- 未满足的意图不衰减，只做累积

## 事件加成

外部事件通过 `intent_boosts` 字段注入或增强意图强度。Sub-skill 和随机事件均可产生 `intent_boosts`：

```json
{
  "intent_boosts": [
    { "category": "connect", "boost": 3.0 },
    { "category": "produce", "boost": 2.0 }
  ]
}
```

具体的事件→意图映射由各 sub-skill 的 `events.yaml` 和 `events.builtin.yaml` 定义。

## 日程注入

弹性日程项作为高强度意图注入池中参与竞争：

- 弹性日程的 `intent_boost` 值加到对应意图类别上
- 例：「今晚做某个项目」→ produce +3.0
- 例：「打算看某部剧」→ rest +2.0

## LLM 的角色

规则引擎算完后，LLM 做最终裁决：

- **新增冲动**：「突然想起来看到一个很有意思的东西，想试试」
- **压制意图**：「虽然很想刷手机但今天说好要赶进度的」
- **合并意图**：「想产出 + 想社交 → 做一个互动型的内容」
- 最终输出 **1-2 个**本次心跳执行的行动

LLM 的裁决受当前情绪、人格参数和 Core Wisdom 影响。高 stress 时倾向压制高耗意图，高 creativity 时倾向放大 produce 类意图。

## 情绪→意图耦合

每个 MetaIntent 的情绪耦合权重可在 `persona.yaml` 的 `intent_config.{meta_intent}.emotion_coupling` 中配置。默认值：

| MetaIntent | 耦合维度 | 权重 |
|------------|---------|------|
| produce | creativity | +0.5 |
| connect | sociability / stress | +0.3 / -0.2 |
| consume | energy_inverse | +0.2 |
| rest | energy_inverse | +0.8 |
| express | valence_abs | +0.3 |
| learn | creativity / stress | +0.2 / -0.3 |
| aspire | valence | +0.2 |
