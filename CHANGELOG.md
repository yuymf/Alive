# Changelog

All notable changes to Alive are documented here.

---

## [1.3.0] — 2026-04-27

### Added
- **Title Skeleton Library** — 28 proven title bone structures across 7 hook types (反问式/数字冲击/指令式/悬念留白/对比反转/身份共鸣/痛点直击) + 8 interaction hook templates. Loaded from `templates/ops/title-skeletons.md` and injected into content generation prompts. Shifts content generation from "LLM invents structure" to "LLM fills proven skeletons." (`topic-generator.ts`, `templates/ops/title-skeletons.md`)
- **5-Template Viral Decomposition** — content dissector now extracts 5 reusable structural templates (title/cover/body/engagement/tag) alongside the existing 6-dimension analysis. Templates use `[placeholder]` syntax for direct reuse in content generation. New `ViralTemplates` type and `viral_templates` field on `ViralEntry.dissection`. (`content-dissector.ts`, `types.ts`)
- **6-Factor Topic Scoring Gate** — pre-generation quality filter evaluating articulability, controversy, serialization potential, shareability, executability, and risk (0-2 each). Topics below threshold (default 6) are filtered out before expensive LLM draft generation, saving tokens and improving hit rate. New `topic-scorer.ts` module with `TopicScore` and `ScoredTrend` types. (`topic-scorer.ts`, `topic-generator.ts`)
- **Risk Annotations on Review Queue** — every content draft now carries `risk_level` (low/medium/high/critical) and `risk_detail` (human-readable risk description). Derived from topic scoring and passed through to the review queue for informed human approval decisions. New `RiskLevel` type. (`types.ts`, `review-queue.ts`, `topic-generator.ts`)
- **4 SOP Template Documents** — standalone markdown Standard Operating Procedures for ops workflows, versioned independently from code:
  - `topic-scoring-sop.md` — 6-dimension scoring rubric with detailed 0/1/2 criteria
  - `viral-decompose-sop.md` — 5-template extraction framework with examples
  - `content-draft-sop.md` — end-to-end draft generation workflow with quality checklist
  - `feed-analysis-sop.md` — 7-dimension feed analysis framework with signal thresholds
- **Viral KB Entry Lifecycle** — entries now have `entry_status` (active/deprecated/experimental) and `confidence_level` (low/medium/high). Deprecated entries are excluded from generation context but preserved for learning history. New `deprecateEntry()` and `setEntryConfidence()` functions. KB stats now include `by_status` breakdown. (`viral-kb-store.ts`, `types.ts`)
- **Per-Platform Voice Variants** — persona config now supports `platform_voices` map (keyed by platform: xhs/douyin/wechat) with platform-specific style, reply structure, anti-patterns, catchphrases, and sample lines. Voice variants are injected into content generation prompts per platform. New `PlatformVoice` interface. (`types.ts`, `persona-schema.yaml`, `topic-generator.ts`)

### Changed
- Content dissector max tokens increased from 1200/800 to 1500/1000 to accommodate viral template extraction output
- `queryTrackInMemory()` and `queryAll()` now exclude deprecated entries by default (use `include_deprecated: true` to override)
- Topic generation pipeline now runs scoring gate → diversity gate → content generation (was diversity gate → content generation)

### Architecture Notes
Inspired by the [xiaohongshu-ops-skill](https://github.com/Xiangyu-CAS/xiaohongshu-ops-skill) project's SOP-as-prompt architecture and multi-dimensional scoring framework. Key design principle: **skeleton filling > open generation** — provide proven structures for LLM to fill rather than generating from scratch.

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
- `.gitignore` now excludes `/e2e/` and `/tools/` (root-level dev directories) from published repo

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
