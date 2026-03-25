/**
 * e2e/shared/setup.ts
 * Loads API keys from ~/.openclaw/openclaw.json skill config
 * and applies them to process.env for real-day E2E tests.
 */

import * as fs from 'fs';
import * as path from 'path';

/** All env keys that the alive framework may need. */
const KNOWN_ENV_KEYS = [
  'IMAGE_ENTRY',
  'LLM_API_KEY',
  'LLM_API_BASE',
  'LLM_MODEL',
  'AIHUBMIX_API_KEY',
  'AIHUBMIX_MODEL',
  'FAL_KEY',
  'FAL_MODEL',
  'IMGURL_TOKEN',
  'INSTAGRAM_USERNAME',
  'INSTAGRAM_PASSWORD',
  'INSTAGRAM_TOTP_SECRET',
  'INSTAGRAM_SESSIONID',
  'INSTAGRAM_CSRFTOKEN',
  'INSTAGRAM_DS_USER_ID',
  'INSTAGRAM_MID',
  'INSTAGRAM_IG_DID',
  'XHS_SKILLS_DIR',
  'ALIVE_PERSONA',
] as const;

export type EnvKeys = Record<string, string | undefined>;

/**
 * Load API keys from openclaw.json for the given skill slug.
 * Reads from ~/.openclaw/openclaw.json → skills.entries.<slug>.env
 *
 * @param slug  Skill slug to look up (default: 'alive')
 * @returns     A record of env key → value (only keys that exist in config)
 */
export function loadApiKeys(slug = 'alive'): EnvKeys {
  const home = process.env.HOME || '~';
  const configPath = path.join(home, '.openclaw', 'openclaw.json');

  if (!fs.existsSync(configPath)) {
    console.warn(`[setup] openclaw.json not found at ${configPath}`);
    return {};
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.warn(`[setup] Failed to parse openclaw.json: ${(err as Error).message}`);
    return {};
  }

  const skills = config.skills as { entries?: Record<string, { env?: Record<string, string> }> } | undefined;
  const entry = skills?.entries?.[slug];
  if (!entry?.env) {
    console.warn(`[setup] No env config found for skill "${slug}" in openclaw.json`);
    return {};
  }

  const result: EnvKeys = {};
  for (const key of KNOWN_ENV_KEYS) {
    if (entry.env[key] !== undefined) {
      result[key] = entry.env[key];
    }
  }
  return result;
}

/**
 * Apply a set of env keys to process.env.
 * Only sets keys that have non-undefined values.
 *
 * @param keys  Record of env key → value
 * @returns     List of keys that were actually applied
 */
export function applyApiKeys(keys: EnvKeys): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(keys)) {
    if (value !== undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

/**
 * Convenience: load and apply API keys in one step.
 */
export function loadAndApplyApiKeys(slug = 'alive'): string[] {
  const keys = loadApiKeys(slug);
  return applyApiKeys(keys);
}

/**
 * Verify that required env vars are set. Throws if any are missing.
 */
export function requireEnvVars(...vars: string[]): void {
  const missing = vars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}
