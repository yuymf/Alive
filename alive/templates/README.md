# Prompt 模板

生命周期 prompt 由 `alive/scripts/utils/file-utils.ts` 的 `readTemplate()` 加载：优先 skill 安装目录覆盖，其次本目录。

## `alive/templates/` — 核心生命周期 prompt

- `heartbeat-prompt.md` — 心跳 tick
- `morning-plan-prompt.md` — 晨规划
- `night-reflect-prompt.md` — 睡前反思
- `reflection-prompt.md` — 通用反思
- `flow-evolution-prompt.md` — 心流进化
- `persona-generate-prompt.md` — 人格生成
- `diary-entry.md` / `identity.md` / `personality.md` / `simulated-action.md` / `soul-injection.md` / `user.md` — 模板组件

## `alive/sub-skills/*/templates/` — 子技能 prompt

- `content-browse/templates/`
- `social-engagement/templates/`
- `voice-tts/templates/`
- `web-search/templates/`
- `send-message/templates/`
- `platform/content-planner/templates/`
