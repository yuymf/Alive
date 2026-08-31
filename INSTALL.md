# Install

Alive is an [Agent Skill](https://agentskills.io/specification). It gives a persona skill (女娲 / 永雏塔菲 / any `SKILL.md`) a body beyond chat.

```bash
npx alive init
npx alive adopt https://github.com/ly-xxx/ace-taffy-skill
```

Copies `alive/SKILL.md` into Code Agent skill directories (`~/.agents/skills/alive`, plus `~/.claude` / `~/.cursor` / `~/.codex` when those hosts exist). Memory: `~/.alive`. After init, `alive status` works without an API key. Chat goes through `chat.js load` / `chat.js save` so the next turn reads diary and emotion.

```bash
npx alive init --project    # .agents/skills/alive in the current repo
npx alive adopt <dir|url>   # take in a Nuwa / persona skill
npx alive tick              # optional scripted heartbeat (needs LLM_API_KEY)
```

Conversation uses the host agent model. See README.md.
