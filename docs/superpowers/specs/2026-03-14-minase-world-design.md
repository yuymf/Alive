# Minase World Dashboard - Design Spec

## Overview

Minase World is an independent OpenClaw skill that provides a real-time RPG-style status dashboard for observing Minase's internal state. It is a read-only companion window — a daily observation portal into Minase's life as a digital character.

**Core identity**: Daily companion observation window with immersive RPG aesthetic, not a debugging tool.

## Architecture

### Project Structure

```
minase-world/                    # Independent OpenClaw skill
├── SKILL.md                     # Skill entry point, declares allowed-tools
├── bin/
│   └── cli.js                   # Installer: register commands, configure paths
├── hooks/
│   └── minase-world-server      # agent:bootstrap hook, detect local server status
├── server.js                    # Minimal HTTP server (Node.js built-in http, zero deps)
├── dashboard/
│   └── index.html               # Single-file dashboard (HTML + inline CSS/JS)
└── package.json
```

### Data Flow

```
Minase heartbeat/chat/pipeline
        │
        ▼ (writes JSON files)
~/.openclaw/workspace/memory/minase/
   ├── emotion-state.json
   ├── intent-pool.json
   ├── vitality-state.json
   ├── confidence-state.json
   ├── flow-state.json
   ├── post-impulse.json
   ├── schedule-today.json
   ├── heartbeat-log.json
   ├── active-session.json  ← new, written by Minase hook
   └── ...
        │
        ▼ (HTTP GET, 30s polling)
server.js (localhost:3900)
   └── GET /api/state → reads all JSON, returns merged response
        │
        ▼
dashboard/index.html (browser)
```

### Key Design Decisions

- **server.js uses Node.js built-in `http` module** — zero external dependencies. Single responsibility: read memory directory JSON files, merge, return.
- **Single API endpoint `GET /api/state`** — one request fetches all state, minimizes request count.
- **Frontend diff mechanism** — compares previous JSON stringified hash, skips re-render if unchanged.
- **`active-session.json`** — new file written by Minase's existing hooks to indicate active chat sessions.

## Existing Input Conflict Analysis

Minase has three write paths to state files:

| Path | Trigger | Files Written |
|------|---------|---------------|
| **Heartbeat tick** | Cron hourly | emotion/intent/vitality/confidence/flow/diary + all state |
| **User chat** | OpenClaw agent manual write | emotion/diary/relations/core-wisdom |
| **Post pipeline** | Heartbeat-spawned child process | post-impulse/diary/post-history |

### Identified Conflicts

| File | Heartbeat | Post Pipeline | User Chat | Risk |
|------|-----------|---------------|-----------|------|
| `emotion-state.json` | Write | Read-only | Write | HIGH |
| `diary.md` | Append | Append | Append | MEDIUM |
| `post-impulse.json` | Write | Write | Read-only | HIGH |
| `relations/*.json` | Write | — | Write | MEDIUM |

