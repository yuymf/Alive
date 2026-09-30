# Nightly / cloud-computer test gate

Default `npm test` is the mocked Vitest day suite plus CLI smoke. Real-LLM E2E files (`e2e-real-llm-day`, `e2e-real-subskills-day`) use `describe.skipIf` and stay skipped unless `LLM_API_KEY` or `REAL_LLM_E2E=1` is set. Do not add Playwright / browser E2E to this gate.

```bash
npm ci && npm test
```

Keep `LLM_API_KEY`, `LLM_API_BASE`, `LLM_MODEL`, and `REAL_LLM_E2E` unset so the gate stays secret-free.
