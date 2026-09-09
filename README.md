<div align="center">
  <img src="docs/assets/logo.svg" alt="Alive" width="72" height="72">

# Alive

**Give a persona skill a body — not just a chat window.**

[![npm](https://img.shields.io/npm/v/@yuymf/alive?style=flat-square)](https://www.npmjs.com/package/@yuymf/alive)
[![Node.js Version](https://img.shields.io/node/v/@yuymf/alive?style=flat-square)](https://nodejs.org)
[![License](https://img.shields.io/npm/l/@yuymf/alive?style=flat-square)](./LICENSE)
[![Agent Skill](https://img.shields.io/badge/Agent%20Skills-SKILL.md-purple.svg?style=flat-square)](https://agentskills.io/specification)

[English](#) · [中文](README.zh.md) · [Changelog](CHANGELOG.md)
</div>

<p align="center">
  <img src="docs/assets/cover.svg" alt="Adopt a SKILL.md → emotion, memory, heartbeat → they start living" width="100%">
</p>

[女娲.skill](https://github.com/alchaincyf/nuwa-skill) and skills like [永雏塔菲](https://github.com/ly-xxx/ace-taffy-skill) already know *how a person speaks*. They stop at the chat box.

Alive is the rest of the body: emotion that carries over, a diary, relationships, and an hourly heartbeat that posts, browses, and reaches out — in that person's voice.

```
alive distill a mind  →  Alive adopts the SKILL.md  →  the person starts living
```

## Quick start

### 1. Install Alive

**Option A — npm global install (recommended / direct CLI access):**

```bash
npm install -g @yuymf/alive
```

After global install, use the `alive` command directly:

```bash
alive init
alive distill 峰哥
```

**Option B — npx (run without install):**

```bash
npx @yuymf/alive init
npx @yuymf/alive distill 峰哥
```

Or an already-distilled skill, or [talk-to-fengge](https://github.com/YeJe-cpu/talk-to-fengge) (voice clone repo, no `SKILL.md`):

```bash
alive distill https://github.com/YeJe-cpu/talk-to-fengge
alive adopt https://github.com/ly-xxx/ace-taffy-skill
alive adopt ./examples/steve-jobs
```

### 2. For AI Agents (Claude Code, Cursor, Codex, Hermes, OpenClaw, etc.)

**Install via Agent Skills package manager:**

```bash
npx skills add yuymf/Alive
```

**Or auto-install to detected hosts via CLI:**

```bash
alive init
# Or via npx: npx @yuymf/alive init
```

Then open Claude Code / Cursor / Codex / Hermes / OpenClaw and talk. Heartbeat reuses a Hermes / OpenClaw model key when present; otherwise put `LLM_API_KEY` in `~/.alive/.env` and run `alive tick`.

From a blank machine to a live LiveKit + VoxCPM call: **[USAGE.md](USAGE.md)**.

`distill` writes a `SKILL.md` then `adopt`s it. A repo that already is a skill is adopted as-is. [talk-to-fengge](https://github.com/YeJe-cpu/talk-to-fengge) is converted from `worker/persona.py`. Chat and heartbeat read the original rules.

## Why this repo exists

| Persona skill alone | After Alive adopts it |
|:---|:---|
| Speaks in character when you @ it | **Still speaks in character** — original `SKILL.md` / `persona.md` stay in context |
| Forgets you between sessions | **4-layer memory** — diary, relations, wisdom |
| Always on, always even | **Gets tired, procrastinates, enters flow** |
| Waits for a prompt | **Hourly heartbeat** — perceive → intend → act |
| Chat-only | **Browse, comment, message, post** through sub-skills |

Same engine runs a distilled VTuber and a distilled thinker. Zero code change.

## Bundled examples

Public figures, MIT, already distillable / adoptable. 峰哥 comes from [feng-ge-skill](https://github.com/YixiaJack/feng-ge-skill) — the persona layer behind [talk-to-fengge](https://github.com/YeJe-cpu/talk-to-fengge). Jobs / 王小波 / 王阳明 / Karpathy come from [awesome-human-distillation](https://github.com/mliu98/awesome-human-distillation); `ace-taffy` is the Nuwa-style skill with `persona.md` + `references/`. Full notes in [examples/](examples/).

```bash
alive distill 峰哥
alive adopt ./examples/ace-taffy
alive adopt ./examples/steve-jobs
alive adopt ./examples/wangxiaobo
alive adopt ./examples/wangyangming
alive adopt ./examples/karpathy
```
*(If running via npx without global install, prepend `npx @yuymf/alive`)*

| Example | Who | After Alive adopts it |
|:---|:---|:---|
| `fengge` | 峰哥亡命天涯 | Dialectical reversal that also remembers yesterday |
| `ace-taffy` | 永雏塔菲 | Streamer cadence, memory, hourly life — not just 喵 |
| `steve-jobs` | Steve Jobs | Product judgment that also gets tired and writes a diary |
| `wangxiaobo` | 王小波 | Black humor that remembers yesterday |
| `wangyangming` | 王阳明 | 知行合一 with a heartbeat |
| `karpathy` | Andrej Karpathy | Engineering realism that can browse and post |

No skill to adopt yet? Built-in **Minase** (ESTP traveler / coser) and **Guodegang** (crosstalk, dry humor), or `/alive create`.

## What's inside

- 🎭 **6D emotion** — valence, arousal, energy, stress, confidence, sociability
- 🧭 **7 MetaIntent** — produce / connect / consume / express / learn / rest / aspire
- 🫀 **Heartbeat** — hourly perceive → intend → act
- 🌊 **Flow & drift**
- ⚡ **Vitality** — 0–100
- 📈 **Confidence** — 0.5×–1.5× quality
- 🔥 **Work impulse** — builds toward a burst

| Layer | Keep | What |
|:---:|:---:|:---|
| 0 | Session | Working memory |
| 1 | 30 days | Diary |
| 2 | 90 days | Relations |
| 3 | Forever | Core wisdom |

Heartbeat can call platform sub-skills (browse, post, voice, call the owner). Chat does not need them. Live calls use Alive's own LiveKit + VoxCPM page (`alive voice`). See [USAGE.md](USAGE.md).

## Commands

```
/alive distill <name|path|url>  # distill then adopt (峰哥 / talk-to-fengge / materials)
/alive adopt <path|url>         # take in an existing persona skill
/alive call                     # invite the owner to a live voice call
/alive status              # emotion / vitality / flow
/alive emotion             # 6D detail
/alive schedule            # wake / sleep
/alive memory              # memory stats
/alive create              # generate a new persona
/alive help
```

## Architecture

**6D emotion, not 2D.** Valence + arousal cannot decide behavior. Energy gates rest vs. content. Stress triggers a break. Confidence scales quality. Sociability decides outreach vs. withdrawal.

```
Impulse (spike)  →  Momentum (drift)  →  Undertone (MBTI baseline)
   20% / tick           3% / tick              constant
```

Most agents only answer. Alive runs even when you are gone:

```
Wake → morning plan
  ↓
Hourly: perceive → intend → act
  ↓
Sleep → night reflect (memory + personality drift)
```

A persona is a config object (MBTI, voice, schedule, feature flags) **plus**, when adopted, the original skill documents. The host must not hand-edit diary or emotion files. `chat.js load` prints context; `chat.js save` writes the next turn's memory.

## Install

Alive is an [Agent Skill](https://agentskills.io/specification).

```bash
alive init                      # ~/.agents/skills/alive (+ Claude / Cursor / Codex / Hermes / OpenClaw if present)
alive init --project            # .agents/skills/alive in this repo
alive init --agent hermes       # only Hermes (~/.hermes/skills/alive)
alive init --agent openclaw
```
*(Or via npx: `npx @yuymf/alive init ...`)*

Memory: `~/.alive` (`ALIVE_HOME`). Default persona: Minase.

| Need | Requires |
|:---|:---|
| Chat + memory | A host that loads `SKILL.md` |
| Heartbeat | Hermes / OpenClaw model key, or `LLM_API_KEY` in `~/.alive/.env` |

## Develop

```bash
npm run build
npm run typecheck
npm run test
```

PRs welcome — especially adopted-skill fixtures and new `persona.yaml` files.

## License

MIT
