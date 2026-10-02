# Releasing

Alive ships on a tag. Pushing a `v*` tag runs [`.github/workflows/publish.yml`](../.github/workflows/publish.yml),
which typechecks, tests, builds, publishes to npm, and opens a GitHub Release. There is no manual `npm publish`.

## One-shot release

```bash
npm run release -- patch     # or: minor | major | 0.10.0
```

The script refuses to run unless the working tree is clean, HEAD is on `main`, and `main` is in sync with
`origin/main`. It then bumps `package.json`, commits `chore(release): vX.Y.Z`, tags `vX.Y.Z`, and pushes the
branch and the tag. Preview without writing anything:

```bash
npm run release -- minor --dry-run
```

## Required secret

| Secret | Where | What |
|:---|:---|:---|
| `NPM_TOKEN` | Settings → Secrets and variables → Actions | npm **Automation** token with publish rights on `@yuymf/alive` |

The workflow fails loudly if `NPM_TOKEN` is missing, rather than silently skipping the publish step.

Publishing uses `--provenance` (npm OIDC), so the package is published with a signed build attestation linking it
to this repository and workflow run.
