# MizuSan 数字游民旅游博主重塑 — 设计文档

**日期**: 2025-01-16
**范围**: 三个相互关联的功能，共同将 Minase 从「打工人副业博主」重塑为「数字游民旅游博主」

---

## 背景与目标

当前 Minase 的人设是一名有固定上班时间的年轻人，偶尔发帖。三项新功能将其重塑为：

> **数字游民旅游博主** — 边旅游边拍摄，Instagram 是主业，cos 接单是副收入，每天至少发一帖是职业要求。

三个功能：
1. **发帖 KPI** — 每日至少 1 帖，通过刚性日程 + 硬兜底保障
2. **INS 运营顾问「小慧」** — 网红闺密，独立 OpenClaw skill，为 Minase 提供内容策略建议
3. **旅行内容系统** — 旅行状态机 + 目的地攻略抓取 + 图片生成适配 + 人设重写

---

## 模块一：发帖 KPI + 刚性日程重塑

### 1.1 刚性日程模板变更

`morning-plan.ts` 的 `WEEKDAY_RIGID` 常量完全替换。不再按星期几硬编码，改为按**旅行 phase** 动态生成。

读取来源：`travel-state.json` 的 `phase` 字段

| Phase | 日程安排 |
|-------|---------|
| `arriving` | 09:00–12:00 到达探索；14:00–18:00 踩点拍摄；20:00–21:00 整理发帖 |
| `exploring` / `shooting` | 09:00–12:00 外景拍摄；14:00–17:00 探店/游览；19:30–21:00 发帖时间 |
| `departing` | 10:00–12:00 打包出发；20:00–21:00 发帖总结 |

每条 rigid 条目的 `allowed_actions` 与其活动对应：
- 拍摄时段：`['拍摄', '生成图片', '找外景', '搜攻略']`
- 发帖时段：`['发帖', '写文案', '回评论']`
- 出发时段：`['内心活动', '搜索下一目的地']`

### 1.2 每日 1 帖 KPI — 双层保障

**层 1：有机发帖窗口**

`morning-plan.ts` 生成日程时，在 rigid 条目中包含一个发帖时段（对应上表最后一条）。
当 `posts_today === 0` 时，`buildPerceptionSummary()` 注入额外上下文：
```
【今日任务提醒】今天还没发帖，发帖是今天的工作内容之一。
```

**层 2：21:00 硬兜底**

`heartbeat-tick.ts` 的 `regularTick()` 入口增加前置检查：

```typescript
// KPI 兜底：21:00 后如果当天还没发帖，强制触发
if (hour >= 21 && impulseState.posts_today === 0) {
  await executePostPipeline(vitality, { forced: true, reason: 'daily_kpi' })
  return
}
```

`forced: true` 的效果：
- 跳过 `vitality < 30` 的早退逻辑
- post-pipeline 在 diary 记录特殊条目：「今天差点忘了发帖，赶紧补上」
- 不影响正常的 impulse 积累和 posts_today 计数

### 1.3 文件变更清单

| 文件 | 变更内容 |
|------|---------|
| `skill/scripts/morning-plan.ts` | 替换 `WEEKDAY_RIGID` 为基于 `travel-state.json` phase 的动态生成函数 |
| `skill/scripts/heartbeat-tick.ts` | 在 `regularTick()` 入口增加 KPI 兜底检查 |
| `skill/scripts/post-pipeline.ts` | 支持 `forced: true` 参数，调整 vitality 门槛逻辑，diary 写入特殊条目 |
| `skill/scripts/types.ts` | `PostPipelineOptions` 增加 `forced?: boolean; reason?: string` |

---

## 模块二：INS 运营顾问「小慧」

### 2.1 角色设定

| 属性 | 内容 |
|------|------|
| 名字 | 小慧（Lin Hui） |
| 年龄 | 20 岁（比 Minase 大 2 岁） |
| 背景 | 深圳人，靠 INS 美妆/穿搭账号起家，8 万粉 |
| 与 Minase 关系 | 认识了几年的网红闺密，偶尔一起出去拍 |
| 说话风格 | 接地气、直接、偶尔带点深圳话，不废话 |
| 专长 | 内容策略、hashtag 优化、数据复盘、选题方向 |

### 2.2 技术架构

新建独立 OpenClaw skill：

```
skill/ins-advisor/
  SKILL.md              # 角色入口：小慧的 system prompt + 触发条件
  personality.md        # 小慧的性格、说话风格、内容知识体系
  advice-prompt.md      # 生成运营建议的 LLM 模板
```

`ins-advisor/SKILL.md` 的 `allowed-tools`：
- `web_search`（查平台热点）
- `read_file`（读 Minase 的 post-history.json）

### 2.3 交互流程

**自动咨询（每天一次，在 planPost 前触发）**

`post-pipeline.ts` 的 `planPost()` 前插入：

