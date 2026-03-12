---
name: minase-context-loader
description: "Injects Minase's core memory context at agent bootstrap so the model always starts with memory loaded"
metadata:
  { "openclaw": { "events": ["agent:bootstrap"], "requires": { "env": ["LLM_API_KEY"] } } }
---

# Minase Context Loader

Automatically injects core memory (wisdom, recent diary, emotion state) into the agent's context at session start. This ensures Minase always has her memories available without relying on the model to proactively read files.
