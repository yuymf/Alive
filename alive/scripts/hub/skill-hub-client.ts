// alive/scripts/hub/skill-hub-client.ts
// CLI-based search and install client for ClawHub and skills.sh
// Design ref: D8

import { execFile as _execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(_execFile);

const CLI_TIMEOUT_MS = 30_000;

// ─── Types ──────────────────────────────────────────────

export interface SkillSearchResult {
  name: string;
  slug: string;
  description: string;
  author?: string;
  source: 'clawhub' | 'skillshub';
}

export interface InstallResult {
  success: boolean;
  output?: string;
  error?: string;
}

// ─── Helpers ────────────────────────────────────────────

async function runCli(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string } | null> {
  try {
    const result = await execFileAsync(cmd, args, { timeout: CLI_TIMEOUT_MS });
    return result;
  } catch {
    return null;
  }
}

function parseSearchResults(
  stdout: string,
  source: 'clawhub' | 'skillshub',
): SkillSearchResult[] {
  try {
    const parsed = JSON.parse(stdout);
    const results: unknown[] = parsed.results ?? parsed;
    if (!Array.isArray(results)) return [];
    return results.map((r: any) => ({
      name: r.name ?? '',
      slug: r.slug ?? r.name ?? '',
      description: r.description ?? '',
      author: r.author,
      source,
    }));
  } catch {
    return [];
  }
}

// ─── Public API ─────────────────────────────────────────

/**
 * Search ClawHub registry for skills matching a query.
 * Uses: `npx clawhub search <query> --json`
 */
export async function searchClawHub(query: string): Promise<SkillSearchResult[]> {
  const result = await runCli('npx', ['clawhub', 'search', query, '--json']);
  if (!result) return [];
  return parseSearchResults(result.stdout, 'clawhub');
}

/**
 * Search skills.sh hub for skills matching a query.
 * Uses: `npx skills find <query> --json`
 */
export async function searchSkillsHub(query: string): Promise<SkillSearchResult[]> {
  const result = await runCli('npx', ['skills', 'find', query, '--json']);
  if (!result) return [];
  return parseSearchResults(result.stdout, 'skillshub');
}

/**
 * Install a skill from ClawHub by slug.
 * Uses: `npx clawhub install <slug>`
 */
export async function installClawHubSkill(slug: string): Promise<InstallResult> {
  const result = await runCli('npx', ['clawhub', 'install', slug]);
  if (!result) {
    return { success: false, error: 'CLI command failed or timed out' };
  }
  return { success: true, output: result.stdout };
}

/**
 * Check if a CLI tool is available (can be invoked).
 */
export async function isCliAvailable(cli: string): Promise<boolean> {
  const result = await runCli(cli, ['--version']);
  return result !== null;
}