```typescript
async function consultAdvisor(ctx: AdvisorContext): Promise<string> {
  // 调用 ins-advisor skill 的 LLM
  // 输入：最近 7 天帖子、当前城市、trending topics、粉丝数
  // 输出：一段 200 字以内的「闺密建议」文字
}

// 在 planPost() 前调用
const advisorAdvice = await consultAdvisor({
  recentPosts: await readRecentPosts(7),
  currentLocation: travelState.current_city,
  trendingTopics: inspirationData.visual_trends,
  followerCount: accountStats.followers
})
// advisorAdvice 注入 planPost prompt 的 {advisor_suggestion} 占位符
```

**小慧建议的典型输出格式：**
> 「最近你的旅行帖互动不错，但 caption 有点短，试试加个问句带动评论。今天在京都的话，#kyoto_japan 比 #japan_travel 竞争少，试试看。」

**diary 写入**

advisorAdvice 摘要写入当天 diary，Minase 的内心活动可以引用：
> 「小慧说我 caption 写得太敷衍了，她说得对……」

**社交图集成**

小慧作为 `core` 层关系节点加入 `social-graph`：
- `relations/lin-hui.json` 初始化（intimacy: 0.85，category: core）
- 每次咨询后 closeness 微增（+0.01），长期未互动则缓慢衰减

**用户直接对话**

用户可在 OpenClaw 中直接与小慧对话，她以闺密语气响应，并会主动引用 Minase 近期数据。

### 2.4 文件变更清单

| 文件 | 变更内容 |
|------|---------|
| `skill/ins-advisor/SKILL.md` | 新建：小慧的 OpenClaw skill 入口 |
| `skill/ins-advisor/personality.md` | 新建：角色性格与知识体系 |
| `skill/ins-advisor/advice-prompt.md` | 新建：运营建议 LLM 模板 |
| `skill/scripts/advisor-client.ts` | 新建：调用 ins-advisor LLM 的客户端函数 |
| `skill/scripts/post-pipeline.ts` | `planPost()` 前插入 `consultAdvisor()` 调用，新增 `{advisor_suggestion}` 占位符 |
| `skill/scripts/social-graph-engine.ts` | 初始化 lin-hui 社交图节点，每次咨询后更新 closeness |
| `skill/templates/plan-post-prompt.md` | 新增 `{advisor_suggestion}` 占位符 |
| `data/relations/lin-hui.json` | 新建：小慧的关系文件初始值 |

---

## 模块三：数字游民旅游博主身份 + 旅行内容系统

### 3.1 旅行状态机

新增持久化状态文件 `travel-state.json`：

```json
{
  "current_city": "京都",
  "country": "日本",
  "arrived_at": "2025-01-15",
  "travel_day": 3,
  "planned_departure": "2025-01-18",
  "phase": "shooting",
  "visited_spots": ["岚山竹林", "伏见稻荷"],
  "next_destination": "大阪",
  "travel_mode": "solo"
}
```

**Phase 状态转换：**
```
arriving (day 1) → exploring (day 2) → shooting (day 3..N-1) → departing (最后一天)
```

`morning-plan.ts` 每天运行时：
1. 读取 `travel-state.json`
2. 计算今日是第几天（`travel_day`）
3. 自动推进 phase（如 day 1 → arriving，day N → departing）
4. 更新 `travel_day` 并写回文件
5. 基于 phase 生成当天的 rigid 日程

**目的地切换：**
当 `travel_day` 超过 `planned_departure` 对应天数时，morning-plan 触发「出发到下一目的地」逻辑：将 `next_destination` 提升为 `current_city`，重置 `travel_day = 1`，phase 回到 `arriving`。

### 3.2 目的地攻略抓取

`inspiration-collector.ts` 新增 `collectTravelInspo()` 函数：

```typescript
async function collectTravelInspo(city: string, country: string): Promise<TravelSpot[]> {
  // 搜索关键词："{city} ins风打卡地"、"{city} photography spots"
  // 数据来源：WebSearch（主）→ 小红书 bridge（备）
  // 返回：地点名称、描述、推荐拍摄时间、风格标签
}
```

结果写入 `inspiration-refs/travel-spots.json`（按城市 key 存储，7 天过期）。

在 `refreshInspiration()` 中调用，结果注入 `planPhoto()` 的 `{travel_spots}` 占位符：
```
当前城市可拍摄地点：
- 岚山竹林（已去）：早晨光线最佳，竹林背景
- 清水寺舞台：傍晚 golden hour，城市全景
- 哲学之道（推荐）：樱花/枫叶季节感强，人少
```

### 3.3 图片生成适配

`generate-image.ts` 在现有 travel style 基础上扩展：

**新增 travel 子风格：**

| 子风格 | 触发条件 | 相机锚点 | 风格特征 |
|--------|---------|---------|---------|
| `travel_portrait` | 有地标/景点背景 | iPhone 15 Pro wide angle, golden hour | 人物在景点前，自然快照感 |
| `travel_food` | sceneDescription 含「探店/餐厅/咖啡」 | iPhone overhead flat lay | 食物特写，温暖色调 |
| `travel_street` | 城市街景 | 35mm film grain, natural light | 街拍，随性，有故事感 |

