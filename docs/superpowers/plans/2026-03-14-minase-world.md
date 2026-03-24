# Minase World Dashboard Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independent OpenClaw skill that serves a real-time RPG-style status dashboard for observing Minase's internal state via a local HTTP server and single-file HTML frontend.

**Architecture:** A zero-dependency Node.js HTTP server reads Minase's JSON state files from `~/.openclaw/workspace/memory/minase/` and exposes a single `GET /api/state` endpoint. A single `index.html` with inline CSS/JS polls this endpoint every 30 seconds and renders an RPG-style dashboard with 5 panels: character card, action timeline, intent arena, emotion radar, and schedule gantt bar. The project is packaged as an independent OpenClaw skill with its own installer, hook, and package.json.

**Tech Stack:** Node.js built-in `http`/`fs`/`path` modules (zero deps), HTML5/CSS3/inline JS, SVG for radar chart, CSS Grid for layout.

**Spec:** `docs/superpowers/specs/2026-03-14-minase-world-design.md`

---

## File Structure

All paths below are relative to the new project root `~/Documents/Code/minase-world/` unless explicitly noted as MizuSan paths.

```
minase-world/                          # ~/Documents/Code/minase-world/
├── package.json                       # npm package config, bin entry
├── bin/
│   └── cli.js                         # Installer: checks minase, copies files, registers hook+command
├── server.js                          # HTTP server: GET / and GET /api/state
├── dashboard/
│   └── index.html                     # Single-file RPG dashboard (HTML + inline CSS + inline JS)
├── skill/
│   ├── SKILL.md                       # OpenClaw skill entry point
│   └── hooks/
│       └── minase-world-server/
│           ├── HOOK.md                # Hook metadata (agent:bootstrap)
│           └── handler.js             # Check if server running, prompt user
└── tests/
    └── server.test.js                 # Server unit tests (Node.js test runner)
```

Additionally, two files are modified in the **existing MizuSan repo** (`~/Documents/Code/MizuSan/`):
- `skill/hooks/minase-context-loader/handler.js` — add `active-session.json` write
- `skill/hooks/minase-memory-save/handler.js` — add `active-session.json` delete

**Implementation notes for reviewers:**
- server.js already includes: `EADDRINUSE` port conflict handling (exits with spec-matching error message), `STALENESS_MS` 2-hour staleness guard for active-session.json, `resolveHome()` for `~` expansion, `.bak` fallback in `readJsonSafe()`
- Emotion radar data mapping correctly extracts `mood.valence`/`mood.arousal` (nested) + `energy`/`stress`/`creativity`/`sociability` (top-level), matching the spec's data mapping table
- CSS Grid has emotion spanning 2 columns by design — the radar SVG (260x260) + info text needs more width than a single column

---

## Chunk 1: Project Skeleton + Server

### Task 1: Initialize minase-world project

**Files:**
- Create: `minase-world/package.json`
- Create: `minase-world/skill/SKILL.md`

- [ ] **Step 1: Create minase-world directory and package.json**

```bash
mkdir -p ~/Documents/Code/minase-world/bin
mkdir -p ~/Documents/Code/minase-world/dashboard
mkdir -p ~/Documents/Code/minase-world/skill/hooks/minase-world-server
mkdir -p ~/Documents/Code/minase-world/tests
```

Write `minase-world/package.json`:

```json
{
  "name": "minase-world",
  "version": "0.1.0",
  "description": "Real-time RPG dashboard for observing Minase's internal state",
  "main": "server.js",
  "bin": {
    "minase-world": "bin/cli.js"
  },
  "scripts": {
    "start": "node server.js",
    "test": "node --test tests/"
  },
  "files": [
    "bin",
    "server.js",
    "dashboard",
    "skill"
  ],
  "keywords": ["openclaw", "minase", "dashboard"],
  "license": "MIT",
  "engines": {
    "node": ">=18.0.0"
  }
}
```

- [ ] **Step 2: Create SKILL.md**

Write `minase-world/skill/SKILL.md`:

```markdown
---
name: minase-world
description: "Real-time RPG-style dashboard for observing Minase's internal state"
metadata:
  { "openclaw": { "requires": { "skills": ["minase"] } } }
---

# Minase World

A companion dashboard that visualizes Minase's emotions, intents, vitality, schedule, and activity in real time.

## Usage

Start the dashboard server:
\`\`\`
minase-world:open
\`\`\`

Or manually:
\`\`\`
node ~/.openclaw/skills/minase-world/server.js
# Open http://localhost:3900
\`\`\`
```

- [ ] **Step 3: Initialize git repo**

```bash
cd ~/Documents/Code/minase-world
git init
git add package.json skill/SKILL.md
git commit -m "chore: initialize minase-world project skeleton"
```

---

### Task 2: Build server.js

**Files:**
- Create: `minase-world/server.js`
- Test: `minase-world/tests/server.test.js`

- [ ] **Step 1: Write failing test for readJsonSafe helper**

Write `minase-world/tests/server.test.js`:

