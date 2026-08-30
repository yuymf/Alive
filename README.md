<div align="center">

# 💫 Alive

### Digital Life Engine — Give your AI a real inner life

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-green.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-1200%2B%20engine-brightgreen.svg)]()
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
| Prompt-only character | **Persona DNA + engines** — emotion, memory, and heartbeat are files the next turn reads |

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
- Feature flags (voice TTS, image generation)

This allows the same engine to run Minase (ESTP, in-the-moment, photography-focused) and Miss V (ENTJ, aggressive, esports-focused) with zero code changes.

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
| Production ready | ❌ research paper | ✅ consumer product | ⚠️ open source, testable (needs a host) |
| Test coverage | N/A | N/A | ✅ 1200+ engine tests |

**Alive bridges the gap** between research prototypes (Stanford) and consumer products (Character.AI) — it has the **architectural depth** of research with the **engineering rigor** of production.

---

## 🎭 Built-in Personas

| | Persona | Vibe |
|:---:|:---|:---|
| 🌸 | **Minase** | ESTP Japanese traveler / coser · cafés, light, and saying yes |
| 💎 | **Miss V** | ENTJ tri-identity virtual influencer · esports · singer · racer |
| 🎭 | **Xingtong** | Warm & witty lifestyle creator |
| 🎤 | **Guodegang** | Crosstalk master with dry humor |

Bring your own — any `persona.yaml` works.

---

## 🚀 Quick Start

Alive is an [Agent Skill](https://agentskills.io/specification). It installs into Claude Code, Cursor, Codex, and any host that loads `SKILL.md`.

```bash
npx alive init
```

This copies the skill to:

- `~/.agents/skills/alive` (Cursor + Codex)
- `~/.claude/skills/alive` if Claude Code is present
- `~/.cursor/skills/alive` if Cursor is present

Memory goes to `~/.alive` (override with `ALIVE_HOME`). Default persona is Minase.

```
1. npx alive init
2. Open your Code Agent and talk — the host runs chat load / chat save
3. Optional: put LLM_API_KEY in ~/.alive/.env and run `alive tick`
```

The host must not hand-edit diary or emotion files. `chat.js load` prints context; `chat.js save` writes diary, relation, and emotion so the next turn sees them.

Project-local install (for a repo):

```bash
npx alive init --project
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

---

## 🔓 Progressive Unlock

| Feature | Required | You Get |
|:---|:---|:---|
| Chat + emotion memory | A Code Agent that loads skills | `SKILL.md` + `~/.alive` |
| Heartbeat autonomy | `LLM_API_KEY` | `alive tick` or `alive start` |
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
├── SKILL.md                  # Agent Skills entry (portable)
├── persona-schema.yaml       # Config schema + MBTI table
├── personas/                 # Built-in presets (minase / miss-v / xingtong / guodegang)
├── templates/                # LLM prompt templates ({persona.*})
├── protocols/                # Heartbeat · memory · social-graph · intent-pool
├── scripts/
│   ├── host/                 # init · boot · outbox · chat load/save
│   ├── admin/                # /alive commands
│   ├── engines/              # 7 core state engines
│   ├── lifecycle/            # Heartbeat loop · morning-plan · night-reflect
│   ├── adapters/             # Platform adapters
│   └── utils/                # Types · config · skill-router · providers
├── sub-skills/               # Pluggable capability units
└── tests/                    # Engine, CLI, and lifecycle tests
```

Heartbeat can optionally call platform sub-skills (browse, post, voice). They are not required for chat.

---

## 🛠️ Development

```bash
npm run build       # Compile TypeScript
npm run typecheck   # Type-check only
npm run test        # Run all tests (vitest)
```

### Testing Philosophy

- **Unit tests**: Mock LLM client, mock filesystem — test engines in isolation
- **CLI smoke**: `init` → `status` → `remember` → `context` against an isolated `$ALIVE_HOME`

PRs welcome! Persona configs (`alive/personas/*.yaml`) especially welcome.

---

## 📄 License

MIT