**Prompt 增强：**
`buildRealisticPrompt()` 的 travel 分支注入目的地关键词：
```
当前目的地：{city}，{country}
建议融入环境元素：{spot_description}
```

### 3.4 personality.md 重写要点

**删除：**
- 「上班族」、「打工人」、「996」相关描述
- 固定住所、通勤、周末安排等内容

**新增：**

```markdown
## 职业身份
数字游民旅游博主。Instagram 是主业，靠品牌合作和 cos 接单维持旅行开销。
没有固定住所，背包+相机，城市之间流动。常驻地：随时在变。

## 旅行风格
特种兵式探索，当天决定次日目的地。偏爱小众目的地和日本/东南亚。
会花半天找一个绝佳拍摄角度，但绝对不做提前规划的攻略型游客。
到了一个地方先找好吃的，再找拍照点。

## 收入结构
- Instagram 品牌合作（主要收入）
- Cos 接单：在当地漫展或外景地接拍摄
- 偶尔接旅拍客片

## 旅行心愿目的地
日本（Comiket/池袋/大阪/京都）、东南亚（曼谷/巴厘岛）、欧洲漫展、国内各地展会
```

### 3.5 内容定位调整

`content-planner.ts` 的 `PHASE_RATIOS` 更新：

```typescript
PHASE_RATIOS = {
  1: { cos: 0.4, daily: 0.1, behind_scenes: 0.1, travel: 0.4 },
  2: { cos: 0.3, daily: 0.1, behind_scenes: 0.1, travel: 0.5 },
  3: { cos: 0.25, daily: 0.1, behind_scenes: 0.15, travel: 0.5 },
}
```

旅行内容占比提升至主导（40–50%），cos 降为副线（25–40%）。

### 3.6 Installer 新增初始化

`bin/cli.js` 新增：
- 初始化 `travel-state.json`（默认城市：由用户在安装向导输入）
- 初始化 `relations/lin-hui.json`
- 新增环境变量提示：`TRAVEL_HOME_CITY`（默认出发城市，可选）

### 3.7 文件变更清单

| 文件 | 变更内容 |
|------|---------|
| `skill/scripts/types.ts` | 新增 `TravelState`、`TravelPhase`、`TravelSpot` 类型 |
| `skill/scripts/morning-plan.ts` | 替换刚性日程生成逻辑，读取 travel-state，按 phase 生成 rigid 条目，推进 phase |
| `skill/scripts/inspiration-collector.ts` | 新增 `collectTravelInspo()` 函数，写入 `travel-spots.json` |
| `skill/scripts/generate-image.ts` | 扩展 travel 子风格，注入目的地关键词到 prompt |
| `skill/scripts/post-pipeline.ts` | `planPhoto()` 的 prompt 注入 `{travel_spots}` |
| `skill/templates/photo-intent-prompt.md` | 新增 `{travel_spots}` 占位符 |
| `skill/personality.md` | 重写：删除上班人设，新增数字游民/旅游博主身份 |
| `data/travel-state.json` | 新建：旅行状态初始值 |
| `bin/cli.js` | 安装向导新增 travel-state 和 lin-hui 初始化步骤 |

---

## 系统交互示意（一天运转）

```
07:00 morning-plan
  → 读取 travel-state（京都，shooting，day 3）
  → 生成刚性日程：外景拍摄 09-12 / 探店 14-17 / 发帖 19:30-21:00
  → collectTravelInspo("京都") → travel-spots.json
  → 注入「今日未发帖」提醒

09:00–17:00 heartbeat ticks
  → perception：当前日程=外景拍摄，可做=[拍摄, 生成图片, 找外景]
  → planPhoto 注入 travel_spots（清水寺舞台、哲学之道）
  → 生成 travel_portrait 风格图片
  → accumulateImpulse(+25)

19:30 tick（发帖窗口）
  → consultAdvisor() → 小慧建议注入 planPost prompt
  → planPost 选图 + 写 caption（带问句，按小慧建议）
  → postToInstagram()
  → diary：「今天清水寺的照片发出去了，小慧说这期光线很好」

21:00 兜底检查
  → posts_today = 1，跳过强制触发 ✓
```

---

## 依赖关系

```
模块三（travel-state）
    ↓ 提供 phase/city
模块一（morning-plan 刚性日程）
    ↓ 提供发帖窗口
模块二（小慧咨询）
    ↓ 提供 advisor_suggestion
post-pipeline（planPost）
```

三个模块按此顺序实现可降低集成风险。

---

## 不在此次范围内

- Minase 与小慧的「用户可见对话」UI（可在后续迭代）
- 真实旅行数据接入（地理位置 API 等）
- travel-state 的自动更新机制（本次由 morning-plan 推进，手动配置目的地）
- XiaoHongShu 旅行内容同步
