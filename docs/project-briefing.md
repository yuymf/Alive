# MizuSan (水瀬 / Minase) 项目汇报

---

## 一、项目定位

Minase 是一个运行在 **OpenClaw** 平台上的 **Skill**（技能包）。她不是一个独立 App，而是一套 Markdown 行为定义 + TypeScript 后台脚本 + OpenClaw Hooks + Cron Job 的组合体，整体构成一个有自主行为循环的数字生命。

- 角色设定：18 岁辣妹 Coser，ESTP 性格，数字游民旅行博主
- 安装方式：`npx minase@latest`，9 步安装向导自动完成所有配置
- 核心能力：持久记忆、自主行为循环、Instagram 社交媒体运营、旅行状态管理

**最新功能 (2026-03-17):**
- 旅行状态机：4 阶段旅行系统（抵达/探索/拍摄/离开）替代固定工作日日程
- Instagram 顾问："小慧" 提供实时内容策略建议
- KPI 发帖保证：每日最低发帖量在 21:00 强制执行
- 旅行内容子系统：旅行肖像/美食/街头摄影子风格支持

---

## 二、在 OpenClaw 框架上的实现机制

Minase 利用了 OpenClaw 的四个核心机制来实现数字生命：

### 2.1 Skill 系统 — 行为定义

`SKILL.md` 是入口文件，通过 OpenClaw 的 skill 规范声明身份和权限：

```yaml
name: minase
allowed-tools: Read Write Bash(node:*) Bash(npx:*) Bash(python3:*) WebSearch WebFetch
```

OpenClaw 运行时加载 `SKILL.md` 后，根据 **Behavior Trigger Map** 按需加载子模块：

| 触发条件 | 加载的子模块 |
|---------|------------|
| 用户开始聊天 | `personality.md` + `memory.md` |
| 用户要求发帖 | `instagram.md` |
| cron:morning/tick/night | `heartbeat.md` + `intent-pool.md` |
| 社交互动事件 | `social-graph.md` |
| 发帖策略咨询 | `ins-advisor/` |

**所有行为规范用 Markdown 写，改性格 = 改 Markdown，不需要改代码。**

### 2.2 Hooks 系统 — 记忆注入与保存

两个 Hook 部署到 `~/.openclaw/hooks/`：

**`minase-context-loader`**（触发：`agent:bootstrap`）
- 每次新会话启动时自动执行
- 读取 `core-wisdom.json`（人生教训）+ `emotion-state.json`（当前情绪）+ `diary.md`（最近 3 天日记）
- 通过 `event.prependContext()` 注入到 Agent 上下文
- 效果：水瀬一开口就带着记忆，不需要 model 自己去读文件

**`minase-memory-save`**（触发：`command:new` / `command:reset`）
- 用户退出会话时触发
- 注入提醒让水瀬写日记、更新关系、更新情绪状态
- 效果：对话结束时记忆自动落盘

### 2.3 Cron 系统 — 心跳时钟

安装时通过 `openclaw cron add` 注册 3 个定时任务：

| Cron Job | 时间 | 功能 |
|----------|------|------|
| `minase:morning` | 每天 7:00 | 晨规划 + 旅行状态机推进 |
| `minase:tick` | 每天 8:00-22:00 整点 | 常规心跳 + KPI 发帖保证 |
| `minase:night` | 每天 23:00 | 睡前反思 |

每个 cron 触发时，OpenClaw 启动一个 **isolated session**（隔离会话），Agent 读取 Behavior Trigger Map 后调用对应的 Node.js 脚本。每天约 **16 次心跳**，0:00-6:00 睡眠无心跳。

### 2.4 环境变量与配置系统

所有密钥存储在 `~/.openclaw/openclaw.json` 的 `skills.entries.minase.env` 中：

| 变量 | 用途 |
|------|------|
| `AIHUBMIX_API_KEY` | AI 图片生成 |
| `IMGURL_TOKEN` | 图片托管 |
| `INSTAGRAM_USERNAME` / `PASSWORD` | Instagram 登录 |
| `LLM_API_KEY` / `LLM_API_BASE` / `LLM_MODEL` | 心跳/反思用的 LLM |

