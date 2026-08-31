---
name: alive
description: >
  Digital life engine for AI personas. Use when chatting in character, checking
  emotion/memory/status, running a heartbeat, creating a persona, or the user
  says /alive, 人设, 心跳, 情绪, 记忆.
license: MIT
compatibility: Requires Node.js >= 18
metadata:
  author: yuymf
  version: "0.4.0"
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

## Heartbeat

Autonomous ticks need `LLM_API_KEY` in `$ALIVE_HOME/.env`.

```bash
node {baseDir}/scripts/host/boot.js tick
```

`morning` / `night` are the same entry with that argument. If the user asks to run a heartbeat, run this and summarize the diary/heartbeat-log change.
