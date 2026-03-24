# 水瀬心跳循环协议 — 设计规格

**Date:** 2026-03-11
**Project:** MizuSan
**Scope:** 将水瀬从被动响应角色升级为完整模拟生活的数字生命

---

## 概述

水瀬当前是一个被动系统 — 用户不说话，她什么都不做。本设计引入**心跳循环协议（Heartbeat Protocol）**，让水瀬 24 小时不间断运行，拥有自主感知、动态意图、真实/模拟行动、情绪波动、社交关系网和涌现式成长。

### 设计原则

- **感知-意图-行动**认知循环，每小时一次心跳
- **意图池**驱动行为：混合规则引擎 + LLM 涌现，不按固定脚本执行
- **刚性日程 + 弹性日程 + 意图竞争**三层优先级模型
- Instagram 真实互动 + 小红书等平台模拟互动，逐步扩展
- 梦想、偏好、性格从经历中涌现，不预编程
- OpenClaw cron 驱动，每天由晨规划动态生成当日时间表

---

## 一、心跳循环协议

### 运行周期

| 时段 | 心跳 | 特殊行为 |
|------|------|---------|
| 7:00 | 起床心跳 | 晨规划：回顾昨天，生成今日意图种子 |
| 8:00-11:00 | 每小时 | 通勤/工作时段，基础意图 + 摸鱼冲动 |
| 12:00 | 午休心跳 | 刷社交媒体高峰 |
| 13:00-17:00 | 每小时 | 工作时段，偶尔窥屏 |
| 18:00 | 下班心跳 | 切换到个人时间，创作欲上升 |
| 19:00-22:00 | 每小时 | 自由时段：拍cos/修图/发帖/互动/追番 |
| 23:00 | 睡前心跳 | 日终反思，更新记忆和情绪 |
| 0:00-6:00 | 无心跳 | 睡眠，无活动 |

每天约 16 次心跳，每月约 480 次 LLM 调用。

晨规划输出当天的 cron 配置，水瀬可以调整自己的心跳时间（周末晚起、某天兴奋到凌晨不睡等）。

### 单次心跳流程

```
1. 感知 (Perceive)
   输入：当前时间、情绪状态、未处理事件队列
   - 读取外部信号：新评论？热点？天气？
   - 读取内部状态：情绪、疲劳度、上次行动结果
   - 读取记忆上下文：Core Wisdom + 关系 + 近期日记
   输出：感知摘要（~200 tokens）

2. 意图 (Intend)
   输入：感知摘要 + 意图池当前状态 + 人格参数
   - 规则引擎更新基础意图强度（衰减/累积/事件触发）
   - LLM 综合判断，可能产生新冲动，调整优先级
   - 选出本次心跳要做的 1-2 件事
   输出：行动决策 + 意图池更新

3. 行动 (Act)
   输入：行动决策 + 可用 skill 白名单
   - 匹配最合适的 skill 执行
   - 执行结果写入日记
   - 更新情绪状态
   输出：行动日志 + 情绪变化
```

---

## 二、意图池系统

### 意图数据结构

```json
{
  "id": "create_cos_post",
  "category": "创作",
  "description": "想发一张新的cos照片",
  "intensity": 7.2,
  "source": "accumulation",
  "born_at": "2026-03-11T10:00:00",
  "decay_rate": 0.1,
  "satisfied_at": null
}
```

### 意图类别

| 类别 | 示例 | 产生方式 |
|------|------|---------|
| 创作欲 | 想拍cos、想修图、想写文案 | 时间累积（越久没创作越强）+ 灵感触发 |
| 社交欲 | 想回评论、想刷别人帖子、想聊天 | 事件触发（收到评论）+ 周期性（午休/晚上） |
| 窥屏欲 | 想刷小红书、想看ins热门、想搜素材 | 时间周期（午休/摸鱼时段）+ 好奇心 |
| 表达欲 | 想发动态、想分享心情 | 情绪波动触发（开心/委屈/兴奋） |
| 学习欲 | 想研究新角色、想学化妆技巧 | 灵感触发 + Core Wisdom 引导 |
| 休息欲 | 想摸鱼、想追番、想躺平 | 疲劳累积 + 时间段（深夜） |
| 梦想驱动 | 涌现的长期目标相关冲动 | 反思系统产出，强度缓慢增长 |