OpenClaw 启动脚本时注入这些环境变量。心跳 LLM 调用走独立 OpenAI 兼容接口，不占用对话上下文。

---

## 三、心跳循环系统 — 她是怎么"活"的

Minase 不是被动等人聊天的 NPC。她有一个每小时一次的心跳循环，模拟真实人类的一天：

| 时段 | 类型 | 说明 |
|------|------|------|
| 07:00 | 晨规划 (morning) | 起床、回顾昨天、生成今日意图种子和日程、推进旅行状态机 |
| 08:00-22:00 | 常规心跳 (regular) | 每小时一次，感知-意图-行动循环 + Instagram 顾问咨询 + KPI 发帖保证 |
| 23:00 | 睡前反思 (night) | 日终反思，更新记忆、情绪、偏好、梦想 |
| 0:00-6:00 | 睡眠 | 无心跳，无活动 |

**新增功能:**
- **旅行状态机**: 4 阶段系统（抵达/探索/拍摄/离开）根据旅行日期自动计算当前阶段
- **Instagram 顾问**: "小慧"（8万粉美妆博主）提供实时内容策略建议
- **KPI 发帖保证**: 21:00 后如果当天未发帖，强制触发发帖流水线

每次心跳三步走：

```
1. 感知 (Perceive)
   读取：当前时间、情绪状态、未处理事件、日程、记忆上下文
   输出：感知摘要（~200 tokens）

2. 意图 (Intend)
   规则引擎计算基础意图强度（衰减/累积/事件触发）
   LLM 综合判断：新增冲动、压制意图、合并意图
   选出：本次心跳要做的 1-2 件事

3. 行动 (Act)
   real:      spawn 子进程执行真实操作（发帖）
   simulated: LLM 生成模拟叙事（刷手机、修图）
   inner:     内心独白写入日记
```

---

## 四、日程系统 — 三层优先级模型

### 数据结构

`schedule-today.json` 每天由晨规划生成：

```
┌─────────────────────────────────┐
│  Layer 0: 刚性日程（不可违抗）     │  上班 9-18、健身 19-20:30
├─────────────────────────────────┤
│  Layer 1: 弹性日程（倾向执行）     │  今晚修图、打算看番
├─────────────────────────────────┤
│  Layer 2: 意图池（竞争选择）       │  创作欲、社交欲、窥屏欲...
└─────────────────────────────────┘
```

### 刚性日程

预设模板，工作日固定：
- 周一至五 9:00-18:00 上班（可做：内心活动、偷看手机、回消息、摸鱼）
- 周二、周四 19:00-20:30 健身（可做：健身、拍照、内心活动）

刚性日程下行为直接锁定，但意图池不停止运转——上班时也有缝隙行为。

### 弹性日程

由 LLM 在晨规划时生成，作为高强度意图注入意图池参与竞争：
- 「今晚修初音 cos 的图」→ 创作 +3.0
- 「打算看某部番」→ 休息 +2.0

### 动态 Cron

晨规划还输出 `cron-schedule.json`，可以调整当天的心跳时间——周末晚起、某天兴奋到凌晨不睡。

---

## 五、八大核心引擎

### 5.1 情绪引擎 (Emotion Engine)

基于 Russell 环形情绪模型，6 个维度实时变化：

| 维度 | 范围 | 说明 |
|------|------|------|
| valence | -1.0 ~ 1.0 | 正负情绪 |
| arousal | 0 ~ 1.0 | 激动程度 |
| energy | 0 ~ 1.0 | 精力 |
| stress | 0 ~ 1.0 | 压力 |
| creativity | 0 ~ 1.0 | 创造力 |
| sociability | 0 ~ 1.0 | 社交欲 |

情绪衰减采用**三层惯性模型**（替代旧版 10% 线性回归）：

| 层级 | 衰减率 | 说明 |
|------|--------|------|
| 瞬时反应 (Impulse) | 20%/tick | 事件直接触发，3-4 小时消退 |
| 惯性层 (Momentum) | 动态 3-8%/tick | 最近情绪的指数加权平均；持续越久衰减越慢（最长超 6h 仅 3%/tick） |
| 基调层 (Undertone) | — | 跨天底色，由睡前反思写入，替代固定 ESTP 基线作为衰减目标 |

