# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Alive** is a universal digital life engine — a generalized framework for creating AI personas with evolving memory, autonomous behavior loops, social presence, and platform integrations. It installs as an OpenClaw skill and lets any character defined in a `persona.yaml` file come alive with human-like quirks: emotions, fatigue, procrastination, flow states, random life events, voice messages, and social media presence.

The project started as "MizuSan" (水瀬 / Minase) — a single hardcoded character — and has been refactored into a persona-agnostic engine where behavior is driven by YAML config + markdown templates. The built-in preset character (Minase) serves as a reference implementation.

### Key Differentiators

- **Not a traditional app** — it's an OpenClaw skill where markdown files define behavior and TypeScript scripts handle background tasks via cron-driven heartbeats.
- **Persona-agnostic** — any character can be plugged in via `persona.yaml`; all templates use `{persona.*}` placeholders.
- **Multi-persona support** — multiple personas can coexist with independent memory directories, each with their own cron schedule and path isolation.
- **Sub-skill architecture** — modular capabilities (Instagram posting, voice TTS, web search, content browsing, social engagement, send-message) loaded dynamically via a skill router.
- **Autonomous skill discovery** — night reflection evaluates capability gaps, searches ClawHub → skills.sh cascade, and can auto-install up to 2 skills/night.

### Latest Features (2026-04-10)

**Viral Content Knowledge Base**: When content in the recommendation feed or from competitor accounts hits a likes threshold (default 5,000), it's automatically queued for 6-dimensional LLM dissection (hook type, content type, identity_mode, emotion arc, interaction design, visual style, CTA). Track-specific entries are soft-injected into `topic-generator.ts` prompts at draft time; universal patterns that appear ≥3 times auto-promote to `content_templates[]` (marked `source: "auto_promoted"`). Entries older than 30 days are pruned automatically. Query the knowledge base with `/alive kb status|search|list|formulas|top`. Three new modules in `scripts/ops/`: `viral-detector.ts`, `content-dissector.ts`, `viral-kb-store.ts`. Storage in `{MEMORY_BASE}/viral-kb/`. Two new persona config fields: `ops.viral_threshold` (default 5000) and `ops.kb_dissect_batch` (default 3).

**Ops Desk — Human-in-the-Loop Content Operations**: Framework-generic content operations layer controlled by `ops.enabled` in persona config. Monitors platform trends (velocity scoring via ClawHub skills), tracks competitor accounts, generates daily content drafts (XHS + Douyin) with LLM + tiktok-growth hooks, manages a review queue with slash commands (/post, /trends, /idea, /brief, /status, /help) and natural language intent recognition, pushes daily briefs to WeChat Work via OpenClaw gateway. Two new cron entry points: `ops-trends` (hourly) and `ops-brief` (daily). Built-in preset persona: Miss V (V姐) — ENTJ tri-identity virtual influencer (esports/singer/racer).

**Structured Competitor Profiles & Content Templates**: Rich competitor profiling system in `ops.competitors[]` with per-account metadata (tag, content mix %, audience demographics, interaction style, takeaways, anti-patterns). Content type template system in `ops.content_templates[]` with scene/camera/styling constraints and reference links. Topic generator injects template constraints and competitor benchmarks into LLM prompts. Review queue items carry `template_spec` and `competitor_benchmarks` metadata. Miss V persona ships with 13 competitor profiles and 22 content templates across 4 categories (音乐/赛车/生活日常/电竞解说).

**Multi-Persona Parallel Support**: Per-persona cron scheduling, path isolation, and additive switching. Multiple personas can run simultaneously without interfering with each other.

**Persona Creator**: `/alive create` command generates full personas — supports random, named, and guided modes with gender-aware name pools and content example templates.

**Voice TTS Sub-Skill**: Synthesize and send voice messages via Noiz TTS (Guest Mode). Throttled to ≤3/day, 3h cooldown, 9-22h active window, requires sociability ≥ 0.30 and energy ≥ 0.25. Voice enrichment via LLM adapts text for spoken delivery.

**Multi-Platform Content Bridge**: `ContentProvider` interface with 5 providers (Reddit, Bilibili, Weibo, Zhihu, DailyHot aggregator). Providers are registered in `ContentProviderRegistry` and configured per-persona via `content_sources` in `persona.yaml`.