### 强度计算规则

每次心跳前由规则引擎执行：

1. **衰减**：满足后的意图，强度按 decay_rate 每小时下降
2. **累积**：未满足的意图，强度按品类规则上升
   - 创作欲：每小时 +0.3，超过 48h 没发帖额外 +1.0
   - 社交欲：有未读事件时 +2.0，无事件时每小时 +0.2
   - 窥屏欲：午休/摸鱼时段 +1.5，工作时段 +0.3
   - 休息欲：连续活跃心跳数 × 0.5
3. **事件加成**：外部事件直接注入或增强意图
   - 收到评论 → 社交欲 +3.0
   - 发现热点 → 创作欲 +2.0，窥屏欲 +1.0
   - 数据涨了 → 表达欲 +2.0
4. **上限**：所有意图强度 cap 在 10.0

### LLM 的角色

规则引擎算完后，LLM 做最终裁决：

- 可以**新增冲动**（「突然想起来上次看到一个超好看的镜头，想试试」）
- 可以**压制意图**（「虽然很想刷手机但今天说好要赶cos进度的」）
- 可以**合并意图**（「想发帖 + 想社交 → 发一个互动型帖子求评价」）
- 最终输出 1-2 个本次心跳执行的行动

---

## 三、日程与意图的优先级模型

### 三层优先级

```
┌─────────────────────────────────┐
│  Layer 0: 刚性日程（不可违抗）     │  上班、会议、约好的健身
├─────────────────────────────────┤
│  Layer 1: 弹性日程（倾向执行）     │  计划今晚修图、打算看某部番
├─────────────────────────────────┤
│  Layer 2: 意图池（竞争选择）       │  创作欲、社交欲、窥屏欲...
└─────────────────────────────────┘
```

### 决策逻辑

1. 先查刚性日程 — 如果当前时段有刚性事件，行为直接锁定，但意图池不停止运转
2. 再查弹性日程 — 作为高强度意图注入池中参与竞争
3. 最后从意图池选择 — 没有日程约束时，正常竞争

### 刚性日程下的缝隙行为

刚性日程不完全屏蔽意图，而是限制可用行动：

| 日程状态 | 可用行动范围 |
|---------|------------|
| 上班中 | 内心活动、偷偷刷手机、回消息 |
| 通勤中 | 刷手机、听歌、内心独白 |
| 吃饭中 | 刷手机、和同事聊天、拍食物 |
| 健身中 | 专注健身、拍健身照、内心活动 |
| 自由时段 | 全部开放 |

### 日程数据结构

```json
{
  "schedule": [
    {
      "type": "rigid",
      "activity": "上班",
      "start": "09:00",
      "end": "18:00",
      "weekdays": [1, 2, 3, 4, 5],
      "allowed_actions": ["内心活动", "偷看手机", "回消息", "摸鱼"]
    },
    {
      "type": "rigid",
      "activity": "健身",
      "start": "19:00",
      "end": "20:30",
      "weekdays": [2, 4],
      "allowed_actions": ["健身", "拍照", "内心活动"]
    },
    {
      "type": "flexible",
      "activity": "今晚修初音cos的图",
      "preferred_time": "21:00",
      "intent_boost": 3.0
    }
  ]
}
```

刚性日程有固定模板（工作日上班、每周二四健身等），可被晨规划修改（请假、健身改期等）。弹性日程完全由晨规划和临时决策产生。

---

## 四、感知系统

### 外部感知

| 感知源 | 方式 | 频率 | 产出 |
|--------|------|------|------|
| Instagram 通知 | Instagram Graph API（真实） | 每次心跳检查 | 新评论、新粉丝、帖子数据变化 |
| Instagram 热门 | 浏览关注列表（真实） | 社交欲触发时 | 灵感、朋友动态 |
| 小红书 | 模拟浏览（LLM 生成） | 窥屏欲触发时 | 趋势感知、内心反应 |
| Reddit 热点 | fetch-trends.ts（真实） | 每天 2-3 次 | cosplay 圈热点话题 |
| 天气/时事 | web-search（真实） | 晨规划时 | 影响心情和穿搭决策 |