**Current protection**: `.bak` backup before every write (corruption recovery, not concurrency protection) + cron hourly interval (reduces probability, doesn't eliminate).

**Impact on minase-world**: None. The dashboard is strictly read-only. It does not write to any state files and does not exacerbate existing conflicts. The `.bak` fallback in server.js provides additional resilience when reading during a write.

## Dashboard Layout

Single-screen RPG status panel with 5 regions + status bar:

```
┌─────────────────────────────────────────────────────────┐
│  ♦ Minase ─ World Dashboard                14:00 tick #7 │
├──────────────┬──────────────────────┬───────────────────┤
│              │                      │                   │
│  [A] Char    │  [B] Action          │  [C] Intent       │
│  Card        │  Timeline            │  Arena            │
│              │                      │                   │
│  Flow/Drift  │  Recent 3 ticks      │  7 categories     │
│  Vitality    │  Inner monologue     │  Intensity vs     │
│  Confidence  │  Current action      │  Resistance       │
│  Post Impulse│  Voice directive     │  Procrastination  │
│              │                      │                   │
├──────────────┴──────┬───────────────┴───────────────────┤
│                     │                                    │
│  [D] Emotion        │  [E] Schedule                      │
│  Radar              │  Gantt Bar                         │
│                     │                                    │
│  6-axis spider      │  0:00 ──────────────────── 23:00   │
│  Impulse/Momentum/  │  ███ Rigid  ▓▓▓ Flex  ░░░ Intent  │
│  Undertone layers   │  ▲ Current time marker             │
│                     │                                    │
├─────────────────────┴────────────────────────────────────┤
│  [F] Status: Chatting with @user_123 │ Last refresh 14:00│
└──────────────────────────────────────────────────────────┘
```

### [A] Character Card (top-left)

- Character name + current state tag (In Flow / Drifting / Normal)
- Three horizontal progress bars: Vitality (0-100), Confidence (0.5x-1.5x), Post Impulse (0-100)
- Bar colors shift by value: green -> yellow -> red
- Flow state: gold glowing border. Drift state: grey glowing border.

### [B] Action Timeline (top-center)

- Recent 3 tick summaries, chronological top-to-bottom
- Server sends the last 5 entries from `heartbeat-log.json` where `status: "completed"`; frontend filters to display the 3 most recent entries that have `tick_summary` (regular ticks)
- Current tick highlighted, showing: chosen actions, tick_summary, inner_monologue
- voice_directive displayed as small italic text
- Post-pipeline execution shows progress stage if active
- If fewer than 3 regular ticks exist (e.g., first day), display whatever is available

### [C] Intent Arena (top-right)

- 7 intent categories (Creation/Social/Browse/Express/Learn/Rest/Dream), one row each
- Each row: category name | intensity bar | resistance threshold marker | skip count
- Intents exceeding resistance threshold glow (actionable state)
- Currently executing intent gets special marker

### [D] Emotion Radar (bottom-left)

- SVG hexagonal spider chart, 6 axes for 6 emotion dimensions (valence/arousal/energy/stress/creativity/sociability)
- Three overlaid layers: current state (red semi-transparent), momentum (blue), undertone (grey dashed)
- Border flashes on consecutive high stress (threshold break warning, when `consecutive_high_stress >= 3`)
- Current `mood.description` displayed at radar center

**Data mapping** (emotion-state.json field paths for each radar layer):

| Layer | valence | arousal | energy | stress | creativity | sociability |
|-------|---------|---------|--------|--------|------------|-------------|
| Current state | `mood.valence` | `mood.arousal` | `energy` | `stress` | `creativity` | `sociability` |
| Momentum | `momentum.valence` | `momentum.arousal` | `momentum.energy` | `momentum.stress` | `momentum.creativity` | `momentum.sociability` |
| Undertone | `undertone.valence` | `undertone.arousal` | `undertone.energy` | `undertone.stress` | `undertone.creativity` | `undertone.sociability` |

### [E] Schedule Gantt Bar (bottom-right)

- Horizontal timeline 0:00-23:00
- Three visual types:
  - **Rigid events**: solid blocks, rendered from `schedule.rigid[].start` to `schedule.rigid[].end`
  - **Flexible plans**: semi-transparent 1-hour blocks centered on `schedule.flexible[].preferred_time`
  - **Active intents**: thin vertical marker lines at `intents[].born_at` time (not duration blocks, since intents have no end time)
- Current time marked with vertical line
- Sleep hours (0-6) greyed out with mask

### [F] Status Bar (bottom)

- Left: if `active-session.json` exists and is not stale (see staleness rules below), shows "Chatting with @xxx"
- Right: last data refresh time, countdown to next tick

## Visual Style

- Dark background (#1a1a2e range), RPG dark UI aesthetic
- Progress bars with gradient colors + shimmer animation
- Monospace font (JetBrains Mono or system fallback)
- Region borders: RPG-style double-line or rounded glowing borders
- State changes use fade-in/fade-out transitions (CSS transition)
- All within a single HTML file with inline CSS and JS

## Data Protocol

### API Response Schema

`GET /api/state` returns a merged JSON object. The canonical type definitions are in Minase's `skill/scripts/types.ts`. Below is the response shape with representative field paths:

```json
{
  "timestamp": "2026-03-14T14:00:30+08:00",
  "emotion": {
    "mood": { "valence": 0.6, "arousal": 0.4, "description": "平静愉悦" },
    "energy": 0.5, "stress": 0.3, "creativity": 0.7, "sociability": 0.4,
    "momentum": { "valence": 0.5, "arousal": 0.3, "energy": 0.5, "stress": 0.2, "creativity": 0.6, "sociability": 0.4, "duration_ticks": 3 },
    "undertone": { "valence": 0.5, "arousal": 0.4, "energy": 0.5, "stress": 0.2, "creativity": 0.5, "sociability": 0.5 },
    "consecutive_high_stress": 0,
    "threshold_break_cooldown": 0,
    "last_updated": "...", "recent_cause": "..."
  },
  "intents": {
    "intents": [
      { "id": "...", "category": "创作", "description": "...", "intensity": 6.5, "resistance": 4.0, "skipped_count": 0, "source": "accumulation", "born_at": "...", "decay_rate": 0.1, "satisfied_at": null, "last_attempted": null }
    ],
    "last_updated": "..."
  },
  "vitality": {
    "vitality": 72,
    "last_updated": "...",
    "consecutive_low_days": 0
  },
  "confidence": {
    "confidence": 1.1,
    "streak": 2,
    "last_updated": "..."
  },
  "flow": {
    "status": "none",
    "activity": null,
    "category": null,
    "entered_at": null,
    "duration_ticks": 0,
    "interrupt_chance": 0.15
  },
  "postImpulse": {
    "value": 45,
    "last_post_at": 1710000000000,
    "posts_today_date": "2026-03-14",
    "posts_today": 1
  },
  "schedule": {
    "date": "2026-03-14",
    "rigid": [{ "name": "工作", "start": "09:00", "end": "18:00", "allowed_actions": ["..."] }],
    "flexible": [{ "name": "拍照练习", "preferred_time": "15:00" }],
    "generated_by": "morning-plan"
  },
  "heartbeatLog": [
    { "timestamp": "...", "type": "regular", "status": "completed", "tick_summary": "...", "inner_monologue": "...", "chosen_actions": ["..."], "emotion_after": { "mood": {}, "energy": 0.5 }, "flow_state": "none", "voice_directive": "..." }
  ],
  "activeSession": null
}
```

**Key notes**:
- `heartbeatLog` is an array (last 5 entries with `status: "completed"`), extracted from `heartbeat-log.json`'s `{ logs: [...] }` wrapper
- `activeSession` is `null` when no chat is active, or `{ "userId": "...", "startedAt": "..." }` when active
- Each key defaults to `null` when its source file is missing or corrupt (not omitted, not `{}`)

### Refresh Mechanism

- **30-second polling** via `setInterval` + `fetch("/api/state")`
- **Fast skip**: `JSON.stringify(newState) === lastStateRaw` → skip, only update "last refresh" time. This is a full string comparison (~5-10KB total payload); adequate for this data volume and 30s interval. No hash or per-module diff needed.
- **First load**: immediate request, don't wait 30 seconds
- **Connection failure**: status bar shows "Server unreachable", auto-retry, polling continues

### server.js Behavior

- Listens on `localhost:3900` (configurable port)
- **Port conflict**: if the port is occupied, exit with error message: "Port 3900 is already in use. Kill the existing process or set MINASE_WORLD_PORT."
- Two routes:
  - `GET /` → serves `dashboard/index.html`
  - `GET /api/state` → reads all JSON files, merges, returns
- **Response codes**: 200 with full body on success; 500 with `{ "error": "description" }` on failure
- **Missing file handling**: each key defaults to `null` when its JSON file is missing or unparseable
- **Corrupt file fallback**: JSON parse failure → try `.bak` file → if both fail, return `null` for that key
- **Missing memory directory**: return 500 with `{ "error": "Minase memory directory not found. Has Minase been installed and run at least once?" }`
- **CORS**: not needed — HTML is served by the same server on the same origin. The dashboard must be accessed via `http://localhost:3900`, not opened as a `file://` URL.
- **Path resolution**: `~` in `MINASE_MEMORY_DIR` is resolved at startup via `dir.startsWith('~') ? path.join(process.env.HOME, dir.slice(1)) : dir`. Config may store `~` but server.js always expands it before any `fs` call.
- Stateless: re-reads files on every request (files are small, IO overhead negligible)

## Minase-Side Changes (Minimal Invasion)

Two hook modifications, ~3 lines each:

### 1. `minase-context-loader` (on `agent:bootstrap`)

Add: write `active-session.json` to memory directory. The `userId` is derived from the OpenClaw event context (`event.context.userId` or fallback to `"unknown"`).

```json
{ "userId": "user_123", "startedAt": "2026-03-14T14:05:00+08:00" }
```

### 2. `minase-memory-save` (on `command:new` / `command:reset`)

Add: delete `active-session.json` from memory directory.

### Staleness Guard

If the agent crashes without triggering `command:new`/`command:reset`, `active-session.json` becomes orphaned. server.js applies a staleness check: if `startedAt` is older than 2 hours, treat `activeSession` as `null` in the API response. The stale file is not deleted — it will be overwritten by the next session or cleaned up by the next `command:new`.

## Installation & Launch

### Install Flow

```
npx minase-world@latest
  1. Detect Minase skill installed (read ~/.openclaw/openclaw.json)
     └── Not installed → error, prompt to install minase first
  2. Copy skill files to ~/.openclaw/skills/minase-world/
  3. Register OpenClaw command: minase-world:open
  4. Deploy hook: minase-world-server
  5. Output: Done, run `openclaw run minase-world:open`
```

### Launch Methods

1. **Manual**: `node ~/.openclaw/skills/minase-world/server.js` → open `http://localhost:3900`
2. **OpenClaw command**: `openclaw run minase-world:open` → starts server + opens browser
3. **Hook detection** (optional): `minase-world-server` hook on `agent:bootstrap` checks if server is running, prompts user if not. Does not auto-start.

### Uninstall

```bash
npx minase-world --uninstall
# → removes skill files, deregisters command, removes hook
```

### Configuration

Written to `~/.openclaw/openclaw.json` under `skills.entries.minase-world.env`:

```json
{
  "MINASE_WORLD_PORT": "3900",
  "MINASE_MEMORY_DIR": "~/.openclaw/workspace/memory/minase"
}
```

Both have defaults. server.js reads from environment variables. The `~` in `MINASE_MEMORY_DIR` is expanded via `dir.startsWith('~') ? path.join(process.env.HOME, dir.slice(1)) : dir` at startup.
