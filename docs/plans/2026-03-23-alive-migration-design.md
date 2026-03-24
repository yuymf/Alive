# Alive — 通用活人感引擎 (Migration Design)

> **Date**: 2026-03-23
> **Status**: Approved
> **Origin**: MizuSan (水瀬) → Alive (通用活人感 skill)

## 1. 定位

OpenClaw 通用活人感引擎 skill — 让任何 AI 角色拥有情绪惯性、精力波动、拖延、心流、随机生活事件等「不完美的人类特征」。

面向 OpenClaw 社区：任何人可以用此 skill 创建自己的数字生命角色，按需选配子 skill。

## 2. 核心设计决策

| 决策 | 方案 |
|------|------|
| 核心引擎边界 | 5 引擎全部保留（信心引擎泛化反馈源） |
| 人设系统 | 分层 persona-schema + persona.yaml 填表 |
| 子 skill 调度 | 意图路由型（意图→子 skill 路由表） |
| 随机事件 | 内置通用事件 + 子 skill 注入领域事件 |
| 子 skill 接口 | 纯函数式（context in → result out） |

## 3. 目录结构

```
alive/
├── SKILL.md                    # 主入口
├── persona-schema.yaml         # 人设 schema 定义
├── persona.example.yaml        # 示例人设（水瀬）
├── events.builtin.yaml         # 内置通用随机事件库
├── personality.md              # 通用性格系统协议
├── memory.md                   # 四层记忆协议
├── heartbeat.md                # 心跳循环协议
├── intent-pool.md              # 意图池系统
├── social-graph.md             # 社交关系协议
├── templates/                  # LLM 提示词模板（泛化）
│   ├── soul-injection.md
│   ├── heartbeat-prompt.md
│   ├── simulated-action.md
│   ├── morning-plan-prompt.md
│   ├── night-reflect-prompt.md
│   ├── diary-entry.md
│   └── reflection-prompt.md
├── scripts/
│   ├── engines/                # 核心状态引擎
│   │   ├── emotion.ts
│   │   ├── intent.ts
│   │   ├── flow.ts
│   │   ├── vitality.ts
│   │   └── confidence.ts
│   ├── lifecycle/              # 生命周期节点
│   │   ├── heartbeat-tick.ts
│   │   ├── morning-plan.ts
│   │   └── night-reflect.ts
│   ├── world/                  # 世界交互
│   │   ├── random-events.ts
│   │   └── social-graph.ts
│   ├── router/                 # 子 skill 调度
│   │   ├── skill-router.ts
│   │   └── sub-skill-sdk.ts
│   ├── persona/                # 人设系统
│   │   └── persona-loader.ts
│   └── utils/                  # 基础设施
│       ├── file-utils.ts
│       ├── time-utils.ts
│       ├── llm-client.ts
│       └── types.ts
├── hooks/                      # OpenClaw 钩子
│   ├── context-loader/
│   └── memory-save/
└── sub-skills/                 # 官方子 skill
    ├── instagram/
    ├── web-search/
    ├── feed-browse/
    └── README.md
```

## 4. 人设配置系统 (persona-schema)

用户填写 `persona.yaml` 定义角色，必填字段：meta + personality + voice。

- `meta`: name, age, tagline
- `personality`: mbti, core_traits, quirks, values
- `voice`: language, style, mixed_languages, emoji_density, sample_lines
- `intimacy`: levels, behaviors (有默认值)
- `schedule`: wake_hour, sleep_hour, timezone, active_peaks (有默认值)
- `events_extra`: 角色专属随机事件（可选追加）

安装时 persona-loader.ts 读取此文件，注入 SOUL 模板和所有提示词模板的 `{persona.*}` 占位符。

## 5. 子 Skill 接口协议

### manifest.yaml

```yaml
name: "instagram"
display_name: "Instagram 社媒能力"
intent_bindings:
  - intent: "create"
    action: "post"
    priority: 10
config_schema:
  username: { type: "string", required: true }
feedback_sources:
  - name: "post_performance"
```

### 标准执行接口

```typescript
interface SubSkillContext {
  persona: PersonaConfig;
  emotion: EmotionState;
  vitality: number;
  confidence: number;
  intent: ResolvedIntent;
  memory: MemoryAccessor;
  socialGraph: SocialGraphAccessor;
  llm: LLMClient;
  config: Record<string, any>;
}

interface SubSkillResult {
  narrative: string;
  emotion_deltas?: EmotionDelta[];
  vitality_cost?: number;
  feedback?: FeedbackEvent[];
  events_triggered?: string[];
}

interface SubSkill {
  actions: {
    [actionName: string]: (ctx: SubSkillContext) => Promise<SubSkillResult>;
  };
}
```

### 路由流程

```
heartbeat-tick
  → 意图引擎产出 winner intent
  → skill-router 查路由表
  → 调用子 skill 的 actions[action](context)
  → 写入日记 narrative
  → 应用 emotion_deltas
  → 扣除 vitality_cost
  → 将 feedback 喂给信心引擎
```

## 6. 关键泛化点

### 6.1 信心引擎
- `PostHistory` → `FeedbackEvent[]` 通用接口
- 任何子 skill 都能通过 `feedback_sources` 喂入数据

### 6.2 意图类别
- 保持 7 大类（创作/社交/窥屏/表达/学习/休息/梦想）
- 意图路由表可配置

### 6.3 随机事件
- 核心内置 ~15 个通用事件
- 子 skill 通过 events.yaml 注入领域事件
- 合并策略：安装子 skill 时自动合并

### 6.4 情绪基线
- `EMOTION_BASELINE` 从 persona.yaml 的 MBTI 推导
- 提供 MBTI→基线映射表

### 6.5 voice directive
- 去掉硬编码的角色签名
- 改为从 persona.yaml 的 voice 配置动态生成

## 7. 迁移阶段

1. **阶段一**：核心骨架（引擎迁移 + 路由器 + persona-loader）
2. **阶段二**：模板泛化（所有 .md 参数化）
3. **阶段三**：子 skill 拆分（instagram / web-search / feed-browse）
4. **阶段四**：文档验证
