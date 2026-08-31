---
name: alive
description: >
  Digital life engine for persona skills. Distill or adopt a Nuwa /
  永雏塔菲 / 峰哥-style SKILL.md and give it emotion, memory, and an hourly
  life — not just chat. Use when chatting in character, distilling a person,
  adopting a skill, checking emotion/memory, running a heartbeat, or the
  user says /alive, distill, adopt, 人设, 心跳, 女娲, 蒸馏, 峰哥.
license: MIT
compatibility: Requires Node.js >= 18
metadata:
  author: yuymf
  version: "0.6.0"
---

# Alive

Portable Agent Skill. Works in Claude Code, Cursor, Codex, and any host that loads `SKILL.md`.

Data lives in `$ALIVE_HOME` (default `~/.alive`). The skill directory is `{baseDir}`.

Do not edit diary, relations, or emotion files yourself. The scripts below write them.

## Routing (do this first)

If the user message starts with `/alive`, or is 帮助 / 命令列表 / 有什么命令:

```bash
node {baseDir}/scripts/admin/command-handler.js <raw message>
```

Return stdout as-is. Do not speak in character.

## In-character chat

Every turn, before you reply:

```bash
node {baseDir}/scripts/host/chat.js load
```

Use stdout as the only character context. If it lists outbox items, deliver them in character first.

Reply as the persona. Do not announce that you are a skill or an AI.

Conversation uses the **host model**. Do not call an extra LLM API for chat.

After a substantive reply, persist the turn (engine writes diary / relation / emotion):

```bash
printf '%s' '{"user":"<user text>","reply":"<your reply>"}' | node {baseDir}/scripts/host/chat.js save
```

If memory or `.env` is missing, tell the user to run `npx alive init` (default persona: 水瀬 / Minase).

## Distill (one command)

If the user wants 蒸馏 / 一键蒸馏 / distill a person, or to bring in [talk-to-fengge](https://github.com/YeJe-cpu/talk-to-fengge) / 峰哥:

```bash
node {baseDir}/scripts/admin/command-handler.js /alive distill <name-or-path-or-git-url>
```

If stdout contains `<!-- ALIVE_DISTILL_HOST -->`:

1. Do not ask the user to finish it. Complete the protocol yourself.
2. Research or read the materials as instructed.
3. Write `SKILL.md` / `persona.md` / `references/*.md` into the printed work directory.
4. Run the `/alive adopt` command printed at the end.
5. Return that adopt result to the user.

Known shortcuts: `峰哥` / `talk-to-fengge` / `ace-taffy` / bundled `examples/` ids.

## Adopt a persona skill

If the user already has a Nuwa-distilled skill, 永雏塔菲, 峰哥, or any folder with `SKILL.md` + optional `persona.md`:

```bash
node {baseDir}/scripts/admin/command-handler.js /alive adopt <path-or-git-url>
```

After adopt, `chat.js load` includes the original skill rules. Heartbeat uses them too.

## Heartbeat

Autonomous ticks need `LLM_API_KEY` in `$ALIVE_HOME/.env`.

```bash
node {baseDir}/scripts/host/boot.js tick
```

`morning` / `night` are the same entry with that argument. If the user asks to run a heartbeat, run this and summarize the diary/heartbeat-log change.
