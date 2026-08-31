# Changelog

All notable changes to Alive are documented here.

---

## [0.6.0] — 2026-08-31

### Added
- **`/alive distill <name|path|url>`** — 一键蒸馏：材料或已有工程写成 `SKILL.md`，立刻 `adopt`。仓库里的峰哥 / 塔菲 / Jobs 等可以直接 `alive distill 峰哥`。
- **峰哥 example** — 来自 [feng-ge-skill](https://github.com/YixiaJack/feng-ge-skill)（MIT）。[talk-to-fengge](https://github.com/YeJe-cpu/talk-to-fengge) 没有 `SKILL.md`，`distill` 会抽出 `worker/persona.py` 再接入。不把 LiveKit / VoxCPM 语音栈并进本仓库。
- 女娲方法的 host 蒸馏协议：没有现成 skill、也没有 `LLM_API_KEY` 时，Code Agent 按协议写文件并 adopt。
- **`voice-call` 子技能 + `/alive call`** — 心跳可以主动给主人发起实时语音。邀请进 outbox，加入页是 talk-to-fengge（`TALK_TO_FENGGE_URL`）。一天最多一通。不并 LiveKit。
- 晨规划允许把「主动找主人说话 / 打电话」写进当天日程。

### Fixed
- `adopt` 现在递归拷贝 `references/**/*.md`（峰哥的 `references/research/` 以前会被丢掉）。

---

## [0.5.0] — 2026-08-31

### Added
- **`/alive adopt <path|url>`** — 把女娲蒸馏出的人物 skill、或永雏塔菲这类公开人格 skill 接进 Alive。拷贝 `SKILL.md` / `persona.md` / `references/*.md`，对话和心跳都按原文规则说话。
- **`examples/`** — 可 `adopt` 的案例：女娲式样板永雏塔菲，以及来自 [awesome-human-distillation](https://github.com/mliu98/awesome-human-distillation) 的 Steve Jobs、王小波、王阳明、Karpathy。
- README 封面与 logo；仓库定位改为「让 persona skill 不只停留在聊天」。
- README 改为 logo + 排版头图（去掉 AI 插画），安装步骤提前，和常见优秀仓库同一套布局。

### Removed
- 内置角色 **Miss V**、**星瞳**。只保留水瀬与郭德纲；其他人设用 `adopt` 或 `/alive create`。

---

## [0.4.0] — 2026-08-30

### Changed
- Alive is an **Agent Skill**, not an OpenClaw product. `alive init` copies `alive/SKILL.md` into Code Agent skill dirs (`~/.agents`, `~/.claude`, `~/.cursor`, `~/.codex`, or project `.agents/skills`).
- Memory and env live in `$ALIVE_HOME` (default `~/.alive`). Conversation uses the host model. Heartbeat scripts require `LLM_API_KEY`.
- Proactive send writes `$ALIVE_HOME/outbox/` for the host agent to deliver.

### Removed
- OpenClaw plugin, gateway RPC, cron-sync, ClawHub installer, Gateway LLM fallback.
- Unused OpenClaw hooks, one-off migration/test scripts, and leaked `/alive create` test personas.

### Fixed
- `alive status` / admin commands now load `$ALIVE_HOME/.env` so they find the persona seeded by `init`.

### Added
- Conversation loop: `chat.js load` / `chat.js save` (also `alive context` / `alive remember`). Diary, relation, and emotion are written by the engine so the next host turn can read them.
- Installed skill launchers jump back to the package so `node {baseDir}/scripts/host/chat.js` works outside the repo (hosts cannot `require('yaml')` from `~/.agents`).

---

## [0.3.0] — 2026-08-30

### Removed
- **Ops Desk / 运营工作台** — 全部删除：`scripts/ops/`、`lifecycle/ops-*`、`sub-skills/ops-desk/`、选题/竞品/爆款 KB/简报/审核队列及相关 cron、斜杠命令、eval 调参集。
- **Frontend** — 删除已废弃的 `alive/dashboard/` 与仅为运营 UI 服务的 `alive/api-server/`。
- Miss V persona 中的 `ops:` 配置块与 `ops-desk` 子技能。

心跳引擎、记忆、人设、平台子技能（浏览/发帖/语音）保留。OpenClaw 仍是当前运行时宿主（解耦列为后续工作）。

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
