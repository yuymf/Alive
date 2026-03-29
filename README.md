# Alive — Universal Digital Life Engine

> 让 AI 角色拥有真实的情绪、精力波动、拖延、心流与随机生活事件

Alive 是一个通用的「活人感」引擎，让任何 AI 角色拥有情绪惯性、精力波动、拖延、心流、随机生活事件等不完美的人类特征。

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green.svg)](package.json)

## 核心特性

- **情绪系统** — 6 维情绪模型（效价/唤醒度/能量/压力/自信/社交欲望），MBTI 基线，30 天滚动日记
- **精力与活力** — 每日精力消耗与恢复，心流状态管理，拖延机制
- **记忆系统** — 关系档案（90 天衰减）、人生教训（永久保留）、意图池、偏好与 aspirations
- **作息管理** — 可配置起床/睡眠时间，时区支持，定时晨规划与夜反思
- **社交能力** — 主动消息（≤2 次/天）、语音消息（≤3 次/天）、评论互动
- **技能发现** — 能力缺口追踪，自动从 ClawHub 安装子技能（每晚最多 2 个）
- **多平台支持** — Instagram、小红书、内容浏览、语音合成等
- **多角色并行** — 每个角色独立记忆、情绪状态与 cron 调度

## 架构

```
alive/                         # 通用活人感引擎 (persona-agnostic)
├── SKILL.md                   # OpenClaw skill 入口
├── persona-schema.yaml        # 人设 schema 定义
├── personas/                  # 内置预设角色
├── events.builtin.yaml        # 内置通用随机事件库
├── protocols/                 # 行为协议
│   ├── memory.md              # 记忆协议
│   ├── heartbeat.md           # 心跳协议
│   ├── intent-pool.md        # 意图池协议
│   ├── social-graph.md        # 社交图谱协议
│   └── photo-sharing.md       # 照片分享协议
├── templates/                 # LLM 提示词模板 ({persona.*} 占位符)
├── scripts/
│   ├── engines/               # 核心状态引擎
│   │   ├── emotion.ts         # 情绪引擎
│   │   ├── intent.ts          # 意图引擎
│   │   ├── flow.ts            # 心流引擎
│   │   ├── vitality.ts        # 活力引擎
│   │   ├── confidence.ts      # 自信引擎
│   │   └── work-impulse.ts    # 核心产出冲动引擎
│   ├── lifecycle/             # 生命周期
│   │   ├── morning-plan.ts    # 晨规划
│   │   ├── heartbeat-tick.ts  # 每小时心跳
│   │   └── night-reflect.ts   # 夜反思
│   ├── world/                 # 随机事件 + 社交图谱
│   ├── router/                # 子 skill 路由调度
│   ├── hub/                   # 技能发现与自动安装
│   ├── persona/               # persona.yaml 加载与模板注入
│   ├── admin/                 # /alive 斜杠命令处理器
│   ├── adapters/              # 平台适配器
│   │   ├── instagram.ts
│   │   ├── xiaohongshu.ts
│   │   └── ...
│   └── utils/                 # 基础工具
├── hooks/                     # OpenClaw 钩子
├── sub-skills/                # 7 个官方子 skill
│   ├── instagram/             # Instagram 发帖管线
│   ├── voice-tts/             # 语音消息合成 (Noiz TTS)
│   ├── web-search/            # 网络搜索 (Exa)
│   ├── content-browse/        # 内容浏览 / 灵感收集
│   ├── send-message/          # 主动消息
│   ├── social-engagement/     # 社交互动
│   └── platform/              # 平台基础能力
└── tests/                     # 测试文件
```

## 安装到 OpenClaw

Alive 作为 OpenClaw skill 运行，安装后会复制到 `~/.openclaw/skills/alive/`。

### 方式一：交互式安装（推荐）

```bash
cd /Users/halyu/Documents/Code/Alive
node bin/cli.js
```

安装程序会依次：
1. 验证 OpenClaw 目录存在
2. 让你选择或指定 persona
3. 复制 alive 框架到 `~/.openclaw/skills/alive/`
4. 在 `openclaw.json` 中注册 skill（含 env 环境变量）
5. 设置参考图（可选）
6. 初始化记忆目录 `~/.openclaw/workspace/memory/<persona-slug>/`
7. 注册 cron 任务（morning / tick / night）

