---
name: minase-memory-save
description: "Reminds Minase to save conversation memory when session ends or resets"
metadata:
  { "openclaw": { "events": ["command:new", "command:reset"], "requires": { "env": ["LLM_API_KEY"] } } }
---

# Minase Memory Save

When a session is about to end (via /new or /reset), injects a reminder for Minase to save conversation memories to diary and relation files before the session context is lost.