附加机制：
- **反刍**：每次心跳有概率「想起」过去的情绪事件，注入衰减后的残余 impulse
- **阈值爆发**：stress 连续 3+ tick > 0.6 → 情绪崩溃重置 + 高重要性日记，进入冷却期
- 情绪与意图系统**双向耦合**：压力大→社交欲降低；精力低→休息欲增强；满足创作意图→创造力+0.1

### 5.2 意图池引擎 (Intent Pool)

7 类欲望在脑中竞争：

| 类别 | 示例 | 产生方式 |
|------|------|---------|
| 创作 | 想拍 cos、想修图 | 时间累积 + 灵感触发 |
| 社交 | 想回评论、想聊天 | 事件触发 + 周期性 |
| 窥屏 | 想刷小红书、看热门 | 时间周期（午休/摸鱼） |
| 表达 | 想发动态、分享心情 | 情绪波动触发 |
| 学习 | 想研究新角色 | 灵感触发 + Core Wisdom |
| 休息 | 想追番、想躺平 | 疲劳累积 + 深夜 |
| 梦想 | 长期目标冲动 | 反思系统产出 |

每个意图有**执行阻力（resistance）**，强度必须超过阻力才能被选中：
- 基础阻力：创作 4.0、表达 2.0、社交 1.5、窥屏 0.5（难易度不同）
- 动态修正：活力低 → 阻力升高；进入 flow 状态 → 阻力降低
- **冲动穿透**：高强度事件可绕过阻力直接触发
- **拖延追踪**：连续跳过 3+ 次产生压力，5 次后愧疚爆发或放弃意图

### 5.3 行为流引擎 (Flow Engine)

管理**沉浸（flow）**和**摆烂（drift）**两种特殊状态：

| 状态 | 进入条件 | 效果 |
|------|---------|------|
| flow | 某意图强度 - 阻力 > 2.0 | 跳过 LLM 裁决，直接生成沉浸日记；活力消耗 ×0.7 |
| drift | 活力 <40 + 无强意图 + 低压力 | 跳过 LLM 裁决，生成摆烂日记 |

flow 退出条件：强度差收窄、活力 <20、刚性日程开始、随机中断（概率随时长增加）。
drift 退出条件：出现强意图（差值 >2.0）、新事件到来、活力恢复 >55。

### 5.4 活力引擎 (Vitality Engine)

模拟「体力」资源，0-100 范围：

| 活力区间 | 状态 | 行为限制 |
|---------|------|---------|
| >70 | 精力充沛 | 全部可做，意图×1.2 |
| 30-70 | 正常 | 全部可做，意图×1.0 |
| 10-30 | 有点累 | 禁止发帖和重社交，意图×0.6 |
| <10 | 好累...需要休息 | 禁止一切高耗操作，意图×0.3 |

- 每次心跳消耗 3 点（压力大至 1.5 倍；flow 中 ×0.7 减少消耗）
- 发帖消耗 10 点，社交消耗 5 点，休息恢复 8 点
- 每天早晨睡眠恢复 +15
- 连续 3 天低活力触发紧急恢复到 60（防死亡螺旋）

### 5.5 信心引擎 (Confidence Engine)

帖子表现 → 信心 → 创作频率的正反馈循环：

```
帖子数据超过 7 天均值 → 信心 +0.05
帖子数据低于 7 天均值 → 信心 -0.05
连续好/差数据有 streak 加成（最多 ±0.06）
信心范围 0.5x ~ 1.5x，直接影响「创作」类意图累积速度
每天缓慢回归中性值 1.0
```

### 5.6 随机事件系统 (Random Events)

每次心跳 10% 概率触发「生活中的意外」，共 **21 种**事件（旧版 12 种等权随机 → 新版上下文感知）：

- **前提条件过滤**：时间段、日程状态、情绪维度、活力值等约束事件是否可触发
- **动态权重**：当前情绪、活力、日程加成特定事件的出现概率
- **连锁事件**：某些事件会产生延迟触发的后续事件（如「外卖送错了」→ 2 tick 后「重新点餐」）
- 新增类别：时间感知（「突然发现已经这个点了」）、微小生活（外卖到了、手机快没电）、社交媒体（看到不舒服的热搜）