**Admin Panel**: `/alive` slash commands bypass persona entirely — direct system management via `command-handler.ts`. Supports status, emotion, schedule, skills, platform, memory, reset, create, and help subcommands.

**Skill Discovery Hub**: Night reflection detects unhandled intents and wished skills, searches ClawHub/skills.sh, generates adapted skill manifests, and auto-installs (max 20 total, 2/night). Failed/unused skills archived to `.archived/`.

**Flow Engine Enhancements**: Hybrid diary strategy (odd ticks: template, even ticks: lightweight LLM via `flow-evolution-prompt.md`), flow cooldown reduced to 1 tick, entry threshold lowered to 2.5, max flow duration capped at 2 ticks for realism.

## Commands

```bash
npm run build          # Compile TypeScript (alive/scripts/ → dist-alive/)
npm run typecheck      # Type-check without emitting
npm run test           # Run all tests (vitest, 78 test files)
npm run test:watch     # Run tests in watch mode

# Run specific test file
npx vitest run alive/tests/flow.test.ts
npx vitest run alive/tests/persona-creator.test.ts

# Run tests matching a pattern
npx vitest run -t "emotion engine"
```

### CLI Commands

```bash
alive                                    # Interactive persona selection from presets
alive --persona <path.yaml>              # Install a custom persona
alive --update --persona <path.yaml>     # Update framework code, preserve memory
alive --reinstall --persona <path.yaml>  # Full reset and reinstall
alive --uninstall --persona <path.yaml>  # Remove skill + config
alive --switch-persona --persona <p.yaml> # Hot-switch to another persona
alive --create                           # Generate random persona
alive --create --name "X" --tagline "Y"  # Generate with name+tagline
alive --create --guided                  # Guided creation wizard
alive --real-day-test --persona <p.yaml> # Full-day E2E simulation
alive --help                             # Show help
```

## Architecture

