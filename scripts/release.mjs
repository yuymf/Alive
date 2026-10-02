#!/usr/bin/env node
// One-shot release: bump version -> commit -> tag -> push (branch + tag).
// The pushed tag triggers .github/workflows/publish.yml, which runs
// typecheck + test + build, publishes to npm, and opens a GitHub Release.
//
// Usage:
//   npm run release -- patch|minor|major|X.Y.Z [--dry-run] [--remote origin] [--branch main]
//
// Safety: refuses unless the working tree is clean, HEAD is on the release
// branch, and that branch is exactly in sync with the remote. Never force-pushes.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATH = path.join(ROOT, 'package.json');

const SEMVER = /^\d+\.\d+\.\d+$/;
const BUMPS = ['patch', 'minor', 'major'];

function fail(msg) {
  console.error(`\n  ✗ ${msg}\n`);
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

  let remoteRef;
  try {
    remoteRef = git(['rev-parse', `refs/remotes/${opts.remote}/${opts.branch}`]).trim();
  } catch {
    fail(`Remote branch ${opts.remote}/${opts.branch} not found. Run: git fetch ${opts.remote}`);
  }
  const head = git(['rev-parse', 'HEAD']).trim();
  if (head !== remoteRef) {
    fail(`Local ${opts.branch} (${head.slice(0, 7)}) is not in sync with ${opts.remote}/${opts.branch} (${remoteRef.slice(0, 7)}). Pull/push first.`);
  }

  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const next = bumpVersion(pkg.version, opts.bump);
  const tag = `v${next}`;

  if (git(['tag', '-l', tag]).trim()) fail(`Tag ${tag} already exists.`);

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
  git(['push', opts.remote, opts.branch], { capture: false });
  git(['push', opts.remote, tag], { capture: false });

  console.log(`\n  ✓ Released ${tag}.`);
  console.log(`    publish.yml is now running: https://github.com/${repoSlug(pkg)}/actions\n`);
}

function repoSlug(pkg) {
  const url = pkg.repository?.url || '';
  return url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^https?:\/\/github\.com\//, '');
}

main();