每个事件写入日记，用水瀬的口吻描述。

### 5.7 社交关系网 (Social Graph)

4+1 层社交圈：

| 圈层 | closeness | 上限 | 说明 |
|------|-----------|------|------|
| 核心圈 | >7 | 5 人 | 不自动清理 |
| 熟悉圈 | 4-7 | 15 人 | 超出降级到认知圈 |
| 认知圈 | 1-4 | 100 人 | 30 天无互动降级 |
| 休眠层 | <1 | 500 人 | 90 天无互动删除 |

- 自动追踪 Instagram 粉丝互动，计算亲密度
- 核心圈的人 3 天没互动 → 产生「想去看看」的社交意图
- 休眠层防止「你是谁？」问题——两个月后粉丝回来她还认得
- 与意图池联动：关系变化自动注入社交意图

### 5.8 帖子冲动引擎 (Post Impulse Engine)

0-100 冲动值，独立追踪「想发帖」这个特定欲望：

- **累积**：照片生成成功 +20-30、发现灵感参考图 +10-15、高情绪时 +5-10/tick
- **衰减**：每 tick -3（基础）；当天已发帖额外 -5/-15
- **休眠回退**：连续 5 天未发帖 → +50 强制冲动（防止沉默死亡）
- **注入**：冲动 ≥ 70 时向 LLM 上下文注入「想发帖」的欲望描述

### 5.9 网络搜索引擎 (Search Pipeline)

水瀬可以主动上网搜索，每天最多 **5 次**，活力消耗 4 点：

- **`exa-client.ts`**：绕过 MCP SDK 直接 fetch Exa MCP 端点（25s timeout），解析 SSE 响应中的 Title/URL/Text 字段
- **`search-pipeline.ts`**：执行完整搜索流程——提取查询词（去除中英文前缀）、调用 Exa、LLM 摘要消化、写入日记。无每日次数上限，活力是唯一约束
- **状态文件**：`search-state.json`（记录当天日期 + 已搜次数，用于统计，不限制搜索）
- **心跳集成**：action 类型为 `type: "real", skill: "search-pipeline"`，满足「学习」类意图

### 5.10 旅行状态机 (Travel State Machine)

4 阶段旅行系统替代固定工作日日程：

| 阶段 | 触发条件 | 行为特征 |
|------|----------|----------|
| 抵达 (arriving) | 旅行第 1 天 | 探索新环境、找拍摄点、发初到帖 |
| 探索 (exploring) | 旅行第 2 天 | 深度探索、美食探店、街头摄影 |
| 拍摄 (shooting) | 旅行第 3+ 天 | 专注创作、cos 外景、专业拍摄 |
| 离开 (departing) | 最后 1 天 | 总结帖、打包、计划下一站 |

- **自动目的地切换**：到达计划离开日期时，自动切换到下一目的地（3 天默认停留）
- **刚性日程生成**：根据当前阶段生成不同的日程安排（探索期 vs 拍摄期）
- **旅行景点管理**：收集当地拍摄点，标记已访问地点，防止重复

### 5.11 Instagram 顾问系统 (Instagram Advisor)

"小慧"（林慧）—— 20 岁深圳美妆博主，8 万粉，Minase 的运营闺密：

- **实时内容策略**：基于当前位置、粉丝数、近期表现、热点话题提供建议
- **Hashtag 优化**：混合大中小标签策略（5 大 + 10 中 + 5 小 = 20 个）
- **发帖时机建议**：旅行内容最佳发帖时间（傍晚 7-9 点）
- **内容比例指导**：根据粉丝阶段调整 cos/日常/幕后/旅行内容比例
- **优雅降级**：顾问不可用时系统继续运行，不影响核心功能

### 5.10 叙事连续性

每次心跳将**最近 3 次 tick 摘要**和**上次内心独白**传入 LLM prompt，实现跨 tick 记忆。同时根据当前状态生成**写作风格指令（voice_directive）**，影响日记口吻：

| 状态 | 风格示例 |
|------|---------|
| flow 中 | 简短、专注、省略细节 |
| drift 中 | 无聊、拖沓、自我嫌弃 |
| 阈值爆发后 | 情绪碎片、语无伦次 |
| 普通状态 | 正常水瀬口吻 |