```
alive/                           ← Universal digital life engine (persona-agnostic)
├── SKILL.md                     # OpenClaw skill entry point
├── persona-schema.yaml          # YAML schema + MBTI baseline table
├── personas/                    # Built-in presets (Minase, Miss V, etc.)
├── events.builtin.yaml          # 21 built-in random event types
├── protocols/                   # 5 behavior protocols
│   ├── memory.md                # Memory protocol
│   ├── heartbeat.md             # Heartbeat protocol
│   ├── intent-pool.md           # Intent pool protocol
│   ├── social-graph.md          # Social graph protocol
│   └── photo-sharing.md         # Photo sharing protocol
├── templates/                   # 10 LLM prompt templates ({persona.*} placeholders)
│   ├── personality.md           # Character voice & personality
│   ├── heartbeat-prompt.md      # Heartbeat LLM decision prompt
│   ├── morning-plan-prompt.md   # Morning planning prompt
│   ├── night-reflect-prompt.md  # Night reflection prompt
│   ├── reflection-prompt.md     # Memory reflection prompt
│   ├── diary-entry.md           # Diary entry template
│   ├── simulated-action.md      # Simulated action template
│   ├── flow-evolution-prompt.md # Flow state evolution prompt
│   ├── soul-injection.md        # Soul injection for SKILL.md
│   └── persona-generate-prompt.md # Persona generation prompt
├── scripts/
│   ├── engines/                 # 6 state engines
│   │   ├── emotion.ts           # 6D emotion model (valence/arousal/energy/stress/creativity/sociability)
│   │   ├── intent.ts            # Intent pool with 7 categories + procrastination
│   │   ├── flow.ts              # Flow/drift state machine
│   │   ├── vitality.ts          # 0-100 energy resource
│   │   ├── confidence.ts        # 0.5x-1.5x creation multiplier
│   │   └── work-impulse.ts      # 0-100 core output impulse accumulator
│   ├── lifecycle/               # 8 lifecycle scripts
│   │   ├── heartbeat-tick.ts    # Core hourly perceive-intend-act loop (39KB)
│   │   ├── morning-plan.ts      # Daily schedule + intent generation
│   │   ├── night-reflect.ts     # Wisdom/preferences/aspirations/drift emergence
│   │   ├── heartbeat-outreach.ts # Proactive message logic
│   │   ├── memory-reflect.ts    # Memory reflection trigger
│   │   ├── cron-sync.ts         # Cron job synchronization
│   │   ├── ops-trends.ts        # Ops: hourly trend monitoring + competitor tracking
│   │   └── ops-brief.ts         # Ops: daily brief generation + WeChat Work push
│   ├── world/                   # Random events + social graph + heartbeat gate
│   ├── router/                  # Sub-skill routing (intent → skill dispatch)
│   ├── ops/                     # 8 ops desk modules
│   │   ├── review-queue.ts      # CRUD for review queue JSON, status transitions, 7-day cleanup
│   │   ├── trend-analyzer.ts    # ClawHub trend fetching, velocity scoring, LLM relevance filter
│   │   ├── competitor-tracker.ts # Competitor monitoring via xhs-bridge + yt-dlp
│   │   ├── topic-generator.ts   # LLM content drafts (XHS + Douyin) with tiktok-growth hooks
│   │   ├── brief-generator.ts   # Daily brief formatting + WeChat Work push
│   │   ├── viral-detector.ts    # Filter trend/competitor items for viral candidates (likes > threshold)
│   │   ├── content-dissector.ts # LLM 6-dimensional structural analysis of viral content
│   │   └── viral-kb-store.ts    # Viral KB CRUD + UniversalFormula promotion logic
│   ├── hub/                     # 5 skill discovery modules
│   │   ├── skill-need-tracker.ts  # Capability gap recording (fuzzy dedup ≥50%)
│   │   ├── skill-hub-client.ts    # ClawHub + skills.sh API search
│   │   ├── skill-adapter.ts       # Adapted manifest generation (priority cap 3)
│   │   ├── skill-lifecycle.ts     # Install limits (max 20) + archive
│   │   └── skill-discovery.ts     # Full evaluate → search → install pipeline
│   ├── persona/                 # Persona loader + template injection
│   ├── admin/                   # 2 admin scripts
│   │   ├── command-handler.ts   # /alive slash command dispatcher (26KB)
│   │   └── persona-creator.ts   # Persona generation engine (32KB)
│   ├── adapters/                # Platform adapters
│   │   ├── instagram-adapter.ts # Instagram API adapter (22KB)
│   │   ├── content-provider.ts  # ContentProvider interface + registry
│   │   └── providers/           # 5 content providers
│   │       ├── reddit-provider.ts
│   │       ├── bilibili-provider.ts
│   │       ├── weibo-provider.ts
│   │       ├── zhihu-provider.ts
│   │       └── dailyhot-provider.ts
│   └── utils/                   # Core utilities (file-utils, llm-client, time-utils, types)
├── hooks/                       # OpenClaw hooks (context-loader, memory-save)
├── sub-skills/                  # 8 modular sub-skills (7 top-level + 1 platform aggregator)
│   ├── instagram/               # Instagram posting pipeline
│   ├── voice-tts/               # Voice message synthesis (Noiz TTS)
│   ├── web-search/              # Web search via Exa
│   ├── content-browse/          # Content browsing / inspiration (multi-platform)
│   ├── send-message/            # Proactive chat messages
│   ├── social-engagement/       # Social interaction (comment replies)
│   ├── ops-desk/                # Human-in-the-loop content operations (slash commands + NLU)
│   └── platform/                # Platform base capabilities (5 sub-skills)
│       ├── content-planner/     # Content planning engine (photo intent, post decisions)
│       ├── gallery/             # Photo gallery (search, share, ImgURL hosting)
│       ├── generate-image/      # AI image generation (AIHubMix / fal.ai)
│       ├── instagram-bridge/    # Instagram API bridge (Python instagrapi)
│       └── xhs-bridge/         # 小红书 bridge (search, feed, note details)
└── tests/                       # 126 test files
```

### OpenClaw Integration Points

1. **Skill system** — `SKILL.md` is the entry point. Declares `allowed-tools`, `slash_commands`, `mcp-tools`, and a Behavior Trigger Map that loads sub-modules on demand.

2. **Hooks** — Two hooks:
   - `alive-context-loader` (event: `agent:bootstrap`) — injects core-wisdom + emotion + recent diary into agent context at session start.
   - `alive-memory-save` (event: `command:new`/`command:reset`) — reminds agent to persist conversation memories before session ends.

