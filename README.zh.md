<div align="center">
  <img src="docs/assets/logo.svg" alt="Alive" width="72" height="72">

# Alive

**让人格 skill 拥有身体 — 而不只是一个对话框。**

[![npm](https://img.shields.io/npm/v/@yuymf/alive?style=flat-square)](https://www.npmjs.com/package/@yuymf/alive)
[![Node.js](https://img.shields.io/node/v/@yuymf/alive?style=flat-square)](https://nodejs.org)
[![License](https://img.shields.io/npm/l/@yuymf/alive?style=flat-square)](./LICENSE)
[![Agent Skill](https://img.shields.io/badge/Agent%20Skills-SKILL.md-purple.svg?style=flat-square)](https://agentskills.io/specification)

[English](README.md) · [中文](#) · [更新日志](CHANGELOG.md)
</div>

<p align="center">
  <img src="docs/assets/cover.svg" alt="接入 SKILL.md → 情绪、记忆、心跳 → 这个人开始过日子" width="100%">
</p>

[女娲.skill](https://github.com/alchaincyf/nuwa-skill) 和 [永雏塔菲](https://github.com/ly-xxx/ace-taffy-skill) 这类 skill，已经知道一个人**怎么说话**。它们停在聊天框里。

Alive 是剩下的那具身体：跨会话的情绪、日记、关系，以及每小时一次的心跳——用那个人的声音去刷、去评、去找人。

```
alive distill 蒸馏一个脑子  →  Alive 接入这份 SKILL.md  →  这个人开始过自己的日子
```

## 快速开始

### 1. 安装 Alive

**方式 A — npm 全局安装（推荐 / 终端直接可用）：**

```bash
npm install -g @yuymf/alive
```

安装后即可直接在终端运行：

```bash
alive init
alive distill 峰哥
```

**方式 B — npx 免安装运行：**

```bash
npx @yuymf/alive init
npx @yuymf/alive distill 峰哥
```

或者接入已有蒸馏好的 skill，或 [talk-to-fengge](https://github.com/YeJe-cpu/talk-to-fengge) 这种只有人格代码、没有 `SKILL.md` 的工程：

```bash
alive distill https://github.com/YeJe-cpu/talk-to-fengge
alive adopt https://github.com/ly-xxx/ace-taffy-skill
alive adopt ./examples/steve-jobs
```

### 2. 给 AI Agent（Hermes, OpenClaw, Claude Code, Cursor, Codex 等）

运行内置初始化命令，自动识别并安装到当前机器上的 Agent 宿主目录：

```bash
alive init
# 或免安装直接运行：
npx @yuymf/alive init
```

#### 为 Hermes / OpenClaw 配置独立 Profile

Alive 深度支持多 Agent 宿主的隔离 Profile 与工作区：

```bash
# 为 Hermes 创建独立的永雏塔菲 Profile (~/.hermes/profiles/taffy)
alive init --hermes taffy

# 直接启动 Hermes 与角色对话（自动加载 Alive 技能设定与记忆）：
hermes -p taffy
# 或启动交互式 TUI：
hermes -p taffy --tui

# 为 OpenClaw 创建专属 Agent 工作区：
alive init --openclaw miss-v

# 安装到当前项目代码库：
alive init --project
```

然后打开 Claude Code / Cursor / Codex / Hermes / OpenClaw，直接说话。心跳会复用 Hermes / OpenClaw 已有的模型 key；没有这两家再把 `LLM_API_KEY` 写进 `~/.alive/.env`，跑 `alive tick`。

从空机器配到 LiveKit + VoxCPM 打电话：看 **[USAGE.md](USAGE.md)**。

`distill` 先写出 `SKILL.md` 再 `adopt`。已经是 skill 的仓库会直接接入。[talk-to-fengge](https://github.com/YeJe-cpu/talk-to-fengge) 会被抽出 `worker/persona.py` 再接入。对话和心跳都读原始规则。

## 这个仓库是干什么的

| 只有 persona skill | 被 Alive 接入之后 |
|:---|:---|
| @ 它才会用角色说话 | **照样用角色说话** — 原始 `SKILL.md` / `persona.md` 仍在上下文里 |
| 关了就忘 | **4 层记忆** — 日记、关系、智慧 |
| 永远在线、永远平稳 | **会疲惫、会拖延、会心流** |
| 等你开口 | **每小时心跳** — 感知 → 意图 → 行动 |
| 只会聊天 | **浏览、评论、私信、发帖** 走子技能 |

同一套引擎可以养活一个被蒸馏的虚拟主播，也可以养活一个被蒸馏的思考者。不用改代码。

## 仓库里的例子

公开人物、MIT、已经能 `distill` / `adopt`。峰哥来自 [feng-ge-skill](https://github.com/YixiaJack/feng-ge-skill)，也是 [talk-to-fengge](https://github.com/YeJe-cpu/talk-to-fengge) 的人格层。Jobs / 王小波 / 王阳明 / Karpathy 来自 [awesome-human-distillation](https://github.com/mliu98/awesome-human-distillation)；`ace-taffy` 是带 `persona.md` + `references/` 的女娲式样板。说明在 [examples/](examples/)。

```bash
alive distill 峰哥
alive adopt ./examples/ace-taffy
alive adopt ./examples/steve-jobs
alive adopt ./examples/wangxiaobo
alive adopt ./examples/wangyangming
alive adopt ./examples/karpathy
```
*(若未全局安装，命令前加上 `npx @yuymf/alive` 即可)*

| 例子 | 人 | 接进 Alive 之后 |
|:---|:---|:---|
| `fengge` | 峰哥亡命天涯 | 辩证反转还记得昨天，也能去刷、去评 |
| `ace-taffy` | 永雏塔菲 | 主播口吻 + 记忆 + 心跳，不只是喵 |
| `steve-jobs` | Steve Jobs | 产品判断也会累、会写日记 |
| `wangxiaobo` | 王小波 | 黑色幽默还记得昨天 |
| `wangyangming` | 王阳明 | 知行合一，加上心跳 |
| `karpathy` | Andrej Karpathy | 工程现实主义，还能自己去刷、去写 |

还没有 skill 可接？用内置的 **水瀬**（ESTP 旅行 / coser）和 **郭德纲**（相声，冷幽默），或 `/alive create`。

## 核心能力

- 🎭 **6 维情绪** — 效价 / 唤醒 / 能量 / 压力 / 创造力 / 社交欲
- 🧭 **7 类元意图** — 创作 / 社交 / 消费 / 表达 / 学习 / 休息 / 追求
- 🫀 **心跳循环** — 每小时 感知 → 意图 → 行动
- 🌊 **心流与漂移**
- ⚡ **活力** — 0–100
- 📈 **自信** — 0.5×–1.5× 质量倍率
- 🔥 **工作冲动** — 累积到创作爆发

| 层级 | 保留 | 内容 |
|:---:|:---:|:---|
| 0 | 会话内 | 工作记忆 |
| 1 | 30 天 | 日记 |
| 2 | 90 天 | 社交关系 |
| 3 | 永久 | 人生智慧 |

心跳可以按需调用平台子技能（浏览、发帖、语音、给主人打电话）。对话本身不需要它们。打电话走 Alive 自己的 LiveKit + VoxCPM 通话页（`alive voice`）。从新角色到接通，见 [USAGE.md](USAGE.md)。

## 命令

```
/alive distill <name|path|url>  # 一键蒸馏并接入（峰哥 / talk-to-fengge / 材料）
/alive adopt <path|url>         # 接入已有的 persona skill
/alive status              # 情绪 / 精力 / 心流
/alive emotion             # 6 维详情
/alive schedule            # 作息
/alive memory              # 记忆统计
/alive create              # 生成新角色
/alive help
```

## 架构

```
examples/                     # 可 adopt 的人格 skill 案例
alive/
├── SKILL.md                  # Agent Skills 入口
├── personas/                 # 内置预设（水瀬 / 郭德纲）
├── templates/                # 提示词模板
├── protocols/                # 心跳 · 记忆 · 社交 · 意图
├── scripts/
│   ├── host/                 # init · boot · chat load/save
│   ├── admin/                # /alive 命令（含 distill / adopt）
│   ├── hub/                  # 蒸馏 + persona skill 接入
│   ├── engines/              # 7 大引擎
│   └── lifecycle/            # 心跳 · 晨间 · 夜间
└── sub-skills/               # 浏览 / 发帖 / 语音 …
```

宿主不要手改日记和情绪文件。`chat.js load` 打出上下文；`chat.js save` 写回下一轮要读的记忆。

记忆在 `~/.alive`（可用 `ALIVE_HOME` 覆盖）。默认人设是水瀬。项目内安装：`alive init --project` 或 `npx @yuymf/alive init --project`。指定宿主：`alive init --agent hermes` 或 `--agent openclaw`。

| 功能 | 需要 |
|:---|:---|
| 对话 + 记忆 | 会加载 `SKILL.md` 的 Agent |
| 心跳 | Hermes / OpenClaw 的模型 key，或 `~/.alive/.env` 里的 `LLM_API_KEY` |

## 开发

```bash
npm run build
npm run typecheck
npm run test
```

无密钥 nightly / 云机门禁（mocked Vitest + CLI smoke；真实 LLM E2E 在未设 key 时保持 skip）：见 [docs/NIGHTLY-E2E.md](docs/NIGHTLY-E2E.md)。

## 发布

打 tag 自动发布，无需手动 `npm publish`。一条命令完成 bump / commit / tag / push：

```bash
npm run release -- patch     # 或 minor | major | 0.10.0
```

push 的 `v*` tag 会触发 [`.github/workflows/publish.yml`](.github/workflows/publish.yml)（typecheck → test → build → `npm publish` → GitHub Release）。需要仓库 secret `NPM_TOKEN`。详见 [docs/RELEASING.md](docs/RELEASING.md)。

欢迎 PR。尤其欢迎把更多女娲产物接进来的 fixture。

## License

MIT