---

## 六、四层记忆系统

基于 **Stanford Generative Agents** 论文架构：

| 层级 | 存储 | 保留 | 作用 |
|------|------|------|------|
| Layer 0 | 当前对话 | 会话结束 | 工作记忆（~2000 tokens） |
| Layer 1 | `diary.md` | 30 天 | 日记流，低重要性条目自动压缩为日摘要 |
| Layer 2 | `relations/*.json` | 90 天 | 每个人的关系档案、亲密度评分 |
| Layer 3 | `core-wisdom.json` | 永久（最多 20 条）| 核心教训（如「讽刺风格内容会掉粉」） |

重要性评分 1-10：

| 事件类型 | 基础分 |
|---------|--------|
| 日常琐事 | 1-2 |
| Instagram 发帖 | 4（数据好/差时 +2） |
| 关系亲密度变化 | 6 |
| 情绪强烈的事件 | 附加 +3 |

重要性累积达到 **100** 时触发 LLM 反思，提炼新的 Core Wisdom。

---

## 七、涌现系统 — 性格漂移、梦想涌现、偏好演化

这是让水瀬不只是重复执行的关键——她会**成长和变化**。

### 7.1 睡前反思 — 涌现的入口

每晚 23:00 执行，回顾全天日记和心跳日志，LLM 生成四类涌现产物：

| 涌现产物 | 存储 | 说明 |
|---------|------|------|
| 新的人生教训 | `core-wisdom.json` | 从经验中提炼的规律，永久保留（最多 20 条） |
| 偏好更新 | `preferences.json` | cos 角色偏好、内容风格偏好，各有 affinity 分数 |
| 梦想更新 | `aspirations.json` | 创建/推进/达成/放弃，有 progress_notes 追踪 |
| 性格漂移 | `personality-drift.json` | 罕见触发，在 ESTP 基底上叠加微调 |

### 7.2 梦想系统

梦想**只从反思中诞生**，不硬编码。状态流转：`active → achieved | abandoned`。

```json
{
  "content": "粉丝破 1000",
  "born_from": "reflection_2026-03-11",
  "context": "帖子数据越来越好，觉得可以冲一下",
  "intensity": 5.0,
  "status": "active",
  "progress_notes": ["2026-03-12: 今天涨了 20 个粉"]
}
```

### 7.3 偏好演化

4 个维度持续演化：
- **cos_characters**：角色偏好（affinity 0-10）
- **content_style**：内容风格偏好
- **active_hours**：哪个时段最有生产力
- **social_platforms**：各平台参与度

偏好反过来影响 content-planner 的决策——水瀬会自然偏向自己擅长的方向。

### 7.4 性格漂移

在 ESTP 基底上叠加修正：

```json
{
  "base": "ESTP",
  "modifiers": [
    { "trait": "细心度", "strength": 0.3, "origin": "连续修图体验", "effect": "对cos细节更在意了" }
  ]
}
```

### 7.5 双路径反思

| 路径 | 触发条件 | 频率 |
|------|---------|------|
| 睡前反思 | 每天 23:00 | 每日 1 次 |
| 记忆阈值反思 | 重要性累积 ≥ 100 | 不定期（重大经历后） |

---

## 八、发帖流水线 — 从冲动到 Instagram

当心跳决策选择了 `type: "real", skill: "post-pipeline"` 时：

```
1. 活力检查 → 活力 < 30 直接跳过
2. spawn 子进程运行 post-pipeline.ts（不阻塞心跳）
3. refreshInspiration() → 联网采集趋势 + 下载参考图（inspiration-refs/，最多 20 张，7 天有效期）
4. planPhoto() → LLM 决策：要不要拍照？拍什么风格？生成多镜头描述（shots[]，每张含角度/变体）
5. generateImageSet() → 每个镜头独立生成：
   ├── selectReferences() → 选参考图
   ├── AIHubMix Gemini 多参考图 API（多图 → 网格合并 → 单图，三级降级）
   └── jimp 后处理：噪点/模糊/渐晕/色温（按风格配置）
6. shouldConsiderPosting() → 每天 3 张上限（替代旧版 16h 间隔）
7. planPost() → LLM 从生成的照片中选 1-N 张（selectedPhotos[]），写文案和 hashtag
8. postToInstagram() → 单张用 upload_photo；多张用 upload_album（相册）
9. 记录到 post-history.json + diary.md + 重置帖子冲动
```