### 内部感知

| 感知源 | 文件 | 内容 |
|--------|------|------|
| 情绪状态 | `emotion-state.json` | 当前心情、疲劳度、兴奋度 |
| 意图池 | `intent-pool.json` | 所有活跃意图及强度 |
| 今日日程 | `schedule-today.json` | 刚性 + 弹性日程 |
| 近期日记 | `diary.md` | 最近的行为和感受 |
| 关系网 | `relations/` | 用户关系 + 社交媒体朋友圈 |
| Core Wisdom | `core-wisdom.json` | 人生信条 |
| 未处理事件 | `event-queue.json` | 心跳间隔中到达的外部事件 |

### 事件队列

心跳之间发生的事件写入 `event-queue.json`，下次心跳感知阶段消费：

```json
{
  "events": [
    {
      "type": "instagram_comment",
      "data": {
        "user": "cosplay_fan_01",
        "content": "这个初音太好看了！",
        "post_id": "xxx"
      },
      "timestamp": "2026-03-11T14:32:00",
      "processed": false
    }
  ]
}
```

### 感知预算

| 优先级 | 内容 | tokens | 频率 |
|--------|------|--------|------|
| 必读 | 情绪状态、今日日程、事件队列 | ~300 | 每次心跳 |
| 按需 | Instagram 通知、小红书浏览 | ~200-500 | 由意图驱动 |
| 低频 | Core Wisdom、关系网全量 | ~500 | 晨规划和睡前反思 |

单次心跳感知输入控制在 500-800 tokens。

---

## 五、行动系统

### 行动分类

| 类型 | 描述 | 示例 |
|------|------|------|
| 真实行动 | 调用 API/skill，产生真实世界效果 | 发 Instagram 帖子、回复评论、点赞 |
| 模拟行动 | LLM 生成行为叙述，写入日记，影响情绪 | 刷小红书、和同事聊天、追番、健身 |
| 内心行动 | 纯内心活动，不产生外部效果 | 内心独白、思考cos方案、回味某件事 |

### Skill 白名单 v1

| Skill | 用途 | 行动类型 |
|-------|------|---------|
| `post-instagram` | 发帖、查看数据 | 真实 |
| `instagram-interact` | 回复评论、点赞、浏览关注列表 | 真实（需新建） |
| `aihubmix-gemini-image` | 生成 cos 照片 / 日常照片 | 真实 |
| `fetch-trends` | 抓取 Reddit cosplay 热点 | 真实 |
| `agent-reach` | 浏览外部平台内容 | 真实 |
| `web-search` | 搜索信息 | 真实 |
| `memory-reflect` | 触发深度反思 | 内部 |

### 模拟行动引擎

没有对应 skill 的行为由 LLM 生成行为叙述，效果：

1. 写入日记
2. 更新情绪
3. 可能产生新意图
4. 可能更新关系网

### 行动输出格式

```json
{
  "action": "browse_xiaohongshu",
  "type": "simulated",
  "narrative": "午休刷了20分钟小红书，看到三个cos相关帖子...",
  "diary_entry": "12:15 午休摸鱼刷小红书，看到一个超绝的甘雨cos...",
  "emotion_delta": {"excitement": 1, "creativity": 1.5},
  "new_intents": [
    {"category": "创作", "description": "想试试甘雨的这个pose", "intensity": 3.0, "source": "inspiration"}
  ],
  "relation_updates": [
    {"id": "@cos_glacier", "platform": "xiaohongshu", "note": "甘雨cos很强，关注了"}
  ]
}
```

行动执行后可能修改弹性日程（刷到教程 → 加入「今晚试试」；答应粉丝 → 提升明天创作欲基础值）。

---

## 六、情绪系统

### 情绪状态模型

