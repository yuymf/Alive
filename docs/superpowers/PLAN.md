# MizuSan 完整化实施计划

## 目标

让 MizuSan 安装后真正能让 OpenClaw 化身为水瀬 — 不只是被动回复，而是拥有自主生活节奏的数字生命。

---

## Phase 1: 心跳循环激活（Cron 注册）

**优先级：最高 — 这是"活人"和"NPC"的分水岭**

### 1.1 安装器注册 Cron 作业

**修改文件：** `bin/cli.js`

在 Step 6（SOUL.md注入）和 Step 7（Summary）之间，新增 Step 6.5：通过 `child_process.execSync` 调用 `openclaw cron add` 注册 3 个 cron 作业：

```bash
# 晨规划 — 每天 07:00
openclaw cron add \
  --name "minase:morning" \
  --cron "0 7 * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --message "[cron:morning] 水瀬的晨规划时间到了。请读取 ~/.openclaw/skills/minase/SKILL.md 然后执行晨规划流程：node ~/.openclaw/skills/minase/scripts/morning-plan.js" \
  --timeout 180

# 常规心跳 — 每天 08:00-22:00 每小时
openclaw cron add \
  --name "minase:tick" \
  --cron "0 8-22 * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --message "[cron:tick] 水瀬的心跳时间。请执行：node ~/.openclaw/skills/minase/scripts/heartbeat-tick.js" \
  --timeout 120

# 夜反思 — 每天 23:00
openclaw cron add \
  --name "minase:night" \
  --cron "0 23 * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --message "[cron:night] 水瀬的睡前反思时间。请执行：node ~/.openclaw/skills/minase/scripts/night-reflect.js" \
  --timeout 300
```

实现方式：
- 先用 `which openclaw` 检测 openclaw CLI 是否可用
- 可用则直接执行 `openclaw cron add`
- 不可用则打印手动注册说明
- 卸载时 (`--uninstall`) 需要删除这 3 个 cron（`openclaw cron remove --name "minase:morning"` 等）

### 1.2 创建初始 cron-schedule.json

**修改文件：** `bin/cli.js`（Step 5 初始化记忆部分）

在 SKILL_DEST 下创建默认的 `cron-schedule.json`：

```json
{
  "date": null,
  "heartbeats": [
    { "time": "07:00", "type": "morning" },
    { "time": "08:00", "type": "regular" },
    { "time": "09:00", "type": "regular" },
    { "time": "10:00", "type": "regular" },
    { "time": "11:00", "type": "regular" },
    { "time": "12:00", "type": "regular" },
    { "time": "13:00", "type": "regular" },
    { "time": "14:00", "type": "regular" },
    { "time": "15:00", "type": "regular" },
    { "time": "16:00", "type": "regular" },
    { "time": "17:00", "type": "regular" },
    { "time": "18:00", "type": "regular" },
    { "time": "19:00", "type": "regular" },
    { "time": "20:00", "type": "regular" },
    { "time": "21:00", "type": "regular" },
    { "time": "22:00", "type": "regular" },
    { "time": "23:00", "type": "night" }
  ]
}
```

---

## Phase 2: SKILL.md 完善

**优先级：高 — 确保 OpenClaw 正确加载和门控 skill**

### 2.1 添加 metadata.requires

**修改文件：** `skill/SKILL.md`

更新 frontmatter：

```yaml
---
name: minase
description: >
  水瀬 (Minase) — digital life companion with evolving memory and Instagram presence.
  Triggers: 水瀬, 瀬瀬, minase, 她, 发帖, 发Instagram, 今天怎么了, 聊天
allowed-tools: Read Write Bash(node:*) Bash(npx:*) Bash(python3:*) WebSearch WebFetch
metadata:
  { "openclaw": { "emoji": "🌊", "requires": { "env": ["LLM_API_KEY"] }, "primaryEnv": "LLM_API_KEY" } }
---
```

### 2.2 使用 {baseDir} 替换硬编码路径

**修改文件：** `skill/SKILL.md`

将所有 `~/.openclaw/skills/minase/` 引用替换为 `{baseDir}/`，例如：

```
cron-schedule:  {baseDir}/cron-schedule.json
```

Module Loading 部分也应使用 `{baseDir}` 前缀：

```
- **Identity & Voice:** Read `{baseDir}/personality.md`
- **Memory Protocol:** Read `{baseDir}/memory.md`
```

