# Changelog

All notable changes to Alive are documented here.

---

## [1.2.0] — 2026-04-10

### Added
- **Viral Content Knowledge Base** — when posts hit a likes threshold (default 5,000), they're automatically dissected across 6 dimensions (hook type, content type, emotion arc, interaction design, visual style, CTA) and stored in a per-persona knowledge base. Track-specific patterns are injected into content drafts as soft context; universal patterns (same hook formula appearing 3× across platforms) auto-promote to `content_templates[]`. Query anytime with `/alive kb`.
- **`/alive kb` commands** — `status`, `search <keyword>`, `list --platform --type`, `formulas`, `top --platform --limit`
- **`ops.viral_threshold`** — configurable likes threshold per persona (default 5000)
- **`ops.kb_dissect_batch`** — max items to dissect per hourly run (default 3, range 1–10)
- **Auto-eviction** — viral KB entries older than 30 days are pruned automatically unless referenced by a formula or actively used in generation

---

## [1.1.0] — 2026-04-07

### Added
- **Zero-config install** — heartbeat loop now works without any API key, falling back to OpenClaw's built-in Claude (`llm-client.ts` `openclaw run` fallback)
- **Streamlined installer** — `bin/cli.js` install flow reduced from 6 questions to 2 opt-in questions (custom LLM + Instagram), with a feature unlock summary at the end
- **`.env.example`** — annotated reference file listing all optional environment variables
- **English README** — concise `README.md` (< 80 lines) rewritten for content creators
- **中文文档** — comprehensive `README.zh.md` with progressive feature unlock table and architecture overview
- **Persona README cards** — `alive/personas/*-readme.md` cards for all 4 built-in characters
- **`/alive setup` command** — in-chat env configuration: `/alive setup`, `/alive setup llm`, `/alive setup instagram`

### Changed
- `.gitignore` now excludes `/e2e/` and `/scripts/` (root-level dev directories) from published repo

---

## [1.0.0] — 2026-03-31

### Added
- **Ops Desk** — human-in-the-loop content operations (`ops-trends`, `ops-brief` cron entries, review queue, trend analyzer, competitor tracker, topic generator, brief generator)
- **Structured competitor profiles** — `ops.competitors[]` with content mix, audience demographics, interaction style metadata
- **Content type templates** — `ops.content_templates[]` with scene/camera/styling constraints and reference links
- **Multi-persona parallel support** — per-persona cron scheduling and path isolation
- **Persona Creator** — `/alive create` command (random, named, guided modes)
- **Voice TTS sub-skill** — Noiz TTS Guest Mode, ≤3/day, 3h cooldown
- **Multi-platform content bridge** — 5 providers: Reddit, Bilibili, Weibo, Zhihu, DailyHot
- **Admin panel** — `/alive` slash commands (status, emotion, schedule, skills, memory, reset, create, help)
- **Skill Discovery Hub** — nightly capability gap analysis, ClawHub + skills.sh search, auto-install (max 2/night)
- **Flow engine enhancements** — hybrid diary strategy, reduced cooldown, capped max duration

### Core engine (since project init 2026-03-10)
- 6D emotion model with three-layer inertia (impulse / momentum / undertone)
- Intent engine with 7 MetaIntent categories and procrastination tracking
- Flow/drift state machine
- Vitality engine (0–100 resource)
- Confidence engine (0.5×–1.5× multiplier)
- Work impulse accumulator
- 21 built-in random event types with chain events
- 4-tier social graph engine
- Memory system: diary (30d), relations (90d), core wisdom (permanent)
- Morning planning + nightly reflection lifecycle
- Instagram posting pipeline with AI image generation
- Multiple personas: Minase, Miss V, Xingtong, Guodegang