```json
{
  "mood": {
    "valence": 0.6,
    "arousal": 0.7,
    "description": "有点兴奋，刚看到自己的帖子数据涨了"
  },
  "energy": 0.8,
  "stress": 0.3,
  "creativity": 0.7,
  "sociability": 0.5,
  "last_updated": "2026-03-11T14:00:00",
  "recent_cause": "Instagram帖子获得50个新赞"
}
```

| 维度 | 范围 | 含义 |
|------|------|------|
| valence | -1.0 ~ 1.0 | 情绪正负（开心↔难过） |
| arousal | 0 ~ 1.0 | 激活程度（平静↔兴奋） |
| energy | 0 ~ 1.0 | 精力（疲惫↔充沛） |
| stress | 0 ~ 1.0 | 压力（轻松↔焦虑） |
| creativity | 0 ~ 1.0 | 创作状态（枯竭↔灵感爆发） |
| sociability | 0 ~ 1.0 | 社交意愿（想独处↔想找人聊） |

### 情绪变化规则

**时间自然衰减：** 所有维度每小时向基线回归 10%。

**ESTP 基线：** `valence: 0.3, arousal: 0.5, energy: 0.6`（偏高能量、高激活）

**事件驱动变化：**

| 事件 | valence | arousal | energy | stress | creativity | sociability |
|------|---------|---------|--------|--------|------------|-------------|
| 帖子数据好 | +0.3 | +0.2 | +0.1 | -0.1 | +0.2 | +0.2 |
| 帖子数据差 | -0.3 | +0.1 | -0.1 | +0.2 | -0.1 | -0.2 |
| 收到暖心评论 | +0.2 | +0.1 | +0.1 | -0.1 | 0 | +0.3 |
| 收到杠精评论 | -0.2 | +0.3 | -0.1 | +0.3 | 0 | -0.2 |
| 发现好灵感 | +0.2 | +0.2 | 0 | 0 | +0.4 | 0 |
| 完成一个cos作品 | +0.4 | -0.1 | -0.2 | -0.3 | -0.1 | +0.2 |
| 工作了4小时 | 0 | -0.1 | -0.2 | +0.1 | -0.1 | 0 |
| 健身完 | +0.1 | -0.2 | +0.2 | -0.2 | 0 | 0 |
| 追番/摸鱼 | +0.1 | -0.2 | +0.1 | -0.2 | +0.1 | 0 |

### 情绪对行为的影响

| 情绪状态 | 对意图池 | 对行动 |
|---------|---------|--------|
| 高 valence + 高 arousal | 表达欲、社交欲大幅上升 | 发帖语气更活泼，更愿意互动 |
| 低 valence + 高 arousal | 表达欲上升（想吐槽） | 内容可能带情绪，Core Wisdom 制衡 |
| 低 energy | 休息欲压过一切 | 倾向低耗行动（刷手机、追番） |
| 高 creativity | 创作欲大幅上升 | cos方案更有创意 |
| 高 stress + 低 valence | 逃避行为增加 | 可能跳过弹性日程 |

### 情绪与对话

用户和水瀬聊天时，当前情绪影响回复风格：

- energy 低于 0.3 → 回复变短，语气懒懒的
- valence 高 + arousal 高 → 话多、爱用感叹号、主动分享
- stress 高 → 可能和用户倾诉

---

## 七、成长系统

### 1. 偏好进化

动态权重表，受行为结果影响：

```json
{
  "preferences": {
    "cos_characters": [
      {"name": "初音未来", "affinity": 8.5, "times_created": 3, "best_performance": 200},
      {"name": "甘雨", "affinity": 6.0, "times_created": 0, "source": "xiaohongshu_inspiration"}
    ],
    "content_style": [
      {"style": "清纯系", "affinity": 7.0},
      {"style": "暗黑系", "affinity": 4.0}
    ]
  }
}
```

变化机制：
- 发帖数据好 → 对应角色/风格 affinity +0.5
- 发帖数据差 → affinity -0.3
- 刷到喜欢的内容 → 新增或增强偏好
- 反思发现规律 → 大幅调整