### 方式二：指定 persona 文件

```bash
node bin/cli.js --persona ./alive/personas/minase.yaml
```

### 保留现有 env 配置

运行安装命令时，**直接按 Enter 跳过所有 API Key 输入**，现有 env 值不会被覆盖。

| 命令 | env 行为 |
|------|---------|
| `install` | 跳过提示 → 保留现有值 |
| `update` | 自动保留现有值 |
| `reinstall` | 会提示输入，会覆盖 |
| `real-day-test` | 自动保留现有值 |

> **推荐**：`update` 命令只更新代码框架，不触碰 env 和记忆，适合日常开发迭代。

### 安装后验证

```bash
openclaw skills list
# 或
openclaw skills check
```

---

## 快速开始

### 安装依赖

```bash
git clone https://github.com/yourname/alive.git
cd alive
npm install
npm run build
```

### 运行（开发模式）

```bash
node bin/cli.js                    # 交互式选择内置角色
node bin/cli.js --create           # 随机生成新角色
node bin/cli.js --create --guided  # 引导模式创建角色
```

> **注意**：`alive` 作为全局命令仅在安装到 OpenClaw 后可用。开发调试阶段使用 `node bin/cli.js`。

---

## 创建角色

### 方式一：自动生成（推荐）

```bash
# 纯随机
node bin/cli.js --create

# 指定名字和定位
node bin/cli.js --create --name "陈小鱼" --tagline "爱吃甜食的插画师"

# 引导模式
node bin/cli.js --create --guided
```

### 方式二：手动编写 YAML

```bash
# 1. 复制模板
cp alive/personas/minase.yaml my-persona.yaml

# 2. 安装
node bin/cli.js --persona ./my-persona.yaml
```

参考 `alive/persona-schema.yaml` 了解所有可配置字段。

---

## CLI 命令

| 命令 | 说明 |
|------|------|
| `node bin/cli.js` | 交互式选择内置角色并安装 |
| `node bin/cli.js --persona <path>` | 安装指定 persona（完整安装） |
| `node bin/cli.js --update --persona <path>` | 更新框架代码，**保留** env 和记忆 |
| `node bin/cli.js --reinstall --persona <path>` | 完全重置（代码+记忆+cron） |
| `node bin/cli.js --uninstall --persona <path>` | 卸载 skill 和 cron |
| `node bin/cli.js --switch-persona --persona <path>` | 热切换角色（保留各自记忆） |
| `node bin/cli.js --setup-references --persona <path>` | 生成参考图（需提供原图） |
| `node bin/cli.js --real-day-test --persona <path>` | E2E 全天测试 |
| `node bin/cli.js --real-day-test --persona <path> --dry-run` | E2E 测试（跳过 API 调用） |
| `node bin/cli.js --help` | 显示帮助 |

### 各命令对数据的影响

| 命令 | 代码 | env | 记忆 | cron |
|------|------|-----|------|------|
| `update` | ✅ 更新 | ❌ 保留 | ❌ 保留 | ❌ 保留 |
| `reinstall` | ✅ 更新 | ✅ 覆盖 | ⚠️ 清空 | ✅ 重建 |
| `uninstall` | ❌ 删除 | ❌ 删除 |可选保留 | ❌ 删除 |
| `switch-persona` | ❌ | ❌ | ✅ 各自独立 | ✅ 各自独立 |

## 管理面板（斜杠命令）

在对话中输入 `/alive` 使用管理命令。这些命令**不经过角色人格、不写入日记、不影响记忆**。

| 命令 | 说明 |
|------|------|
| `/alive status` | 查看角色综合状态 |
| `/alive emotion` | 查看情绪详情 |
| `/alive emotion --reset` | 重置情绪到 MBTI 基线 |
| `/alive schedule` | 查看作息配置 |
| `/alive schedule --wake 9 --sleep 1` | 修改作息时间 |
| `/alive skills` | 列出已启用的子技能 |
| `/alive platform` | 查看平台配置 |
| `/alive memory` | 查看记忆统计 |
| `/alive reset all` | 重置所有状态 |
| `/alive help` | 显示帮助 |

## 开发

```bash
npm run build       # 构建
npm run typecheck   # 类型检查
npm run test        # 运行全部测试
npm run test:watch  # watch 模式
```

## 许可

MIT