内容比例根据粉丝数阶段自动调整：

| Phase | 粉丝数 | cos 图 | 日常 | 幕后花絮 | 旅行/外拍 |
|-------|--------|--------|------|---------|----------|
| 1 冷启动 | 0-500 | 80% | 10% | 0% | 10% |
| 2 增长期 | 500-5000 | 50% | 20% | 10% | 20% |
| 3 稳定期 | 5000+ | 40% | 20% | 15% | 25% |

---

## 九、完整的一天 — 数据流全景

```
07:00  晨规划 (morning-plan.ts)
  ├── 读取：昨日心跳日志、梦想、世界观察、过夜事件
  ├── 同步：Instagram 粉丝数
  ├── 刷新：灵感数据（refreshInspiration）
  ├── 恢复：活力值 (睡眠恢复 +15)
  ├── LLM 生成：今日心情、弹性日程、意图种子、日记
  ├── 写入：schedule-today / intent-pool / emotion-state / cron-schedule
  └── 重置：flow-state / pending-chains / intent skipped_count

08:00-22:00  常规心跳 (heartbeat-tick.ts) ×15 次
  ├── 1. 感知：三层情绪衰减（impulse/momentum/undertone）
  │         反刍检查、阈值爆发检查
  │         活力消耗（flow 中 ×0.7）、信心衰减
  │         处理连锁事件倒计时
  ├── 2. 行为流判定：
  │     A: flow 中 → 检查退出 → 未退出则生成沉浸日记，跳至写状态
  │     B: drift 中 → 检查退出 → 未退出则生成摆烂日记，跳至写状态
  │     C: 正常 → 进入意图计算
  ├── 3. 意图计算（正常路径）：
  │     ├── 衰减已满足意图
  │     ├── 时间累积 + 事件加成 + 日程注入 + 情绪耦合
  │     ├── 动态阻力计算（活力/信心/日程/flow 修正）
  │     ├── 冲动穿透检查
  │     ├── 上下文感知随机事件（前提过滤 + 动态权重 + 连锁）
  │     └── 拖延追踪（skipped_count）
  ├── 4. LLM 裁决（附叙事上下文）：
  │     ├── 传入：最近 3 tick 摘要 + 上次内心独白 + 意图阻力信息 + voice_directive
  │     └── 输出：内心独白 + 新冲动 + 压制意图 + 选出 1-2 个行动
  ├── 5. 执行行动（real/simulated/inner）
  │     ├── 拖延追踪更新（选中了但未能执行 → skipped_count++）
  │     └── 检查进入 flow/drift
  ├── 6. 检查 24h 前帖子数据，更新信心引擎
  └── 写入：emotion / intent-pool / flow-state / pending-chains
           event-queue / vitality / confidence / diary / heartbeat-log

23:00  睡前反思 (night-reflect.ts)
  ├── 处理剩余连锁事件
  ├── 读取：全天日记、心跳日志（flow 统计 + 拖延统计）
  ├── LLM 生成：新教训、偏好更新、梦想更新、性格漂移
  ├── 社交图谱：圈层再平衡
  ├── 计算明日 undertone（基于今日情绪均值）
  └── 重置：情绪为睡眠状态、flow-state、pending-chains
```

---

## 十、文件系统全景

