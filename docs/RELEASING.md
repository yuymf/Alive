# Releasing

Alive ships on a tag. Pushing a `v*` tag runs [`.github/workflows/publish.yml`](../.github/workflows/publish.yml),
which typechecks, tests, builds, publishes to npm, and opens a GitHub Release. There is no manual `npm publish`.

## One-shot release

```bash
npm run release -- patch     # or: minor | major | 0.10.0
```

The script refuses to run unless the working tree is clean, HEAD is on `main`, and `main` is exactly in sync
with the remote. The sync check reads the remote's real SHA with `git ls-remote` (after a best-effort
`git fetch`), so it cannot be fooled by a stale local remote-tracking ref when the remote has moved ahead.
It then bumps `package.json`, commits `chore(release): vX.Y.Z`, tags `vX.Y.Z`, and pushes the branch and the
tag. If a push is rejected, the script prints the exact commands to undo the local commit/tag before retrying —
it never force-pushes.

Preview without writing anything:

```bash
npm run release -- minor --dry-run
```

## Required secret

| Secret | Where | What |
|:---|:---|:---|
| `NPM_TOKEN` | Settings → Secrets and variables → Actions | npm **Automation** token with publish rights on `@yuymf/alive` |

The workflow fails loudly if `NPM_TOKEN` is missing, rather than silently skipping the publish step.

## Provenance

npm provenance (the signed build attestation linking a package to its source repo and workflow run) is
**only supported for public source repositories**. The workflow therefore requests `--provenance` only when
`github.event.repository.visibility` is `public`; on a private repo it logs a warning and publishes without
provenance instead of failing with npm's `422 ... Unsupported GitHub Actions source repository visibility:
"private"` error. Make the repository public if you want provenance on releases.