3. **Cron jobs** — Three core jobs + two ops jobs registered via `openclaw cron add`:
   - `alive:morning` → `morning-plan.js` — generates daily schedule, intent seeds, cron config, advances travel state.
   - `alive:tick` → `heartbeat-tick.js` — hourly perceive-intend-act loop.
   - `alive:night` → `night-reflect.js` — daily reflection producing wisdom, preferences, aspirations, personality drift, skill gap analysis.
   - `alive:ops-trends` → `ops-trends.js` — hourly trend monitoring + competitor tracking (only when `ops.enabled`).
   - `alive:ops-brief` → `ops-brief.js` — daily brief generation + WeChat Work push at `ops.brief_time - 10min` (only when `ops.enabled`).

4. **Environment variables** — stored in `~/.openclaw/openclaw.json` under `skills.entries.alive.env`.

### Heartbeat System (Core Loop)

`heartbeat-tick.ts` routes by hour: `runMorningPlan()` (wake hour), `runNightReflect()` (sleep hour), or `regularTick()` (active hours). Sleep hours are skipped via `heartbeat-gate.ts`.

Each regular tick runs: **Perceive** (read emotion/events/schedule/world) → **Intend** (rule engine + LLM decision) → **Act** (real/simulated/inner actions via skill-router). The tick orchestrates these engines:

- **Emotion engine** (`emotion.ts`) — 6-dimensional state (valence/arousal/energy/stress/creativity/sociability) with a three-layer inertia model: **impulse** (event-driven, 20%/tick decay), **momentum** (exponential moving average, dynamic 3-8%/tick decay), and **undertone** (daily baseline set by nightly reflection). Includes **rumination** and **threshold break** (stress >0.6 for 3+ ticks → emotional explosion with cooldown).
- **Intent engine** (`intent.ts`) — 7 MetaIntent categories (produce/connect/consume/express/learn/rest/aspire) with rule-based accumulation, event boosts, schedule injection, LLM arbitration. Each intent has **resistance** thresholds. Supports **impulse breakthrough** and **procrastination tracking** (guilt at 3+, abandonment at 5+). Intent display names and emotion coupling weights are configurable per-persona via `intent_config` in `persona.yaml`.
- **Flow engine** (`flow.ts`) — State machine: **flow** (immersion, vitality drain ×0.7) and **drift** (slacking, skips LLM). Hybrid diary: odd ticks template, even ticks LLM evolution. Max 2 ticks each, cooldown 1 tick.
- **Vitality engine** (`vitality.ts`) — 0-100 resource with per-tick drain, per-action cost, afternoon rest recovery. Gates posting at >30. Emergency recovery after 3 consecutive low days.
- **Confidence engine** (`confidence.ts`) — 0.5x-1.5x multiplier on produce intent, updated by output performance vs 7-day average, with streak bonuses.
- **Work impulse engine** (`work-impulse.ts`) — 0-100 core output desire accumulator. Sources configurable per persona via `work_impulse.sources`. Decays per tick. Triggers produce desire when ≥threshold (default 70).
- **Random events** (`random-events.ts`) — 21 event types with precondition filtering, dynamic weight modifiers, and chain events (delayed follow-ups).
- **Social graph engine** (`social-graph-engine.ts`) — 4-tier relationship system (core/familiar/cognitive/dormant) with closeness decay and social intent generation.

**Narrative continuity**: Each tick passes last 3 tick summaries + previous inner monologue + voice directive to LLM.

### Sub-Skill Router

`skill-router.ts` dynamically loads sub-skills from `manifest.json` files, building a route table mapping intent categories to skills sorted by priority. Routes are resolved by intent category or explicit skill name. Context is built from emotion state, persona config, memory accessors, and social graph data.

### Skill Discovery System (Hub)

Five modules in `scripts/hub/`:
- **skill-need-tracker** — records capability gaps with fuzzy dedup (keyword overlap ≥50%), tracks occurrences and intensity peaks.
- **skill-hub-client** — searches ClawHub and skills.sh APIs.
- **skill-adapter** — generates adapted `manifest.json` + `index.ts` wrapper for discovered skills (priority capped at 3).
- **skill-lifecycle** — install limits (max 20), archive/uninstall management.
- **skill-discovery** — orchestrates the full evaluate → search → install pipeline during night reflect.