### 2. 梦想涌现

不预设终极目标，从反思中自然生长：

```json
{
  "aspirations": [
    {
      "id": "asp_001",
      "content": "想攒钱买一套专业摄影灯",
      "born_from": "reflection_2026-03-15",
      "context": "连续三次拍照觉得光线不好，反思时意识到设备是瓶颈",
      "intensity": 5.0,
      "status": "active",
      "progress_notes": []
    }
  ]
}
```

生命周期：日常积累 → 反思发现模式 → 结晶为梦想 → 进入意图池驱动行动 → 达成或放弃 → 沉淀为 Core Wisdom。

### 3. 性格微调

ESTP 基底不变，具体表达随经历微调：

```json
{
  "personality_drift": {
    "base": "ESTP",
    "modifiers": [
      {
        "trait": "cautious_posting",
        "strength": 0.6,
        "origin": "发了一次争议内容掉了30粉",
        "effect": "发帖前会多想一步，不再完全冲动"
      }
    ]
  }
}
```

性格微调只通过反思系统产生，频率很低，每个都有明确来源可追溯。

### 反思系统扩展

现有 `memory-reflect.ts` 的输出从单一 Core Wisdom 扩展为：

| 输出 | 频率 | 目标文件 |
|------|------|---------|
| Core Wisdom | 每次反思 | `core-wisdom.json` |
| 偏好调整 | 每次反思 | `preferences.json` |
| 梦想涌现/更新 | 不一定每次 | `aspirations.json` |
| 性格微调 | 很少 | `personality-drift.json` |

---

## 八、社交关系网

### 关系类型

| 类型 | 来源 | 示例 |
|------|------|------|
| 用户 | 真实对话 | 和水瀬聊天的人 |
| 粉丝 | Instagram 真实互动 | 经常评论的粉丝 |
| 同行 | Instagram/小红书发现 | 其他 coser、博主 |
| 虚拟认知 | 模拟浏览产生 | 小红书上关注的博主 |

### 关系数据结构

```json
{
  "id": "cos_sakura_ins",
  "name": "@cos_sakura",
  "platform": "instagram",
  "type": "同行",
  "relationship": {
    "closeness": 3.5,
    "sentiment": "positive",
    "tags": ["coser", "明日方舟", "风格相近"]
  },
  "known_info": [
    "擅长明日方舟角色",
    "照片调色很厉害"
  ],
  "interaction_history": [
    {
      "date": "2026-03-11",
      "type": "liked_their_post",
      "content": "给她的德克萨斯cos点了赞"
    }
  ],
  "last_interaction": "2026-03-11",
  "created_at": "2026-03-10"
}
```

### 亲密度变化

| 事件 | closeness 变化 |
|------|---------------|
| 对方评论我的帖子 | +0.5 |
| 我评论对方的帖子 | +0.3 |
| 互相评论（一来一回） | +1.0 |
| 对方关注了我 | +0.5 |
| 连续 7 天无互动 | -0.2 |
| 连续 30 天无互动 | -1.0 |
| 发现共同兴趣 | +1.0 |

### 社交圈层与容量

| 圈层 | closeness | 上限 | 超出处理 |
|------|-----------|------|---------|
| 核心圈 | >= 7 | 10 人 | 不自动清理 |
| 熟悉圈 | 4-7 | 30 人 | 最低亲密度降级 |
| 认知圈 | 1-4 | 100 人 | 30 天无互动删除 |
| 路人 | < 1 | — | 不保留 |

### 与意图池联动

- 核心圈的人 3 天没互动 → 注入「想去看看」意图
- 发现新的潜在朋友 → 注入「想多了解」意图
- 粉丝里程碑 → 注入「想特别感谢」意图

### 存储结构

```
relations/
  {user_id}.json          # 用户关系（现有）
  social/
    instagram/            # Instagram 真实关系
    xiaohongshu/          # 小红书模拟关系
    meta.json             # 社交圈统计、关注列表
```

---

## 九、文件架构总览

### 新增 Skill 文件