### 2.3 强化记忆加载指令

**修改文件：** `skill/SKILL.md`

在 Core Behavioral Rules 中增加更明确的上下文加载指令：

```markdown
## Conversation Start Protocol (MANDATORY)

When starting ANY conversation:
1. FIRST read `$MEMORY_BASE/core-wisdom.json` — do not respond until this is loaded
2. Read `$MEMORY_BASE/relations/{user_id}.json` if user is known
3. Read last 7 days of `$MEMORY_BASE/diary.md`
4. Load personality.md and memory.md sub-modules
5. Only THEN respond in character

## Conversation End Protocol (MANDATORY)

Before ending any substantive conversation (>3 exchanges):
1. Write diary entry to `$MEMORY_BASE/diary.md`
2. Update `$MEMORY_BASE/relations/{user_id}.json` with new information
3. If importance_score >= 7, also update `$MEMORY_BASE/core-wisdom.json`
```

---

## Phase 3: Hook 对接（记忆可靠性保证）

**优先级：高 — 让记忆读写不依赖模型自觉**

### 3.1 创建 minase-context-loader hook

**新建目录和文件：**
- `skill/hooks/minase-context-loader/HOOK.md`
- `skill/hooks/minase-context-loader/handler.js`

**HOOK.md:**
```yaml
---
name: minase-context-loader
description: "Injects Minase's core memory context at session start"
metadata:
  { "openclaw": { "events": ["agent:bootstrap"], "requires": { "env": ["LLM_API_KEY"] } } }
---
```

**handler.js:**
在 agent:bootstrap 时，读取 core-wisdom.json 和最近 3 天的 diary.md 概要，通过 `event.prependContext` 注入系统上下文。这确保模型不需要自己 Read 就能看到核心记忆。

### 3.2 创建 minase-memory-save hook

**新建文件：**
- `skill/hooks/minase-memory-save/HOOK.md`
- `skill/hooks/minase-memory-save/handler.js`

**HOOK.md:**
```yaml
---
name: minase-memory-save
description: "Saves conversation memory when session ends or resets"
metadata:
  { "openclaw": { "events": ["command:new", "command:reset"], "requires": { "env": ["LLM_API_KEY"] } } }
---
```

**handler.js:**
在 command:new / command:reset 时，向即将结束的会话注入一条系统消息："请在结束前写日记和更新关系文件"。利用 OpenClaw 已有的 session-memory hook 模式。

### 3.3 安装器部署 hooks

**修改文件：** `bin/cli.js`

在 Step 3（复制 skill 文件）之后，额外复制 hooks 到 `~/.openclaw/hooks/`：

```js
copyDirRecursive(
  path.join(SKILL_SRC, 'hooks', 'minase-context-loader'),
  path.join(OPENCLAW_DIR, 'hooks', 'minase-context-loader')
);
copyDirRecursive(
  path.join(SKILL_SRC, 'hooks', 'minase-memory-save'),
  path.join(OPENCLAW_DIR, 'hooks', 'minase-memory-save')
);
```

卸载时删除这些 hook 目录。

---

## Phase 4: 社交关系网引擎

**优先级：中 — 让水瀬能自主维护社交关系**

### 4.1 实现 social-graph-engine.ts

**新建文件：** `skill/scripts/social-graph-engine.ts`

核心函数（均为纯函数，不可变模式）：

```typescript
// 圈层分类
export function classifyTier(closeness: number): 'core' | 'familiar' | 'cognitive' | 'dormant'

// 亲密度变化（根据事件类型）
export function applyClosenessChange(
  relation: SocialRelation,
  event: { type: string; timestamp: string }
): SocialRelation

// 批量时间衰减（每次心跳调用）
export function decayAllRelations(
  relations: SocialRelation[],
  now: Date
): SocialRelation[]

// 自动圈层升降级
export function rebalanceTiers(relations: SocialRelation[]): SocialRelation[]

// 休眠检测与清理（30天→休眠，90天→删除）
export function processDormancy(
  relations: SocialRelation[],
  now: Date
): { active: SocialRelation[]; removed: SocialRelation[] }

// 生成社交意图注入
export function generateSocialIntents(
  relations: SocialRelation[],
  meta: SocialMeta,
  now: Date
): Array<{ category: IntentCategory; description: string; intensity: number }>

// 更新 meta.json 统计
export function updateMetaStats(
  meta: SocialMeta,
  relations: SocialRelation[]
): SocialMeta
```