### Multi-Platform Content Bridge

`content-provider.ts` defines the `ContentProvider` interface with `getFeed()` and `search()` methods. Five providers:
- **Reddit** (`reddit-provider.ts`) — JSON API, configurable subreddits
- **Bilibili** (`bilibili-provider.ts`) — Hot/trending API
- **Weibo** (`weibo-provider.ts`) — Hot search API
- **Zhihu** (`zhihu-provider.ts`) — Hot topics API
- **DailyHot** (`dailyhot-provider.ts`) — Aggregator API supporting 60+ sub-platforms

Providers are registered in `ContentProviderRegistry` and configured per-persona via `content_sources` in `persona.yaml`.

### Voice TTS Sub-Skill

Located at `sub-skills/voice-tts/`. Flow: gate check (hour/energy/sociability/cooldown) → LLM generate message text → voice enrichment (adapts written text to spoken form with pauses, interjections, emotional cues) → Noiz TTS synthesis → send via `openclaw --media` → diary entry. State tracked in `voice-state.json`, audio stored in `{MEMORY_BASE}/voice/` with 7-day auto-cleanup.

### Admin Panel (Slash Commands)

`command-handler.ts` parses `/alive <subcommand> [args] [--flags]` and dispatches to handler functions. **Complete isolation**: no personality loading, no diary writes, no hooks, no LLM calls. Includes `persona-creator.ts` for `/alive create` with random name pools (30 surnames × 30 given names per gender), 32 trait categories, and 16 MBTI types.

### Ops Desk (Human-in-the-Loop Content Operations)

Framework-generic content operations layer controlled by `ops.enabled` in `persona.yaml`. Eight core modules in `scripts/ops/`:

- **review-queue** (`review-queue.ts`) — CRUD for `{MEMORY_BASE}/review-queue.json`. Status transitions: `pending → approved → published` or `pending → discarded`. 7-day auto-cleanup for published/discarded items. Immutable operations via spread.
- **trend-analyzer** (`trend-analyzer.ts`) — Calls `daily-hot-news` and `douyin-hot-trend` ClawHub skills, computes velocity scores (`current_volume / avg_7d`), filters by `ops.trend_score_threshold`, runs LLM relevance filter against persona identities. History persisted to `trend-history.json` (14-day rolling window).
- **competitor-tracker** (`competitor-tracker.ts`) — Monitors competitor accounts via `xhs-bridge` (search) and `yt-dlp-downloader` ClawHub skills. Graceful failure on all external calls. Persists to `competitor-log.json` (200 entries max). Enhanced with `buildCompetitorContext()` for rich LLM prompt injection (grouped by tag, content mix %, audience, takeaways/avoid) and `resolveCompetitorAccounts()` to merge legacy `competitor_accounts` with new `competitors[]` profiles.
- **topic-generator** (`topic-generator.ts`) — Given filtered trends, generates N content drafts per `ops.topic_count`. For each trend: selects matching `ContentTemplate` by identity mode, injects scene/camera/styling constraints + competitor benchmarks into LLM prompt, generates XHS图文 + Douyin视频脚本 enriched with `tiktok-growth` hooks and AI cover images. Pushes drafts into review queue with `template_spec` and `competitor_benchmarks` metadata.
- **viral-detector** (`viral-detector.ts`) — Filters trend/competitor items where `likes > ops.viral_threshold` (default 5000), deduplicates against existing KB entries and queue. Pure function — does not write to disk.
- **content-dissector** (`content-dissector.ts`) — LLM 6-dimensional structural analysis (hook_type, content_type, identity_mode, emotion_arc, interaction_design, visual_style, cta_type, summary). Assigns `kb_tier = "track"` when identity_mode is non-null, else `"universal"`. Failed dissections set `dissection_status = "failed"` without throwing.
- **viral-kb-store** (`viral-kb-store.ts`) — Viral KB CRUD + UniversalFormula promotion. upsertEntry, addToQueue, dequeueItems, queryTrack, queryAll, queryFormulas, getStats. checkFormulaPromotion promotes when same (platform + content_type + hook_type) appears ≥3 times; on promotion writes a new ContentTemplate to persona.yaml with `source: "auto_promoted"`.

