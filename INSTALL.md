# Install

Alive is an [Agent Skill](https://agentskills.io/specification).

```bash
npx alive init
```

Copies `alive/SKILL.md` into Code Agent skill directories (`~/.agents/skills/alive`, plus `~/.claude` / `~/.cursor` / `~/.codex` when those hosts exist). Memory: `~/.alive`.

```bash
npx alive init --project    # .agents/skills/alive in the current repo
npx alive tick              # optional scripted heartbeat (needs LLM_API_KEY)
```

Conversation uses the host agent model. See README.md.
