# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MizuSan (水瀬 / Minase) is an npm-installable OpenClaw skill that creates a digital life companion — an 18-year-old cosplayer character with persistent memory, autonomous behavior loops, and Instagram presence. It is **not** a traditional app; it's a skill system where markdown files define behavior and TypeScript scripts handle background tasks via hourly cron-driven heartbeats.

## Commands

```bash
npm run build          # Compile TypeScript (skill/scripts/ → dist/)
npm run typecheck      # Type-check without emitting
npm run test           # Run all tests (vitest)
npm run test:watch     # Run tests in watch mode
npx vitest run tests/emotion-engine.test.ts   # Run a single test file
```

Install the skill locally: `npx minase@latest` (runs `bin/cli.js` 9-step wizard).

Manual script execution (post-install, scripts live at `~/.openclaw/skills/minase/scripts/`):
```bash
LLM_API_KEY=<key> node ~/.openclaw/skills/minase/scripts/heartbeat-tick.js
node ~/.openclaw/skills/minase/scripts/memory-reflect.js --force
```

## Architecture

### OpenClaw Integration Points

The skill uses four OpenClaw mechanisms:

1. **Skill system** — `skill/SKILL.md` is the entry point. It declares `allowed-tools` and a Behavior Trigger Map that loads sub-modules (`personality.md`, `memory.md`, `instagram.md`, `heartbeat.md`, `intent-pool.md`, `social-graph.md`) on demand based on triggers.

2. **Hooks** — Two hooks in `skill/hooks/`:
   - `minase-context-loader` (event: `agent:bootstrap`) — injects core-wisdom + emotion + recent diary into agent context at session start via `event.prependContext()`.
   - `minase-memory-save` (event: `command:new`/`command:reset`) — reminds the agent to persist conversation memories before session ends.

3. **Cron jobs** — Three jobs registered via `openclaw cron add` in the installer:
   - `minase:morning` (`0 7 * * *`) → `morning-plan.js` — generates daily schedule, intent seeds, cron config.
   - `minase:tick` (`0 8-22 * * *`) → `heartbeat-tick.js` — hourly perceive-intend-act loop.
   - `minase:night` (`0 23 * * *`) → `night-reflect.js` — daily reflection producing wisdom, preferences, aspirations, personality drift.

4. **Environment variables** — stored in `~/.openclaw/openclaw.json` under `skills.entries.minase.env`: `AIHUBMIX_API_KEY` (image gen), `IMGURL_TOKEN` (image hosting), `INSTAGRAM_USERNAME`/`INSTAGRAM_PASSWORD`/`INSTAGRAM_TOTP_SECRET` (posting), `LLM_API_KEY`/`LLM_API_BASE`/`LLM_MODEL` (heartbeat/reflection LLM calls via OpenAI-compatible API), `XHS_MCP_URL` (XiaoHongShu MCP endpoint, default: `http://localhost:18060/mcp`).

### Heartbeat System (Core Loop)

`heartbeat-tick.ts` is the main entry point, routing by hour to `runMorningPlan()` (7:00), `runNightReflect()` (23:00), or `regularTick()` (8:00-22:00). Sleep hours (0:00-6:00) are skipped.

Each regular tick runs: **Perceive** (read emotion/events/schedule/world) → **Intend** (rule engine + LLM decision) → **Act** (real/simulated/inner actions). The tick orchestrates six engines:

- **Emotion engine** (`emotion-engine.ts`) — 6-dimensional state (valence/arousal/energy/stress/creativity/sociability) with hourly decay toward ESTP baseline, event deltas, and bidirectional coupling with intents.
- **Intent engine** (`intent-engine.ts`) — 7 intent categories (创作/社交/窥屏/表达/学习/休息/梦想) with rule-based accumulation, event boosts, schedule injection, and LLM final arbitration.
- **Vitality engine** (`vitality-engine.ts`) — 0-100 resource that drains per tick and per action, gates posting (must be >30), with emergency recovery after 3 consecutive low days.
- **Confidence engine** (`confidence-engine.ts`) — 0.5x-1.5x multiplier on creation intent, updated by comparing post performance to 7-day average, with streak bonuses.
- **Random events** (`random-events.ts`) — 10% per-tick chance of stochastic life events (12 types) that inject emotion deltas and intent boosts.
- **Social graph engine** (`social-graph-engine.ts`) — 4-tier relationship system (core/familiar/cognitive/dormant) with closeness decay, dormancy processing, and social intent generation.

