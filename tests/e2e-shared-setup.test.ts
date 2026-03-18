import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadApiKeys, applyApiKeys } from '../e2e/shared/setup';

describe('e2e shared setup env loading', () => {
  let tempHome: string | undefined;
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    for (const key of [
      'INSTAGRAM_USERNAME',
      'INSTAGRAM_PASSWORD',
      'INSTAGRAM_TOTP_SECRET',
      'XHS_SKILLS_DIR',
      'LLM_API_KEY',
    ]) {
      delete process.env[key];
    }

    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  it('loads live-run env keys from openclaw.json skill config', () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'minase-openclaw-home-'));
    process.env.HOME = tempHome;

    const openclawDir = path.join(tempHome, '.openclaw');
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(openclawDir, 'openclaw.json'),
      JSON.stringify({
        skills: {
          entries: {
            minase: {
              env: {
                INSTAGRAM_USERNAME: 'minase_test_user',
                INSTAGRAM_PASSWORD: 'minase_test_password',
                INSTAGRAM_TOTP_SECRET: 'minase_test_totp',
                XHS_SKILLS_DIR: '/tmp/xhs-skills',
                LLM_API_KEY: 'llm-key',
              },
            },
          },
        },
      }, null, 2),
    );

    const keys = loadApiKeys() as Record<string, string | undefined>;

    expect(keys.INSTAGRAM_USERNAME).toBe('minase_test_user');
    expect(keys.INSTAGRAM_PASSWORD).toBe('minase_test_password');
    expect(keys.INSTAGRAM_TOTP_SECRET).toBe('minase_test_totp');
    expect(keys.XHS_SKILLS_DIR).toBe('/tmp/xhs-skills');
    expect(keys.LLM_API_KEY).toBe('llm-key');
  });

  it('applies loaded live-run env keys to process.env', () => {
    const applied = applyApiKeys({
      INSTAGRAM_USERNAME: 'minase_test_user',
      INSTAGRAM_PASSWORD: 'minase_test_password',
      INSTAGRAM_TOTP_SECRET: 'minase_test_totp',
      XHS_SKILLS_DIR: '/tmp/xhs-skills',
    } as Record<string, string>);

    expect(applied).toEqual([
      'INSTAGRAM_USERNAME',
      'INSTAGRAM_PASSWORD',
      'INSTAGRAM_TOTP_SECRET',
      'XHS_SKILLS_DIR',
    ]);
    expect(process.env.INSTAGRAM_USERNAME).toBe('minase_test_user');
    expect(process.env.INSTAGRAM_PASSWORD).toBe('minase_test_password');
    expect(process.env.INSTAGRAM_TOTP_SECRET).toBe('minase_test_totp');
    expect(process.env.XHS_SKILLS_DIR).toBe('/tmp/xhs-skills');
  });
});
