# Install

Alive is an [Agent Skill](https://agentskills.io/specification). It gives a persona skill (女娲 / 永雏塔菲 / any `SKILL.md`) a body beyond chat.

## 1. Install CLI

### Option A — npm global install (recommended):

```bash
npm install -g @yuymf/alive
```

After global install, use the `alive` command directly:

```bash
alive init
alive distill 峰哥
```

### Option B — npx (run without install):

```bash
npx @yuymf/alive init
npx @yuymf/alive distill 峰哥
```

## 2. Install Skill to AI Agents

Use the built-in initializer (`alive init` or `npx @yuymf/alive init`) to automatically configure your Agent environment and install the skill:

```bash
alive init
# or run directly via npx:
npx @yuymf/alive init
```

This automatically detects and installs the skill into your Code Agent directories:
- `~/.agents/skills/alive` (Cursor + Codex global fallback)
- `~/.claude/skills/alive` (Claude Code, if present)
- `~/.cursor/skills/alive` (Cursor, if present)
- `~/.codex/skills/alive` (Codex, if present)
- `~/.hermes/skills/alive` (Hermes, if present)
- `~/.openclaw/skills/alive` (OpenClaw, if present)

Memory lives at `~/.alive` (customizable via `ALIVE_HOME`). After init, `alive status` works without an API key.

## Common commands

```bash
alive init --hermes taffy          # Hermes dedicated profile (~/.hermes/profiles/taffy)
alive init --openclaw miss-v       # OpenClaw dedicated workspace (~/.openclaw/agents/miss-v)
alive init --project               # .agents/skills/alive in the current repo
alive init --agent hermes,openclaw # only target specific hosts
alive distill <name|dir|url>       # materials / talk-to-fengge → skill → adopt
alive adopt <dir|url>              # take in a Nuwa / persona skill
alive adopt ./examples/fengge
alive tick                         # scripted heartbeat (host key or LLM_API_KEY)
```
*(If running via npx without global install, prepend `npx @yuymf/alive`)*

Bundled cases live in `examples/` — 峰哥 plus 永雏塔菲, and Jobs / 王小波 / 王阳明 / Karpathy from [awesome-human-distillation](https://github.com/mliu98/awesome-human-distillation).

Conversation uses the host agent model. From a new character to a live call: [USAGE.md](USAGE.md).