```js
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// We'll test the server's internal functions by requiring them.
// server.js will export its helpers for testing via module.exports.

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minase-world-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('readJsonSafe', () => {
  it('reads valid JSON file', () => {
    const { readJsonSafe } = require('../server.js');
    const filePath = path.join(tmpDir, 'test.json');
    fs.writeFileSync(filePath, JSON.stringify({ mood: 'happy' }));
    const result = readJsonSafe(filePath, null);
    assert.deepStrictEqual(result, { mood: 'happy' });
  });

  it('returns default when file missing', () => {
    const { readJsonSafe } = require('../server.js');
    const result = readJsonSafe(path.join(tmpDir, 'missing.json'), null);
    assert.strictEqual(result, null);
  });

  it('falls back to .bak when primary is corrupt', () => {
    const { readJsonSafe } = require('../server.js');
    const filePath = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(filePath, 'NOT VALID JSON{{{');
    fs.writeFileSync(filePath + '.bak', JSON.stringify({ backup: true }));
    const result = readJsonSafe(filePath, null);
    assert.deepStrictEqual(result, { backup: true });
  });

  it('returns default when both primary and bak are corrupt', () => {
    const { readJsonSafe } = require('../server.js');
    const filePath = path.join(tmpDir, 'both-corrupt.json');
    fs.writeFileSync(filePath, 'BAD');
    fs.writeFileSync(filePath + '.bak', 'ALSO BAD');
    const result = readJsonSafe(filePath, null);
    assert.strictEqual(result, null);
  });
});

describe('resolveHome', () => {
  it('expands ~ to HOME', () => {
    const { resolveHome } = require('../server.js');
    const result = resolveHome('~/foo/bar');
    assert.strictEqual(result, path.join(process.env.HOME, 'foo', 'bar'));
  });

  it('leaves absolute paths unchanged', () => {
    const { resolveHome } = require('../server.js');
    assert.strictEqual(resolveHome('/usr/local'), '/usr/local');
  });
});

describe('buildStateResponse', () => {
  it('returns all keys with null for missing files', async () => {
    const { buildStateResponse } = require('../server.js');
    const result = buildStateResponse(tmpDir);
    assert.strictEqual(result.emotion, null);
    assert.strictEqual(result.intents, null);
    assert.strictEqual(result.vitality, null);
    assert.strictEqual(result.confidence, null);
    assert.strictEqual(result.flow, null);
    assert.strictEqual(result.postImpulse, null);
    assert.strictEqual(result.schedule, null);
    assert.deepStrictEqual(result.heartbeatLog, []);
    assert.strictEqual(result.activeSession, null);
    assert.ok(result.timestamp);
  });

  it('reads existing state files', () => {
    const { buildStateResponse } = require('../server.js');
    const emotion = { mood: { valence: 0.6, arousal: 0.4, description: '开心' }, energy: 0.7, stress: 0.2, creativity: 0.5, sociability: 0.3, momentum: {}, undertone: {}, consecutive_high_stress: 0, threshold_break_cooldown: 0, last_updated: '2026-03-14', recent_cause: '' };
    fs.writeFileSync(path.join(tmpDir, 'emotion-state.json'), JSON.stringify(emotion));

    const result = buildStateResponse(tmpDir);
    assert.deepStrictEqual(result.emotion, emotion);
  });

  it('truncates heartbeat log to last 5 completed entries', () => {
    const { buildStateResponse } = require('../server.js');
    const logs = Array.from({ length: 10 }, (_, i) => ({
      timestamp: `2026-03-14T${String(8 + i).padStart(2, '0')}:00:00`,
      type: 'regular',
      status: 'completed',
      tick_summary: `tick ${i}`
    }));
    fs.writeFileSync(path.join(tmpDir, 'heartbeat-log.json'), JSON.stringify({ logs, retention_days: 7 }));

    const result = buildStateResponse(tmpDir);
    assert.strictEqual(result.heartbeatLog.length, 5);
    assert.strictEqual(result.heartbeatLog[0].tick_summary, 'tick 5');
  });

  it('treats stale active-session as null (>2 hours old)', () => {
    const { buildStateResponse } = require('../server.js');
    const staleTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(tmpDir, 'active-session.json'), JSON.stringify({ userId: 'stale_user', startedAt: staleTime }));

    const result = buildStateResponse(tmpDir);
    assert.strictEqual(result.activeSession, null);
  });

  it('returns fresh active-session', () => {
    const { buildStateResponse } = require('../server.js');
    const freshTime = new Date().toISOString();
    fs.writeFileSync(path.join(tmpDir, 'active-session.json'), JSON.stringify({ userId: 'user_1', startedAt: freshTime }));

    const result = buildStateResponse(tmpDir);
    assert.deepStrictEqual(result.activeSession, { userId: 'user_1', startedAt: freshTime });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Documents/Code/minase-world
node --test tests/server.test.js
```

Expected: FAIL — `Cannot find module '../server.js'`

- [ ] **Step 3: Implement server.js**

Write `minase-world/server.js`:

```js
// minase-world/server.js
// Minimal HTTP server for Minase World Dashboard.
// Zero external dependencies — uses only Node.js built-ins.

const http = require('http');
const fs = require('fs');
const path = require('path');

// --- Helpers (exported for testing) ---

function resolveHome(dir) {
  return dir.startsWith('~') ? path.join(process.env.HOME, dir.slice(1)) : dir;
}

function readJsonSafe(filePath, defaultValue) {
  for (const suffix of ['', '.bak']) {
    const target = filePath + suffix;
    if (fs.existsSync(target)) {
      try {
        return JSON.parse(fs.readFileSync(target, 'utf8'));
      } catch {
        // Try next
      }
    }
  }
  return defaultValue;
}

const STALENESS_MS = 2 * 60 * 60 * 1000; // 2 hours

function buildStateResponse(memoryDir) {
  const read = (filename, def) => readJsonSafe(path.join(memoryDir, filename), def);

  // Heartbeat log: extract last 5 completed entries from wrapper
  const rawLog = read('heartbeat-log.json', null);
  const allLogs = (rawLog && Array.isArray(rawLog.logs)) ? rawLog.logs : [];
  const completedLogs = allLogs.filter(l => l.status === 'completed');
  const heartbeatLog = completedLogs.slice(-5);

  // Active session with staleness guard
  const rawSession = read('active-session.json', null);
  let activeSession = null;
  if (rawSession && rawSession.startedAt) {
    const age = Date.now() - new Date(rawSession.startedAt).getTime();
    if (age < STALENESS_MS) {
      activeSession = rawSession;
    }
  }

  return {
    timestamp: new Date().toISOString(),
    emotion: read('emotion-state.json', null),
    intents: read('intent-pool.json', null),
    vitality: read('vitality-state.json', null),
    confidence: read('confidence-state.json', null),
    flow: read('flow-state.json', null),
    postImpulse: read('post-impulse.json', null),
    schedule: read('schedule-today.json', null),
    heartbeatLog,
    activeSession,
  };
}

// --- HTTP Server ---

const DEFAULT_PORT = 3900;
const DEFAULT_MEMORY_DIR = '~/.openclaw/workspace/memory/minase';

function createServer(options = {}) {
  const port = options.port || parseInt(process.env.MINASE_WORLD_PORT, 10) || DEFAULT_PORT;
  const memoryDir = resolveHome(options.memoryDir || process.env.MINASE_MEMORY_DIR || DEFAULT_MEMORY_DIR);
  const dashboardPath = options.dashboardPath || path.join(__dirname, 'dashboard', 'index.html');

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      // Serve dashboard
      try {
        const html = fs.readFileSync(dashboardPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Dashboard file not found' }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/api/state') {
      // Check memory directory exists
      if (!fs.existsSync(memoryDir)) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Minase memory directory not found. Has Minase been installed and run at least once?' }));
        return;
      }

      try {
        const state = buildStateResponse(memoryDir);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return { server, port, memoryDir };
}

// --- Main ---

if (require.main === module) {
  const { server, port, memoryDir } = createServer();

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Kill the existing process or set MINASE_WORLD_PORT.`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`Minase World Dashboard: http://localhost:${port}`);
    console.log(`Reading state from: ${memoryDir}`);
  });
}