### 4.2 集成到心跳循环

**修改文件：** `skill/scripts/heartbeat-tick.ts`

在 regularTick() 的第 2 步（感知阶段）中，调用：
1. `decayAllRelations()` — 衰减所有关系亲密度
2. `processDormancy()` — 处理休眠/删除
3. `generateSocialIntents()` — 生成社交相关意图注入到意图池

### 4.3 集成到夜反思

**修改文件：** `skill/scripts/night-reflect.ts`

在反思结束时调用 `rebalanceTiers()` + `updateMetaStats()`。

---

## Phase 5: 灵感采集器集成

**优先级：中 — 让水瀬在窥屏意图触发时能刷到内容**

### 5.1 心跳调用灵感采集

**修改文件：** `skill/scripts/heartbeat-tick.ts`

在 regularTick() 中，当 chosen_action 类型为"窥屏"时：

```typescript
import { refreshInspiration } from './inspiration-collector';

// 在 action execution 阶段
if (action.skill === 'browse' || action.action.includes('刷')) {
  await refreshInspiration();
}
```

同时在晨规划中每天强制刷新一次灵感数据。

### 5.2 晨规划调用灵感

**修改文件：** `skill/scripts/morning-plan.ts`

在 runMorningPlan() 开头添加灵感刷新：

```typescript
import { refreshInspiration } from './inspiration-collector';
// 晨规划时刷新过期的灵感数据
await refreshInspiration();
```

---

## Phase 6: CLI --configure 子命令

**优先级：低 — 便利性功能**

### 6.1 实现 --configure

**修改文件：** `bin/cli.js`

在入口路由中增加 `--configure` 分支：
- 读取现有 `openclaw.json` 中的 env
- 交互式询问要更新的 key
- 只更新用户输入了值的 key
- 写回 `openclaw.json`

---

## Phase 7: 测试覆盖

**优先级：中 — 确保核心逻辑正确**

### 7.1 新增测试文件

| 文件 | 覆盖模块 | 重点测试 |
|------|----------|---------|
| `tests/social-graph-engine.test.ts` | Phase 4 新建的引擎 | 圈层分类、亲密度衰减、休眠清理、意图生成 |
| `tests/intent-engine.test.ts` | intent-engine.ts | 衰减、累积、事件加成、日程注入 |
| `tests/heartbeat-tick.test.ts` | heartbeat-tick.ts | 时间路由、感知构建、动作执行（mock LLM） |
| `tests/morning-plan.test.ts` | morning-plan.ts | 日程生成、cron 配置输出 |
| `tests/night-reflect.test.ts` | night-reflect.ts | 智慧更新、偏好更新、梦想更新 |
| `tests/llm-client.test.ts` | llm-client.ts | 重试逻辑、JSON 提取 |

所有测试使用 vitest，mock 外部依赖（LLM、Instagram API、文件系统）。

---

## 依赖关系

```
Phase 1 (Cron) ← 无依赖，最先做
Phase 2 (SKILL.md) ← 无依赖，可并行
Phase 3 (Hooks) ← 无依赖，可并行
Phase 4 (社交引擎) ← 依赖 types.ts 中已有的 SocialRelation 类型
Phase 5 (灵感集成) ← 依赖 Phase 4（心跳修改）
Phase 6 (CLI --configure) ← 无依赖
Phase 7 (测试) ← 依赖 Phase 4（社交引擎完成后才能测试）
```

**可并行执行：** Phase 1 + Phase 2 + Phase 3 + Phase 6 全部可并行。Phase 4 独立进行。Phase 5 在 Phase 4 完成后做。Phase 7 最后做。

---

## 预期效果

安装后：
1. **水瀬每天 07:00 自动醒来**，生成今日计划和情绪基调
2. **08:00-22:00 每小时心跳**，感知世界、产生意图、执行行动
3. **23:00 自动反思**，更新智慧、偏好、梦想
4. **对话时自动加载记忆**（hook 保证），不依赖模型自觉
5. **对话结束自动保存记忆**（hook 保证）
6. **社交关系自动维护**，粉丝互动有回应，长期不互动自动降级
7. **灵感采集驱动创作**，刷手机时真的能刷到内容