**Sub-skill**: `sub-skills/ops-desk/` with `manifest.json` routing `produce→generate-topics` and `consume→refresh-trends`. Message parser (`message-parser.ts`) handles slash commands (`/post`, `/trends`, `/idea`, `/brief`, `/status`, `/help`) and LLM-based natural language intent recognition for the review queue.

**Lifecycle entry points**: `ops-trends.ts` (hourly cron) and `ops-brief.ts` (daily at `brief_time - 10min`). Both gate on `persona.ops?.enabled` and exit immediately if disabled.

**ClawHub skills used** (not reimplemented): `daily-hot-news`, `douyin-hot-trend`, `yt-dlp-downloader`, `video-summary`, `tiktok-growth`, `content-writer`.

### Post Pipeline

When heartbeat chooses `type: "real", skill: "post-pipeline"`:
1. `refreshInspiration()` — collect trends + download reference images (FIFO 20 cap, 7-day expiry)
2. `planPhoto()` — LLM decides what to photograph, outputs multi-shot descriptions
3. `generateImageSet()` — per-shot reference selection, AIHubMix Gemini API with multi-reference fallback chain (multi-image → grid composite → single), jimp post-processing
4. `shouldConsiderPosting()` — 3 posts/day hard limit
5. `planPost()` — LLM selects photos, writes caption/hashtags
6. `postToInstagram()` — single photo or carousel via Python instagrapi bridge
7. Record to `post-history.json` + `diary.md` + reset post impulse

### Photo Gallery & Chat Sharing

`gallery-send.ts` — three actions: `search` (filters by publicUrl, reshare cooldown 24h), `send` (existing photo via bridge), `generate-and-send` (new photo on demand).

### Memory System (4 Layers)

| Layer | File | Retention | Purpose |
|-------|------|-----------|---------|
| 0 | In-conversation | Session only | Working memory |
| 1 | `diary.md` | 30 days | Episodic stream, auto-compress low-importance |
| 2 | `relations/{user_id}.json` | 90 days | Per-user relationship with intimacy scoring |
| 3 | `core-wisdom.json` | Permanent (max 20) | Distilled life lessons |

Memory files at `~/.openclaw/workspace/memory/<persona-slug>/`. Two reflection paths: nightly (sleep hour) and threshold (total_importance_since_reflection ≥ 100).

### Emergence System

Nightly reflection produces four types of emergent output:
- **Core Wisdom** → `core-wisdom.json` — life lessons from experience
- **Preferences** → `preferences.json` — evolving affinities
- **Aspirations** → `aspirations.json` — dreams with status tracking (active/achieved/abandoned)
- **Personality Drift** → `personality-drift.json` — rare MBTI-base modifiers

### Memory File Paths

```
MEMORY_BASE = ~/.openclaw/workspace/memory/{persona.meta.id}

diary:          {MEMORY_BASE}/diary.md
core-wisdom:    {MEMORY_BASE}/core-wisdom.json
world:          {MEMORY_BASE}/world.md
relations:      {MEMORY_BASE}/relations/{user_id}.json
emotion-state:  {MEMORY_BASE}/emotion-state.json
intent-pool:    {MEMORY_BASE}/intent-pool.json
schedule-today: {MEMORY_BASE}/schedule-today.json
event-queue:    {MEMORY_BASE}/event-queue.json
preferences:    {MEMORY_BASE}/preferences.json
aspirations:    {MEMORY_BASE}/aspirations.json
personality:    {MEMORY_BASE}/personality-drift.json
heartbeat-log:  {MEMORY_BASE}/heartbeat-log.json
social-meta:    {MEMORY_BASE}/relations/social-meta.json
voice-audio:    {MEMORY_BASE}/voice/*.mp3          (auto-cleaned after 7 days)
voice-state:    {MEMORY_BASE}/voice-state.json     (daily count + cooldown tracking)
skill-needs:    {MEMORY_BASE}/skill-needs.json     (capability gap tracking)
review-queue:   {MEMORY_BASE}/review-queue.json    (ops: content draft review queue)
competitor-log: {MEMORY_BASE}/competitor-log.json   (ops: competitor monitoring log)
trend-history:  {MEMORY_BASE}/trend-history.json    (ops: 14-day trend velocity history)
ops-brief-log:  {MEMORY_BASE}/ops-brief-log.json    (ops: daily brief send log)
viral-kb/entries.json:       {MEMORY_BASE}/viral-kb/entries.json       (viral KB: dissected entries)
viral-kb/formulas.json:      {MEMORY_BASE}/viral-kb/formulas.json      (viral KB: promoted universal formulas)
viral-kb/dissect-queue.json: {MEMORY_BASE}/viral-kb/dissect-queue.json (viral KB: items awaiting dissection)
cron-schedule:  {baseDir}/cron-schedule.json
```