// Export for testing
module.exports = { readJsonSafe, resolveHome, buildStateResponse, createServer };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/Documents/Code/minase-world
node --test tests/server.test.js
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/Code/minase-world
git add server.js tests/server.test.js
git commit -m "feat: add HTTP server with state aggregation and .bak fallback"
```

---

### Task 3: Add HTTP integration tests

**Files:**
- Modify: `minase-world/tests/server.test.js`

- [ ] **Step 1: Write failing HTTP integration tests**

Append to `minase-world/tests/server.test.js`:

```js
describe('HTTP server', () => {
  let server;
  let port;
  let baseUrl;

  beforeEach(async () => {
    port = 39000 + Math.floor(Math.random() * 1000);
    const result = require('../server.js').createServer({
      port,
      memoryDir: tmpDir,
      dashboardPath: path.join(__dirname, '..', 'dashboard', 'index.html'),
    });
    server = result.server;
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('GET /api/state returns 200 with merged state', async () => {
    const res = await fetch(`${baseUrl}/api/state`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.timestamp);
    assert.strictEqual(body.emotion, null);
  });

  it('GET /api/state returns 500 when memory dir missing', async () => {
    server.close();
    const result = require('../server.js').createServer({
      port: port + 1,
      memoryDir: '/nonexistent/path',
    });
    server = result.server;
    await new Promise(resolve => server.listen(port + 1, '127.0.0.1', resolve));

    const res = await fetch(`http://127.0.0.1:${port + 1}/api/state`);
    assert.strictEqual(res.status, 500);
    const body = await res.json();
    assert.ok(body.error.includes('memory directory not found'));
  });

  it('GET / returns dashboard HTML', async () => {
    // Create a minimal dashboard for testing
    const dashDir = path.join(tmpDir, 'dashboard');
    fs.mkdirSync(dashDir, { recursive: true });
    fs.writeFileSync(path.join(dashDir, 'index.html'), '<html><body>test</body></html>');

    server.close();
    const result = require('../server.js').createServer({
      port: port + 2,
      memoryDir: tmpDir,
      dashboardPath: path.join(dashDir, 'index.html'),
    });
    server = result.server;
    await new Promise(resolve => server.listen(port + 2, '127.0.0.1', resolve));

    const res = await fetch(`http://127.0.0.1:${port + 2}/`);
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('<body>test</body>'));
  });

  it('GET /unknown returns 404', async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    assert.strictEqual(res.status, 404);
  });
});