### Post Pipeline

When heartbeat chooses `type: "real", skill: "post-pipeline"`, it spawns a detached child process running `post-pipeline.ts`:
1. `refreshInspiration()` — collect trends from web
2. `planPhoto()` — LLM decides whether/what to photograph
3. `generateImage()` — AIHubMix Gemini API + reference image
4. `shouldConsiderPosting()` — rule gate (>16h since last post, not posted today)
5. `planPost()` — LLM selects photo, writes caption/hashtags
6. `postToInstagram()` — Python instagrapi bridge (`instagram-bridge.py` called via `instagram-bridge-client.ts`)
7. Record to `post-history.json` + `diary.md`

### Memory System (4 Layers)

| Layer | File | Retention | Purpose |
|-------|------|-----------|---------|
| 0 | In-conversation | Session only | Working memory (~2000 tokens) |
| 1 | `diary.md` | 30 days | Episodic stream, low-importance entries auto-compress |
| 2 | `relations/{user_id}.json` | 90 days | Per-user relationship data with intimacy scoring |
| 3 | `core-wisdom.json` | Permanent (max 20) | Distilled life lessons from reflection |

Memory files live at `~/.openclaw/workspace/memory/minase/` at runtime. Two reflection paths exist: nightly reflection (always at 23:00) and threshold reflection (when `total_importance_since_reflection >= 100`).

### Emergence System

The nightly reflection (`night-reflect.ts`) produces four types of emergent output written to persistent state:
- **Core Wisdom** → `core-wisdom.json` — life lessons distilled from experience
- **Preferences** → `preferences.json` — evolving cos character/style/hour/platform affinities
- **Aspirations** → `aspirations.json` — dreams that are born from reflection, with status tracking (active/achieved/abandoned)
- **Personality Drift** → `personality-drift.json` — rare ESTP-base modifiers injected into LLM prompts

### File I/O Pattern

All JSON state reads/writes go through `file-utils.ts` which provides:
- `.bak` backup before every write
- Automatic fallback: primary → `.bak` → default value
- `readAllJSON()` for directory scanning (social relations)

### Schedule System (3-Layer Priority)

`schedule-today.json` uses a 3-tier model:
- **Rigid** (Layer 0) — non-negotiable events (work 9-18, gym Tue/Thu 19-20:30) with `allowed_actions` list
- **Flexible** (Layer 1) — LLM-generated daily plans, injected as high-intensity intents
- **Intent Pool** (Layer 2) — competing desires resolved by rule engine + LLM

## Key Conventions

- **Language:** The character speaks Chinese with Japanese loanwords. Code comments and docs are in Chinese.
- **Markdown as config:** Behavior is defined in `.md` files, not code. Changing personality or memory rules means editing markdown.
- **Immutability:** All engine functions return new objects. Never mutate state in place — use spread operators to create updated copies.
- **Importance scoring (1-10):** Every memory event gets an importance score that drives compression, reflection triggers, and pruning.
- **LLM calls:** Heartbeat/reflection scripts use their own LLM via `llm-client.ts` (OpenAI-compatible API), independent of the OpenClaw agent model. All LLM outputs are parsed as JSON from code blocks.
- **TypeScript config:** Strict mode, ES2022 target, CommonJS modules. Source in `skill/scripts/`, output to `dist/`. Tests excluded from compilation.
- **Testing:** Vitest with `globals: true`. Tests in `tests/`. Engine modules (emotion, intent, vitality, confidence, random-events, social-graph) all have unit tests. Tests import source `.ts` files directly.
- **Templates:** 10 prompt templates in `skill/templates/` (e.g., `heartbeat-prompt.md`, `morning-plan-prompt.md`). Templates use `{placeholder}` syntax replaced at runtime.
- **Installer:** `bin/cli.js` is plain Node.js (no build step). It copies skill files, registers cron jobs, deploys hooks, injects persona into `SOUL.md`, and initializes 15+ state files with defaults.
