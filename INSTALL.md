# Install

Alive is an [Agent Skill](https://agentskills.io/specification). It gives a persona skill (女娲 / 永雏塔菲 / any `SKILL.md`) a body beyond chat.

```bash
npx alive init
npx alive distill 峰哥
```

Copies `alive/SKILL.md` into Code Agent skill directories (`~/.agents/skills/alive`, plus `~/.claude` / `~/.cursor` / `~/.codex` / `~/.hermes` / `~/.openclaw` when those hosts exist). Memory: `~/.alive`. After init, `alive status` works without an API key. Chat goes through `chat.js load` / `chat.js save` so the next turn reads diary and emotion. Heartbeat reuses a Hermes / OpenClaw model key when present.

```bash
npx alive init --project              # .agents/skills/alive in the current repo
npx alive init --agent hermes         # only Hermes
npx alive init --agent openclaw
npx alive init --agent hermes,openclaw
npx alive distill <name|dir|url>      # materials / talk-to-fengge → skill → adopt
npx alive adopt <dir|url>             # take in a Nuwa / persona skill
npx alive adopt ./examples/fengge
npx alive tick                        # scripted heartbeat (host key or LLM_API_KEY)
```

Bundled cases live in `examples/` — 峰哥 plus 永雏塔菲, and Jobs / 王小波 / 王阳明 / Karpathy from [awesome-human-distillation](https://github.com/mliu98/awesome-human-distillation).

Conversation uses the host agent model. From a new character to a live call: [USAGE.md](USAGE.md).
