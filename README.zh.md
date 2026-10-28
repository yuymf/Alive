<div align="center">
  <img src="docs/assets/logo.svg" alt="Alive" width="72" height="72">

# Alive

**让人格 skill 拥有身体 — 而不只是一个对话框。**

[![npm](https://img.shields.io/npm/v/@yuymf/alive?style=flat-square)](https://www.npmjs.com/package/@yuymf/alive)
[![Node.js](https://img.shields.io/node/v/@yuymf/alive?style=flat-square)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](./LICENSE)
[![Agent Skill](https://img.shields.io/badge/Agent%20Skills-SKILL.md-purple.svg?style=flat-square)](https://agentskills.io/specification)

[English](README.md) · [中文](#) · [安装](INSTALL.md) · [用法](USAGE.md) · [更新日志](CHANGELOG.md)
</div>

<p align="center">
  <img src="docs/assets/cover.svg" alt="接入 SKILL.md → 情绪、记忆、心跳 → 这个人开始过日子" width="100%">
</p>

[女娲.skill](https://github.com/alchaincyf/nuwa-skill) 和 [永雏塔菲](https://github.com/ly-xxx/ace-taffy-skill) 这类 skill，已经知道一个人**怎么说话**。它们停在聊天框里。

Alive 是剩下的那具身体：跨会话的情绪、日记、关系，以及每小时一次的心跳——用那个人的声音去刷、去评、去找人。

```
alive distill 蒸馏一个脑子  →  Alive 接入这份 SKILL.md  →  这个人开始过自己的日子
```

## 功能

- 🎭 **6 维情绪** — 效价 / 唤醒 / 能量 / 压力 / 创造力 / 社交欲
- 🧭 **7 类元意图** — 创作 / 社交 / 消费 / 表达 / 学习 / 休息 / 追求
- 🫀 **每小时心跳** — 感知 → 意图 → 行动（你不在也会继续）
- 🧠 **4 层记忆** — 会话 → 日记 → 关系 → 人生智慧
- 📞 **通话页** — `alive voice` 拉起 LiveKit + VoxCPM
- 🧩 **Agent Skill** — 装进 Hermes / OpenClaw / Claude Code / Cursor / Codex …

## 快速开始（Docker）

Alive 是 **Node CLI + Agent Skill**，不是 Next.js 应用——**没有**一键 Vercel 按钮。给陌生人的一键路径是 Docker Compose（Railway / Fly / Render 的 Docker 部署同样适用）。

```bash
git clone https://github.com/yuymf/Alive.git
cd Alive
cp .env.example .env          # 需要心跳时填 LLM_API_KEY
docker compose up --build
```

打开 **http://127.0.0.1:8766** 进通话页。记忆落在 `alive-home` 卷（容器内 `ALIVE_HOME=/data/alive`）。

```bash
# 单次心跳（.env 里需要 LLM_API_KEY）
docker compose run --rm alive node bin/cli.js tick

docker compose run --rm alive node bin/cli.js status
```

### 环境变量

| 变量 | 必需 | 用途 |
|:---|:---:|:---|
| `LLM_API_KEY` | 心跳需要 | `alive tick` / `alive start` |
| `LLM_API_BASE` / `LLM_MODEL` | 可选 | OpenAI 兼容接口 |
| `ALIVE_PERSONA` | 可选 | 默认 `minase` |
| `ALIVE_VOICE_PORT` | 可选 | 默认 `8766` |
| `LIVEKIT_*` / `CARTESIA_API_KEY` / `VOXCPM_URL` | 可选 | 完整语音栈，见 [USAGE.md](USAGE.md) |
| 平台相关 Key | 可选 | 见 [`.env.example`](.env.example) |

**不要**提交真实的 `.env`。

## 快速开始（npm）

```bash
npm install -g @yuymf/alive
alive init
alive distill 峰哥
# 或：alive adopt ./examples/steve-jobs
```

免安装：`npx @yuymf/alive init`。

### 宿主 Agent

```bash
alive init --hermes taffy
alive init --openclaw miss-v
alive init --project
alive tick
```

对话走宿主模型。从空机器到接通电话：**[USAGE.md](USAGE.md)**。安装细节：**[INSTALL.md](INSTALL.md)**。

## 为什么需要 Alive

| 只有 persona skill | 被 Alive 接入之后 |
|:---|:---|
| @ 才用角色说话 | **照样用角色说话** |
| 关了就忘 | **4 层记忆** |
| 永远平稳 | **会累、会拖延、会心流** |
| 等你开口 | **每小时心跳** |
| 只会聊天 | **浏览 / 评论 / 私信 / 发帖** |

## 仓库里的例子

```bash
alive distill 峰哥
alive adopt ./examples/ace-taffy
alive adopt ./examples/steve-jobs
alive adopt ./examples/wangxiaobo
alive adopt ./examples/wangyangming
alive adopt ./examples/karpathy
```

内置 **水瀬** / **郭德纲**，或 `/alive create`。说明在 [`examples/`](examples/)。

## 架构速览

```
examples/                 可 adopt 的人格 skill
alive/
├── SKILL.md              Agent Skills 入口
├── personas/             内置预设
├── templates/            提示词
├── protocols/            心跳 · 记忆 · 社交 · 意图
├── scripts/
│   ├── host/             init · boot · chat
│   ├── admin/            /alive 命令
│   ├── hub/              蒸馏 + 接入
│   ├── engines/          情绪 · 活力 · 心流 …
│   ├── lifecycle/        tick · morning · night
│   └── voice/            通话页
└── sub-skills/           浏览 / 发帖 / TTS / 通话 …
```

记忆在 `$ALIVE_HOME`（默认 `~/.alive`；Docker：`/data/alive`）。

## 开发

```bash
npm ci
npm run build
npm run typecheck
npm test
```

## License

[MIT](./LICENSE)