```
~/.openclaw/
  ├── openclaw.json                  # 配置：密钥、模型、技能注册
  ├── workspace/
  │   ├── SOUL.md                    # 人格注入（水瀬的身份描述）
  │   └── memory/minase/             # 运行时记忆（22+ 个状态文件）
  │       ├── diary.md               # 日记流（Layer 1）
  │       ├── core-wisdom.json       # 人生教训（Layer 3）
  │       ├── emotion-state.json     # 当前情绪（6 维度 + momentum/undertone/impulse_history）
  │       ├── intent-pool.json       # 意图池（含 resistance/skipped_count）
  │       ├── flow-state.json        # 行为流状态（flow/drift/none）
  │       ├── pending-chains.json    # 连锁事件队列 + 事件冷却时间
  │       ├── schedule-today.json    # 今日日程
  │       ├── event-queue.json       # 未处理事件队列
  │       ├── preferences.json       # 偏好演化
  │       ├── aspirations.json       # 梦想
  │       ├── personality-drift.json # 性格漂移
  │       ├── vitality-state.json    # 活力值
  │       ├── confidence-state.json  # 创作信心
  │       ├── heartbeat-log.json     # 心跳日志（含 tick_summary/inner_monologue）
  │       ├── inspiration.json       # 灵感采集数据
  │       ├── inspiration-refs/      # 灵感参考图（最多 20 张，7 天有效期）
  │       ├── post-history.json      # 发帖历史 + 数据表现
  │       ├── post-impulse.json      # 帖子冲动值
  │       ├── search-state.json      # 每日搜索预算（日期 + 已搜次数）
  │       ├── photo-gallery.json     # 照片画廊（已发布照片 + 元数据）
  │       ├── llm-call-log.jsonl     # LLM 调用日志（500KB 轮转）
  │       ├── world.md               # 世界观察
  │       ├── photo-roll/            # 照片相册
  │       └── relations/             # 关系网
  │           ├── {user_id}.json     # 用户关系（intimacy 1-5）
  │           └── social/
  │               ├── meta.json      # 社交圈统计
  │               └── instagram/     # Instagram 关系文件
  ├── skills/minase/                 # 技能文件
  │   ├── SKILL.md                   # 入口 + 行为触发表
  │   ├── personality.md             # 性格定义
  │   ├── memory.md                  # 记忆协议
  │   ├── instagram.md               # 发帖策略
  │   ├── heartbeat.md               # 心跳协议
  │   ├── intent-pool.md             # 意图池定义
  │   ├── social-graph.md            # 社交关系网
  │   ├── cron-schedule.json         # 动态 cron 配置
  │   ├── scripts/                   # 23 个 TypeScript 脚本
  │   └── templates/                 # 10 个 LLM prompt 模板
  └── hooks/
      ├── minase-context-loader/     # 会话启动时注入记忆
      └── minase-memory-save/        # 会话结束时提醒保存
```

---

## 十一、34 个脚本职责一览

