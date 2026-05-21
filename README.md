<div align="center">

# 💫 Alive

### Digital Life Engine — Give your AI a real inner life

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-147%20passed-brightgreen.svg)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](tsconfig.json)

**Emotions · Fatigue · Procrastination · Flow States · Random Life Events**

[English](#) · [中文](README.zh.md) · [Changelog](CHANGELOG.md)

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

---

## 🏗️ Architecture Decisions

Alive isn't another "prompt + tools + loop" agent. Here's why each layer exists.

### Why 6D Emotion instead of 2D (valence/arousal)?

Most emotion models use just valence (positive/negative) and arousal (calm/excited). But this misses critical dimensions that drive **behavioral decisions**:

- **Energy** (0→1): Controls procrastination, flow entry, content quality. A tired agent should rest, not force content.
- **Stress** (0→1): Triggers threshold breaks — emotional explosions after sustained pressure. Without this, agents are eternally patient (unrealistic).
- **Confidence** (0→1): Quality multiplier (0.5×→1.5×). Recent successes boost output; failures dampen it. This creates natural performance variation.
- **Sociability** (0→1): Determines outreach vs. withdrawal. An introverted agent in low-sociability mode won't spam comments.

```
Impulse (瞬时刺激)  →  Momentum (惯性趋势)  →  Undertone (个性底色)
    ↓ fast decay           ↓ slow drift             ↓ persona baseline
  20% per tick          3% per tick              constant (MBTI-derived)
```

**Why three layers?** A single event (e.g., getting a compliment) should spike arousal immediately (impulse), create a lingering positive bias (momentum), but not permanently change personality (undertone). Without separation, agents either overreact to single events or are immune to them.

### Why 4-Layer Memory instead of flat context?

Inspired by [Stanford Generative Agents](https://arxiv.org/abs/2304.03442), but optimized for **cost**:

| Layer | Retention | Storage | Why |
|:---:|:---:|:---:|:---|
| 0 | Session | In-memory | Free — no LLM call needed |
| 1 | 30 days | Markdown diary | Cheap — low-importance entries auto-merge |
| 2 | 90 days | JSON relations | Structured — fast lookup for social context |
| 3 | Permanent | Core wisdom | Expensive — only 20 slots, highest-value only |

**Cost control**: Layer 1 entries with importance < 4 are auto-merged into daily summaries. Layer 3 is capped at 20 entries — when full, lowest-importance entries are evicted. This prevents unbounded memory growth.

### Why a Heartbeat Loop?

Most agents are **reactive** — they only act when prompted. Alive is **proactive** — it runs `perceive → intend → act` every hour, even without user input.

```
Wake → Morning Plan (seed today's intents)
  ↓
Hourly: Perceive (read world state) → Intend (pick action) → Act (execute)
  ↓
Sleep → Night Reflect (consolidate memory, update personality drift)
```

**Why hourly?** Balances responsiveness with cost. More frequent = expensive LLM calls. Less frequent = misses time-sensitive opportunities (trending topics, breaking news).

### Why Persona DNA instead of a single prompt?

A persona is not a system prompt. It's a **configuration object** with:

- MBTI baseline (drift range for each dimension)
- Voice signature (catchphrases, anti-patterns, platform-specific styles)
- Schedule (wake/sleep, active peaks)
- Content sources (platforms, keywords, competitor accounts)
- Feature flags (ops enabled, voice TTS, image generation)

This allows the same engine to run Minase (INFP, quiet, photography-focused) and Miss V (ENTJ, aggressive, esports-focused) with zero code changes.

---

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

---

## 🔬 What Makes This Different

| Feature | Stanford Generative Agents | Character.AI | **Alive** |
|:---|:---:|:---:|:---:|
| Emotion model | Basic (valence only) | None | ✅ 6D + 3-layer inertia |
| Memory | 3-tier (research) | Flat context | ✅ 4-tier with cost control |
| Proactive behavior | ✅ (research demo) | ❌ reactive only | ✅ heartbeat loop |
| Persona system | Single agent | Pre-built characters | ✅ YAML-driven DNA |
| Content ops | ❌ | ❌ | ✅ trends, competitors, viral KB |
| Production ready | ❌ research paper | ✅ consumer product | ✅ open source, testable |
| Test coverage | N/A | N/A | ✅ 147 tests, 37k lines |

**Alive bridges the gap** between research prototypes (Stanford) and consumer products (Character.AI) — it has the **architectural depth** of research with the **engineering rigor** of production.

---

## 🎭 Built-in Personas

| | Persona | Vibe |
|:---:|:---|:---|
| 🌸 | **Minase** | INFP Japanese college student · photography & cafés |
| 💎 | **Miss V** | ENTJ tri-identity virtual influencer · esports · singer · racer |
| 🎭 | **Xingtong** | Warm & witty lifestyle creator |
| 🎤 | **Guodegang** | Crosstalk master with dry humor |

Bring your own — any `persona.yaml` works.

---

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

---

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

---

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

---

## 🏗️ Project Structure

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
├── api-server/               # REST API (auth, analytics, intel, strategy)
├── dashboard/                # Web dashboard
└── tests/                    # 147 test files, 37k lines
```

### Sub-Skills (9 pluggable units)

`instagram-post` · `voice-tts` · `web-search` · `content-browse` · `social-engage` · `photo-share` · `story-share` · `xhs-post` · `message-send`

### Content Providers (7 platforms)

`Bilibili` · `Reddit` · `DailyHot` · `Weibo` · `Zhihu` · `小红书 (XHS)` · `Douyin`

---

## 🛠️ Development

```bash
npm run build       # Compile TypeScript
npm run typecheck   # Type-check only
npm run test        # Run all tests (vitest)
```

### Testing Philosophy

- **Unit tests**: Mock LLM client, mock filesystem — test engines in isolation
- **E2E tests**: Real LLM calls, full heartbeat cycle — verify end-to-end behavior
- **Autoresearch**: Auto-tune prompts using eval fixtures (inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch))

PRs welcome! Persona configs (`alive/personas/*.yaml`) especially welcome.

---

## 📄 License

MIT