## Key Conventions

- **Language:** Personas speak the language defined in their `voice.language` config. Code comments and docs are in Chinese or English. All templates use `{persona.*}` placeholders — no hardcoded character content.
- **Persona-agnostic:** Never reference a specific character name or personality in engine code. All character-specific content lives in `persona.yaml` and is injected via `injectPersona()`.
- **Markdown as config:** Behavior is defined in `.md` files. Changing personality or memory rules means editing markdown templates.
- **Immutability:** All engine functions return new objects. Never mutate state in place — use spread operators.
- **Importance scoring (1-10):** Every memory event gets an importance score driving compression, reflection triggers, and pruning.
- **LLM calls:** Heartbeat/reflection scripts use their own LLM via `llm-client.ts` (OpenAI-compatible API), independent of the OpenClaw agent model. All LLM outputs parsed as JSON from code blocks.
- **TypeScript config:** Strict mode, ES2022 target, CommonJS modules. Source in `alive/scripts/`, output to `dist-alive/`. Tests excluded from compilation.
- **Testing:** Vitest with `globals: true`. 126 test files in `alive/tests/`. Engine modules, sub-skills, providers, admin commands, persona creator, ops desk modules, and viral KB all have unit tests.
- **Templates:** 10 prompt templates in `alive/templates/` using `{placeholder}` syntax replaced at runtime by `injectPersona()`.
- **Installer:** `bin/cli.js` is plain Node.js (no build step). Copies skill files, registers cron, deploys hooks, injects persona into `SOUL.md`, initializes state files. Supports `--update`, `--reinstall`, `--uninstall`, `--switch-persona`, `--create`, `--real-day-test`. Conditionally registers `ops-trends` and `ops-brief` cron jobs when `persona.ops.enabled` is true.
- **Time utilities:** `time-utils.ts` exports `now()` (respects `setTimeOverride()` for E2E) and `wallNow()` (always real time). **Always use `wallNow()` for log timestamps; use `now()` for heartbeat business logic.**
- **File I/O:** All JSON reads/writes through `file-utils.ts` with `.bak` backup before every write, automatic primary → `.bak` → default fallback.
- **LLM logging:** `llm-client.ts` appends to `llm-call-log.jsonl` (auto-rotates at 500KB). Entries include caller tag, prompt/response, elapsed_ms, model, tokens.
- **Content sources:** Configured per-persona in `persona.yaml` under `content_sources`. Providers are loaded at runtime and can be filtered by platform name.

### Schedule System (3-Layer Priority)

`schedule-today.json` uses a 3-tier model:
- **Rigid** (Layer 0) — non-negotiable events with `allowed_actions` list
- **Flexible** (Layer 1) — LLM-generated daily plans, injected as high-intensity intents
- **Intent Pool** (Layer 2) — competing desires resolved by rule engine + LLM

### Sub-Skill Manifest Format

Each sub-skill directory contains `manifest.json`:
```json
{
  "name": "skill-name",
  "description": "...",
  "routes": [
    { "intent": "produce", "action": "post", "priority": 7 }
  ],
  "gates": { "min_vitality": 30 }
}
```

And a `scripts/index.ts` exporting the sub-skill implementation conforming to the `SubSkill` interface.

### Platform Sub-Skills (under `sub-skills/platform/`)

Five platform-level sub-skills providing infrastructure capabilities:

