# Alive Sub-Skills 开发指南

> 子技能 (Sub-Skill) 是 Alive 引擎的能力扩展单元。每个子技能负责一个具体领域的行为（如发帖、搜索、社交互动），通过意图路由系统被心跳引擎调度。

## 目录结构

```
sub-skills/
└── your-skill/
    ├── manifest.json           # 必须 — 技能声明与路由配置
    ├── scripts/
    │   └── index.js            # 必须 — 入口模块，导出 actions
    ├── templates/              # 可选 — LLM 提示词模板
    │   └── *.md
    ├── events.yaml             # 可选 — 领域专属随机事件
    └── strategy.md             # 可选 — 策略文档（供 LLM 参考）
```

## manifest.json

```json
{
  "id": "your-skill",
  "name": "你的技能名称",
  "version": "1.0.0",
  "description": "简短描述",
  "intent_categories": ["produce", "connect"],
  "triggers": ["your-trigger-name"],
  "priority": 5,
  "vitality_cost": {
    "base": 15
  },
  "dependencies": {
    "env": ["SOME_API_KEY"],
    "tools": ["WebFetch"]
  }
}
```

### 字段说明

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 唯一标识符（目录名应与此一致） |
| `name` | string | ✅ | 显示名称 |
| `version` | string | ✅ | 语义化版本号 |
| `description` | string | ✅ | 简短描述 |
| `intent_categories` | string[] | ✅ | 该技能可响应的 MetaIntent 类别（7选N） |
| `triggers` | string[] | ✅ | 触发器名称列表 |
| `priority` | number | ✅ | 路由优先级（1-10，越高越优先） |
| `vitality_cost` | object | ✅ | 体力消耗配置 |
| `dependencies.env` | string[] | — | 需要的环境变量 |
| `dependencies.tools` | string[] | — | 需要的 OpenClaw 工具 |

### 7 大 MetaIntent 类别

| MetaIntent | 说明 | 示例行为 |
|------------|------|---------|
| `produce` | 核心产出 | 写文、发帖、画图、剪片、写论文等 |
| `connect` | 社交互动 | 评论、回复、发消息、开会等 |
| `consume` | 信息摄取 | 刷 feed、看热门、读文献、审片等 |
| `express` | 情绪表达 | 发泄、分享心情、表达观点等 |
| `learn` | 学习成长 | 搜索、阅读、研究、上课等 |
| `rest` | 休息恢复 | 发呆、听歌、放松等 |
| `aspire` | 愿景追求 | 长期计划、技能学习、梦想推进等 |

每个角色可通过 `persona.yaml` 的 `intent_config` 自定义 display_name、活动示例、阻力值和情绪耦合权重。

## 脚本入口 (scripts/index.js)

```typescript
import type { SubSkillContext, SubSkillResult } from '../../scripts/router/sub-skill-sdk';
import { createResult, createFeedback } from '../../scripts/router/sub-skill-sdk';

export const actions = {
  /**
   * 每个 action 是一个纯函数：context in → result out
   */
  async 'your-trigger-name'(ctx: SubSkillContext): Promise<SubSkillResult> {
    // 1. 读取你需要的上下文
    const { persona, emotion, vitality, intent, memory, llm, config } = ctx;

    // 2. 做你的事情（调用 API、生成内容等）
    const response = await llm.call(`你是${persona.meta.name}，...`);

    // 3. 返回标准结果
    return createResult(response, {
      emotion_deltas: [{ valence: 0.1, creativity: 0.05 }],
      vitality_cost: 15,
      feedback: [
        createFeedback('your-skill', 85, 70), // metric vs baseline
      ],
    });
  },
};
```

### SubSkillContext 可用字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `persona` | PersonaConfig | 当前角色配置 |
| `emotion` | EmotionState | 当前情绪状态（6维） |
| `vitality` | number | 当前体力值 |
| `confidence` | number | 当前信心值 |
| `intent` | ResolvedIntent | 被路由到此的意图 |
| `memory` | MemoryAccessor | 日记和 JSON 存取 |
| `socialGraph` | SocialGraphAccessor | 社交关系读写 |
| `llm` | LLMClient | LLM 调用接口 |
| `config` | Record | 技能专属配置 |

### SubSkillResult 返回字段

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `narrative` | string | ✅ | 本次行动的叙述（写入日记） |
| `emotion_deltas` | EmotionDelta[] | — | 情绪变化（由情绪引擎应用） |
| `vitality_cost` | number | — | 消耗的体力 |
| `feedback` | FeedbackEvent[] | — | 反馈数据（喂给信心引擎） |
| `events_triggered` | string[] | — | 触发的随机事件 ID |

## 事件定义 (events.yaml)

子技能可以注入领域专属的随机事件，它们会与内置事件合并：

```yaml
events:
  - id: your_skill_event_1
    description: "你的事件描述"
    weight: 1.0
    emotion_impact:
      valence: 0.2
      creativity: 0.1
    intent_boosts:
      - category: "produce"
        boost: 2.0
    diary_entry: "发生了一件有趣的事..."
    precondition: null
```

## 路由流程

```
heartbeat-tick（心跳）
  → 意图引擎选出 winner intent
  → skill-router 查路由表（manifest 的 intent_categories + priority）
  → 调用子技能的 actions[trigger](context)
  → 写入日记 narrative
  → 应用 emotion_deltas
  → 扣除 vitality_cost
  → 将 feedback 喂给信心引擎
```

## 开发建议

1. **保持纯函数** — action 函数不应有副作用，所有状态变更通过返回值传达
2. **尊重体力** — 检查 `ctx.vitality`，体力不足时应降级或跳过
3. **利用情绪** — 读取 `ctx.emotion` 来调整行为风格（低情绪时产出更内敛的内容）
4. **提供反馈** — 返回 `feedback` 让信心引擎学习，这影响角色的长期行为偏好
5. **模板化提示词** — 将 LLM prompt 放在 `templates/` 中，使用 `{persona.*}` 占位符
6. **版本兼容** — 遵守 manifest 的 version 字段，大版本变更需更新 schema

## 官方子技能

| 技能 | 意图 | 说明 |
|------|------|------|
| `instagram` | produce, express | Instagram 内容发布管线 |
| `web-search` | learn, consume | 网络搜索与知识摘要 |
| `content-browse` | consume, learn | 浏览 Feed 内容并提取灵感素材 |
| `social-engagement` | connect | 评论回复与主动互动 |
| `send-message` | connect, express | 主动发送消息 |
| `voice-tts` | connect, express | 语音消息合成与发送 |