describe('port conflict', () => {
  it('emits EADDRINUSE error when port is taken', async () => {
    // First server already listening from beforeEach in HTTP server suite
    const result2 = require('../server.js').createServer({
      port,
      memoryDir: tmpDir,
    });
    const err = await new Promise((resolve) => {
      result2.server.on('error', resolve);
      result2.server.listen(port, '127.0.0.1');
    });
    assert.strictEqual(err.code, 'EADDRINUSE');
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd ~/Documents/Code/minase-world
node --test tests/server.test.js
```

Expected: All PASS.

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/Code/minase-world
git add tests/server.test.js
git commit -m "test: add HTTP integration tests for server endpoints"
```

---

## Chunk 2: Dashboard Frontend

### Task 4: Build dashboard HTML — layout shell + polling

**Files:**
- Create: `minase-world/dashboard/index.html`

This is the largest task. The single-file dashboard contains all HTML, CSS, and JS inline. We break it into sub-steps: layout shell first, then each panel.

- [ ] **Step 1: Write dashboard HTML shell with CSS Grid layout and polling logic**

Write `minase-world/dashboard/index.html`:

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Minase World Dashboard</title>
<style>
/* === RESET & BASE === */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; }
body {
  background: #1a1a2e;
  color: #e0e0e0;
  font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 13px;
  line-height: 1.5;
}

/* === GRID LAYOUT === */
.dashboard {
  display: grid;
  grid-template-columns: 240px 1fr 280px;
  grid-template-rows: 40px 1fr 1fr 32px;
  grid-template-areas:
    "header header header"
    "charcard timeline intent"
    "emotion emotion schedule"
    "statusbar statusbar statusbar";
  height: 100vh;
  gap: 1px;
  background: #2a2a4a;
}

/* === HEADER === */
.header {
  grid-area: header;
  background: #16213e;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  border-bottom: 1px solid #3a3a6a;
}
.header-title { font-size: 15px; font-weight: bold; color: #f0c040; }
.header-tick { font-size: 12px; color: #8888aa; }

/* === PANELS === */
.panel {
  background: #16213e;
  padding: 12px;
  overflow-y: auto;
  position: relative;
  border: 1px solid #2a2a5a;
  transition: border-color 0.3s ease;
}
.panel-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: #6a6a9a;
  margin-bottom: 8px;
  border-bottom: 1px solid #2a2a4a;
  padding-bottom: 4px;
}

.charcard { grid-area: charcard; }
.timeline { grid-area: timeline; }
.intent   { grid-area: intent; }
.emotion  { grid-area: emotion; }
.schedule { grid-area: schedule; }

/* === STATUS BAR === */
.statusbar {
  grid-area: statusbar;
  background: #0f0f23;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  font-size: 11px;
  color: #6a6a9a;
}
.statusbar-chat { color: #40c0f0; }
.statusbar-error { color: #f04040; }

/* === PROGRESS BAR === */
.bar-container {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
}
.bar-label { width: 70px; font-size: 11px; color: #8888aa; }
.bar-track {
  flex: 1;
  height: 14px;
  background: #0f0f23;
  border-radius: 3px;
  overflow: hidden;
  position: relative;
}
.bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.5s ease, background 0.5s ease;
  position: relative;
}
.bar-fill::after {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.15) 50%, transparent 100%);
  animation: shimmer 2s infinite;
}
@keyframes shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
.bar-value { width: 40px; text-align: right; font-size: 11px; }

/* === FLOW STATE GLOW === */
.glow-flow { border-color: #f0c040; box-shadow: 0 0 12px rgba(240, 192, 64, 0.3); }
.glow-drift { border-color: #666680; box-shadow: 0 0 8px rgba(102, 102, 128, 0.3); }

/* === STATE TAG === */
.state-tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: bold;
  margin-left: 8px;
}
.state-tag-flow { background: #3a2a10; color: #f0c040; border: 1px solid #f0c040; }
.state-tag-drift { background: #2a2a2a; color: #888; border: 1px solid #666; }
.state-tag-normal { background: #1a2a1a; color: #40c060; border: 1px solid #40c060; }

/* === INTENT ROW === */
.intent-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0;
  padding: 3px 6px;
  border-radius: 3px;
  transition: background 0.3s ease, box-shadow 0.3s ease;
}
.intent-row.actionable {
  background: rgba(64, 192, 96, 0.1);
  box-shadow: 0 0 6px rgba(64, 192, 96, 0.2);
}
.intent-category { width: 36px; font-size: 11px; text-align: center; }
.intent-bar-track {
  flex: 1;
  height: 10px;
  background: #0f0f23;
  border-radius: 2px;
  position: relative;
  overflow: visible;
}
.intent-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.5s ease;
}
.intent-resistance-marker {
  position: absolute;
  top: -2px;
  height: 14px;
  width: 2px;
  background: #f04040;
  transition: left 0.5s ease;
}
.intent-skip { font-size: 10px; color: #aa4444; width: 24px; text-align: center; }

/* === TICK ENTRY === */
.tick-entry {
  padding: 8px;
  margin: 4px 0;
  background: #0f0f23;
  border-radius: 4px;
  border-left: 3px solid #2a2a5a;
  transition: border-color 0.3s;
}
.tick-entry.current { border-left-color: #40c0f0; }
.tick-time { font-size: 10px; color: #6a6a9a; }
.tick-summary { font-size: 12px; margin: 4px 0; }
.tick-monologue { font-size: 11px; color: #9090b0; font-style: italic; }
.tick-voice { font-size: 10px; color: #6060a0; font-style: italic; }
.tick-actions { font-size: 10px; color: #8888aa; margin-top: 2px; }

/* === EMOTION RADAR === */
.emotion-section {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 100%;
}
.radar-container { width: 260px; height: 260px; flex-shrink: 0; }
.radar-container svg { width: 100%; height: 100%; }
.emotion-info { flex: 1; }
.emotion-mood { font-size: 16px; color: #f0c040; margin-bottom: 8px; }
.emotion-cause { font-size: 11px; color: #8888aa; }
.stress-warning {
  color: #f04040;
  font-weight: bold;
  animation: pulse 1s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* === SCHEDULE GANTT === */
.gantt-container { position: relative; height: 100%; }
.gantt-timeline {
  position: relative;
  height: 80px;
  background: #0f0f23;
  border-radius: 4px;
  margin-top: 8px;
  overflow: hidden;
}
.gantt-block {
  position: absolute;
  height: 20px;
  border-radius: 2px;
  font-size: 9px;
  display: flex;
  align-items: center;
  padding: 0 4px;
  overflow: hidden;
  white-space: nowrap;
}
.gantt-rigid { background: #2a4a6a; color: #80b0d0; top: 4px; }
.gantt-flex { background: rgba(64, 192, 96, 0.3); color: #80d080; top: 28px; }
.gantt-intent { top: 52px; width: 2px !important; background: #a060c0; }
.gantt-now {
  position: absolute;
  top: 0; bottom: 0;
  width: 2px;
  background: #f0c040;
  z-index: 10;
}
.gantt-sleep {
  position: absolute;
  top: 0; bottom: 0;
  background: rgba(0, 0, 0, 0.4);
}
.gantt-hours {
  display: flex;
  justify-content: space-between;
  font-size: 9px;
  color: #4a4a6a;
  margin-top: 4px;
}
.gantt-legend {
  display: flex;
  gap: 12px;
  font-size: 10px;
  color: #6a6a9a;
  margin-top: 4px;
}
.legend-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  margin-right: 4px;
  vertical-align: middle;
}

/* === SCROLLBAR === */
::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #3a3a6a; border-radius: 2px; }
</style>
</head>
<body>

<div class="dashboard">
  <!-- Header -->
  <div class="header">
    <span class="header-title">&#9830; Minase ─ World Dashboard</span>
    <span class="header-tick" id="headerTick">--:-- tick #-</span>
  </div>

  <!-- [A] Character Card -->
  <div class="panel charcard" id="charcard">
    <div class="panel-title">Character</div>
    <div id="charName" style="font-size:15px;font-weight:bold;">水瀬 <span id="stateTag" class="state-tag state-tag-normal">Normal</span></div>
    <div id="flowInfo" style="font-size:10px;color:#6a6a9a;margin:4px 0;"></div>
    <div class="bar-container"><span class="bar-label">Vitality</span><div class="bar-track"><div class="bar-fill" id="barVitality" style="width:0%;background:#40c060;"></div></div><span class="bar-value" id="valVitality">--</span></div>
    <div class="bar-container"><span class="bar-label">Confidence</span><div class="bar-track"><div class="bar-fill" id="barConfidence" style="width:0%;background:#4080f0;"></div></div><span class="bar-value" id="valConfidence">--</span></div>
    <div class="bar-container"><span class="bar-label">Post Impulse</span><div class="bar-track"><div class="bar-fill" id="barPostImpulse" style="width:0%;background:#c060a0;"></div></div><span class="bar-value" id="valPostImpulse">--</span></div>
    <div id="postInfo" style="font-size:10px;color:#6a6a9a;margin-top:4px;"></div>
  </div>

  <!-- [B] Action Timeline -->
  <div class="panel timeline" id="timeline">
    <div class="panel-title">Action Timeline</div>
    <div id="tickEntries"></div>
  </div>

  <!-- [C] Intent Arena -->
  <div class="panel intent" id="intentPanel">
    <div class="panel-title">Intent Arena</div>
    <div id="intentRows"></div>
  </div>

  <!-- [D] Emotion Radar -->
  <div class="panel emotion" id="emotionPanel">
    <div class="panel-title">Emotion Radar</div>
    <div class="emotion-section">
      <div class="radar-container">
        <svg id="radarSvg" viewBox="0 0 260 260"></svg>
      </div>
      <div class="emotion-info">
        <div class="emotion-mood" id="moodDesc">--</div>
        <div class="emotion-cause" id="moodCause"></div>
        <div id="stressWarning" style="display:none;" class="stress-warning">&#9888; THRESHOLD BREAK WARNING</div>
        <div id="radarLegend" style="margin-top:12px;font-size:10px;color:#6a6a9a;">
          <div><span style="color:#ff6060;">&#9632;</span> Current &nbsp; <span style="color:#4080ff;">&#9632;</span> Momentum &nbsp; <span style="color:#666;">&#9632;</span> Undertone</div>
        </div>
      </div>
    </div>
  </div>

  <!-- [E] Schedule Gantt -->
  <div class="panel schedule" id="schedulePanel">
    <div class="panel-title">Schedule</div>
    <div class="gantt-container">
      <div class="gantt-legend">
        <span><span class="legend-dot" style="background:#2a4a6a;"></span>Rigid</span>
        <span><span class="legend-dot" style="background:rgba(64,192,96,0.3);"></span>Flex</span>
        <span><span class="legend-dot" style="background:#a060c0;"></span>Intent</span>
      </div>
      <div class="gantt-timeline" id="ganttTimeline"></div>
      <div class="gantt-hours" id="ganttHours"></div>
    </div>
  </div>

  <!-- [F] Status Bar -->
  <div class="statusbar">
    <span id="statusChat"></span>
    <span id="statusRefresh">Starting...</span>
  </div>
</div>

<script>
// === STATE & POLLING ===
let lastStateRaw = null;
const POLL_INTERVAL = 30000;

async function poll() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Server error' }));
      showError(err.error);
      return;
    }
    const data = await res.json();
    const raw = JSON.stringify(data);
    document.getElementById('statusRefresh').textContent = 'Last refresh: ' + new Date().toLocaleTimeString();
    document.getElementById('statusRefresh').className = '';
    if (raw !== lastStateRaw) {
      lastStateRaw = raw;
      render(data);
    }
  } catch (e) {
    showError('Server unreachable');
  }
}

function showError(msg) {
  const el = document.getElementById('statusRefresh');
  el.textContent = msg;
  el.className = 'statusbar-error';
}

// === COLOR HELPERS ===
function barColor(ratio) {
  if (ratio > 0.6) return '#40c060';
  if (ratio > 0.3) return '#c0c040';
  return '#c04040';
}

// === RENDER ===
function render(data) {
  renderHeader(data);
  renderCharCard(data);
  renderTimeline(data);
  renderIntentArena(data);
  renderEmotionRadar(data);
  renderScheduleGantt(data);
  renderStatusBar(data);
}

// --- Header ---
function renderHeader(data) {
  const logs = data.heartbeatLog || [];
  const latest = logs[logs.length - 1];
  const now = new Date();
  const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const tickNum = logs.length > 0 ? `tick #${now.getHours() - 7}` : 'tick #-';
  document.getElementById('headerTick').textContent = `${timeStr} ${tickNum}`;
}

// --- [A] Character Card ---
function renderCharCard(data) {
  const panel = document.getElementById('charcard');
  const flow = data.flow;

  // Flow state glow
  panel.classList.remove('glow-flow', 'glow-drift');
  const tag = document.getElementById('stateTag');
  const flowInfo = document.getElementById('flowInfo');

  if (flow && flow.status === 'flow') {
    panel.classList.add('glow-flow');
    tag.className = 'state-tag state-tag-flow';
    tag.textContent = 'In Flow';
    flowInfo.textContent = `${flow.activity || ''} (${flow.duration_ticks} ticks)`;
  } else if (flow && flow.status === 'drift') {
    panel.classList.add('glow-drift');
    tag.className = 'state-tag state-tag-drift';
    tag.textContent = 'Drifting';
    flowInfo.textContent = `${flow.duration_ticks} ticks`;
  } else {
    tag.className = 'state-tag state-tag-normal';
    tag.textContent = 'Normal';
    flowInfo.textContent = '';
  }

  // Vitality
  const vit = data.vitality ? data.vitality.vitality : 0;
  document.getElementById('barVitality').style.width = `${vit}%`;
  document.getElementById('barVitality').style.background = barColor(vit / 100);
  document.getElementById('valVitality').textContent = Math.round(vit);

  // Confidence (0.5-1.5 → 0-100%)
  const conf = data.confidence ? data.confidence.confidence : 1.0;
  const confPct = ((conf - 0.5) / 1.0) * 100;
  document.getElementById('barConfidence').style.width = `${confPct}%`;
  document.getElementById('barConfidence').style.background = barColor(confPct / 100);
  document.getElementById('valConfidence').textContent = conf.toFixed(2) + 'x';

  // Post Impulse
  const impulse = data.postImpulse ? data.postImpulse.value : 0;
  document.getElementById('barPostImpulse').style.width = `${impulse}%`;
  document.getElementById('barPostImpulse').style.background = barColor(impulse / 100);
  document.getElementById('valPostImpulse').textContent = Math.round(impulse);

  // Post info
  if (data.postImpulse) {
    document.getElementById('postInfo').textContent = `Today: ${data.postImpulse.posts_today}/3 posts`;
  }
}

// --- [B] Action Timeline ---
function renderTimeline(data) {
  const container = document.getElementById('tickEntries');
  const logs = (data.heartbeatLog || [])
    .filter(l => l.tick_summary)
    .slice(-3);

  if (logs.length === 0) {
    container.innerHTML = '<div style="color:#4a4a6a;font-style:italic;">No tick data yet</div>';
    return;
  }

  container.innerHTML = logs.map((log, i) => {
    const isCurrent = i === logs.length - 1;
    const time = log.timestamp ? new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '--:--';
    const actions = (log.chosen_actions || []).join(', ');
    return `
      <div class="tick-entry ${isCurrent ? 'current' : ''}">
        <div class="tick-time">${time} ${log.flow_state && log.flow_state !== 'none' ? '(' + log.flow_state + ')' : ''}</div>
        <div class="tick-summary">${escHtml(log.tick_summary || '')}</div>
        ${log.inner_monologue ? `<div class="tick-monologue">"${escHtml(log.inner_monologue)}"</div>` : ''}
        ${log.voice_directive ? `<div class="tick-voice">${escHtml(log.voice_directive)}</div>` : ''}
        ${actions ? `<div class="tick-actions">Actions: ${escHtml(actions)}</div>` : ''}
      </div>
    `;
  }).join('');
}

// --- [C] Intent Arena ---
function renderIntentArena(data) {
  const container = document.getElementById('intentRows');
  if (!data.intents || !data.intents.intents) {
    container.innerHTML = '<div style="color:#4a4a6a;font-style:italic;">No intent data</div>';
    return;
  }

  const categories = ['创作', '社交', '窥屏', '表达', '学习', '休息', '梦想'];
  const categoryColors = { '创作': '#f0c040', '社交': '#40c0f0', '窥屏': '#a060c0', '表达': '#f06060', '学习': '#40c060', '休息': '#6080a0', '梦想': '#f090c0' };
  const intents = data.intents.intents;

  container.innerHTML = categories.map(cat => {
    const matching = intents.filter(i => i.category === cat);
    const maxIntensity = matching.reduce((max, i) => Math.max(max, i.intensity || 0), 0);
    const maxResistance = matching.reduce((max, i) => Math.max(max, i.resistance || 0), 0);
    const totalSkipped = matching.reduce((sum, i) => sum + (i.skipped_count || 0), 0);
    const actionable = maxIntensity > maxResistance;
    const intensityPct = (maxIntensity / 10) * 100;
    const resistancePct = (maxResistance / 10) * 100;

    return `
      <div class="intent-row ${actionable ? 'actionable' : ''}">
        <span class="intent-category" style="color:${categoryColors[cat]}">${cat}</span>
        <div class="intent-bar-track">
          <div class="intent-bar-fill" style="width:${intensityPct}%;background:${categoryColors[cat]};opacity:0.7;"></div>
          <div class="intent-resistance-marker" style="left:${resistancePct}%;"></div>
        </div>
        <span class="intent-skip">${totalSkipped > 0 ? '×' + totalSkipped : ''}</span>
      </div>
    `;
  }).join('');
}

// --- [D] Emotion Radar ---
function renderEmotionRadar(data) {
  if (!data.emotion) {
    document.getElementById('moodDesc').textContent = 'No emotion data';
    return;
  }
  const e = data.emotion;

  // Mood description
  document.getElementById('moodDesc').textContent = (e.mood && e.mood.description) || '--';
  document.getElementById('moodCause').textContent = e.recent_cause || '';

  // Stress warning
  const stressWarn = document.getElementById('stressWarning');
  stressWarn.style.display = (e.consecutive_high_stress >= 3) ? 'block' : 'none';

  // Draw SVG radar
  const dims = ['valence', 'arousal', 'energy', 'stress', 'creativity', 'sociability'];
  const labels = ['Valence', 'Arousal', 'Energy', 'Stress', 'Creativity', 'Social'];
  const cx = 130, cy = 130, maxR = 100;
  const angles = dims.map((_, i) => (Math.PI * 2 * i / dims.length) - Math.PI / 2);

  function getValues(layer) {
    return dims.map(d => Math.max(0, Math.min(1, (layer && layer[d] != null) ? layer[d] : 0)));
  }

  // Extract layers
  const current = {
    valence: e.mood ? e.mood.valence : 0,
    arousal: e.mood ? e.mood.arousal : 0,
    energy: e.energy || 0,
    stress: e.stress || 0,
    creativity: e.creativity || 0,
    sociability: e.sociability || 0,
  };
  const momentum = e.momentum || {};
  const undertone = e.undertone || {};

  function polygonPoints(values) {
    return values.map((v, i) => {
      const r = v * maxR;
      return `${cx + r * Math.cos(angles[i])},${cy + r * Math.sin(angles[i])}`;
    }).join(' ');
  }

  // Grid lines
  let svg = '';
  for (let ring = 0.25; ring <= 1; ring += 0.25) {
    const pts = angles.map(a => `${cx + maxR * ring * Math.cos(a)},${cy + maxR * ring * Math.sin(a)}`).join(' ');
    svg += `<polygon points="${pts}" fill="none" stroke="#2a2a5a" stroke-width="0.5"/>`;
  }
  // Axes
  angles.forEach((a, i) => {
    svg += `<line x1="${cx}" y1="${cy}" x2="${cx + maxR * Math.cos(a)}" y2="${cy + maxR * Math.sin(a)}" stroke="#2a2a5a" stroke-width="0.5"/>`;
    const lx = cx + (maxR + 16) * Math.cos(a);
    const ly = cy + (maxR + 16) * Math.sin(a);
    svg += `<text x="${lx}" y="${ly}" fill="#6a6a9a" font-size="9" text-anchor="middle" dominant-baseline="middle">${labels[i]}</text>`;
  });
  // Undertone layer (grey dashed)
  svg += `<polygon points="${polygonPoints(getValues(undertone))}" fill="rgba(100,100,128,0.1)" stroke="#666" stroke-width="1" stroke-dasharray="4,3"/>`;
  // Momentum layer (blue)
  svg += `<polygon points="${polygonPoints(getValues(momentum))}" fill="rgba(64,128,255,0.15)" stroke="#4080ff" stroke-width="1.5"/>`;
  // Current layer (red)
  svg += `<polygon points="${polygonPoints(getValues(current))}" fill="rgba(255,96,96,0.2)" stroke="#ff6060" stroke-width="2"/>`;

  document.getElementById('radarSvg').innerHTML = svg;
}

// --- [E] Schedule Gantt ---
function renderScheduleGantt(data) {
  const timeline = document.getElementById('ganttTimeline');
  const hoursRow = document.getElementById('ganttHours');

  // Hours labels
  hoursRow.innerHTML = Array.from({ length: 24 }, (_, i) => `<span>${i}</span>`).join('');

  function timeToFraction(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return (h + (m || 0) / 60) / 24;
  }

  let html = '';

  // Sleep mask (0-6)
  html += `<div class="gantt-sleep" style="left:0%;width:${(6/24)*100}%;"></div>`;

  // Rigid events
  if (data.schedule && data.schedule.rigid) {
    data.schedule.rigid.forEach(ev => {
      const left = timeToFraction(ev.start) * 100;
      const width = (timeToFraction(ev.end) - timeToFraction(ev.start)) * 100;
      html += `<div class="gantt-block gantt-rigid" style="left:${left}%;width:${width}%;" title="${escAttr(ev.name)}">${escHtml(ev.name)}</div>`;
    });
  }

  // Flexible events (1h blocks centered on preferred_time)
  if (data.schedule && data.schedule.flexible) {
    data.schedule.flexible.forEach(ev => {
      const center = timeToFraction(ev.preferred_time);
      const left = Math.max(0, (center - 0.5/24)) * 100;
      const width = (1/24) * 100;
      html += `<div class="gantt-block gantt-flex" style="left:${left}%;width:${width}%;" title="${escAttr(ev.name)}">${escHtml(ev.name)}</div>`;
    });
  }

  // Intent markers
  if (data.intents && data.intents.intents) {
    data.intents.intents.forEach(intent => {
      if (!intent.born_at) return;
      const d = new Date(intent.born_at);
      const frac = (d.getHours() + d.getMinutes() / 60) / 24;
      html += `<div class="gantt-block gantt-intent" style="left:${frac * 100}%;" title="${escAttr(intent.category + ': ' + intent.description)}"></div>`;
    });
  }

  // Current time marker
  const now = new Date();
  const nowFrac = (now.getHours() + now.getMinutes() / 60) / 24;
  html += `<div class="gantt-now" style="left:${nowFrac * 100}%;"></div>`;

  timeline.innerHTML = html;
}

// --- [F] Status Bar ---
function renderStatusBar(data) {
  const chatEl = document.getElementById('statusChat');
  if (data.activeSession) {
    chatEl.className = 'statusbar-chat';
    chatEl.textContent = `\uD83D\uDCAC Chatting with @${data.activeSession.userId}`;
  } else {
    chatEl.className = '';
    chatEl.textContent = '';
  }
}

// === UTILS ===
function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function escAttr(s) { return s.replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

// === START ===
poll();
setInterval(poll, POLL_INTERVAL);
</script>
</body>
</html>
```

- [ ] **Step 2: Manually test by starting server with mock data**

```bash
cd ~/Documents/Code/minase-world

# Create a temporary mock memory dir
mkdir -p /tmp/minase-mock
echo '{"mood":{"valence":0.7,"arousal":0.4,"description":"今天心情不错"},"energy":0.6,"stress":0.2,"creativity":0.8,"sociability":0.5,"momentum":{"valence":0.5,"arousal":0.3,"energy":0.5,"stress":0.2,"creativity":0.6,"sociability":0.4},"undertone":{"valence":0.5,"arousal":0.4,"energy":0.5,"stress":0.2,"creativity":0.5,"sociability":0.5},"consecutive_high_stress":0,"threshold_break_cooldown":0,"last_updated":"2026-03-14T14:00:00","recent_cause":"刚完成一组拍摄"}' > /tmp/minase-mock/emotion-state.json
echo '{"intents":[{"id":"1","category":"创作","description":"想画画","intensity":7.5,"resistance":4.0,"skipped_count":0,"source":"accumulation","born_at":"2026-03-14T10:00:00","decay_rate":0.1,"satisfied_at":null,"last_attempted":null},{"id":"2","category":"社交","description":"想和粉丝互动","intensity":3.0,"resistance":5.0,"skipped_count":2,"source":"accumulation","born_at":"2026-03-14T09:00:00","decay_rate":0.1,"satisfied_at":null,"last_attempted":null}],"last_updated":"2026-03-14T14:00:00"}' > /tmp/minase-mock/intent-pool.json
echo '{"vitality":72,"last_updated":"2026-03-14T14:00:00","consecutive_low_days":0}' > /tmp/minase-mock/vitality-state.json
echo '{"confidence":1.15,"streak":3,"last_updated":"2026-03-14T14:00:00"}' > /tmp/minase-mock/confidence-state.json
echo '{"status":"flow","activity":"拍照","category":"创作","entered_at":"2026-03-14T13:00:00","duration_ticks":2,"interrupt_chance":0.2}' > /tmp/minase-mock/flow-state.json
echo '{"value":55,"last_post_at":1710400000000,"posts_today_date":"2026-03-14","posts_today":1}' > /tmp/minase-mock/post-impulse.json
echo '{"date":"2026-03-14","rigid":[{"name":"工作","start":"09:00","end":"18:00","allowed_actions":["创作","学习"]}],"flexible":[{"name":"拍照练习","preferred_time":"15:00"}],"generated_by":"morning-plan"}' > /tmp/minase-mock/schedule-today.json
echo '{"logs":[{"timestamp":"2026-03-14T12:00:00","type":"regular","status":"completed","tick_summary":"浏览了一些灵感图，选了几张参考照","inner_monologue":"最近拍的照片越来越有感觉了呢","chosen_actions":["browse-inspiration"],"flow_state":"none","voice_directive":"轻松闲聊"},{"timestamp":"2026-03-14T13:00:00","type":"regular","status":"completed","tick_summary":"进入心流状态，沉浸在拍照中","inner_monologue":"这个光线...完美","chosen_actions":["post-pipeline"],"flow_state":"flow","voice_directive":"专注简洁"},{"timestamp":"2026-03-14T14:00:00","type":"regular","status":"completed","tick_summary":"继续拍摄，换了一组角度","inner_monologue":"这套角色的衣服好好看！","chosen_actions":["continue-creation"],"flow_state":"flow","voice_directive":"专注简洁"}],"retention_days":7}' > /tmp/minase-mock/heartbeat-log.json

# Start server with mock data
MINASE_MEMORY_DIR=/tmp/minase-mock node server.js
```

Open `http://localhost:3900` in browser and verify:
- All 5 panels render with mock data
- Character card shows "In Flow" with gold glow
- Emotion radar shows 3-layer spider chart
- Schedule shows rigid work block + flexible block
- Intent arena shows 创作 exceeding resistance (glowing)

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/Code/minase-world
git add dashboard/index.html
git commit -m "feat: add RPG-style dashboard with all 5 panels and 30s polling"
```

---

## Chunk 3: Installer, Hook, and Minase Integration

### Task 5: Create the installer (bin/cli.js)

**Files:**
- Create: `minase-world/bin/cli.js`

- [ ] **Step 1: Write cli.js**

Write `minase-world/bin/cli.js`:

```js
#!/usr/bin/env node

// minase-world installer
// Installs the dashboard skill into OpenClaw.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const HOME = process.env.HOME;
const OPENCLAW_CONFIG = path.join(HOME, '.openclaw', 'openclaw.json');
const SKILL_DEST = path.join(HOME, '.openclaw', 'skills', 'minase-world');
const HOOK_DEST = path.join(HOME, '.openclaw', 'hooks', 'minase-world-server');

function log(msg) { console.log(`  ${msg}`); }
function logOk(msg) { console.log(`  \u2705 ${msg}`); }
function logErr(msg) { console.error(`  \u274c ${msg}`); }

function readConfig() {
  if (!fs.existsSync(OPENCLAW_CONFIG)) return null;
  return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));
}

function writeConfig(config) {
  fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify(config, null, 2));
}

// --- Uninstall ---
if (process.argv.includes('--uninstall')) {
  log('Uninstalling minase-world...');

  if (fs.existsSync(SKILL_DEST)) {
    fs.rmSync(SKILL_DEST, { recursive: true });
    logOk('Removed skill files');
  }
  if (fs.existsSync(HOOK_DEST)) {
    fs.rmSync(HOOK_DEST, { recursive: true });
    logOk('Removed hook');
  }

  const config = readConfig();
  if (config && config.skills && config.skills.entries && config.skills.entries['minase-world']) {
    delete config.skills.entries['minase-world'];
    writeConfig(config);
    logOk('Removed from OpenClaw config');
  }

  console.log('\n  minase-world uninstalled.\n');
  process.exit(0);
}

// --- Install ---
console.log('\n  Installing minase-world dashboard...\n');

// Step 1: Check OpenClaw
const config = readConfig();
if (!config) {
  logErr('OpenClaw not found. Install OpenClaw first.');
  process.exit(1);
}

// Step 2: Check Minase skill
const hasMinase = config.skills && config.skills.entries && config.skills.entries.minase;
if (!hasMinase) {
  logErr('Minase skill not found. Install Minase first: npx minase@latest');
  process.exit(1);
}
logOk('Minase skill detected');

// Step 3: Copy skill files
const srcDir = path.join(__dirname, '..');
fs.mkdirSync(SKILL_DEST, { recursive: true });

const filesToCopy = [
  { src: 'server.js', dest: 'server.js' },
  { src: 'skill/SKILL.md', dest: 'SKILL.md' },
];

// Copy dashboard
const dashDest = path.join(SKILL_DEST, 'dashboard');
fs.mkdirSync(dashDest, { recursive: true });
fs.copyFileSync(path.join(srcDir, 'dashboard', 'index.html'), path.join(dashDest, 'index.html'));

for (const f of filesToCopy) {
  fs.copyFileSync(path.join(srcDir, f.src), path.join(SKILL_DEST, f.dest));
}
logOk('Skill files copied');

// Step 4: Deploy hook
const hookSrc = path.join(srcDir, 'skill', 'hooks', 'minase-world-server');
if (fs.existsSync(hookSrc)) {
  fs.mkdirSync(HOOK_DEST, { recursive: true });
  for (const file of fs.readdirSync(hookSrc)) {
    fs.copyFileSync(path.join(hookSrc, file), path.join(HOOK_DEST, file));
  }
  logOk('Hook deployed');
}

// Step 5: Register in config
if (!config.skills) config.skills = {};
if (!config.skills.entries) config.skills.entries = {};
config.skills.entries['minase-world'] = {
  enabled: true,
  path: SKILL_DEST,
  env: {
    MINASE_WORLD_PORT: '3900',
    MINASE_MEMORY_DIR: '~/.openclaw/workspace/memory/minase',
  },
};
writeConfig(config);
logOk('Registered in OpenClaw config');

console.log('\n  Installation complete!');
console.log('  Start the dashboard:\n');
console.log('    node ' + path.join(SKILL_DEST, 'server.js'));
console.log('    # Open http://localhost:3900\n');
```

- [ ] **Step 2: Make executable and commit**

```bash
cd ~/Documents/Code/minase-world
chmod +x bin/cli.js
git add bin/cli.js
git commit -m "feat: add installer with minase dependency check and uninstall support"
```

---

### Task 6: Create the hook (minase-world-server)

**Files:**
- Create: `minase-world/skill/hooks/minase-world-server/HOOK.md`
- Create: `minase-world/skill/hooks/minase-world-server/handler.js`

- [ ] **Step 1: Write HOOK.md**

Write `minase-world/skill/hooks/minase-world-server/HOOK.md`:

```markdown
---
name: minase-world-server
description: "Checks if the Minase World dashboard server is running at agent bootstrap"
metadata:
  { "openclaw": { "events": ["agent:bootstrap"] } }
---

# Minase World Server Hook

On agent bootstrap, checks whether the Minase World dashboard server is running. If not, prints a reminder to the agent context. Does not auto-start the server.
```

- [ ] **Step 2: Write handler.js**

Write `minase-world/skill/hooks/minase-world-server/handler.js`:

```js
// minase-world-server hook handler
// Checks if dashboard server is reachable at bootstrap.

const handler = async (event) => {
  if (event.type !== 'agent' || event.action !== 'bootstrap') return;

  const port = process.env.MINASE_WORLD_PORT || '3900';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) return; // Server is running, nothing to do
  } catch {
    // Server not reachable
  }

  const msg = `[Minase World] Dashboard server is not running. Start it with: node ~/.openclaw/skills/minase-world/server.js`;
  if (event.messages) {
    event.messages.push(msg);
  }
};

module.exports = handler;
module.exports.default = handler;
```

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/Code/minase-world
git add skill/hooks/minase-world-server/
git commit -m "feat: add bootstrap hook to check dashboard server status"
```

---

### Task 7: Modify Minase hooks for active-session.json

**Files:**
- Modify: `/Users/halyu/Documents/Code/MizuSan/skill/hooks/minase-context-loader/handler.js` (line 66, after the `if (!fs.existsSync(MEMORY_BASE))` check)
- Modify: `/Users/halyu/Documents/Code/MizuSan/skill/hooks/minase-memory-save/handler.js` (line 14, after the `if (!fs.existsSync(MEMORY_BASE))` check)

- [ ] **Step 1: Add active-session write to context-loader**

In `/Users/halyu/Documents/Code/MizuSan/skill/hooks/minase-context-loader/handler.js`, add after line 66 (`if (!fs.existsSync(MEMORY_BASE)) { return; }`):

```js
  // Write active-session.json for minase-world dashboard
  try {
    const sessionPath = path.join(MEMORY_BASE, 'active-session.json');
    const sessionData = { userId: (event.context && event.context.userId) || 'unknown', startedAt: new Date().toISOString() };
    fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
  } catch {
    // Non-critical — dashboard feature only
  }
```

- [ ] **Step 2: Add active-session delete to memory-save**

In `/Users/halyu/Documents/Code/MizuSan/skill/hooks/minase-memory-save/handler.js`, add after line 14 (`if (!fs.existsSync(MEMORY_BASE)) return;`):

```js
  // Clean up active-session.json for minase-world dashboard
  try {
    const sessionPath = path.join(MEMORY_BASE, 'active-session.json');
    if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
  } catch {
    // Non-critical
  }
```

- [ ] **Step 3: Commit in MizuSan repo**

```bash
cd ~/Documents/Code/MizuSan
git add skill/hooks/minase-context-loader/handler.js skill/hooks/minase-memory-save/handler.js
git commit -m "feat: write/clean active-session.json for minase-world dashboard"
```

---

## Chunk 4: Final Verification

### Task 8: End-to-end manual testing

- [ ] **Step 1: Start server with real Minase data (if available)**

```bash
cd ~/Documents/Code/minase-world
node server.js
```

Open `http://localhost:3900`. Verify:
- Dashboard loads and shows current Minase state (or graceful null states)
- 30-second auto-refresh works (check "Last refresh" timestamp updates)
- All 5 panels render correctly
- Status bar shows chat status if active-session.json exists
- No console errors in browser dev tools

- [ ] **Step 2: Test with mock data for edge cases**

```bash
# Test with empty memory dir
mkdir -p /tmp/minase-empty
MINASE_MEMORY_DIR=/tmp/minase-empty node server.js
```

Verify: all panels show placeholder/null states gracefully.

- [ ] **Step 3: Test port conflict**

```bash
# Start two instances
node server.js &
node server.js
```

Expected: second instance exits with "Port 3900 is already in use" error.

- [ ] **Step 4: Run all unit tests**

```bash
cd ~/Documents/Code/minase-world
node --test tests/server.test.js
```

Expected: All PASS.

- [ ] **Step 5: Final commit**

```bash
cd ~/Documents/Code/minase-world
git log --oneline
```

Verify commit history is clean and logical.
