# Nightly / cloud-computer test gate

Default `npm test` is the mocked Vitest day suite plus CLI smoke. Real-LLM E2E files (`e2e-real-llm-day`, `e2e-real-subskills-day`) use `describe.skipIf` and stay skipped unless `LLM_API_KEY` or `REAL_LLM_E2E=1` is set. Do not add Playwright / browser E2E to this gate.

## One-shot on the cloud computer (box)

```bash
cd /workspace/nightly-audit/Alive && npm ci && npm test
```

Ensure `LLM_API_KEY`, `LLM_API_BASE`, `LLM_MODEL`, and `REAL_LLM_E2E` are unset or empty so the gate stays secret-free.

Optional: pull tip of `main` first:

```bash
cd /workspace/nightly-audit/Alive && git fetch origin && git checkout main && git pull --ff-only origin main
```

If the checkout is missing:

```bash
mkdir -p /workspace/nightly-audit && gh repo clone yuymf/Alive /workspace/nightly-audit/Alive
```
