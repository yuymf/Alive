<div align="center">
  <img src="docs/assets/logo.svg" alt="Alive" width="72" height="72">

# Alive

**Give a persona skill a body — not just a chat window.**

[![npm](https://img.shields.io/npm/v/@yuymf/alive?style=flat-square)](https://www.npmjs.com/package/@yuymf/alive)
[![Node.js Version](https://img.shields.io/node/v/@yuymf/alive?style=flat-square)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](./LICENSE)
[![Agent Skill](https://img.shields.io/badge/Agent%20Skills-SKILL.md-purple.svg?style=flat-square)](https://agentskills.io/specification)

[English](#) · [中文](README.zh.md) · [Install](INSTALL.md) · [Usage](USAGE.md) · [Changelog](CHANGELOG.md)
</div>

<p align="center">
  <img src="docs/assets/cover.svg" alt="Adopt a SKILL.md → emotion, memory, heartbeat → they start living" width="100%">
</p>

[女娲.skill](https://github.com/alchaincyf/nuwa-skill) and skills like [永雏塔菲](https://github.com/ly-xxx/ace-taffy-skill) already know *how a person speaks*. They stop at the chat box.

Alive is the rest of the body: emotion that carries over, a diary, relationships, and an hourly heartbeat that posts, browses, and reaches out — in that person's voice.

```
alive distill a mind  →  Alive adopts the SKILL.md  →  the person starts living
```

## Features

- 🎭 **6D emotion** — valence, arousal, energy, stress, creativity, sociability
- 🧭 **7 MetaIntent** — produce / connect / consume / express / learn / rest / aspire
- 🫀 **Hourly heartbeat** — perceive → intend → act (even when you are away)
- 🧠 **4-layer memory** — session → diary → relations → core wisdom
- 📞 **Voice call page** — LiveKit + VoxCPM stack via `alive voice`
- 🧩 **Agent Skill** — installs into Hermes, OpenClaw, Claude Code, Cursor, Codex, …

## Quick start (Docker)

Alive is a **Node CLI + Agent Skill**, not a Next.js app — there is no one-click Vercel button. The supported one-command path for strangers is Docker Compose (also works on Railway / Fly / Render as a Docker deploy).

```bash
git clone https://github.com/yuymf/Alive.git
cd Alive
cp .env.example .env          # optional: set LLM_API_KEY for heartbeats
docker compose up --build
```

Open **http://127.0.0.1:8766** for the call page. Persist memory with the `alive-home` volume (`ALIVE_HOME=/data/alive` in the container).

```bash
# one-shot heartbeat (needs LLM_API_KEY in .env)
docker compose run --rm alive node bin/cli.js tick

# status
docker compose run --rm alive node bin/cli.js status
```

### Environment

| Variable | Required | Purpose |
|:---|:---:|:---|
| `LLM_API_KEY` | for heartbeat | Scripted `alive tick` / `alive start` |
| `LLM_API_BASE` / `LLM_MODEL` | optional | OpenAI-compatible endpoint |
| `ALIVE_PERSONA` | optional | Default `minase` |
| `ALIVE_VOICE_PORT` | optional | Default `8766` |
| `LIVEKIT_*` / `CARTESIA_API_KEY` / `VOXCPM_URL` | optional | Full duplex voice — see [USAGE.md](USAGE.md) |
| `FAL_KEY` / `AIHUBMIX_API_KEY` / Instagram / XHS | optional | Platform unlocks |

Full template: [`.env.example`](.env.example). Never commit a real `.env`.

## Quick start (npm)

```bash
npm install -g @yuymf/alive
alive init
alive distill 峰哥
# or: alive adopt ./examples/steve-jobs
```

Or without install: `npx @yuymf/alive init`.

### Host agents (Hermes / OpenClaw / …)

```bash
alive init --hermes taffy      # ~/.hermes/profiles/taffy
alive init --openclaw miss-v   # OpenClaw agent workspace
alive init --project           # .agents/skills/alive in this repo
alive tick                     # heartbeat (host key or LLM_API_KEY)
```

Conversation uses the host agent model. From a blank machine to a live call: **[USAGE.md](USAGE.md)**. Install details: **[INSTALL.md](INSTALL.md)**.

## Why Alive

| Persona skill alone | After Alive adopts it |
|:---|:---|
| Speaks in character when you @ it | **Still in character** — original `SKILL.md` stays in context |
| Forgets you between sessions | **4-layer memory** |
| Always on, always even | **Gets tired, procrastinates, enters flow** |
| Waits for a prompt | **Hourly heartbeat** |
| Chat-only | **Browse, comment, message, post** via sub-skills |

## Bundled examples

```bash
alive distill 峰哥
alive adopt ./examples/ace-taffy
alive adopt ./examples/steve-jobs
alive adopt ./examples/wangxiaobo
alive adopt ./examples/wangyangming
alive adopt ./examples/karpathy
```

| Example | Who |
|:---|:---|
| `fengge` | 峰哥亡命天涯 |
| `ace-taffy` | 永雏塔菲 |
| `steve-jobs` | Steve Jobs |
| `wangxiaobo` | 王小波 |
| `wangyangming` | 王阳明 |
| `karpathy` | Andrej Karpathy |

Built-ins: **Minase** and **Guodegang**, or `/alive create`. Notes in [`examples/`](examples/).

## Architecture (sketch)

```
examples/                 adoptable persona skills
alive/
├── SKILL.md              Agent Skills entry
├── personas/             built-in presets
├── templates/            prompts
├── protocols/            heartbeat · memory · social · intent
├── scripts/
│   ├── host/             init · boot · chat load/save
│   ├── admin/            /alive commands (distill / adopt)
│   ├── hub/              distill + adopt
│   ├── engines/          emotion · vitality · flow · …
│   ├── lifecycle/        tick · morning · night
│   └── voice/            call page + LiveKit helpers
└── sub-skills/           browse / post / TTS / call …
```

```
Wake → morning plan
  ↓
Hourly: perceive → intend → act
  ↓
Sleep → night reflect (memory + personality drift)
```

Memory lives in `$ALIVE_HOME` (default `~/.alive`; Docker: `/data/alive`).

## Commands

```
alive init | adopt | distill | voice | tick | morning | night | start
alive status | emotion | schedule | memory | context | help
```

Inside a host chat you can also use `/alive …` slash commands.

## Develop

```bash
npm ci
npm run build
npm run typecheck
npm test
```

PRs welcome — especially adopted-skill fixtures and new `persona.yaml` files.

## License

[MIT](./LICENSE)