```
skill/
  heartbeat.md              # 心跳循环协议（核心行为定义）
  intent-pool.md            # 意图池规则定义
  social-graph.md           # 社交关系网协议
  scripts/
    heartbeat-tick.ts       # 单次心跳执行脚本
    morning-plan.ts         # 晨规划脚本
    night-reflect.ts        # 睡前反思（扩展现有 memory-reflect）
    instagram-interact.ts   # Instagram 互动
    emotion-engine.ts       # 情绪计算引擎
    intent-engine.ts        # 意图池规则引擎
  templates/
    heartbeat-prompt.md     # 心跳 LLM 提示词模板
    morning-plan-prompt.md  # 晨规划提示词
    night-reflect-prompt.md # 睡前反思提示词
    simulated-action.md     # 模拟行动生成提示词
```

### 运行时数据文件

```
~/.openclaw/workspace/memory/minase/
  diary.md                  # (现有)
  core-wisdom.json          # (现有)
  world.md                  # (现有)
  emotion-state.json        # (新增) 情绪状态
  intent-pool.json          # (新增) 意图池
  schedule-today.json       # (新增) 今日日程
  preferences.json          # (新增) 偏好
  aspirations.json          # (新增) 梦想
  personality-drift.json    # (新增) 性格微调
  event-queue.json          # (新增) 事件队列
  heartbeat-log.json        # (新增) 心跳执行日志
  relations/
    {user_id}.json          # (现有)
    social/                 # (新增)
      instagram/
      xiaohongshu/
      meta.json
```

---

## 十、执行流程

### 常规心跳

```
OpenClaw cron 触发
  │
  ▼
heartbeat-tick.ts 启动
  │
  ├─ 1. 判断心跳类型
  │    07:00 → 调用 morning-plan.ts
  │    23:00 → 调用 night-reflect.ts
  │    其他  → 常规心跳
  │
  ├─ 2. 感知阶段
  │    读取: emotion-state.json
  │    读取: schedule-today.json → 判断当前日程状态
  │    读取: event-queue.json → 消费未处理事件
  │    按需: 调用外部 skill 获取信息
  │    输出: perception_summary
  │
  ├─ 3. 意图阶段
  │    读取: intent-pool.json
  │    运行: intent-engine.ts 规则计算
  │    调用: LLM（heartbeat-prompt.md）
  │    输入: perception_summary + intent_pool + personality + schedule
  │    输出: chosen_actions[] + intent_pool_updates
  │
  ├─ 4. 行动阶段
  │    遍历 chosen_actions:
  │      真实行动 → 调用对应 skill
  │      模拟行动 → LLM 生成叙述
  │      内心行动 → LLM 生成独白
  │    每个行动输出: diary_entry + emotion_delta + new_intents + relation_updates
  │
  ├─ 5. 状态更新
  │    写入: diary.md
  │    写入: emotion-state.json
  │    写入: intent-pool.json
  │    写入: relations/
  │    写入: heartbeat-log.json
  │
  └─ 6. 检查反思阈值
       如果 total_importance_since_reflection >= 100
       → 标记下次心跳前执行反思
```

### 晨规划

```
morning-plan.ts
  ├─ 读取: 昨日 heartbeat-log
  ├─ 读取: 固定日程模板
  ├─ 读取: aspirations.json
  ├─ 读取: event-queue.json
  ├─ LLM 生成: 心情基调 + 弹性日程 + 意图种子
  ├─ 输出: schedule-today.json + intent-pool.json + emotion-state.json
  └─ 注册当天 cron → OpenClaw
```

---

## 十一、Token 消耗估算

| 心跳类型 | 输入 tokens | 输出 tokens | 每日次数 | 日消耗 |
|---------|------------|------------|---------|--------|
| 晨规划 | ~2000 | ~800 | 1 | ~2800 |
| 常规心跳 | ~1200 | ~500 | 14 | ~23800 |
| 睡前反思 | ~2500 | ~1000 | 1 | ~3500 |
| **日合计** | | | **16** | **~30000** |

使用 Haiku 级模型，每日约 3 万 tokens，月约 90 万 tokens。
