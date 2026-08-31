import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'cli.js');

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

describe('bin/cli.js smoke', () => {
  it('init then status / emotion / help / tick-without-key', () => { // compiles tsc via `alive init`
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-cli-'));
    const home = path.join(root, 'home');
    const aliveHome = path.join(root, 'alive-home');
    fs.mkdirSync(home);
    const env = { HOME: home, ALIVE_HOME: aliveHome };

    const init = run(['init', '--persona', 'minase'], env);
    expect(init.status).toBe(0);
    expect(init.stdout).toContain('installed skill');
    expect(fs.existsSync(path.join(home, '.agents', 'skills', 'alive', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(aliveHome, 'personas', 'minase', 'state', 'emotion-state.json'))).toBe(true);

    const status = run(['status'], env);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain('Status');

    const emotion = run(['emotion'], env);
    expect(emotion.status).toBe(0);
    expect(emotion.stdout).toContain('Emotion');

    const help = run(['help'], env);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('/alive status');

    const tick = run(['tick'], env);
    expect(tick.status).not.toBe(0);
    expect(`${tick.stderr}${tick.stdout}`).toContain('LLM_API_KEY');

    const remember = run(['remember', '--user', '今天去咖啡馆了吗', '--reply', '去了啦光线超好'], env);
    expect(remember.status).toBe(0);
    const context = run(['context'], env);
    expect(context.status).toBe(0);
    expect(context.stdout).toContain('水瀬');
    expect(context.stdout).toContain('今天去咖啡馆了吗');

    fs.rmSync(root, { recursive: true, force: true });
  });
});
