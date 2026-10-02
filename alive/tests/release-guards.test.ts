import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Offline regression test for scripts/release.mjs preflight guards.
// Builds a throwaway bare repo + clones in a temp dir; no network access.

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function sh(cwd: string, args: string[], opts: Record<string, unknown> = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString().trim();
}

function initRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'release.mjs'), path.join(dir, 'scripts', 'release.mjs'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      { name: '@yuymf/alive', version: '0.9.0', repository: { type: 'git', url: 'git+https://github.com/yuymf/Alive.git' } },
      null,
      2,
    ) + '\n',
  );
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.email', 'test@example.com']);
  sh(dir, ['config', 'user.name', 'test']);
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-q', '-m', 'init']);
}

function runRelease(cwd: string, args: string[] = ['patch']): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [path.join(cwd, 'scripts', 'release.mjs'), ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    return { status: 0, stdout, stderr: '' };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return { status: err.status ?? 1, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' };
  }
}

describe('release.mjs preflight guards', () => {
  let tmp: string;
  let origin: string;
  let work: string;
  let other: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-release-'));
    origin = path.join(tmp, 'origin.git');
    work = path.join(tmp, 'work');
    other = path.join(tmp, 'other');

    fs.mkdirSync(origin, { recursive: true });
    sh(origin, ['init', '-q', '--bare', '-b', 'main']);

    initRepo(work);
    sh(work, ['remote', 'add', 'origin', origin]);
    sh(work, ['push', '-q', '-u', 'origin', 'main']);

    sh(tmp, ['clone', '-q', origin, other]);
    sh(other, ['config', 'user.email', 'test@example.com']);
    sh(other, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(other, 'CHANGELOG.md'), 'advanced\n');
    sh(other, ['add', '.']);
    sh(other, ['commit', '-q', '-m', 'advance origin']);
    sh(other, ['push', '-q', 'origin', 'main']);
  });

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses when the remote branch moved ahead but the local tracking ref is stale', () => {
    // work's origin/main tracking ref still points at the first commit, but the
    // remote's real SHA has advanced. A stale-ref comparison would wrongly pass.
    const stale = sh(work, ['rev-parse', 'refs/remotes/origin/main']);
    const fresh = sh(work, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0];
    expect(stale).not.toBe(fresh);

    const res = runRelease(work);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/not in sync/i);

    // No half-published state: no local commit or tag was created.
    expect(sh(work, ['tag', '-l', 'v0.9.1'])).toBe('');
    expect(sh(work, ['rev-parse', 'HEAD'])).toBe(stale);
  });

  it('refuses when the tag already exists only on the remote', () => {
    // Advance work to match the remote, then create the tag remotely only.
    sh(work, ['fetch', '-q', 'origin', 'main']);
    sh(work, ['reset', '-q', '--hard', 'origin/main']);
    sh(work, ['tag', 'v0.9.1']);
    sh(work, ['push', '-q', 'origin', 'v0.9.1']);
    sh(work, ['tag', '-d', 'v0.9.1']);

    const res = runRelease(work);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/already exists/i);
  });

  it('dry-run reports the plan without writing anything', () => {
    const res = runRelease(work, ['major', '--dry-run']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/DRY RUN/);
    expect(sh(work, ['status', '--porcelain'])).toBe('');
    expect(sh(work, ['tag', '-l', 'v1.0.0'])).toBe('');
  });
});