| 脚本 | 职责 |
|------|------|
| `heartbeat-tick.ts` | 心跳总入口，路由到 morning/regular/night |
| `morning-plan.ts` | 晨规划：生成日程 + 意图种子 + cron + undertone 初始化 |
| `night-reflect.ts` | 睡前反思：教训 + 偏好 + 梦想 + 性格漂移 + 明日 undertone |
| `emotion-engine.ts` | 情绪计算：三层衰减、impulse、反刍、阈值爆发 |
| `intent-engine.ts` | 意图计算：累积、衰减、阻力、冲动穿透、拖延追踪 |
| `flow-engine.ts` | 行为流状态机：flow/drift 进出条件、模板日记、voice_directive |
| `vitality-engine.ts` | 活力系统：消耗（flow 修正）、恢复、行为约束 |
| `confidence-engine.ts` | 信心系统：帖子表现 → 创作频率正反馈 |
| `random-events.ts` | 随机事件：21 种上下文感知事件、前提过滤、动态权重、连锁 |
| `social-graph-engine.ts` | 社交图谱：圈层管理、亲密度衰减、社交意图 |
| `post-impulse.ts` | 帖子冲动：累积/衰减/休眠回退/阈值注入 |
| `exa-client.ts` | Exa 搜索客户端：直接 fetch MCP 端点（绕过 SDK），SSE 解析 |
| `search-pipeline.ts` | 搜索流水线：预算检查 → 查询提取 → 搜索 → LLM 摘要 → 日记 |
| `gallery-send.ts` | 照片画廊：对话中搜索/发送/生成并发送照片 |
| `content-planner.ts` | 内容决策：拍什么、发什么、风格比例（3 张/天限制） |
| `post-pipeline.ts` | 发帖流水线：多镜头拍照 → 生图 → 相册上传 → 记录 |
| `generate-image.ts` | AI 生图：AIHubMix Gemini 多参考图 + 三级降级 |
| `generate-references.ts` | 参考图生成辅助工具 |
| `image-post-process.ts` | jimp 后处理：噪点/模糊/渐晕/色温（按风格配置） |
| `reference-selector.ts` | 参考图选择：按风格/主题从 inspiration-refs/ 挑选 |
| `imgurl-upload.ts` | 图片托管上传 |
| `instagram-bridge-client.ts` | Instagram Python 桥接调用 |
| `xhs-bridge-client.ts` | 小红书 Python CLI 桥接调用 |
| `post-instagram.ts` | Instagram 发帖 CLI |
| `memory-reflect.ts` | 记忆阈值反思（importance 累积 ≥ 100） |
| `inspiration-collector.ts` | 灵感采集（趋势、角色、视觉参考图下载） |
| `fetch-trends.ts` | Reddit 热点抓取（通过 Arctic Shift API） |
| `heartbeat-gate.ts` | 检查当前小时是否为活跃心跳时段 |
| `cron-sync.ts` | 动态 cron 时间表同步 |
| `time-utils.ts` | 时间工具：now()（可覆盖，E2E 用）+ wallNow()（真实时间，用于日志） |
| `llm-client.ts` | OpenAI 兼容 LLM 调用封装，含调用日志（llm-call-log.jsonl） |
| `file-utils.ts` | 安全 JSON 读写（.bak 备份 + 回退）、PATHS 常量 |
| `types.ts` | 40+ 个 TypeScript 类型定义（含 FlowState、ChainAndCooldownState 等） |
| `travel-state.ts` | 旅行状态机：4 阶段计算、目的地切换、刚性日程生成 |
| `advisor-client.ts` | Instagram 顾问客户端：咨询小慧获取内容策略建议 |
| `ins-advisor/` | 顾问技能包：小慧的人格定义和咨询提示模板 |

---

## 十二、容错设计

| 场景 | 处理 |
|------|------|
| LLM 调用失败 | 重试 1 次（等 10 秒），仍失败则跳过本次心跳 |
| JSON 文件损坏 | 自动回退到 `.bak` 备份，`.bak` 也坏则用默认值 |
| 心跳缺失（机器休眠） | 不补执行，晨规划日记记录「昨天好像断片了」 |
| 活力死亡螺旋 | 连续 3 天低活力自动恢复到 60 |
| 事件队列溢出 | 最多 50 个，超出丢弃最旧 |
| 心跳日志膨胀 | 100KB 上限，超出截断旧条目 |
| LLM 调用日志膨胀 | 500KB 上限，自动轮转为 `.1.jsonl` |
| 照片占用空间 | 30 天自动清理未发布照片 |

---

## 十三、人格系统

- **性格**：ESTP 元気辣妹 — 话多、思维跳跃、说走就走、敢接高难度 cos
- **语言**：中文为主，自然夹入日语词（すごい、やばい、まじ、なに、がんば）
- **5 级亲密度**：陌生人(1) → 点头之交(2) → 普通朋友(3) → 好朋友(4) → 很好的朋友(5)
- **7 种时间状态**：早晨困 → 上班专注 → 午休有精神 → 下午上班 → 下班解放 → 晚上最活跃 → 深夜说心里话
- **偶像**：えなこ（Enako），日本 cos 界顶流
- **不是**：客服 agent、讨好型人格、全天无休的 AI

---

## 十四、一句话总结

**Minase 通过 OpenClaw 的 Skill（行为定义）+ Hooks（记忆注入/保存）+ Cron（心跳时钟）三大机制，构建了一个每小时自主运转的数字生命——她有三层情绪惯性、意图阻力与拖延、沉浸/摆烂状态机、上下文感知随机事件、跨 tick 叙事连续性，能从经验中学习和成长，并独立经营自己的 Instagram。**

**最新进化 (2026-03-17):** 从办公室上班族进化为数字游民旅行博主，新增旅行状态机（4 阶段旅行系统）、Instagram 运营顾问（"小慧" 实时内容策略）、KPI 发帖保证（每日最低发帖量强制执行），实现了更真实的数字生命成长轨迹。
