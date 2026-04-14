<div align="center">

# 💫 Alive

### Digital Life Engine — Give your AI a real inner life

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green.svg)](package.json)
[![OpenClaw Skill](https://img.shields.io/badge/OpenClaw-skill-purple.svg)](https://openclaw.ai)
[![Zero Config](https://img.shields.io/badge/zero-config-brightgreen.svg)]()

**Emotions · Fatigue · Procrastination · Flow States · Random Life Events**

[English](#) · [中文](README.zh.md) · [Guide](docs/guide.md) · [Changelog](CHANGELOG.md)

</div>

---

> She remembers how your last conversation made her feel.  
> She gets tired after a long day. She procrastinates when motivation is low.  
> She plans her week autonomously.  
> **She's alive.**

---

## ✨ Why Alive?

| Traditional Chatbot | Alive |
|:---|:---|
| Stateless — forgets you between sessions | **4-layer memory** — emotions carry across conversations |
| Always eager, always on | **Gets tired, procrastinates, enters flow** |
| Scripted responses | **Autonomous heartbeat loop** — hourly perceive→intend→act |
| One-size-fits-all | **Persona DNA** — MBTI baselines, voice, schedule, feature flags |
| No content ops | **Built-in Ops Desk** — trends, competitors, viral KB |
| Single platform | **7 content providers** — Bilibili, Reddit, Weibo, Zhihu, XHS, Douyin, DailyHot |

## 🧠 What's Inside

<table>
<tr>
<td width="50%">

### 7 Core Engines

- 🎭 **6D Emotion** — valence, arousal, energy, stress, confidence, sociability; three-layer inertia (Impulse → Momentum → Undertone)
- 🧭 **7 MetaIntent** — produce / connect / consume / express / learn / rest / aspire
- 🫀 **Heartbeat Loop** — hourly perceive → intend → act
- 🌊 **Flow & Drift** — hyper-focus vs. aimless drifting
- ⚡ **Vitality** — 0–100 energy resource
- 📈 **Confidence** — 0.5×–1.5× quality multiplier
- 🔥 **Work Impulse** — accumulates toward creative bursts

</td>
<td width="50%">

### 4-Layer Memory

| Layer | Retention | What |
|:---:|:---:|:---|
| 0 | Session | Working memory |
| 1 | 30 days | Episodic diary |
| 2 | 90 days | Social relations |
| 3 | Permanent | Core wisdom |

### Ops Desk

- 📊 Trend Analyzer
- 🔍 Competitor Tracker (XHS / Douyin / Bilibili)
- 💡 Topic Generator
- 📋 Daily Brief (WeChat Work push)
- 🎯 Persona Advisor
- 🦠 **Viral Knowledge Base** — auto-dissect → auto-promote → auto-evict

</td>
</tr>
</table>

## 🎭 Built-in Personas

| | Persona | Vibe |
|:---:|:---|:---|
| 🌸 | **Minase** | INFP Japanese college student · photography & cafés |
| 💎 | **Miss V** | ENTJ tri-identity virtual influencer · esports · singer · racer |
| 🎭 | **Xingtong** | Warm & witty lifestyle creator |
| 🎤 | **Guodegang** | Crosstalk master with dry humor |

Bring your own — any `persona.yaml` works.

## 🚀 Quick Start

```bash
npx alive
```

That's it. The wizard walks you through the rest.

> **Prerequisite:** [OpenClaw](https://openclaw.ai) installed (Node.js ≥ 18)
>
> **No API key required** — falls back to OpenClaw's built-in Claude.

### 30-Second Setup

```
1. npx alive                    # Install
2. Pick a persona               # Minase, Miss V, or import your own
3. Done ✅                      # Cron jobs auto-registered, she's alive
```

## ⌨️ Commands

### Admin

```
/alive status              # Emotion / vitality / flow snapshot
/alive emotion             # 6D emotion details
/alive schedule            # Wake/sleep config
/alive setup               # Reconfigure env (no reinstall)
/alive memory              # Memory statistics
/alive create              # Generate a new persona
/alive help                # All commands
```

### Ops

```
/alive brief               # Daily brief (trends + topics + advice)
/alive trends              # Trending keywords
/alive idea [direction]    # Generate topic ideas
/alive post [N]            # Topic queue / detail
/alive analyze <URL>       # Dissect a viral post
/alive advice              # Persona × trend fit
/alive kb status           # Viral KB stats
/alive kb search <kw>      # Search dissections
/alive kb formulas         # Universal formulas
```

## 🔓 Progressive Unlock

| Feature | Required | You Get |
|:---|:---|:---|
| Chat + emotion memory | _nothing_ | Works out of the box |
| Heartbeat autonomy | _nothing_ | Uses built-in Claude |
| Custom LLM | `LLM_API_KEY` | Any OpenAI-compatible endpoint |
| AI image generation | `AIHUBMIX_API_KEY` / `FAL_KEY` | Auto-posting with images |
| Instagram | `INSTAGRAM_USERNAME` + `PASSWORD` | Autonomous posting |
| 小红书 browse/engage | `XHS_SKILLS_DIR` | Full XHS integration |
| Voice messages | _nothing_ | Noiz TTS Guest Mode, ≤3/day |
| Image hosting | `IMGURL_TOKEN` | Public ImgURL uploads |

Reconfigure anytime: `/alive setup`

## 🏗️ Architecture

```
alive/
├── SKILL.md                  # OpenClaw skill entry
├── persona-schema.yaml       # Config schema + MBTI table
├── personas/                 # Built-in presets
├── templates/                # LLM prompt templates ({persona.*})
├── protocols/                # Heartbeat · memory · social-graph · intent-pool
├── scripts/
│   ├── engines/              # 7 core state engines
│   ├── lifecycle/            # Heartbeat loop · morning-plan · night-reflect
│   ├── ops/                  # Trend · competitor · brief · advisor · viral KB
│   ├── adapters/             # Platform adapters
│   └── utils/                # Types · config · skill-router · providers
├── sub-skills/               # 9 pluggable capability units
├── hooks/                    # Context-loader · memory-save
├── plugin/                   # /alive command registration
└── dashboard/                # Web dashboard
```

### Sub-Skills (9 pluggable units)

`instagram-post` · `voice-tts` · `web-search` · `content-browse` · `social-engage` · `photo-share` · `story-share` · `xhs-post` · `message-send`

### Content Providers (7 platforms)

`Bilibili` · `Reddit` · `DailyHot` · `Weibo` · `Zhihu` · `小红书 (XHS)` · `Douyin`

## 🛠️ Development

```bash
npm run build       # Compile TypeScript
npm run typecheck   # Type-check only
npm run test        # Run all tests (vitest)
```

PRs welcome! Persona configs (`alive/personas/*.yaml`) especially welcome.

## 📄 License

MIT