| Sub-Skill | Description | Key Scripts |
|-----------|-------------|-------------|
| **content-planner** | Content planning engine — photo intent, post decisions, style ratio, advisor consultation | `planner.ts`, `advisor.ts`, `travel-state.ts` |
| **gallery** | Photo gallery — search, share, ImgURL public hosting | `gallery-ops.ts`, `imgurl-upload.ts` |
| **generate-image** | AI image generation — prompt building, AIHubMix/fal.ai API, reference management, post-processing | `prompt-builder.ts`, `provider.ts`, `reference-selector.ts`, `post-process.ts` |
| **instagram-bridge** | Instagram API bridge — upload, comments, feed, hashtag search | `bridge-client.ts`, `post-instagram.ts`, `instagram-bridge.py` |
| **xhs-bridge** | 小红书 bridge — search, feed, note details | `xhs-client.ts` |

### Ops Desk Sub-Skill (under `sub-skills/ops-desk/`)

| Component | Description |
|-----------|-------------|
| `manifest.json` | Routes `produce→generate-topics`, `consume→refresh-trends`, priority 3 |
| `scripts/index.ts` | Action dispatcher using `ctx.persona`, ops.enabled gate |
| `scripts/message-parser.ts` | Slash commands + LLM NLU intent recognition for WeChat Work messages |

## Environment Variables

All configured interactively at install time, stored in `~/.openclaw/openclaw.json`:

| Variable | Purpose | Required |
|----------|---------|----------|
| `LLM_API_KEY` | LLM API key | Recommended |
| `LLM_API_BASE` | LLM API endpoint (default: `https://aihubmix.com/v1`) | Optional |
| `LLM_MODEL` | LLM model name (default: `claude-sonnet-4-20250514`) | Optional |
| `ALIVE_PERSONA` | Active persona slug (auto-managed) | Auto |
| `IMAGE_ENTRY` | Image gen provider: `AIHUBMIX` or `FAI` | Optional |
| `AIHUBMIX_API_KEY` | AIHubMix API Key | Conditional |
| `FAL_KEY` | fal.ai API Key | Conditional |
| `IMGURL_TOKEN` | Image upload to public hosting | Optional |
| `INSTAGRAM_USERNAME` | Instagram login | Optional |
| `INSTAGRAM_PASSWORD` | Instagram password | Optional |
| `XHS_SKILLS_DIR` | Path to xiaohongshu-skills Python directory | Optional |

## Project Timeline (from Git History)

| Date | Milestone |
|------|-----------|
| 2026-03-10 | Project initialized as "minase" — npx installer, persona templates, TypeScript config |
| 2026-03-11 | Core engine built: emotion, intent, vitality, flow, heartbeat-tick, morning-plan, night-reflect, auto-photo system, content-planner, post-pipeline, Instagram integration |
| 2026-03-12 | Refactored Instagram to use instagrapi bridge, added ImgURL upload |
| 2026-03-13–14 | Social engagement: outbound comments, comment replies, social-graph engine, send-message |
| 2026-03-15–16 | Cron sync, confidence engine, random events, web search pipeline |
| 2026-03-17 | Travel state machine, advisor system, LLM infrastructure improvements, E2E tests |
| 2026-03-18 | Live follower sync, live data sources for collector, real day E2E tests |
| 2026-03-19 | JSON parsing fixes, outfit normalization, dedup logic, advisor timeout |
| 2026-03-20–21 | Weekly simulation system, fal.ai image gen, enhanced realism |
| 2026-03-22 | Production simulation scripts, absolute path migration |
| 2026-03-24 | **Major refactor**: Generalized to "Alive" framework — removed hardcoded character content, added ContentProvider interface + 5 providers, multi-platform content bridge, template variables |
| 2026-03-25 | Multi-persona parallel support, `/alive` admin panel, voice-tts sub-skill, flow engine enhancements, persona creator, skill discovery hub, gender + content examples config |
| 2026-03-26 | XHS bridge, content-planner template updates, E2E sub-skills tests, Instagram bridge improvements |
| 2026-03-31 | **Ops Desk**: Human-in-the-loop content operations — trend analyzer (velocity scoring), competitor tracker, topic generator (XHS+Douyin), brief generator (WeChat Work push), review queue CRUD, message parser (slash commands + NLU), ops-desk sub-skill, lifecycle cron entries, Miss V persona. **Structured Competitor Profiles & Content Templates**: 13 competitor profiles with content mix/audience/interaction metadata, 22 content templates with scene/camera/styling constraints, template-injected LLM prompts, review queue metadata enrichment |
