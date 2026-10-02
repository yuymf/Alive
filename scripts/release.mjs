#!/usr/bin/env node
// One-shot release: bump version -> commit -> tag -> push (branch + tag).
// The pushed tag triggers .github/workflows/publish.yml, which runs
// typecheck + test + build, publishes to npm, and opens a GitHub Release.
//
// Usage:
//   npm run release -- patch|minor|major|X.Y.Z [--dry-run] [--remote origin] [--branch main]
//
// Safety: refuses unless the working tree is clean, HEAD is on the release
// branch, and that branch is exactly in sync with the *fresh* remote state
// (verified via `git ls-remote`, not a possibly-stale local tracking ref).
// Never force-pushes.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATH = path.join(ROOT, 'package.json');

const SEMVER = /^\d+\.\d+\.\d+$/;
const BUMPS = ['patch', 'minor', 'major'];

function fail(msg, hint) {
  console.error(`\n  ✗ ${msg}\n`);
  if (hint) console.error(`  ${hint}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { dryRun: false, remote: 'origin', branch: 'main', bump: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') opts.dryRun = true;
    else if (a === '--remote') opts.remote = argv[++i];
    else if (a === '--branch') opts.branch = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: npm run release -- <patch|minor|major|X.Y.Z> [--dry-run] [--remote <name>] [--branch <name>]');
      process.exit(0);
    } else if (a.startsWith('-')) fail(`Unknown flag: ${a}`);
    else if (opts.bump === null) opts.bump = a;
    else fail(`Unexpected extra argument: ${a}`);
  }
  if (!opts.bump) fail('Missing version argument. Usage: npm run release -- <patch|minor|major|X.Y.Z>');
  if (!BUMPS.includes(opts.bump) && !SEMVER.test(opts.bump)) {
    fail(`Invalid version "${opts.bump}". Use patch, minor, major, or an exact X.Y.Z.`);
  }
  return opts;
}

function git(args, { capture = true } = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}

// Best-effort git: returns trimmed stdout, or null when the command fails
// (e.g. offline). Never throws — used for network probes and existence checks.
function gitQuiet(args) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function bumpVersion(current, bump) {
  if (SEMVER.test(bump)) return bump;
  const [major, minor, patch] = current.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const label = opts.dryRun ? 'DRY RUN' : 'RELEASE';

  // --- Preflight ---------------------------------------------------------
  const dirty = git(['status', '--porcelain']).trim();
  if (dirty) fail(`Working tree is not clean:\n${dirty}\nCommit or stash your changes first.`);

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (branch !== opts.branch) {
    fail(`On branch "${branch}", expected "${opts.branch}". Release from ${opts.branch}.`);
  }

  const head = git(['rev-parse', 'HEAD']).trim();

  // Refresh remote-tracking refs. Offline is tolerated here (warning) because
  // the authoritative sync check below uses `git ls-remote`, which reads the
  // remote's real SHA instead of a possibly-stale local tracking ref.
  if (gitQuiet(['fetch', '--quiet', opts.remote, opts.branch]) === null) {
    console.warn(`  ! git fetch ${opts.remote} ${opts.branch} failed (offline?) — checking the remote directly.`);
  }

  const remoteLine = gitQuiet(['ls-remote', opts.remote, `refs/heads/${opts.branch}`]);
  if (!remoteLine) {
    const msg = `Could not read ${opts.remote}/${opts.branch} from the remote (offline, or branch missing).`;
    if (opts.dryRun) {
      console.warn(`  ! ${msg} Dry run continues; a real run would refuse.`);
    } else {
      fail(msg, `Verify connectivity and the branch name: git ls-remote ${opts.remote} refs/heads/${opts.branch}`);
    }
  } else {
    const remoteSha = remoteLine.split(/\s+/)[0];
    if (head !== remoteSha) {
      fail(
        `Local ${opts.branch} (${head.slice(0, 7)}) is not in sync with ${opts.remote}/${opts.branch} (${remoteSha.slice(0, 7)}).`,
        `Fetch and reconcile first: git fetch ${opts.remote} && git pull --ff-only ${opts.remote} ${opts.branch}`,
      );
    }
  }

  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const next = bumpVersion(pkg.version, opts.bump);
  const tag = `v${next}`;

  const localTag = gitQuiet(['tag', '-l', tag]);
  const remoteTag = gitQuiet(['ls-remote', '--tags', opts.remote, `refs/tags/${tag}`]);
  if (localTag || remoteTag) {
    fail(`Tag ${tag} already exists${remoteTag ? ' on the remote' : ''}. Pick a different version.`);
  }

  // --- Plan --------------------------------------------------------------
  const steps = [
    `bump package.json  ${pkg.version} -> ${next}`,
    `commit             chore(release): ${tag}`,
    `tag                ${tag} (annotated)`,
    `push               ${opts.remote} ${opts.branch}`,
    `push               ${opts.remote} ${tag}   (triggers publish.yml)`,
  ];
  console.log(`\n  ${label}: ${pkg.name} ${pkg.version} -> ${next}`);
  console.log(`  branch: ${opts.branch}  remote: ${opts.remote}\n`);
  steps.forEach((s, i) => console.log(`    ${i + 1}. ${s}`));
  console.log('');

  if (opts.dryRun) {
    console.log('  Dry run — nothing written, no commits, no tags, no push.\n');
    return;
  }

  // --- Execute -----------------------------------------------------------
  const updated = `${JSON.stringify({ ...pkg, version: next }, null, 2)}\n`;
  fs.writeFileSync(PKG_PATH, updated);

  git(['add', 'package.json']);
  git(['commit', '-m', `chore(release): ${tag}`], { capture: false });
  git(['tag', '-a', tag, '-m', `Release ${tag}`]);

  // Undo the local-only release commit/tag so a rejected push cannot leave a
  // half-published state that pollutes the next release.
  const recover = (why) => {
    console.error(`\n  ✗ Failed to push ${why}. Nothing was published to npm.`);
    console.error('    Undo the local release artifacts, then retry:\n');
    console.error(`      git tag -d ${tag}`);
    console.error('      git reset --mixed HEAD~1        # drop the release commit, keep the working tree');
    console.error('      git checkout -- package.json    # discard the version bump');
    console.error(`      git fetch ${opts.remote} && git pull --ff-only ${opts.remote} ${opts.branch}\n`);
    process.exit(1);
  };

  try {
    git(['push', opts.remote, opts.branch], { capture: false });
  } catch {
    recover(`branch ${opts.branch}`);
  }

  try {
    git(['push', opts.remote, tag], { capture: false });
  } catch {
    console.error(`\n  ✗ Branch ${opts.branch} was pushed but tag ${tag} was rejected.`);
    console.error(`    Nothing is published yet — retry just the tag:\n`);
    console.error(`      git push ${opts.remote} ${tag}\n`);
    process.exit(1);
  }

  console.log(`\n  ✓ Released ${tag}.`);
  console.log(`    publish.yml is now running: https://github.com/${repoSlug(pkg)}/actions\n`);
}

function repoSlug(pkg) {
  const url = pkg.repository?.url || '';
  return url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^https?:\/\/github\.com\//, '');
}

main();
